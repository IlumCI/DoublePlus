// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {LaunchFeesV3 as LaunchFees} from "./LaunchFeesV3.sol";

/// @title StockFeeHookV3
/// @notice Base-chain fee engine forked from the deployed AdvancedFeeHook.
///         Each pool carries its own config: a trade `taxBps` skimmed in
///         `afterSwap`, of which the platform takes half (capped at 1% of
///         volume). The rest is the creator share, split three ways:
///
///           - `burnBps`  : burned. If the fee lands in the coin it is sent
///             straight to dEaD; if it lands in the pair token it market-buys
///             the coin and burns what it gets (buyback-and-burn).
///           - `liquidityBps` : added back as single-sided liquidity in a band
///             beside the current price.
///           - remainder  : paid pro-rata to up to 8 configurable `Payee`
///             slots (revenue share; slots are transferable by their holder).
///
///         The fee is taken from whichever currency the swap leaves
///         unspecified, so the pool token can be ETH or any stock/wrapped
///         token — every pair works the same way. `launcher` (the factory)
///         is the only address that can configure a pool; `platformAdmin`
///         curates payees afterward.
contract StockFeeHookV3 is IHooks {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using SafeCast for uint256;

    uint256 private constant BPS = 10_000;
    uint256 public constant MAX_PAYEES = 8;
    uint256 public constant PAYOUT_GAS = 100_000;
    int24 internal constant LP_WIDTH = 10;
    address internal constant BURN = 0x000000000000000000000000000000000000dEaD;

    struct Payee {
        address to;
        uint16 shareBps;
    }

    struct Config {
        uint16 taxBps;
        uint16 burnBps;
        uint16 liquidityBps;
        bool coinIsCurrency0;
        bool set;
    }

    IPoolManager public immutable poolManager;
    address public immutable platformTreasury;
    address public immutable launcher;
    address public immutable platformAdmin;

    mapping(PoolId => Config) public configOf;
    mapping(PoolId => Payee[]) internal payeesOf;

    error NotPoolManager();
    error NotLauncher();
    error NotRecipientOrAdmin();
    error AlreadyConfigured();
    error PoolNotConfigured();
    error TaxTooHigh(uint16 got, uint256 max);
    error SharesMustSumToBps(uint256 got);
    error TooManyPayees(uint256 got, uint256 max);
    error PayeeRequired();
    error PayeeAlreadyHoldsSlot(address to);
    error HookNotImplemented();

    event PoolConfigured(PoolId indexed id, uint16 taxBps, uint16 burnBps, uint16 liquidityBps, uint256 payees);
    event FeeTaken(PoolId indexed id, Currency currency, uint256 platform, uint256 creator);
    event CreatorShareSplit(PoolId indexed id, uint256 burnt, uint256 toLiquidity, uint256 paid);
    event PayeesChanged(PoolId indexed id, uint256 count);
    event PayeeSlotTransferred(PoolId indexed id, address indexed from, address indexed to);
    event RemainderSwept(PoolId indexed id, Currency currency, uint256 amount);
    event LiquidityAdded(PoolId indexed id, Currency currency, uint256 amount, uint128 liquidity);
    event BoughtBackAndBurnt(PoolId indexed id, uint256 spent, uint256 burnt);
    event PayoutDeferred(address indexed to, Currency indexed currency, uint256 amount);

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    constructor(IPoolManager _poolManager, address _platformTreasury, address _launcher, address _platformAdmin) {
        poolManager = _poolManager;
        platformTreasury = _platformTreasury;
        launcher = _launcher;
        platformAdmin = _platformAdmin;
    }

    // ---------------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------------

    /// @notice One-time per-pool setup, called by the factory at launch.
    function configurePool(
        PoolKey calldata key,
        uint16 taxBps,
        uint16 burnBps,
        uint16 liquidityBps,
        bool coinIsCurrency0,
        Payee[] memory payees
    ) external {
        if (msg.sender != launcher) revert NotLauncher();
        if (taxBps > LaunchFees.MAX_TAX_BPS) revert TaxTooHigh(taxBps, LaunchFees.MAX_TAX_BPS);
        if (uint256(burnBps) + liquidityBps > BPS) revert SharesMustSumToBps(uint256(burnBps) + liquidityBps);

        PoolId id = key.toId();
        if (configOf[id].set) revert AlreadyConfigured();

        _writePayees(id, payees, uint256(burnBps) + liquidityBps);
        configOf[id] =
            Config({taxBps: taxBps, burnBps: burnBps, liquidityBps: liquidityBps, coinIsCurrency0: coinIsCurrency0, set: true});
        emit PoolConfigured(id, taxBps, burnBps, liquidityBps, payees.length);
    }

    /// @notice Replace the payee set for a pool. Platform-admin curated.
    function setPayees(PoolKey calldata key, Payee[] calldata payees) external {
        PoolId id = key.toId();
        Config memory c = configOf[id];
        if (!c.set) revert PoolNotConfigured();
        if (msg.sender != platformAdmin) revert NotRecipientOrAdmin();
        _writePayees(id, payees, uint256(c.burnBps) + c.liquidityBps);
        emit PayeesChanged(id, payees.length);
    }

    /// @notice A payee hands their revenue-share slot to another address.
    function transferPayeeSlot(PoolKey calldata key, address to) external {
        if (to == address(0)) revert PayeeRequired();
        PoolId id = key.toId();
        if (!configOf[id].set) revert PoolNotConfigured();

        Payee[] storage existing = payeesOf[id];
        uint256 slot = type(uint256).max;
        for (uint256 i = 0; i < existing.length; i++) {
            if (existing[i].to == to) revert PayeeAlreadyHoldsSlot(to);
            if (existing[i].to == msg.sender) slot = i;
        }
        if (slot == type(uint256).max) revert NotRecipientOrAdmin();
        existing[slot].to = to;
        emit PayeeSlotTransferred(id, msg.sender, to);
    }

    function payees(PoolKey calldata key) external view returns (Payee[] memory) {
        return payeesOf[key.toId()];
    }

    function _writePayees(PoolId id, Payee[] memory list, uint256 reserved) private {
        if (list.length > MAX_PAYEES) revert TooManyPayees(list.length, MAX_PAYEES);
        uint256 sum = reserved;
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i].to == address(0)) revert PayeeRequired();
            sum += list[i].shareBps;
        }
        if (sum != BPS) revert SharesMustSumToBps(sum);
        delete payeesOf[id];
        for (uint256 i = 0; i < list.length; i++) {
            payeesOf[id].push(list[i]);
        }
    }

    // ---------------------------------------------------------------------
    // Fee engine
    // ---------------------------------------------------------------------

    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        Config memory c = configOf[key.toId()];
        if (!c.set || c.taxBps == 0) return (IHooks.afterSwap.selector, 0);

        (Currency feeCurrency, uint256 magnitude) = _unspecified(key, params, delta);
        if (magnitude == 0) return (IHooks.afterSwap.selector, 0);

        uint256 fee = (magnitude * c.taxBps) / BPS;
        if (fee == 0) return (IHooks.afterSwap.selector, 0);

        uint256 platformFee = (magnitude * LaunchFees.platformCut(c.taxBps)) / BPS;
        if (platformFee > fee) platformFee = fee;

        if (platformFee > 0) _payOut(feeCurrency, platformTreasury, platformFee);
        if (fee > platformFee) _payCreatorShare(key, key.toId(), c, feeCurrency, fee - platformFee);

        emit FeeTaken(key.toId(), feeCurrency, platformFee, fee - platformFee);
        return (IHooks.afterSwap.selector, fee.toInt128());
    }

    function _unspecified(PoolKey calldata key, SwapParams calldata params, BalanceDelta delta)
        private
        pure
        returns (Currency currency, uint256 magnitude)
    {
        int128 amount;
        if (params.amountSpecified < 0) {
            currency = params.zeroForOne ? key.currency1 : key.currency0;
            amount = params.zeroForOne ? delta.amount1() : delta.amount0();
        } else {
            currency = params.zeroForOne ? key.currency0 : key.currency1;
            amount = params.zeroForOne ? delta.amount0() : delta.amount1();
        }
        magnitude = amount < 0 ? uint256(uint128(-amount)) : uint256(uint128(amount));
    }

    function _payCreatorShare(PoolKey calldata key, PoolId id, Config memory c, Currency feeCurrency, uint256 creatorFee)
        private
    {
        Currency coin = c.coinIsCurrency0 ? key.currency0 : key.currency1;
        bool feeIsToken = Currency.unwrap(feeCurrency) == Currency.unwrap(coin);

        uint256 burnt;
        if (c.burnBps > 0 && feeIsToken) {
            burnt = (creatorFee * c.burnBps) / BPS;
            if (burnt > 0) _payOut(feeCurrency, BURN, burnt);
        }

        uint256 toLiquidity;
        if (c.liquidityBps > 0) {
            uint256 want = (creatorFee * c.liquidityBps) / BPS;
            if (want > 0) toLiquidity = _addSingleSided(key, id, feeCurrency, want);
        }

        uint256 sharedToPlatform;
        if (!feeIsToken && c.burnBps > 0) {
            uint256 unburnable = (creatorFee * c.burnBps) / BPS;
            uint256 boughtBack = _buybackAndBurn(key, id, c.coinIsCurrency0, unburnable);
            if (boughtBack > 0) {
                burnt += boughtBack;
                unburnable -= boughtBack;
            }
            sharedToPlatform = c.taxBps == 0 ? 0 : (unburnable * LaunchFees.platformCut(c.taxBps)) / c.taxBps;
            if (sharedToPlatform > 0) {
                _payOut(feeCurrency, platformTreasury, sharedToPlatform);
                emit RemainderSwept(id, feeCurrency, sharedToPlatform);
            }
        }

        uint256 distributable = creatorFee - burnt - toLiquidity - sharedToPlatform;
        Payee[] storage plist = payeesOf[id];
        uint256 totalShares = BPS - c.burnBps - c.liquidityBps;
        uint256 paid;
        for (uint256 i = 0; i < plist.length; i++) {
            uint256 amount = i + 1 == plist.length
                ? distributable - paid
                : totalShares == 0 ? 0 : (distributable * plist[i].shareBps) / totalShares;
            if (amount > 0) {
                _payOut(feeCurrency, plist[i].to, amount);
                paid += amount;
            }
        }

        uint256 unplaced = distributable - paid;
        if (unplaced > 0) {
            _payOut(feeCurrency, platformTreasury, unplaced);
            emit RemainderSwept(id, feeCurrency, unplaced);
        }
        emit CreatorShareSplit(id, burnt, toLiquidity, paid);
    }

    function _payOut(Currency currency, address to, uint256 amount) private {
        if (amount == 0) return;
        try poolManager.take{gas: PAYOUT_GAS}(currency, to, amount) {
            return;
        } catch {
            poolManager.mint(to, currency.toId(), amount);
            emit PayoutDeferred(to, currency, amount);
        }
    }

    function _buybackAndBurn(PoolKey calldata key, PoolId id, bool coinIsCurrency0, uint256 amount)
        private
        returns (uint256 spent)
    {
        if (amount == 0) return 0;
        // Sell the pair currency for the coin: zeroForOne when the coin is
        // currency1 (spend currency0), the reverse when the coin is currency0.
        bool zeroForOne = !coinIsCurrency0;
        try poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        ) returns (BalanceDelta d) {
            int128 gotCoin = coinIsCurrency0 ? d.amount0() : d.amount1();
            int128 paidPair = coinIsCurrency0 ? d.amount1() : d.amount0();
            if (gotCoin <= 0 || paidPair >= 0) return 0;
            poolManager.take(coinIsCurrency0 ? key.currency0 : key.currency1, BURN, uint256(uint128(gotCoin)));
            spent = uint256(uint128(-paidPair));
            emit BoughtBackAndBurnt(id, spent, uint256(uint128(gotCoin)));
        } catch {
            spent = 0;
        }
    }

    function _addSingleSided(PoolKey calldata key, PoolId id, Currency currency, uint256 amount)
        private
        returns (uint256 spent)
    {
        (, int24 tick,,) = poolManager.getSlot0(id);
        int24 spacing = key.tickSpacing;
        bool isToken0 = Currency.unwrap(currency) == Currency.unwrap(key.currency0);

        int24 aligned = (tick / spacing) * spacing;
        int24 lower;
        int24 upper;
        if (isToken0) {
            lower = aligned + spacing;
            upper = lower + spacing * LP_WIDTH;
            if (upper >= TickMath.MAX_TICK) return 0;
        } else {
            upper = aligned - spacing;
            lower = upper - spacing * LP_WIDTH;
            if (lower <= TickMath.MIN_TICK) return 0;
        }

        uint128 liquidity = isToken0
            ? LiquidityAmounts.getLiquidityForAmount0(TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), amount)
            : LiquidityAmounts.getLiquidityForAmount1(TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), amount);
        if (liquidity == 0) return 0;

        try poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: lower, tickUpper: upper, liquidityDelta: int256(uint256(liquidity)), salt: bytes32(0)}),
            ""
        ) returns (BalanceDelta callerDelta, BalanceDelta) {
            int128 cost = isToken0 ? callerDelta.amount0() : callerDelta.amount1();
            spent = cost < 0 ? uint256(uint128(-cost)) : 0;
            emit LiquidityAdded(id, currency, spent, liquidity);
        } catch {
            spent = 0;
        }
    }

    // ---------------------------------------------------------------------
    // IHooks surface — only beforeInitialize + afterSwap(+returnDelta) live;
    // the rest revert and are never reached (address flags gate the calls).
    // ---------------------------------------------------------------------

    function beforeInitialize(address sender, PoolKey calldata, uint160) external view returns (bytes4) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        if (sender != launcher) revert NotLauncher();
        return IHooks.beforeInitialize.selector;
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        pure
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }
}
