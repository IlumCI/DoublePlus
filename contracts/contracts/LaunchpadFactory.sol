// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {TokenDeployer} from "./TokenDeployer.sol";
import {TickMath} from "./libraries/TickMath.sol";
import {ProtocolConfig} from "./libraries/ProtocolConfig.sol";
import {
    IUniswapV3Factory,
    IUniswapV3Pool,
    INonfungiblePositionManager,
    ISwapRouter,
    IWETH9
} from "./interfaces/IUniswapV3.sol";

interface IPriceFeed {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

/// @title LaunchpadFactory
/// @notice Direct Uniswap V3 launchpad. A single transaction deploys a
///         fixed-supply token, creates and seeds a real V3 pool single-sided
///         with the full supply, and opens trading. The full-range liquidity
///         position is held by this factory and mapped to its token; it is
///         never handed to the token contract.
///
///         App-routed trades pay a flat 1% fee that accrues inside the factory
///         and splits 80% to the token creator, 20% to the protocol. Fees are
///         not pushed per trade; the creator and the protocol pull their own
///         balances with claimCreatorFees / claimPlatformFees.
///
///         Three roles are strictly independent:
///           - Token creator: the launcher; claims only their token's fees.
///           - Factory deployer: deploys this contract; holds no privileges.
///           - Protocol admin: an immutable wallet distinct from the deployer;
///             claims the protocol fee share and manages the held positions.
contract LaunchpadFactory is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------
    error NotProtocolAdmin();
    error AdminIsDeployer();
    error NotTokenCreator();
    error NothingToClaim();
    error UnknownToken();
    error InvalidParams();
    error ZeroAddress();
    error ZeroAmount();
    error LaunchesPaused();
    error FeeTierNotSupported();
    error Expired();
    error SlippageExceeded();
    error TransferFailed();
    error PriceUnavailable();

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------
    event TokenLaunched(
        address indexed token,
        address indexed creator,
        address pool,
        uint256 positionId,
        string name,
        string symbol,
        string metadataURI,
        uint256 totalSupply,
        uint24 feeTier,
        uint256 initialBuyWei
    );
    event Trade(
        address indexed token,
        address indexed trader,
        bool isBuy,
        uint256 nativeAmount,
        uint256 tokenAmount,
        uint256 feeAmount,
        uint160 sqrtPriceX96After
    );
    event FeeAccrued(address indexed token, uint256 creatorAmount, uint256 protocolAmount);
    event CreatorFeesClaimed(address indexed token, address indexed creator, uint256 amount);
    event PlatformFeesClaimed(address indexed admin, uint256 amount);
    event PositionUnwound(
        address indexed token,
        uint128 liquidityRemoved,
        uint256 tokenAmount,
        uint256 wethAmount,
        address indexed recipient
    );
    event LaunchesPausedSet(bool paused);
    event TokenFeaturedSet(address indexed token, bool featured);
    event NativeUsdPriceSet(uint256 price8);
    event PriceFeedSet(address feed);

    // ---------------------------------------------------------------------
    // Types and storage
    // ---------------------------------------------------------------------
    struct LaunchParams {
        string name;
        string symbol;
        // JSON metadata: description, logo, website, twitter, telegram.
        string metadataURI;
    }

    /// @notice A launched token, its creator, and the V3 position that backs it.
    struct Listing {
        address creator;
        address pool;
        uint256 positionId;
        uint24 feeTier;
        uint64 createdAt;
        bool featured;
        bool tokenIsToken0;
    }

    uint16 internal constant BPS = ProtocolConfig.BPS;
    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;

    uint256 public constant TOTAL_SUPPLY = ProtocolConfig.TOTAL_SUPPLY;
    uint24 public constant POOL_FEE_TIER = ProtocolConfig.POOL_FEE_TIER;
    uint16 public constant TRADE_FEE_BPS = ProtocolConfig.TRADE_FEE_BPS;
    uint16 public constant CREATOR_FEE_BPS = ProtocolConfig.CREATOR_FEE_BPS;
    uint16 public constant PROTOCOL_FEE_BPS = ProtocolConfig.PROTOCOL_FEE_BPS;
    uint256 public constant INITIAL_MARKET_CAP_USD = ProtocolConfig.INITIAL_MARKET_CAP_USD;

    /// @notice Immutable protocol administrator. Distinct from the deployer.
    address public immutable protocolAdmin;

    TokenDeployer public immutable tokenDeployer;
    IUniswapV3Factory public immutable uniswapFactory;
    INonfungiblePositionManager public immutable positionManager;
    ISwapRouter public immutable swapRouter;
    IWETH9 public immutable weth;

    bool public launchesPaused;

    /// @notice Fallback native/USD price (8 decimals) used to size the initial
    ///         pool price when no on-chain feed is configured.
    uint256 public nativeUsdPrice8;
    IPriceFeed public priceFeed;

    mapping(address token => Listing) public listings;
    address[] public allTokens;
    mapping(address creator => address[] tokens) internal _tokensByCreator;

    /// @notice Creator-owed fees per token (native wei), pull-claimed by the creator.
    mapping(address token => uint256) public creatorFeesAccrued;
    /// @notice Protocol-owed fees (native wei), pull-claimed by the protocol admin.
    uint256 public protocolFeesAccrued;

    /// @notice Lifetime stats for the operations view.
    uint256 public totalLaunches;
    uint256 public totalTradeVolumeWei;
    uint256 public totalFeesWei;

    modifier onlyProtocolAdmin() {
        if (msg.sender != protocolAdmin) revert NotProtocolAdmin();
        _;
    }

    constructor(
        address protocolAdmin_,
        TokenDeployer tokenDeployer_,
        IUniswapV3Factory uniswapFactory_,
        INonfungiblePositionManager positionManager_,
        ISwapRouter swapRouter_,
        IWETH9 weth_,
        uint256 nativeUsdPrice8_
    ) {
        if (
            protocolAdmin_ == address(0) ||
            address(tokenDeployer_) == address(0) ||
            address(uniswapFactory_) == address(0) ||
            address(positionManager_) == address(0) ||
            address(swapRouter_) == address(0) ||
            address(weth_) == address(0)
        ) revert ZeroAddress();
        // The deployer must never be the protocol admin by default.
        if (protocolAdmin_ == msg.sender) revert AdminIsDeployer();

        protocolAdmin = protocolAdmin_;
        tokenDeployer = tokenDeployer_;
        uniswapFactory = uniswapFactory_;
        positionManager = positionManager_;
        swapRouter = swapRouter_;
        weth = weth_;
        nativeUsdPrice8 = nativeUsdPrice8_;
    }

    receive() external payable {}

    // ---------------------------------------------------------------------
    // Launch
    // ---------------------------------------------------------------------

    /// @notice Deploy a token, create its V3 pool, and seed it single-sided
    ///         with the full supply. Launching needs no upfront liquidity; an
    ///         optional msg.value performs a first buy in the same transaction.
    function launch(LaunchParams calldata p)
        external
        payable
        nonReentrant
        returns (address token, address pool, uint256 positionId)
    {
        if (launchesPaused) revert LaunchesPaused();
        if (bytes(p.name).length == 0 || bytes(p.symbol).length == 0) revert InvalidParams();

        int24 tickSpacing = uniswapFactory.feeAmountTickSpacing(POOL_FEE_TIER);
        if (tickSpacing == 0) revert FeeTierNotSupported();

        token = tokenDeployer.deploy(msg.sender, p.name, p.symbol, p.metadataURI);

        bool tokenIsToken0 = token < address(weth);
        (address token0, address token1) = tokenIsToken0
            ? (token, address(weth))
            : (address(weth), token);

        (uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper) = _initialPosition(tokenIsToken0, tickSpacing);
        pool = positionManager.createAndInitializePoolIfNecessary(token0, token1, POOL_FEE_TIER, sqrtPriceX96);

        IERC20(token).forceApprove(address(positionManager), TOTAL_SUPPLY);
        (positionId, , , ) = positionManager.mint(
            INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: POOL_FEE_TIER,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: tokenIsToken0 ? TOTAL_SUPPLY : 0,
                amount1Desired: tokenIsToken0 ? 0 : TOTAL_SUPPLY,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this),
                deadline: block.timestamp
            })
        );

        listings[token] = Listing({
            creator: msg.sender,
            pool: pool,
            positionId: positionId,
            feeTier: POOL_FEE_TIER,
            createdAt: uint64(block.timestamp),
            featured: false,
            tokenIsToken0: tokenIsToken0
        });
        allTokens.push(token);
        _tokensByCreator[msg.sender].push(token);
        totalLaunches += 1;

        emit TokenLaunched(
            token,
            msg.sender,
            pool,
            positionId,
            p.name,
            p.symbol,
            p.metadataURI,
            TOTAL_SUPPLY,
            POOL_FEE_TIER,
            msg.value
        );

        if (msg.value > 0) {
            _buy(token, listings[token], msg.value, 0, block.timestamp);
        }
    }

    /// @dev Initial pool price (snapped to a tick boundary) and the token-only
    ///      range directly adjacent, so the whole supply seeds one side.
    function _initialPosition(bool tokenIsToken0, int24 tickSpacing)
        internal
        view
        returns (uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper)
    {
        uint256 mcapWeth = Math.mulDiv(INITIAL_MARKET_CAP_USD, 1e18, nativeUsdPrice());
        uint256 priceWei = Math.mulDiv(mcapWeth, 1e18, TOTAL_SUPPLY);
        if (priceWei == 0) revert InvalidParams();

        uint160 target = tokenIsToken0
            ? uint160(Math.sqrt(Math.mulDiv(priceWei, 1 << 192, 1e18)))
            : uint160(Math.sqrt(Math.mulDiv(1e18, 1 << 192, priceWei)));

        int24 tick = TickMath.getTickAtSqrtRatio(target);
        int24 aligned = (tick / tickSpacing) * tickSpacing;
        if (tick < 0 && tick % tickSpacing != 0) aligned -= tickSpacing;

        if (tokenIsToken0) {
            sqrtPriceX96 = TickMath.getSqrtRatioAtTick(aligned);
            tickLower = aligned + tickSpacing;
            tickUpper = (MAX_TICK / tickSpacing) * tickSpacing;
        } else {
            sqrtPriceX96 = TickMath.getSqrtRatioAtTick(aligned + tickSpacing);
            tickLower = (MIN_TICK / tickSpacing) * tickSpacing;
            tickUpper = aligned + tickSpacing;
        }
    }

    // ---------------------------------------------------------------------
    // Trading
    // ---------------------------------------------------------------------

    /// @notice Buy `token` with native currency; the 1% fee is retained and
    ///         split 80/20 between creator and protocol.
    function buy(address token, uint256 minTokensOut, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 tokensOut)
    {
        Listing memory l = listings[token];
        if (l.pool == address(0)) revert UnknownToken();
        if (msg.value == 0) revert ZeroAmount();
        tokensOut = _buy(token, l, msg.value, minTokensOut, deadline);
    }

    function _buy(address token, Listing memory l, uint256 value, uint256 minTokensOut, uint256 deadline)
        internal
        returns (uint256 tokensOut)
    {
        if (block.timestamp > deadline) revert Expired();
        uint256 fee = (value * TRADE_FEE_BPS) / BPS;
        _accrueFee(token, fee);

        uint256 amountIn = value - fee;
        tokensOut = swapRouter.exactInputSingle{value: amountIn}(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: address(weth),
                tokenOut: token,
                fee: l.feeTier,
                recipient: msg.sender,
                amountIn: amountIn,
                amountOutMinimum: minTokensOut,
                sqrtPriceLimitX96: 0
            })
        );

        totalTradeVolumeWei += value;
        (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(l.pool).slot0();
        emit Trade(token, msg.sender, true, value, tokensOut, fee, sqrtPriceX96);
    }

    /// @notice Sell `token` for native currency; the 1% fee is retained from
    ///         the proceeds and split 80/20 between creator and protocol.
    function sell(address token, uint256 amountIn, uint256 minNativeOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 nativeOut)
    {
        Listing memory l = listings[token];
        if (l.pool == address(0)) revert UnknownToken();
        if (amountIn == 0) revert ZeroAmount();
        if (block.timestamp > deadline) revert Expired();

        IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(token).forceApprove(address(swapRouter), amountIn);

        uint256 wethOut = swapRouter.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: token,
                tokenOut: address(weth),
                fee: l.feeTier,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );

        weth.withdraw(wethOut);
        uint256 fee = (wethOut * TRADE_FEE_BPS) / BPS;
        _accrueFee(token, fee);

        nativeOut = wethOut - fee;
        if (nativeOut < minNativeOut) revert SlippageExceeded();
        (bool ok, ) = msg.sender.call{value: nativeOut}("");
        if (!ok) revert TransferFailed();

        totalTradeVolumeWei += wethOut;
        (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(l.pool).slot0();
        emit Trade(token, msg.sender, false, wethOut, amountIn, fee, sqrtPriceX96);
    }

    /// @dev Splits a fee into its creator and protocol shares and books both.
    function _accrueFee(address token, uint256 fee) internal {
        if (fee == 0) return;
        uint256 creatorCut = (fee * CREATOR_FEE_BPS) / BPS;
        uint256 protocolCut = fee - creatorCut;
        creatorFeesAccrued[token] += creatorCut;
        protocolFeesAccrued += protocolCut;
        totalFeesWei += fee;
        emit FeeAccrued(token, creatorCut, protocolCut);
    }

    // ---------------------------------------------------------------------
    // Fee claims
    // ---------------------------------------------------------------------

    /// @notice Claim the fees accrued to a token you created.
    function claimCreatorFees(address token) external nonReentrant returns (uint256 amount) {
        Listing memory l = listings[token];
        if (l.pool == address(0)) revert UnknownToken();
        if (msg.sender != l.creator) revert NotTokenCreator();

        amount = creatorFeesAccrued[token];
        if (amount == 0) revert NothingToClaim();
        creatorFeesAccrued[token] = 0;

        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit CreatorFeesClaimed(token, msg.sender, amount);
    }

    /// @notice Claim the protocol's accrued fee share. Protocol admin only.
    function claimPlatformFees() external nonReentrant onlyProtocolAdmin returns (uint256 amount) {
        amount = protocolFeesAccrued;
        if (amount == 0) revert NothingToClaim();
        protocolFeesAccrued = 0;

        (bool ok, ) = protocolAdmin.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit PlatformFeesClaimed(protocolAdmin, amount);
    }

    // ---------------------------------------------------------------------
    // Protocol-owned liquidity (admin only)
    // ---------------------------------------------------------------------

    /// @notice Reduce a token's held liquidity by `liquidityBps` (0 collects
    ///         only accrued pool fees) and send everything to `recipient`.
    ///         Works after the token has renounced ownership, since the
    ///         position lives here and is keyed by token. Protocol admin only.
    function unwindPosition(address token, uint16 liquidityBps, address recipient)
        public
        nonReentrant
        onlyProtocolAdmin
        returns (uint256 tokenAmount, uint256 wethAmount)
    {
        if (liquidityBps > BPS) revert InvalidParams();
        if (recipient == address(0)) revert ZeroAddress();
        Listing memory l = listings[token];
        if (l.pool == address(0)) revert UnknownToken();

        uint128 removed;
        if (liquidityBps > 0) {
            (, , , , , , , uint128 liquidity, , , , ) = positionManager.positions(l.positionId);
            removed = uint128((uint256(liquidity) * liquidityBps) / BPS);
            if (removed > 0) {
                positionManager.decreaseLiquidity(
                    INonfungiblePositionManager.DecreaseLiquidityParams({
                        tokenId: l.positionId,
                        liquidity: removed,
                        amount0Min: 0,
                        amount1Min: 0,
                        deadline: block.timestamp
                    })
                );
            }
        }

        (uint256 amount0, uint256 amount1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: l.positionId,
                recipient: recipient,
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        (tokenAmount, wethAmount) = l.tokenIsToken0 ? (amount0, amount1) : (amount1, amount0);
        emit PositionUnwound(token, removed, tokenAmount, wethAmount, recipient);
    }

    /// @notice Collect only the accrued pool fees of a held position, leaving
    ///         the principal in place. Protocol admin only.
    function collectPositionFees(address token, address recipient)
        external
        returns (uint256 tokenAmount, uint256 wethAmount)
    {
        return unwindPosition(token, 0, recipient);
    }

    // ---------------------------------------------------------------------
    // Admin configuration
    // ---------------------------------------------------------------------

    function setLaunchesPaused(bool paused) external onlyProtocolAdmin {
        launchesPaused = paused;
        emit LaunchesPausedSet(paused);
    }

    function setFeatured(address token, bool featured) external onlyProtocolAdmin {
        if (listings[token].pool == address(0)) revert UnknownToken();
        listings[token].featured = featured;
        emit TokenFeaturedSet(token, featured);
    }

    function setNativeUsdPrice(uint256 price8) external onlyProtocolAdmin {
        if (price8 == 0) revert InvalidParams();
        nativeUsdPrice8 = price8;
        emit NativeUsdPriceSet(price8);
    }

    function setPriceFeed(address feed) external onlyProtocolAdmin {
        priceFeed = IPriceFeed(feed);
        emit PriceFeedSet(feed);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }

    function tokensOf(address creator) external view returns (address[] memory) {
        return _tokensByCreator[creator];
    }

    /// @notice The V3 position id backing a token.
    function positionOf(address token) external view returns (uint256) {
        Listing memory l = listings[token];
        if (l.pool == address(0)) revert UnknownToken();
        return l.positionId;
    }

    /// @notice Native/USD price (8 decimals), from the feed when configured.
    function nativeUsdPrice() public view returns (uint256) {
        if (address(priceFeed) != address(0)) {
            (, int256 answer, , , ) = priceFeed.latestRoundData();
            if (answer > 0) {
                uint8 dec = priceFeed.decimals();
                if (dec == 8) return uint256(answer);
                if (dec < 8) return uint256(answer) * (10 ** (8 - dec));
                return uint256(answer) / (10 ** (dec - 8));
            }
        }
        if (nativeUsdPrice8 == 0) revert PriceUnavailable();
        return nativeUsdPrice8;
    }

    /// @notice Market cap of `token` in native wei.
    function marketCapWeth(address token) public view returns (uint256) {
        Listing memory l = listings[token];
        if (l.pool == address(0)) revert UnknownToken();
        (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(l.pool).slot0();
        uint256 supply = IERC20(token).totalSupply();
        if (l.tokenIsToken0) {
            uint256 a = Math.mulDiv(supply, sqrtPriceX96, 1 << 96);
            return Math.mulDiv(a, sqrtPriceX96, 1 << 96);
        } else {
            uint256 a = Math.mulDiv(supply, 1 << 96, sqrtPriceX96);
            return Math.mulDiv(a, 1 << 96, sqrtPriceX96);
        }
    }

    /// @notice Market cap of `token` in USD (8 decimals).
    function marketCapUsd(address token) external view returns (uint256) {
        return Math.mulDiv(marketCapWeth(token), nativeUsdPrice(), 1e18);
    }

    /// @notice Pool and held-position snapshot for a token.
    function poolInfo(address token)
        external
        view
        returns (
            address pool,
            uint24 feeTier,
            uint160 sqrtPriceX96,
            int24 tick,
            uint128 poolLiquidity,
            uint256 positionId,
            uint128 positionLiquidity
        )
    {
        Listing memory l = listings[token];
        if (l.pool == address(0)) revert UnknownToken();
        pool = l.pool;
        feeTier = l.feeTier;
        (sqrtPriceX96, tick, , , , , ) = IUniswapV3Pool(l.pool).slot0();
        poolLiquidity = IUniswapV3Pool(l.pool).liquidity();
        positionId = l.positionId;
        (, , , , , , , positionLiquidity, , , , ) = positionManager.positions(l.positionId);
    }

    /// @dev ERC-721 receiver so the position manager can mint positions here.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
