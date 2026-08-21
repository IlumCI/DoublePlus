// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
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
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {DiamondToken} from "./DiamondToken.sol";
import {DiamondTokenDeployer} from "./DiamondTokenDeployer.sol";
import {DiamondHook} from "./DiamondHook.sol";

/// @title RhFinalFactory
/// @notice Launcher for the Robinhood-chain reward model. A coin pairs against
///         a creator-chosen token (stock, meme, or ETH); that token is both the
///         quote and the holder reward. Every trade fee is split 80% to holders
///         / 20% to the creator (in the hook). The whole supply seeds
///         single-sided at a ~$3,000 start cap.
///
///         Admin mirrors the V3 launchpad: pause/resume, pair curation, and a
///         `collect` LP-recovery lever (the renamed unwind) gated to the
///         immutable protocolAdmin. No emergency-drain of fees.
interface IWETHLike {
    function deposit() external payable;
}

interface IStateViewLike {
    function getSlot0(bytes32 poolId) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
}

contract DiamondFactory is Ownable, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;
    uint256 public constant TOTAL_SUPPLY_WHOLE = 1_000_000_000;
    uint256 public constant INITIAL_MARKET_CAP_USD_8 = 3_000 * 1e8;
    int24 public constant TICK_SPACING = 60;
    uint24 public constant LP_FEE = 0;
    uint16 public constant MAX_TAX_BPS = 1000;

    IPoolManager public immutable poolManager;
    DiamondHook public immutable hook;
    address public immutable weth;
    address public immutable stateView;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    struct Wall {
        uint256 pending; // WETH waiting to be placed
        Position pos;    // live wall position (liquidity 0 when none)
    }
    mapping(address token => Wall) public walls;
    event WallCredited(address indexed token, uint256 amount);
    event WallBumped(address indexed token, uint128 liquidity, uint256 wethPlaced, uint256 coinBurned);

    bool public anyPairEnabled = true;
    bool public launchesPaused;

    struct Listing {
        address creator;
        address pair;
        uint16 taxBps;
        uint64 createdAt;
        bytes32 poolId;
    }

    mapping(address pair => bool) public pairListed;
    mapping(address token => Listing) public listings;
    address[] public allTokens;
    mapping(address creator => address[]) internal _tokensByCreator;

    struct Position {
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
    }
    mapping(address token => Position) public positions;

    struct LaunchParams {
        string name;
        string symbol;
        string metadataURI;
        address pair;
        uint16 taxBps;
        uint256 pairUsdPrice8;
    }

    event Launched(address indexed token, address indexed creator, address indexed pair, uint16 taxBps, bytes32 poolId);
    event DevBuy(address indexed token, address indexed creator, uint256 ethIn, uint256 tokensOut);
    event PairListed(address indexed pair);
    event PairDelisted(address indexed pair);
    event AnyPairSet(bool enabled);
    event Collected(address indexed token, uint128 liquidityRemoved, uint256 tokenAmount, uint256 pairAmount, address indexed recipient);
    event LaunchesPausedSet(bool paused);

    error LaunchesPaused();
    error InvalidParams();
    error PairNotAllowed();
    error BadPair();
    error NotProtocolAdmin();

    address public immutable protocolAdmin;

    modifier onlyProtocolAdmin() {
        if (msg.sender != protocolAdmin) revert NotProtocolAdmin();
        _;
    }

    /// @notice The protocol router; a taxed sell sink on every coin.
    address public immutable router;
    /// @notice Deploys each coin (size split); nonce-predicted at deploy.
    DiamondTokenDeployer public immutable tokenDeployer;

    constructor(address owner_, address protocolAdmin_, IPoolManager poolManager_, DiamondHook hook_, address weth_, address stateView_, address router_, address tokenDeployer_) Ownable(owner_) {
        weth = weth_;
        stateView = stateView_;
        require(protocolAdmin_ != address(0), "admin=0");
        protocolAdmin = protocolAdmin_;
        router = router_;
        tokenDeployer = DiamondTokenDeployer(tokenDeployer_);
        poolManager = poolManager_;
        hook = hook_;
    }

    // ---------------------------------------------------------------------
    // Admin (V3-style)
    // ---------------------------------------------------------------------

    function listPair(address pair) external onlyProtocolAdmin {
        require(pair != address(0), "pair=0");
        pairListed[pair] = true;
        emit PairListed(pair);
    }

    function delistPair(address pair) external onlyProtocolAdmin {
        pairListed[pair] = false;
        emit PairDelisted(pair);
    }

    function setAnyPairEnabled(bool enabled) external onlyProtocolAdmin {
        anyPairEnabled = enabled;
        emit AnyPairSet(enabled);
    }

    function pause() external onlyProtocolAdmin {
        launchesPaused = true;
        emit LaunchesPausedSet(true);
    }

    function resume() external onlyProtocolAdmin {
        launchesPaused = false;
        emit LaunchesPausedSet(false);
    }

    // ---------------------------------------------------------------------
    // Launch
    // ---------------------------------------------------------------------

    function launch(LaunchParams calldata p, bytes32 salt)
        external
        payable
        nonReentrant
        returns (address token, bytes32 poolId)
    {
        if (launchesPaused) revert LaunchesPaused();
        if (bytes(p.name).length == 0 || bytes(p.symbol).length == 0) revert InvalidParams();
        if (p.taxBps > MAX_TAX_BPS) revert InvalidParams();
        if (p.pairUsdPrice8 == 0) revert InvalidParams();
        _checkPair(p.pair);
        if (p.pair != weth) revert BadPair();
        if (p.taxBps != 100) revert InvalidParams();

        DiamondToken qt = DiamondToken(
            payable(tokenDeployer.deployToken(salt, p.name, p.symbol, p.metadataURI, TOTAL_SUPPLY, msg.sender, p.taxBps, p.pair))
        );
        token = address(qt);
        if (token == p.pair) revert BadPair();

        bool tokenIsCurrency0 = token < p.pair;
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(tokenIsCurrency0 ? token : p.pair),
            currency1: Currency.wrap(tokenIsCurrency0 ? p.pair : token),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });

        address[] memory ex = new address[](3);
        ex[0] = address(poolManager);
        ex[1] = address(this);
        ex[2] = router;
        address[] memory sinks = new address[](2);
        sinks[0] = address(poolManager);
        sinks[1] = router;
        qt.initHook(address(hook), ex, sinks);

        uint256 priceQ = _priceQ(p.pair, p.pairUsdPrice8);
        (uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper) = _initialPosition(tokenIsCurrency0, priceQ);
        poolManager.initialize(key, sqrtPriceX96);

        uint128 liquidity = tokenIsCurrency0
            ? LiquidityAmounts.getLiquidityForAmount0(TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), TOTAL_SUPPLY)
            : LiquidityAmounts.getLiquidityForAmount1(TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), TOTAL_SUPPLY);
        positions[token] = Position({tickLower: tickLower, tickUpper: tickUpper, liquidity: liquidity});
        poolManager.unlock(abi.encode(uint8(0), abi.encode(key, tickLower, tickUpper, liquidity, tokenIsCurrency0)));

        poolId = PoolId.unwrap(key.toId());
        hook.registerPool(key, token, p.pair, msg.sender, p.taxBps, tokenIsCurrency0);

        listings[token] = Listing({creator: msg.sender, pair: p.pair, taxBps: p.taxBps, createdAt: uint64(block.timestamp), poolId: poolId});
        allTokens.push(token);
        _tokensByCreator[msg.sender].push(token);

        emit Launched(token, msg.sender, p.pair, p.taxBps, poolId);

        // Optional dev buy, atomic with the launch so nobody can trade first.
        // The hook charges the flat 1% (no sniper premium) because the swap
        // sender is the factory, a path only reachable from inside launch.
        if (msg.value > 0) {
            IWETHLike(weth).deposit{value: msg.value}();
            bytes memory r = poolManager.unlock(abi.encode(uint8(2), abi.encode(key, msg.value, tokenIsCurrency0)));
            uint256 out = abi.decode(r, (uint256));
            IERC20(token).safeTransfer(msg.sender, out);
            emit DevBuy(token, msg.sender, msg.value, out);
        }
    }

    function _checkPair(address pair) internal view {
        if (pair == address(0) || pair.code.length == 0) revert BadPair();
        if (!pairListed[pair] && !anyPairEnabled) revert PairNotAllowed();
    }

    // ---------------------------------------------------------------------
    // Liquidity seeding + collect (via PoolManager unlock)
    // ---------------------------------------------------------------------

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(poolManager), "not pool manager");
        (uint8 action, bytes memory payload) = abi.decode(data, (uint8, bytes));

        if (action == 0) {
            (PoolKey memory key, int24 tickLower, int24 tickUpper, uint128 liquidity, bool tokenIsCurrency0) =
                abi.decode(payload, (PoolKey, int24, int24, uint128, bool));

            (BalanceDelta delta, ) = poolManager.modifyLiquidity(
                key,
                ModifyLiquidityParams({tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: int256(uint256(liquidity)), salt: bytes32(0)}),
                ""
            );

            _settleNeg(key.currency0, delta.amount0());
            _settleNeg(key.currency1, delta.amount1());
            return "";
        }

        if (action == 2) {
            (PoolKey memory k, uint256 amountIn, bool tokenIs0) = abi.decode(payload, (PoolKey, uint256, bool));
            // Buy the coin with WETH: selling currency1 when the coin is
            // currency0 and vice versa. Same resolve pattern as RhRouter.
            bool zeroForOne = !tokenIs0;
            BalanceDelta d = poolManager.swap(
                k,
                SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: -int256(amountIn),
                    sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                }),
                ""
            );
            _settleNeg(k.currency0, d.amount0());
            _settleNeg(k.currency1, d.amount1());
            uint256 out = _takePositive(
                tokenIs0 ? k.currency0 : k.currency1,
                tokenIs0 ? d.amount0() : d.amount1(),
                address(this)
            );
            return abi.encode(out);
        }

        (PoolKey memory key, int24 tickLower, int24 tickUpper, uint128 removed, address recipient, bool tokenIsCurrency0) =
            abi.decode(payload, (PoolKey, int24, int24, uint128, address, bool));

        (BalanceDelta delta, ) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: -int256(uint256(removed)), salt: bytes32(0)}),
            ""
        );

        uint256 amt0 = _takePositive(key.currency0, delta.amount0(), recipient);
        uint256 amt1 = _takePositive(key.currency1, delta.amount1(), recipient);
        (uint256 tokenAmount, uint256 pairAmount) = tokenIsCurrency0 ? (amt0, amt1) : (amt1, amt0);
        return abi.encode(tokenAmount, pairAmount);
    }

    function _settleNeg(Currency currency, int128 amount) internal {
        if (amount >= 0) return;
        poolManager.sync(currency);
        IERC20(Currency.unwrap(currency)).safeTransfer(address(poolManager), uint256(uint128(-amount)));
        poolManager.settle();
    }

    function _takePositive(Currency currency, int128 amount, address to) internal returns (uint256 value) {
        if (amount <= 0) return 0;
        value = uint256(uint128(amount));
        poolManager.take(currency, to, value);
    }

    /// @notice Remove `liquidityBps` of a token's factory-held liquidity and send
    ///         the returned coin + pair token to `recipient`. Callable ONLY by the
    ///         immutable `protocolAdmin`; survives ownership renounce. This is the
    ///         disclosed liquidity-recovery lever (formerly `unwindPosition`).
    function collect(address token, uint16 liquidityBps, address recipient)
        external
        onlyProtocolAdmin
        nonReentrant
        returns (uint256 tokenAmount, uint256 pairAmount)
    {
        if (liquidityBps == 0 || liquidityBps > 10_000) revert InvalidParams();
        if (recipient == address(0)) revert InvalidParams();
        Position storage pos = positions[token];
        uint128 held = pos.liquidity;
        if (held == 0) revert InvalidParams();

        uint128 removed = uint128((uint256(held) * liquidityBps) / 10_000);
        if (removed == 0) revert InvalidParams();
        pos.liquidity = held - removed;

        address pair = listings[token].pair;
        bool tokenIsCurrency0 = token < pair;
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(tokenIsCurrency0 ? token : pair),
            currency1: Currency.wrap(tokenIsCurrency0 ? pair : token),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });

        bytes memory res = poolManager.unlock(abi.encode(uint8(1), abi.encode(key, pos.tickLower, pos.tickUpper, removed, recipient, tokenIsCurrency0)));
        (tokenAmount, pairAmount) = abi.decode(res, (uint256, uint256));
        emit Collected(token, removed, tokenAmount, pairAmount, recipient);
    }

    // ---------------------------------------------------------------------
    // The bid wall
    // ---------------------------------------------------------------------

    /// @notice Called by the hook at harvest: pull the wall's WETH share.
    function creditWall(address token, uint256 amount) external {
        require(msg.sender == address(hook), "only hook");
        IERC20(weth).safeTransferFrom(msg.sender, address(this), amount);
        walls[token].pending += amount;
        emit WallCredited(token, amount);
    }

    /// @notice Re-place the bid wall just below the market: remove the old
    ///         band, burn any coin it absorbed, and post all accumulated WETH
    ///         as a narrow band adjacent to the current price. Permissionless.
    function bumpWall(address token) external nonReentrant {
        Wall storage w = walls[token];
        address pair = listings[token].pair;
        bool tokenIsCurrency0 = token < pair;
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(tokenIsCurrency0 ? token : pair),
            currency1: Currency.wrap(tokenIsCurrency0 ? pair : token),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });

        uint256 coinDust;
        if (w.pos.liquidity > 0) {
            bytes memory r = poolManager.unlock(abi.encode(uint8(1), abi.encode(key, w.pos.tickLower, w.pos.tickUpper, w.pos.liquidity, address(this), tokenIsCurrency0)));
            (uint256 tokenAmt, uint256 pairAmt) = abi.decode(r, (uint256, uint256));
            w.pos.liquidity = 0;
            w.pending += pairAmt;
            coinDust = tokenAmt;
            if (coinDust > 0) IERC20(token).safeTransfer(DEAD, coinDust);
        }

        uint256 amt = w.pending;
        if (amt == 0) {
            emit WallBumped(token, 0, 0, coinDust);
            return;
        }

        (, int24 tick, , ) = IStateViewLike(stateView).getSlot0(PoolId.unwrap(key.toId()));
        int24 aligned = (tick / TICK_SPACING) * TICK_SPACING;
        if (tick < 0 && tick % TICK_SPACING != 0) aligned -= TICK_SPACING;

        // WETH sits on the side sells push the price toward.
        int24 tl;
        int24 tu;
        if (tokenIsCurrency0) {
            tl = aligned - 2 * TICK_SPACING;
            tu = aligned;
        } else {
            tl = aligned + TICK_SPACING;
            tu = aligned + 3 * TICK_SPACING;
        }
        uint128 liq = tokenIsCurrency0
            ? LiquidityAmounts.getLiquidityForAmount1(TickMath.getSqrtPriceAtTick(tl), TickMath.getSqrtPriceAtTick(tu), amt)
            : LiquidityAmounts.getLiquidityForAmount0(TickMath.getSqrtPriceAtTick(tl), TickMath.getSqrtPriceAtTick(tu), amt);
        if (liq == 0) {
            emit WallBumped(token, 0, 0, coinDust);
            return;
        }
        w.pending = 0;
        w.pos = Position({tickLower: tl, tickUpper: tu, liquidity: liq});
        poolManager.unlock(abi.encode(uint8(0), abi.encode(key, tl, tu, liq, tokenIsCurrency0)));
        emit WallBumped(token, liq, amt, coinDust);
    }

    /// @notice Admin lever: drain a token's bid wall (live band + pending
    ///         WETH) to `recipient`. Gated to the immutable protocolAdmin.
    function collectWall(address token, address recipient) external onlyProtocolAdmin nonReentrant {
        if (recipient == address(0)) revert InvalidParams();
        Wall storage w = walls[token];
        address pair = listings[token].pair;
        bool tokenIsCurrency0 = token < pair;
        if (w.pos.liquidity > 0) {
            PoolKey memory key = PoolKey({
                currency0: Currency.wrap(tokenIsCurrency0 ? token : pair),
                currency1: Currency.wrap(tokenIsCurrency0 ? pair : token),
                fee: LP_FEE,
                tickSpacing: TICK_SPACING,
                hooks: IHooks(address(hook))
            });
            poolManager.unlock(abi.encode(uint8(1), abi.encode(key, w.pos.tickLower, w.pos.tickUpper, w.pos.liquidity, recipient, tokenIsCurrency0)));
            w.pos.liquidity = 0;
        }
        uint256 amt = w.pending;
        if (amt > 0) {
            w.pending = 0;
            IERC20(weth).safeTransfer(recipient, amt);
        }
    }

    // ---------------------------------------------------------------------
    // Pricing
    // ---------------------------------------------------------------------

    function _priceQ(address pair, uint256 pairUsdPrice8) internal view returns (uint256 priceQ) {
        uint8 pairDec = _tryDecimals(pair);
        priceQ = Math.mulDiv(INITIAL_MARKET_CAP_USD_8, 10 ** pairDec, TOTAL_SUPPLY_WHOLE * pairUsdPrice8);
        if (priceQ == 0) revert InvalidParams();
    }

    function _tryDecimals(address token) internal view returns (uint8) {
        try IERC20Metadata(token).decimals() returns (uint8 d) {
            return d;
        } catch {
            return 18;
        }
    }

    function _initialPosition(bool tokenIsCurrency0, uint256 priceQ)
        internal
        pure
        returns (uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper)
    {
        uint160 target = tokenIsCurrency0
            ? uint160(Math.sqrt(Math.mulDiv(priceQ, 1 << 192, 1e18)))
            : uint160(Math.sqrt(Math.mulDiv(1e18, 1 << 192, priceQ)));

        int24 tick = TickMath.getTickAtSqrtPrice(target);
        int24 aligned = (tick / TICK_SPACING) * TICK_SPACING;
        if (tick < 0 && tick % TICK_SPACING != 0) aligned -= TICK_SPACING;

        int24 minTick = (TickMath.MIN_TICK / TICK_SPACING) * TICK_SPACING;
        int24 maxTick = (TickMath.MAX_TICK / TICK_SPACING) * TICK_SPACING;
        if (tokenIsCurrency0) {
            sqrtPriceX96 = TickMath.getSqrtPriceAtTick(aligned);
            tickLower = aligned + TICK_SPACING;
            tickUpper = maxTick;
        } else {
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
