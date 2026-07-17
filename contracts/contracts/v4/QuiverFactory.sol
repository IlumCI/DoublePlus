// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {QuiverToken} from "./QuiverToken.sol";
import {QuiverHook} from "./QuiverHook.sol";

/// @title QuiverFactory
/// @notice One-transaction launcher for the Quiver V4 launchpad. It mints a
///         fixed-supply token, opens a native/token Uniswap V4 pool bound to
///         the Quiver hook, and seeds the entire supply as single-sided
///         liquidity at a fixed $5,000 starting market cap. Holders of the new
///         token then earn a chosen tokenized stock from the trading tax; the
///         creator earns a claimable native share; part of every trade buys
///         back and burns the token; the rest funds the protocol.
contract QuiverFactory is Ownable, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether; // 1e27
    uint256 public constant INITIAL_MARKET_CAP_USD_8 = 5_000 * 1e8; // $5,000, 8dp
    int24 public constant TICK_SPACING = 60;
    uint24 public constant LP_FEE = 0; // the hook tax is the only fee
    uint16 public constant MAX_TAX_BPS = 1000; // 10%

    IPoolManager public immutable poolManager;
    QuiverHook public immutable hook;
    /// @notice WETH the launched tokens pair against (Robinhood Chain convention).
    address public immutable weth;

    /// @notice Native/USD price, 8 decimals, used to size the initial pool.
    uint256 public nativeUsdPrice8;
    bool public launchesPaused;

    struct Listing {
        address creator;
        address stock;
        uint16 taxBps;
        uint64 createdAt;
        bytes32 poolId;
    }

    /// @notice Stock tokens eligible as holder rewards, mapped to the USDG pool
    ///         the hook buys them through. Curated by the protocol admin.
    mapping(address stock => PoolKey) internal _stockPool;
    mapping(address stock => bool) public stockListed;

    mapping(address token => Listing) public listings;
    address[] public allTokens;
    mapping(address creator => address[]) internal _tokensByCreator;

    struct Position {
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity; // remaining factory-held liquidity (decremented on unwind)
    }
    /// @notice The seeded LP position the factory holds for each token. Kept so
    ///         the owner can unwind it later (see `unwindPosition`).
    mapping(address token => Position) public positions;

    struct LaunchParams {
        string name;
        string symbol;
        string metadataURI;
        address stock; // reward stock (must be listed)
        uint16 taxBps; // 0..1000
    }

    event Launched(
        address indexed token,
        address indexed creator,
        address indexed stock,
        uint16 taxBps,
        bytes32 poolId
    );
    event StockListed(address indexed stock);
    event StockDelisted(address indexed stock);
    event PositionUnwound(
        address indexed token,
        uint128 liquidityRemoved,
        uint256 tokenAmount,
        uint256 wethAmount,
        address indexed recipient
    );
    event NativeUsdPriceSet(uint256 price8);
    event LaunchesPausedSet(bool paused);

    error LaunchesPaused();
    error InvalidParams();
    error StockNotListed();
    error BadVanity();

    constructor(
        address admin_,
        IPoolManager poolManager_,
        QuiverHook hook_,
        address weth_,
        uint256 nativeUsdPrice8_
    ) Ownable(admin_) {
        require(nativeUsdPrice8_ > 0, "price=0");
        require(weth_ != address(0), "weth=0");
        poolManager = poolManager_;
        hook = hook_;
        weth = weth_;
        nativeUsdPrice8 = nativeUsdPrice8_;
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function listStock(address stock, PoolKey calldata usdgStockPool) external onlyOwner {
        require(stock != address(0), "stock=0");
        _stockPool[stock] = usdgStockPool;
        stockListed[stock] = true;
        emit StockListed(stock);
    }

    function delistStock(address stock) external onlyOwner {
        stockListed[stock] = false;
        emit StockDelisted(stock);
    }

    function stockPool(address stock) external view returns (PoolKey memory) {
        return _stockPool[stock];
    }

    function setNativeUsdPrice(uint256 price8) external onlyOwner {
        require(price8 > 0, "price=0");
        nativeUsdPrice8 = price8;
        emit NativeUsdPriceSet(price8);
    }

    function setLaunchesPaused(bool paused) external onlyOwner {
        launchesPaused = paused;
        emit LaunchesPausedSet(paused);
    }

    /// @notice Graduation: lift (or restore) a token's anti-whale caps.
    function setTokenLimits(address token, bool active) external onlyOwner {
        QuiverToken(payable(token)).setLimitsActive(active);
    }

    // ---------------------------------------------------------------------
    // Launch
    // ---------------------------------------------------------------------

    /// @param salt CREATE2 salt, mined off-chain so the token address ends in
    ///        0x4663. Deterministic from the launch params + this factory.
    function launch(LaunchParams calldata p, bytes32 salt)
        external
        nonReentrant
        returns (address token, bytes32 poolId)
    {
        if (launchesPaused) revert LaunchesPaused();
        if (bytes(p.name).length == 0 || bytes(p.symbol).length == 0) revert InvalidParams();
        if (p.taxBps > MAX_TAX_BPS) revert InvalidParams();
        if (!stockListed[p.stock]) revert StockNotListed();

        // 1. Mint the token via CREATE2 so its address carries the 4663 vanity.
        //    The factory holds the whole supply to seed with.
        QuiverToken qt = new QuiverToken{salt: salt}(
            p.name,
            p.symbol,
            p.metadataURI,
            TOTAL_SUPPLY,
            msg.sender,
            address(this),
            p.taxBps,
            p.stock
        );
        token = address(qt);
        if (uint160(token) & 0xffff != 0x4663) revert BadVanity();

        // 2. Pair with WETH; currencies sort by address.
        bool tokenIsCurrency0 = token < weth;
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(tokenIsCurrency0 ? token : weth),
            currency1: Currency.wrap(tokenIsCurrency0 ? weth : token),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });

        // 3. Exclude the pool endpoints from dividends and caps, wire the hook.
        address[] memory ex = new address[](2);
        ex[0] = address(poolManager);
        ex[1] = address(this);
        qt.initHook(address(hook), ex);

        // 4. Price the pool at the $5,000 start cap and seed the full supply
        //    single-sided (token only) in the range adjacent to spot.
        (uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper) = _initialPosition(tokenIsCurrency0);
        poolManager.initialize(key, sqrtPriceX96);

        uint128 liquidity = tokenIsCurrency0
            ? LiquidityAmounts.getLiquidityForAmount0(
                TickMath.getSqrtPriceAtTick(tickLower),
                TickMath.getSqrtPriceAtTick(tickUpper),
                TOTAL_SUPPLY
            )
            : LiquidityAmounts.getLiquidityForAmount1(
                TickMath.getSqrtPriceAtTick(tickLower),
                TickMath.getSqrtPriceAtTick(tickUpper),
                TOTAL_SUPPLY
            );
        positions[token] = Position({tickLower: tickLower, tickUpper: tickUpper, liquidity: liquidity});
        poolManager.unlock(abi.encode(uint8(0), abi.encode(key, tickLower, tickUpper, liquidity, tokenIsCurrency0)));

        // 5. Register the pool with the hook so trades are taxed and rewarded.
        poolId = PoolId.unwrap(key.toId());
        hook.registerPool(key, token, p.stock, msg.sender, p.taxBps, tokenIsCurrency0, _stockPool[p.stock]);

        listings[token] = Listing({
            creator: msg.sender,
            stock: p.stock,
            taxBps: p.taxBps,
            createdAt: uint64(block.timestamp),
            poolId: poolId
        });
        allTokens.push(token);
        _tokensByCreator[msg.sender].push(token);

        emit Launched(token, msg.sender, p.stock, p.taxBps, poolId);
    }

    // ---------------------------------------------------------------------
    // Liquidity seeding (via the PoolManager unlock)
    // ---------------------------------------------------------------------

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(poolManager), "not pool manager");
        (uint8 action, bytes memory payload) = abi.decode(data, (uint8, bytes));

        // action 0 = seed the launch liquidity (single-sided token deposit).
        if (action == 0) {
            (PoolKey memory key, int24 tickLower, int24 tickUpper, uint128 liquidity, bool tokenIsCurrency0) =
                abi.decode(payload, (PoolKey, int24, int24, uint128, bool));

            (BalanceDelta delta, ) = poolManager.modifyLiquidity(
                key,
                ModifyLiquidityParams({
                    tickLower: tickLower,
                    tickUpper: tickUpper,
                    liquidityDelta: int256(uint256(liquidity)),
                    salt: bytes32(0)
                }),
                ""
            );

            // Single-sided token position: only the token side should be owed;
            // the WETH side must net to zero (we deposit no WETH).
            int128 tokenOwed = tokenIsCurrency0 ? delta.amount0() : delta.amount1();
            int128 wethOwed = tokenIsCurrency0 ? delta.amount1() : delta.amount0();
            require(wethOwed >= 0, "weth owed");
            if (tokenOwed < 0) {
                Currency tokenCurrency = tokenIsCurrency0 ? key.currency0 : key.currency1;
                uint256 amt = uint256(uint128(-tokenOwed));
                poolManager.sync(tokenCurrency);
                IERC20(Currency.unwrap(tokenCurrency)).safeTransfer(address(poolManager), amt);
                poolManager.settle();
            }
            return "";
        }

        // action 1 = unwind: remove `removed` liquidity and send everything the
        // position returns (token + WETH, incl. any accrued fees) to recipient.
        (
            PoolKey memory key,
            int24 tickLower,
            int24 tickUpper,
            uint128 removed,
            address recipient,
            bool tokenIsCurrency0
        ) = abi.decode(payload, (PoolKey, int24, int24, uint128, address, bool));

        (BalanceDelta delta, ) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: -int256(uint256(removed)),
                salt: bytes32(0)
            }),
            ""
        );

        uint256 amt0 = _takePositive(key.currency0, delta.amount0(), recipient);
        uint256 amt1 = _takePositive(key.currency1, delta.amount1(), recipient);
        (uint256 tokenAmount, uint256 wethAmount) = tokenIsCurrency0 ? (amt0, amt1) : (amt1, amt0);
        return abi.encode(tokenAmount, wethAmount);
    }

    /// @dev Take a positive balance-delta amount for `currency` straight to `to`.
    function _takePositive(Currency currency, int128 amount, address to) internal returns (uint256 value) {
        if (amount <= 0) return 0;
        value = uint256(uint128(amount));
        poolManager.take(currency, to, value);
    }

    // ---------------------------------------------------------------------
    // Liquidity unwind (owner)
    // ---------------------------------------------------------------------

    /// @notice Remove `liquidityBps` of a token's factory-held liquidity and send
    ///         the returned token + WETH to `recipient`. Owner only.
    /// @dev This is a deliberate, disclosed admin power: it lets the owner pull
    ///      pooled liquidity, so the "locked liquidity" guarantee does NOT apply
    ///      to markets launched by a factory that exposes it.
    /// @dev If the token's anti-whale limits are still active, `recipient` must be
    ///      able to hold the returned token amount, or the max-wallet cap will
    ///      revert the transfer. Lift the token's limits first (`setTokenLimits`)
    ///      when unwinding a large position to a normal wallet.
    function unwindPosition(address token, uint16 liquidityBps, address recipient)
        external
        onlyOwner
        nonReentrant
        returns (uint256 tokenAmount, uint256 wethAmount)
    {
        if (liquidityBps == 0 || liquidityBps > 10_000) revert InvalidParams();
        if (recipient == address(0)) revert InvalidParams();
        Position storage pos = positions[token];
        uint128 held = pos.liquidity;
        if (held == 0) revert InvalidParams();

        uint128 removed = uint128((uint256(held) * liquidityBps) / 10_000);
        if (removed == 0) revert InvalidParams();
        pos.liquidity = held - removed;

        bool tokenIsCurrency0 = token < weth;
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(tokenIsCurrency0 ? token : weth),
            currency1: Currency.wrap(tokenIsCurrency0 ? weth : token),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });

        bytes memory res = poolManager.unlock(
            abi.encode(uint8(1), abi.encode(key, pos.tickLower, pos.tickUpper, removed, recipient, tokenIsCurrency0))
        );
        (tokenAmount, wethAmount) = abi.decode(res, (uint256, uint256));
        emit PositionUnwound(token, removed, tokenAmount, wethAmount, recipient);
    }

    // ---------------------------------------------------------------------
    // Pricing
    // ---------------------------------------------------------------------

    /// @dev Initial pool price snapped to a tick, plus the token-only range
    ///      directly below it, so the whole supply seeds one side. Native is
    ///      currency0 and the token is currency1, mirroring the v3 launchpad.
    function _initialPosition(bool tokenIsCurrency0)
        internal
        view
        returns (uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper)
    {
        uint256 mcapWei = Math.mulDiv(INITIAL_MARKET_CAP_USD_8, 1e18, nativeUsdPrice8);
        uint256 priceWei = Math.mulDiv(mcapWei, 1e18, TOTAL_SUPPLY); // WETH per token
        if (priceWei == 0) revert InvalidParams();

        // sqrtPrice = sqrt(price(token1/token0)) * 2^96.
        uint160 target = tokenIsCurrency0
            ? uint160(Math.sqrt(Math.mulDiv(priceWei, 1 << 192, 1e18)))
            : uint160(Math.sqrt(Math.mulDiv(1e18, 1 << 192, priceWei)));

        int24 tick = TickMath.getTickAtSqrtPrice(target);
        int24 aligned = (tick / TICK_SPACING) * TICK_SPACING;
        if (tick < 0 && tick % TICK_SPACING != 0) aligned -= TICK_SPACING;

        int24 minTick = (TickMath.MIN_TICK / TICK_SPACING) * TICK_SPACING;
        int24 maxTick = (TickMath.MAX_TICK / TICK_SPACING) * TICK_SPACING;
        if (tokenIsCurrency0) {
            // Token is currency0: seed the range above spot (token-only).
            sqrtPriceX96 = TickMath.getSqrtPriceAtTick(aligned);
            tickLower = aligned + TICK_SPACING;
            tickUpper = maxTick;
        } else {
            // Token is currency1: seed the range below spot (token-only).
            sqrtPriceX96 = TickMath.getSqrtPriceAtTick(aligned + TICK_SPACING);
            tickLower = minTick;
            tickUpper = aligned + TICK_SPACING;
        }
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function totalTokens() external view returns (uint256) {
        return allTokens.length;
    }

    function tokensByCreator(address creator) external view returns (address[] memory) {
        return _tokensByCreator[creator];
    }
}
