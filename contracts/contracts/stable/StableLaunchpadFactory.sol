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
import {
    IUniswapV3Factory,
    IUniswapV3Pool,
    INonfungiblePositionManager,
    ISwapRouter
} from "../interfaces/IUniswapV3.sol";

/// @title StableLaunchpadFactory
/// @author Steadypads
/// @notice Decentralized token launchpad for Stable Mainnet built directly on
///         the official Uniswap V3 deployment. One transaction deploys a
///         fixed-supply, tax-free, ownerless ERC-20, creates and initializes
///         its Uniswap V3 pool at a target starting market cap (default
///         $3,000), seeds the pool single-sided with the entire supply, and
///         opens trading immediately on the official SwapRouter.
///
///         Design guarantees:
///           - No presale, whitelist, bonding curve, vesting or reflection.
///           - No transfer/buy/sell tax on the token; the only trading cost is
///             the fixed 1% Uniswap V3 pool fee tier.
///           - Supply is minted exactly once; the token renounces ownership in
///             its constructor and is immutable from birth.
///           - All trading happens on the official Uniswap V3 SwapRouter; this
///             contract routes nothing and implements no AMM logic.
///           - The full-range-above-price LP NFT is custodied by this factory
///             forever; creators receive no privileges of any kind.
///
///         Pool trading fees (the 1% tier) accrue inside the held position and
///         are distributed by {harvestFees}: 80% to the token's creator, 20%
///         to the configurable platform fee recipient. The factory owner is
///         the only privileged account: it can harvest liquidity via
///         {collectFees}, pause/resume launches, update the fee recipient and
///         recover assets sent here by mistake.
contract StableLaunchpadFactory is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    /// @notice A required address argument was the zero address.
    error ZeroAddress();
    /// @notice A parameter failed validation (empty string, zero value, …).
    error InvalidParams();
    /// @notice Launches are currently paused by the factory owner.
    error LaunchesArePaused();
    /// @notice Launches are not paused, so resume() has nothing to do.
    error NotPaused();
    /// @notice The requested quote asset is not on the approved list.
    error QuoteNotApproved();
    /// @notice The queried token was not launched by this factory.
    error UnknownToken();
    /// @notice The official V3 factory does not support the fixed fee tier.
    error FeeTierNotSupported();
    /// @notice The requested starting market cap is outside the safe bounds.
    error MarketCapOutOfRange();
    /// @notice There is nothing to collect or distribute.
    error NothingToCollect();
    /// @notice A native-currency transfer failed.
    error NativeTransferFailed();

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /// @notice A new token was deployed and its full supply minted here.
    event TokenCreated(
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        string metadataURI,
        uint256 totalSupply
    );
    /// @notice The token's Uniswap V3 pool was created and initialized.
    event PoolCreated(
        address indexed token,
        address indexed quote,
        address pool,
        uint24 feeTier,
        uint160 sqrtPriceX96,
        uint256 marketCapUsd8
    );
    /// @notice The single-sided position seeding the pool was minted.
    event LiquidityAdded(address indexed token, uint256 positionId, uint128 liquidity, uint256 tokenAmount);
    /// @notice Accrued pool fees were distributed 80/20 creator/platform.
    event FeesCollected(
        address indexed token,
        address indexed creator,
        uint256 creatorTokenAmount,
        uint256 creatorQuoteAmount,
        uint256 platformTokenAmount,
        uint256 platformQuoteAmount
    );
    /// @notice The owner harvested a position's underlying assets.
    event LiquidityCollected(
        address indexed token,
        uint128 liquidityRemoved,
        uint256 tokenAmount,
        uint256 quoteAmount,
        address indexed recipient
    );
    /// @notice The platform fee recipient was changed.
    event FeeRecipientUpdated(address indexed previousRecipient, address indexed newRecipient);
    /// @notice New launches were paused.
    event FactoryPaused(address indexed by);
    /// @notice New launches were resumed.
    event FactoryResumed(address indexed by);
    /// @notice Assets sent here by mistake were recovered to the owner.
    event EmergencyRecovered(address indexed asset, uint256 amount, address indexed to);
    /// @notice A quote asset was approved (or updated) for launches.
    event QuoteAssetSet(address indexed quote, bool approved, uint256 usdPrice8, uint8 decimals);

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @notice Launch parameters. `marketCapUsd8` of 0 selects the default.
    struct CreateParams {
        string name;
        string symbol;
        /// @dev JSON metadata: description, logo, website, socials.
        string metadataURI;
        /// @dev Approved quote asset the pool prices against.
        address quote;
        /// @dev Optional starting market cap, USD with 8 decimals. 0 = $3,000.
        uint256 marketCapUsd8;
    }

    /// @notice An approved quote asset and its USD price used to size pools.
    struct QuoteAsset {
        bool approved;
        /// @dev USD per whole quote token, 8 decimals ($1.00 = 1e8).
        uint64 usdPrice8;
        uint8 decimals;
    }

    /// @notice A launched token, its market and the position that backs it.
    struct Listing {
        address creator;
        address quote;
        address pool;
        uint256 positionId;
        uint64 createdAt;
        bool tokenIsToken0;
    }

    // ---------------------------------------------------------------------
    // Constants and immutables
    // ---------------------------------------------------------------------

    uint16 internal constant BPS = 10_000;
    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;

    /// @notice Fixed supply of every launched token (1B, 18 decimals).
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    /// @notice Fixed Uniswap V3 fee tier — 1% — for every launch pool.
    uint24 public constant POOL_FEE_TIER = 10_000;
    /// @notice Creator share of harvested pool fees.
    uint16 public constant CREATOR_FEE_BPS = 8_000; // 80%
    /// @notice Platform share of harvested pool fees.
    uint16 public constant PLATFORM_FEE_BPS = 2_000; // 20%
    /// @notice Default starting market cap: $3,000 (8 decimals).
    uint256 public constant DEFAULT_MARKET_CAP_USD8 = 3_000e8;
    /// @notice Creator-selectable market cap bounds (8 decimals).
    uint256 public constant MIN_MARKET_CAP_USD8 = 100e8;
    uint256 public constant MAX_MARKET_CAP_USD8 = 100_000_000e8;

    /// @notice Deploys each token so its bytecode stays out of this contract.
    TokenDeployer public immutable tokenDeployer;
    /// @notice Official Uniswap V3 factory on Stable Mainnet.
    IUniswapV3Factory public immutable uniswapFactory;
    /// @notice Official Uniswap V3 NonfungiblePositionManager.
    INonfungiblePositionManager public immutable positionManager;
    /// @notice Official Uniswap V3 SwapRouter — all trading happens there.
    ISwapRouter public immutable swapRouter;
    /// @notice Official wrapped native token (WUSDT0 on Stable Mainnet).
    address public immutable wrappedNative;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// @notice Receives the platform's 20% of harvested pool fees.
    address public feeRecipient;
    /// @notice When true, {createToken} reverts; existing markets trade on.
    bool public launchesPaused;

    /// @notice Approved quote assets, keyed by token address.
    mapping(address quote => QuoteAsset) public quoteAssets;
    /// @notice Registry of every launch, keyed by token address.
    mapping(address token => Listing) public listings;
    /// @notice Every token this factory has launched, in order.
    address[] public allTokens;
    mapping(address creator => address[] tokens) internal _tokensByCreator;

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    /// @param owner_ Factory owner — the only privileged account.
    /// @param feeRecipient_ Initial platform fee recipient.
    /// @param tokenDeployer_ Bound token deployer (mints supply to this factory).
    /// @param uniswapFactory_ Official Stable Mainnet Uniswap V3 factory.
    /// @param positionManager_ Official NonfungiblePositionManager.
    /// @param swapRouter_ Official SwapRouter.
    /// @param wrappedNative_ Official wrapped native token; auto-approved as a
    ///        $1.00 quote asset (the native currency on Stable is a dollar).
    constructor(
        address owner_,
        address feeRecipient_,
        TokenDeployer tokenDeployer_,
        IUniswapV3Factory uniswapFactory_,
        INonfungiblePositionManager positionManager_,
        ISwapRouter swapRouter_,
        address wrappedNative_
    ) Ownable(owner_) {
        if (
            feeRecipient_ == address(0) ||
            address(tokenDeployer_) == address(0) ||
            address(uniswapFactory_) == address(0) ||
            address(positionManager_) == address(0) ||
            address(swapRouter_) == address(0) ||
            wrappedNative_ == address(0)
        ) revert ZeroAddress();

        feeRecipient = feeRecipient_;
        tokenDeployer = tokenDeployer_;
        uniswapFactory = uniswapFactory_;
        positionManager = positionManager_;
        swapRouter = swapRouter_;
        wrappedNative = wrappedNative_;

        uint8 dec = IERC20Metadata(wrappedNative_).decimals();
        quoteAssets[wrappedNative_] = QuoteAsset({approved: true, usdPrice8: 1e8, decimals: dec});
        emit QuoteAssetSet(wrappedNative_, true, 1e8, dec);
    }

    // ---------------------------------------------------------------------
    // Launch
    // ---------------------------------------------------------------------

    /// @notice Deploy a token and open its market in one transaction: mint the
    ///         fixed supply once, create + initialize the Uniswap V3 pool at
    ///         the target market cap, seed it single-sided with the entire
    ///         supply, and custody the LP NFT here. No quote asset is required
    ///         up front — buyers' quote fills the pool as price moves into the
    ///         range. Trading is live on the official router immediately.
    /// @dev    The position is minted in the same transaction the pool is
    ///         initialized, so the pool price cannot move before the mint;
    ///         amount mins of 0 are therefore safe, and the deadline is the
    ///         current block by construction.
    function createToken(CreateParams calldata p)
        external
        nonReentrant
        returns (address token, address pool, uint256 positionId)
    {
        if (launchesPaused) revert LaunchesArePaused();
        if (bytes(p.name).length == 0 || bytes(p.symbol).length == 0) revert InvalidParams();

        QuoteAsset memory q = quoteAssets[p.quote];
        if (!q.approved) revert QuoteNotApproved();

        int24 tickSpacing = uniswapFactory.feeAmountTickSpacing(POOL_FEE_TIER);
        if (tickSpacing == 0) revert FeeTierNotSupported();

        uint256 mcapUsd8 = p.marketCapUsd8 == 0 ? DEFAULT_MARKET_CAP_USD8 : p.marketCapUsd8;
        if (mcapUsd8 < MIN_MARKET_CAP_USD8 || mcapUsd8 > MAX_MARKET_CAP_USD8) revert MarketCapOutOfRange();

        // The token mints its supply here and renounces ownership in its own
        // constructor — it is immutable before this function returns.
        token = tokenDeployer.deploy(msg.sender, p.name, p.symbol, p.metadataURI);
        emit TokenCreated(token, msg.sender, p.name, p.symbol, p.metadataURI, TOTAL_SUPPLY);

        bool tokenIsToken0 = token < p.quote;
        (address token0, address token1) = tokenIsToken0 ? (token, p.quote) : (p.quote, token);

        (uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper) =
            _initialPosition(tokenIsToken0, tickSpacing, mcapUsd8, q);

        // Creates the pool if absent and initializes it; token addresses are
        // fresh each launch, so a pre-existing initialized pool cannot occur.
        pool = positionManager.createAndInitializePoolIfNecessary(token0, token1, POOL_FEE_TIER, sqrtPriceX96);
        emit PoolCreated(token, p.quote, pool, POOL_FEE_TIER, sqrtPriceX96, mcapUsd8);

        IERC20(token).forceApprove(address(positionManager), TOTAL_SUPPLY);
        uint128 liquidity;
        uint256 amount0;
        uint256 amount1;
        (positionId, liquidity, amount0, amount1) = positionManager.mint(
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
        emit LiquidityAdded(token, positionId, liquidity, tokenIsToken0 ? amount0 : amount1);

        listings[token] = Listing({
            creator: msg.sender,
            quote: p.quote,
            pool: pool,
            positionId: positionId,
            createdAt: uint64(block.timestamp),
            tokenIsToken0: tokenIsToken0
        });
        allTokens.push(token);
        _tokensByCreator[msg.sender].push(token);
    }

    /// @dev Initial pool price (snapped to a tick boundary) and the token-only
    ///      range directly adjacent, so the whole supply seeds one side and
    ///      buyers' quote fills the pool from the first trade.
    ///      Price derivation: market cap in quote-wei = mcapUsd8 * 10^qDec /
    ///      quoteUsd8; per-token price (scaled 1e18) = mcapQuote * 1e18 / supply.
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

    // ---------------------------------------------------------------------
    // Fee distribution — 80% creator / 20% platform
    // ---------------------------------------------------------------------

    /// @notice Collect the pool fees accrued to a token's held position and
    ///         distribute them: 80% to the token's creator, 20% to the
    ///         platform fee recipient. Permissionless — anyone may trigger a
    ///         distribution; shares always go to the fixed parties.
    function harvestFees(address token)
        external
        nonReentrant
        returns (uint256 creatorToken, uint256 creatorQuote, uint256 platformToken, uint256 platformQuote)
    {
        Listing memory l = listings[token];
        if (l.pool == address(0)) revert UnknownToken();

        (uint256 amount0, uint256 amount1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: l.positionId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        (uint256 tokenAmount, uint256 quoteAmount) = l.tokenIsToken0 ? (amount0, amount1) : (amount1, amount0);
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

    /// @notice Harvest a token's held position: internally decreases all
    ///         remaining liquidity, collects every underlying asset, and
    ///         transfers the proceeds to the factory owner. Owner only.
    function collectFees(address token)
        external
        onlyOwner
        nonReentrant
        returns (uint256 tokenAmount, uint256 quoteAmount)
    {
        Listing memory l = listings[token];
        if (l.pool == address(0)) revert UnknownToken();

        (, , , , , , , uint128 liquidity, , , , ) = positionManager.positions(l.positionId);
        if (liquidity > 0) {
            positionManager.decreaseLiquidity(
                INonfungiblePositionManager.DecreaseLiquidityParams({
                    tokenId: l.positionId,
                    liquidity: liquidity,
                    amount0Min: 0,
                    amount1Min: 0,
                    deadline: block.timestamp
                })
            );
        }

        (uint256 amount0, uint256 amount1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: l.positionId,
                recipient: owner(),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        (tokenAmount, quoteAmount) = l.tokenIsToken0 ? (amount0, amount1) : (amount1, amount0);
        if (tokenAmount == 0 && quoteAmount == 0) revert NothingToCollect();

        emit LiquidityCollected(token, liquidity, tokenAmount, quoteAmount, owner());
    }

    // ---------------------------------------------------------------------
    // Owner: configuration
    // ---------------------------------------------------------------------

    /// @notice Approve or update a quote asset (stablecoins, approved ERC20s).
    ///         The wrapped native is approved at construction.
    /// @param usdPrice8 USD per whole quote token, 8 decimals; must be > 0
    ///        when approving.
    function setQuoteAsset(address quote, bool approved, uint64 usdPrice8) external onlyOwner {
        if (quote == address(0)) revert ZeroAddress();
        if (approved && usdPrice8 == 0) revert InvalidParams();
        uint8 dec = IERC20Metadata(quote).decimals();
        quoteAssets[quote] = QuoteAsset({approved: approved, usdPrice8: usdPrice8, decimals: dec});
        emit QuoteAssetSet(quote, approved, usdPrice8, dec);
    }

    /// @notice Update the platform fee recipient.
    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        emit FeeRecipientUpdated(feeRecipient, newRecipient);
        feeRecipient = newRecipient;
    }

    /// @notice Pause new launches. Existing markets keep trading on Uniswap.
    function pause() external onlyOwner {
        if (launchesPaused) revert InvalidParams();
        launchesPaused = true;
        emit FactoryPaused(msg.sender);
    }

    /// @notice Resume new launches.
    function resume() external onlyOwner {
        if (!launchesPaused) revert NotPaused();
        launchesPaused = false;
        emit FactoryResumed(msg.sender);
    }

    /// @notice Recover ERC20 tokens sent here by mistake. The factory never
    ///         holds ERC20 balances between transactions by design.
    function recoverERC20(address asset, uint256 amount) external onlyOwner {
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidParams();
        IERC20(asset).safeTransfer(owner(), amount);
        emit EmergencyRecovered(asset, amount, owner());
    }

    /// @notice Recover native currency sent here by mistake.
    function recoverNative() external onlyOwner {
        uint256 amount = address(this).balance;
        if (amount == 0) revert InvalidParams();
        (bool ok, ) = owner().call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
        emit EmergencyRecovered(address(0), amount, owner());
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Number of tokens launched by this factory.
    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }

    /// @notice All tokens launched by `creator`.
    function tokensOf(address creator) external view returns (address[] memory) {
        return _tokensByCreator[creator];
    }

    /// @notice The V3 position id backing `token`.
    function positionOf(address token) external view returns (uint256) {
        Listing memory l = listings[token];
        if (l.pool == address(0)) revert UnknownToken();
        return l.positionId;
    }

    /// @notice Pool and held-position snapshot for a token.
    function poolInfo(address token)
        external
        view
        returns (
            address pool,
            address quote,
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
        quote = l.quote;
        (sqrtPriceX96, tick, , , , , ) = IUniswapV3Pool(l.pool).slot0();
        poolLiquidity = IUniswapV3Pool(l.pool).liquidity();
        positionId = l.positionId;
        (, , , , , , , positionLiquidity, , , , ) = positionManager.positions(l.positionId);
    }

    /// @notice Market cap of `token` in quote-asset wei, from the live pool price.
    function marketCapQuote(address token) public view returns (uint256) {
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
        Listing memory l = listings[token];
        QuoteAsset memory q = quoteAssets[l.quote];
        return Math.mulDiv(marketCapQuote(token), q.usdPrice8, 10 ** q.decimals);
    }

    /// @dev ERC-721 receiver so the position manager can mint positions here.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    /// @dev Accepts native currency only so mistaken sends are recoverable.
    receive() external payable {}
}
