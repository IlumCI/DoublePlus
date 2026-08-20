// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {IQuiverToken} from "../interfaces/IQuiverToken.sol";

/// @title HoodHook
/// @notice Fee vault for the launch-to-earn launchpad. Every coin pairs with
///         ETH (WETH) at a flat 1% fee, skimmed in `afterSwap`; trades in the
///         first seconds pay a sniper premium tracked separately. On `harvest`
///         everything is normalised to ETH and split:
///
///           1. creator  — 80%, pushed straight to the creator's wallet
///           2. treasury — 15%
///           3. bid wall —  5% + the whole sniper premium, credited to the
///              factory's wall vault.
///
///         There is no owner: `factory` and `treasury` are immutable, so the
///         recipients of every split can never be redirected.
interface IHoodWall {
    function creditWall(address token, uint256 amount) external;
}

contract HoodHook is BaseHook, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    uint16 internal constant BPS = 10_000;
    uint16 public constant CREATOR_BPS = 8_000;   // 80% creator
    uint16 public constant TREASURY_BPS = 1_500;  // 15% platform treasury
    // remaining 5% + all sniper premium -> the bid wall
    uint16 public constant BASE_TAX_BPS = 100;    // 1% flat trade fee
    /// @notice Sniper premium fees awaiting harvest, on top of tokenFees/pairFees.
    mapping(address => uint256) public tokenFeesSniper;
    mapping(address => uint256) public pairFeesSniper;
    /// @notice Platform treasury; fixed at deploy, can never be redirected.
    address public immutable treasury;

    struct PoolConfig {
        address token; // launched coin
        address pair; // pair + reward token
        address creator;
        uint16 taxBps;
        uint64 launchTime;
        bool tokenIsCurrency0;
        bool registered;
        PoolKey poolKey;
    }

    /// @notice The launchpad factory (also the bid-wall vault); fixed at
    ///         deploy via a nonce-predicted address, can never be changed.
    address public immutable factory;
    mapping(PoolId => PoolConfig) internal _config;
    mapping(address => PoolId) internal _poolOf;
    /// @notice token => launched-coin fees awaiting harvest (from buys).
    mapping(address => uint256) public tokenFees;
    /// @notice token => pair-token fees awaiting harvest (from sells).
    mapping(address => uint256) public pairFees;

    struct SwapAction {
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
    }

    event PoolRegistered(address indexed token, PoolId indexed id, address pair, uint16 taxBps);
    event FeeAccrued(address indexed token, bool pairToken, uint256 amount);
    event Harvested(address indexed token, uint256 toHolders, uint256 toCreator);

    error NotFactory();
    error AlreadySet();
    error NotRegistered();

    constructor(IPoolManager pm, address factory_, address treasury_) BaseHook(pm) {
        require(factory_ != address(0) && treasury_ != address(0), "zero");
        factory = factory_;
        treasury = treasury_;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory p) {
        p.afterSwap = true;
        p.afterSwapReturnDelta = true;
    }

    function registerPool(
        PoolKey calldata key,
        address token,
        address pair,
        address creator,
        uint16 taxBps,
        bool tokenIsCurrency0
    ) external {
        if (msg.sender != factory) revert NotFactory();
        PoolId id = key.toId();
        PoolConfig storage c = _config[id];
        if (c.registered) revert AlreadySet();
        c.token = token;
        c.pair = pair;
        c.creator = creator;
        c.taxBps = taxBps;
        c.tokenIsCurrency0 = tokenIsCurrency0;
        c.registered = true;
        c.poolKey = key;
        c.launchTime = uint64(block.timestamp);
        _poolOf[token] = id;
        emit PoolRegistered(token, id, pair, taxBps);
    }

    function config(PoolId id) external view returns (PoolConfig memory) {
        return _config[id];
    }

    // ---------------------------------------------------------------------
    // afterSwap: skim the tax
    // ---------------------------------------------------------------------

    function _afterSwap(address sender, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        PoolConfig storage c = _config[key.toId()];
        if (!c.registered) return (BaseHook.afterSwap.selector, int128(0));
        // Sniper schedule: 15% in the first 5s, 5% until 15s, then the 1% base.
        // The factory only swaps inside launch (the creator's atomic dev buy),
        // so that path pays the flat base fee with no sniper premium.
        uint256 age = block.timestamp - c.launchTime;
        uint256 rateBps = sender == factory ? BASE_TAX_BPS : age < 5 ? 1_500 : age < 15 ? 500 : BASE_TAX_BPS;

        bool exactInput = params.amountSpecified < 0;
        bool unspecifiedIsCurrency1 = (params.zeroForOne == exactInput);
        Currency unspecified = unspecifiedIsCurrency1 ? key.currency1 : key.currency0;
        int128 unspecifiedAmount = unspecifiedIsCurrency1 ? delta.amount1() : delta.amount0();

        uint256 magnitude = unspecifiedAmount < 0 ? uint256(uint128(-unspecifiedAmount)) : uint256(uint128(unspecifiedAmount));
        uint256 fee = (magnitude * rateBps) / BPS;
        uint256 baseFee = (magnitude * BASE_TAX_BPS) / BPS;
        if (fee == 0) return (BaseHook.afterSwap.selector, int128(0));

        poolManager.take(unspecified, address(this), fee);

        bool feeIsToken = Currency.unwrap(unspecified) == c.token;
        uint256 sniperPart = fee - baseFee;
        if (feeIsToken) {
            tokenFees[c.token] += baseFee;
            if (sniperPart > 0) tokenFeesSniper[c.token] += sniperPart;
        } else {
            pairFees[c.token] += baseFee;
            if (sniperPart > 0) pairFeesSniper[c.token] += sniperPart;
        }
        emit FeeAccrued(c.token, !feeIsToken, fee);

        return (BaseHook.afterSwap.selector, int128(int256(fee)));
    }

    // ---------------------------------------------------------------------
    // harvest: normalise to pair, split 80/20 holders/creator
    // ---------------------------------------------------------------------

    function harvest(address token) external nonReentrant {
        _harvest(token, 0);
    }

    function harvestBounded(address token, uint256 minPairOut) external nonReentrant {
        _harvest(token, minPairOut);
    }

    function _harvest(address token, uint256 minPairOut) private {
        PoolConfig storage c = _config[_poolOf[token]];
        if (!c.registered) revert NotRegistered();

        Currency tokenCurrency = c.tokenIsCurrency0 ? c.poolKey.currency0 : c.poolKey.currency1;
        uint256 tf = tokenFees[token];
        uint256 tfs = tokenFeesSniper[token];
        if (tf + tfs > 0) {
            tokenFees[token] = 0;
            tokenFeesSniper[token] = 0;
            uint256 out = _swap(c.poolKey, tokenCurrency, tf + tfs, minPairOut);
            // Pro-rate the converted WETH back into base vs sniper share.
            uint256 sniperOut = tf + tfs == 0 ? 0 : (out * tfs) / (tf + tfs);
            pairFeesSniper[token] += sniperOut;
            pairFees[token] += out - sniperOut;
        }

        uint256 base = pairFees[token];
        uint256 sniper = pairFeesSniper[token];
        if (base + sniper == 0) {
            emit Harvested(token, 0, 0);
            return;
        }
        pairFees[token] = 0;
        pairFeesSniper[token] = 0;

        uint256 toCreator = (base * CREATOR_BPS) / BPS;
        uint256 toTreasury = (base * TREASURY_BPS) / BPS;
        uint256 toWall = base - toCreator - toTreasury + sniper;

        if (toCreator > 0) IERC20(c.pair).safeTransfer(c.creator, toCreator);
        if (toTreasury > 0) IERC20(c.pair).safeTransfer(treasury, toTreasury);
        if (toWall > 0) {
            IERC20(c.pair).forceApprove(factory, toWall);
            IHoodWall(factory).creditWall(token, toWall);
        }

        emit Harvested(token, toCreator, toWall);
    }

    // ---------------------------------------------------------------------
    // Swap plumbing (our own router, via PoolManager.unlock)
    // ---------------------------------------------------------------------

    function _swap(PoolKey memory key, Currency currencyIn, uint256 amountIn, uint256 minOut)
        internal
        returns (uint256 amountOut)
    {
        if (amountIn == 0) return 0;
        bool zeroForOne = Currency.unwrap(currencyIn) == Currency.unwrap(key.currency0);
        bytes memory res = poolManager.unlock(abi.encode(SwapAction(key, zeroForOne, amountIn)));
        amountOut = abi.decode(res, (uint256));
        require(amountOut >= minOut, "slippage");
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(poolManager), "not pool manager");
        SwapAction memory a = abi.decode(data, (SwapAction));

        BalanceDelta delta = poolManager.swap(
            a.key,
            SwapParams({
                zeroForOne: a.zeroForOne,
                amountSpecified: -int256(a.amountIn),
                sqrtPriceLimitX96: a.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        _resolve(a.key.currency0, delta.amount0());
        _resolve(a.key.currency1, delta.amount1());

        uint256 out = a.zeroForOne ? uint256(uint128(delta.amount1())) : uint256(uint128(delta.amount0()));
        return abi.encode(out);
    }

    function _resolve(Currency currency, int128 amount) internal {
        if (amount < 0) {
            uint256 owed = uint256(uint128(-amount));
            poolManager.sync(currency);
            IERC20(Currency.unwrap(currency)).safeTransfer(address(poolManager), owed);
            poolManager.settle();
        } else if (amount > 0) {
            poolManager.take(currency, address(this), uint256(uint128(amount)));
        }
    }
}
