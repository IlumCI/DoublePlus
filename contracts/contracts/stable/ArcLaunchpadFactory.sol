// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {TokenDeployer} from "../TokenDeployer.sol";
import {TickMath} from "../libraries/TickMath.sol";
import {IUniswapV3FactoryCore, IUniswapV3PoolCore} from "./IUniswapV3Core.sol";

/// @title ArcLaunchpadFactory
/// @author arcx.fun
/// @notice Token launchpad for Arc mainnet that opens markets directly on the
///         DyorSwap Uniswap V3 factory (the pool source the chain's trading
///         bots index). One transaction deploys a fixed-supply, tax-free,
///         ownerless ERC-20, creates and initializes its V3 pool at a target
///         starting market cap, and seeds the pool single-sided with the
///         entire supply. Pools pair against the chain's native USDC through
///         its ERC-20 interface, so every pair is a dollar pair.
///
///         This factory drives the V3 CORE contracts directly (createPool,
///         initialize, mint via callback, burn/collect) and custodies each
///         seeded position itself; there is no dependency on any third-party
///         periphery. Pool trading fees (the 1% tier) accrue inside the held
///         position and are distributed by {harvestFees}: 80% to the token's
///         creator, 20% to the platform fee recipient.
contract ArcLaunchpadFactory is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAddress();
    error InvalidParams();
    error LaunchesArePaused();
    error NotPaused();
    error QuoteNotApproved();
    error UnknownToken();
    error FeeTierNotSupported();
    error MarketCapOutOfRange();
    error NothingToCollect();
    error NotPool();

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event TokenCreated(
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        string metadataURI,
        uint256 totalSupply
    );
    event PoolCreated(
        address indexed token,
        address indexed quote,
        address pool,
        uint24 feeTier,
        uint160 sqrtPriceX96,
        uint256 marketCapUsd8
    );
    event LiquidityAdded(address indexed token, uint128 liquidity, uint256 tokenAmount);
    event FeesCollected(
        address indexed token,
        address indexed creator,
        uint256 creatorTokenAmount,
        uint256 creatorQuoteAmount,
        uint256 platformTokenAmount,
        uint256 platformQuoteAmount
    );
    event LiquidityCollected(
        address indexed token,
        uint128 liquidityRemoved,
        uint256 tokenAmount,
        uint256 quoteAmount,
        address indexed recipient
    );
    event FeeRecipientUpdated(address indexed previousRecipient, address indexed newRecipient);
    event FactoryPaused(address indexed by);
    event FactoryResumed(address indexed by);
    event EmergencyRecovered(address indexed asset, uint256 amount, address indexed to);
    event QuoteAssetSet(address indexed quote, bool approved, uint256 usdPrice8, uint8 decimals);

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @notice Launch parameters. `marketCapUsd8` of 0 selects the default.
    struct CreateParams {
        string name;
        string symbol;
        string metadataURI;
        address quote;
        uint256 marketCapUsd8;
    }

    /// @notice An approved quote asset and its USD price used to size pools.
    struct QuoteAsset {
        bool approved;
        uint64 usdPrice8;
        uint8 decimals;
    }

    /// @notice A launched token, its market and the position that backs it.
    ///         The position is identified by (this contract, tickLower,
    ///         tickUpper) inside the pool; there is no NFT.
    struct Listing {
        address creator;
        address quote;
        address pool;
        int24 tickLower;
        int24 tickUpper;
        uint64 createdAt;
        bool tokenIsToken0;
    }

    // ---------------------------------------------------------------------
    // Constants and immutables
    // ---------------------------------------------------------------------

    uint16 internal constant BPS = 10_000;
    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;
    uint256 internal constant Q96 = 1 << 96;

    /// @notice Fixed supply of every launched token (1B, 18 decimals).
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    /// @notice Fixed Uniswap V3 fee tier - 1% - for every launch pool.
    uint24 public constant POOL_FEE_TIER = 10_000;
    /// @notice Creator share of harvested pool fees.
    uint16 public constant CREATOR_FEE_BPS = 8_000; // 80%
    /// @notice Platform share of harvested pool fees.
    uint16 public constant PLATFORM_FEE_BPS = 2_000; // 20%
    /// @notice Default starting market cap: $3,000 (8 decimals).
    uint256 public constant DEFAULT_MARKET_CAP_USD8 = 3_000e8;
    uint256 public constant MIN_MARKET_CAP_USD8 = 100e8;
    uint256 public constant MAX_MARKET_CAP_USD8 = 100_000_000e8;

    /// @notice Deploys each token so its bytecode stays out of this contract.
    TokenDeployer public immutable tokenDeployer;
    /// @notice The V3 factory pools are created on (DyorSwap on Arc).
    IUniswapV3FactoryCore public immutable uniswapFactory;
    /// @notice Native USDC through its ERC-20 interface; the default quote.
    address public immutable quoteNative;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// @notice Receives the platform's 20% of harvested pool fees.
    address public feeRecipient;
    /// @notice When true, {createToken} reverts; existing markets trade on.
    bool public launchesPaused;

    mapping(address quote => QuoteAsset) public quoteAssets;
    mapping(address token => Listing) public listings;
    address[] public allTokens;
    mapping(address creator => address[] tokens) internal _tokensByCreator;

    /// @dev The only pool allowed to call the mint callback, set for the
    ///      duration of a single mint.
    address private _expectedPool;

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    constructor(
        address owner_,
        address feeRecipient_,
        TokenDeployer tokenDeployer_,
        IUniswapV3FactoryCore uniswapFactory_,
        address quoteNative_
    ) Ownable(owner_) {
        if (
            feeRecipient_ == address(0) ||
            address(tokenDeployer_) == address(0) ||
            address(uniswapFactory_) == address(0) ||
            quoteNative_ == address(0)
        ) revert ZeroAddress();

        feeRecipient = feeRecipient_;
        tokenDeployer = tokenDeployer_;
        uniswapFactory = uniswapFactory_;
        quoteNative = quoteNative_;

        uint8 dec = IERC20Metadata(quoteNative_).decimals();
        quoteAssets[quoteNative_] = QuoteAsset({approved: true, usdPrice8: 1e8, decimals: dec});
        emit QuoteAssetSet(quoteNative_, true, 1e8, dec);
    }

    // ---------------------------------------------------------------------
    // Launch
    // ---------------------------------------------------------------------

    /// @notice Deploy a token and open its market in one transaction. The
    ///         entire supply seeds the pool single-sided just above (or below)
    ///         the starting price, so buyers' quote fills the pool from the
    ///         first trade. No quote asset is required up front.
    function createToken(CreateParams calldata p)
        external
        nonReentrant
        returns (address token, address pool)
    {
        if (launchesPaused) revert LaunchesArePaused();
        if (bytes(p.name).length == 0 || bytes(p.symbol).length == 0) revert InvalidParams();

        QuoteAsset memory q = quoteAssets[p.quote];
        if (!q.approved) revert QuoteNotApproved();

        int24 tickSpacing = uniswapFactory.feeAmountTickSpacing(POOL_FEE_TIER);
        if (tickSpacing == 0) revert FeeTierNotSupported();

        uint256 mcapUsd8 = p.marketCapUsd8 == 0 ? DEFAULT_MARKET_CAP_USD8 : p.marketCapUsd8;
        if (mcapUsd8 < MIN_MARKET_CAP_USD8 || mcapUsd8 > MAX_MARKET_CAP_USD8) revert MarketCapOutOfRange();

        token = tokenDeployer.deploy(msg.sender, p.name, p.symbol, p.metadataURI);
        emit TokenCreated(token, msg.sender, p.name, p.symbol, p.metadataURI, TOTAL_SUPPLY);

        bool tokenIsToken0 = token < p.quote;
        (address token0, address token1) = tokenIsToken0 ? (token, p.quote) : (p.quote, token);

        (uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper) =
            _initialPosition(tokenIsToken0, tickSpacing, mcapUsd8, q);

        pool = uniswapFactory.getPool(token0, token1, POOL_FEE_TIER);
        if (pool == address(0)) pool = uniswapFactory.createPool(token0, token1, POOL_FEE_TIER);
        (uint160 current,,,,,,) = IUniswapV3PoolCore(pool).slot0();
        if (current == 0) IUniswapV3PoolCore(pool).initialize(sqrtPriceX96);
        emit PoolCreated(token, p.quote, pool, POOL_FEE_TIER, sqrtPriceX96, mcapUsd8);

        uint128 liquidity = _liquidityForSupply(tokenIsToken0, tickLower, tickUpper);
        _expectedPool = pool;
        (uint256 amount0, uint256 amount1) =
            IUniswapV3PoolCore(pool).mint(address(this), tickLower, tickUpper, liquidity, "");
        _expectedPool = address(0);
        emit LiquidityAdded(token, liquidity, tokenIsToken0 ? amount0 : amount1);

        listings[token] = Listing({
            creator: msg.sender,
            quote: p.quote,
            pool: pool,
            tickLower: tickLower,
            tickUpper: tickUpper,
            createdAt: uint64(block.timestamp),
            tokenIsToken0: tokenIsToken0
        });
        allTokens.push(token);
        _tokensByCreator[msg.sender].push(token);
    }

    /// @notice Pool mint callback: pays the owed token amounts from the supply
    ///         minted to this contract. Only callable by the pool currently
    ///         being seeded.
    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata) external {
        if (msg.sender != _expectedPool) revert NotPool();
        if (amount0Owed > 0) IERC20(IUniswapV3PoolCore(msg.sender).token0()).safeTransfer(msg.sender, amount0Owed);
        if (amount1Owed > 0) IERC20(IUniswapV3PoolCore(msg.sender).token1()).safeTransfer(msg.sender, amount1Owed);
    }

    /// @dev Initial pool price (snapped to a tick boundary) and the token-only
    ///      range directly adjacent, mirroring the proven Stable-era layout.
    function _initialPosition(bool tokenIsToken0, int24 tickSpacing, uint256 mcapUsd8, QuoteAsset memory q)
        internal
        pure
        returns (uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper)
    {
        uint256 mcapQuote = Math.mulDiv(mcapUsd8, 10 ** q.decimals, q.usdPrice8);
        uint256 priceX18 = Math.mulDiv(mcapQuote, 1e18, TOTAL_SUPPLY);
        if (priceX18 == 0) revert InvalidParams();

        uint160 target = tokenIsToken0
            ? uint160(Math.sqrt(Math.mulDiv(priceX18, 1 << 192, 1e18)))
            : uint160(Math.sqrt(Math.mulDiv(1e18, 1 << 192, priceX18)));

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

    /// @dev Liquidity so the position consumes as close to the full supply as
    ///      possible. Canonical LiquidityAmounts formulas; the range is fully
    ///      token-sided so only one formula applies per orientation.
    function _liquidityForSupply(bool tokenIsToken0, int24 tickLower, int24 tickUpper)
        internal
        pure
        returns (uint128 liquidity)
    {
        uint160 sqrtL = TickMath.getSqrtRatioAtTick(tickLower);
        uint160 sqrtU = TickMath.getSqrtRatioAtTick(tickUpper);
        uint256 l = tokenIsToken0
            ? Math.mulDiv(TOTAL_SUPPLY, Math.mulDiv(sqrtL, sqrtU, Q96), sqrtU - sqrtL)
            : Math.mulDiv(TOTAL_SUPPLY, Q96, sqrtU - sqrtL);
        if (l > type(uint128).max) revert InvalidParams();
        liquidity = uint128(l);
    }

    // ---------------------------------------------------------------------
    // Fee distribution - 80% creator / 20% platform
    // ---------------------------------------------------------------------

    /// @notice Collect the pool fees accrued to a token's held position and
    ///         distribute them: 80% to the token's creator, 20% to the
    ///         platform fee recipient. Permissionless.
    function harvestFees(address token)
        external
        nonReentrant
        returns (uint256 creatorToken, uint256 creatorQuote, uint256 platformToken, uint256 platformQuote)
    {
        Listing memory l = listings[token];
        if (l.pool == address(0)) revert UnknownToken();

        // Poke the position so fees owed are up to date, then pull them here.
        IUniswapV3PoolCore(l.pool).burn(l.tickLower, l.tickUpper, 0);
        (uint128 a0, uint128 a1) = IUniswapV3PoolCore(l.pool).collect(
            address(this), l.tickLower, l.tickUpper, type(uint128).max, type(uint128).max
        );
        (uint256 tokenAmount, uint256 quoteAmount) =
            l.tokenIsToken0 ? (uint256(a0), uint256(a1)) : (uint256(a1), uint256(a0));
        if (tokenAmount == 0 && quoteAmount == 0) revert NothingToCollect();

        creatorToken = (tokenAmount * CREATOR_FEE_BPS) / BPS;
        creatorQuote = (quoteAmount * CREATOR_FEE_BPS) / BPS;
        platformToken = tokenAmount - creatorToken;
        platformQuote = quoteAmount - creatorQuote;

        if (creatorToken > 0) IERC20(token).safeTransfer(l.creator, creatorToken);
        if (creatorQuote > 0) IERC20(l.quote).safeTransfer(l.creator, creatorQuote);
        if (platformToken > 0) IERC20(token).safeTransfer(feeRecipient, platformToken);
        if (platformQuote > 0) IERC20(l.quote).safeTransfer(feeRecipient, platformQuote);

        emit FeesCollected(token, l.creator, creatorToken, creatorQuote, platformToken, platformQuote);
    }

    // ---------------------------------------------------------------------
    // Owner: position harvest
    // ---------------------------------------------------------------------

    /// @notice Remove a token's held position entirely and send everything
    ///         (principal plus any uncollected fees) to the owner. Owner only.
    function collectFees(address token)
        external
        onlyOwner
        nonReentrant
        returns (uint256 tokenAmount, uint256 quoteAmount)
    {
        Listing memory l = listings[token];
        if (l.pool == address(0)) revert UnknownToken();

        bytes32 key = keccak256(abi.encodePacked(address(this), l.tickLower, l.tickUpper));
        (uint128 liquidity,,,,) = IUniswapV3PoolCore(l.pool).positions(key);
        if (liquidity > 0) {
            IUniswapV3PoolCore(l.pool).burn(l.tickLower, l.tickUpper, liquidity);
        }
        (uint128 a0, uint128 a1) = IUniswapV3PoolCore(l.pool).collect(
            owner(), l.tickLower, l.tickUpper, type(uint128).max, type(uint128).max
        );
        (tokenAmount, quoteAmount) = l.tokenIsToken0 ? (uint256(a0), uint256(a1)) : (uint256(a1), uint256(a0));
        if (tokenAmount == 0 && quoteAmount == 0) revert NothingToCollect();

        emit LiquidityCollected(token, liquidity, tokenAmount, quoteAmount, owner());
    }

    // ---------------------------------------------------------------------
    // Owner: configuration
    // ---------------------------------------------------------------------

    /// @notice Approve or update a quote asset. The native USDC interface is
    ///         approved at construction.
    function setQuoteAsset(address quote, bool approved, uint64 usdPrice8) external onlyOwner {
        if (quote == address(0)) revert ZeroAddress();
        if (approved && usdPrice8 == 0) revert InvalidParams();
        uint8 dec = IERC20Metadata(quote).decimals();
        quoteAssets[quote] = QuoteAsset({approved: approved, usdPrice8: usdPrice8, decimals: dec});
        emit QuoteAssetSet(quote, approved, usdPrice8, dec);
    }

    /// @notice Update the platform fee recipient.
    function setFeeRecipient(address recipient) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        emit FeeRecipientUpdated(feeRecipient, recipient);
        feeRecipient = recipient;
    }

    /// @notice Pause new launches. Existing markets are untouched.
    function pause() external onlyOwner {
        if (launchesPaused) revert LaunchesArePaused();
        launchesPaused = true;
        emit FactoryPaused(msg.sender);
    }

    /// @notice Resume new launches.
    function resume() external onlyOwner {
        if (!launchesPaused) revert NotPaused();
        launchesPaused = false;
        emit FactoryResumed(msg.sender);
    }

    /// @notice Recover assets sent here by mistake. Cannot touch positions;
    ///         they live inside the pools, not on this contract.
    function emergencyRecover(address asset, uint256 amount, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (asset == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert InvalidParams();
        } else {
            IERC20(asset).safeTransfer(to, amount);
        }
        emit EmergencyRecovered(asset, amount, to);
    }

    /// @dev Native may arrive from quote transfers through the USDC interface.
    receive() external payable {}

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function totalTokens() external view returns (uint256) {
        return allTokens.length;
    }

    function tokensByCreator(address creator) external view returns (address[] memory) {
        return _tokensByCreator[creator];
    }

    /// @notice Liquidity currently held in a token's position.
    function positionLiquidity(address token) external view returns (uint128 liquidity) {
        Listing memory l = listings[token];
        if (l.pool == address(0)) revert UnknownToken();
        bytes32 key = keccak256(abi.encodePacked(address(this), l.tickLower, l.tickUpper));
        (liquidity,,,,) = IUniswapV3PoolCore(l.pool).positions(key);
    }

    /// @notice Fees currently claimable for a token (after a poke), split by
    ///         side. Callable via staticcall for UI display.
    function pendingFees(address token) external returns (uint256 tokenAmount, uint256 quoteAmount) {
        Listing memory l = listings[token];
        if (l.pool == address(0)) revert UnknownToken();
        IUniswapV3PoolCore(l.pool).burn(l.tickLower, l.tickUpper, 0);
        bytes32 key = keccak256(abi.encodePacked(address(this), l.tickLower, l.tickUpper));
        (, , , uint128 owed0, uint128 owed1) = IUniswapV3PoolCore(l.pool).positions(key);
        (tokenAmount, quoteAmount) = l.tokenIsToken0 ? (uint256(owed0), uint256(owed1)) : (uint256(owed1), uint256(owed0));
    }
}
