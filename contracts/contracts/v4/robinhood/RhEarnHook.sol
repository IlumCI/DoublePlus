// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
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

/// @title RhFinalHook
/// @notice Fee vault for the Robinhood-chain launchpad. A coin pairs against a
///         creator-chosen token (a Robinhood stock, a meme, or ETH); that token
///         is both the trading quote and the holder reward. Each swap pays a
///         per-token tax skimmed in `afterSwap`. On `harvest`, everything is
///         normalised to the pair token and split:
///
///           1. creator — 80%: pushed to the creator, in the pair token
///           2. holders — 20%: credited pro-rata via QuiverToken.distributeRewards
///
///         No platform cut. Ownership is renounced at deploy; a hardcoded,
///         source-visible immutable `admin` keeps the setter power.
contract RhEarnHook is BaseHook, Ownable, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    uint16 internal constant BPS = 10_000;
    uint16 public constant HOLDER_FEE_BPS = 2_000; // launch-to-earn: 20% holders, 80% creator

    struct PoolConfig {
        address token; // launched coin
        address pair; // pair + reward token
        address creator;
        uint16 taxBps;
        bool tokenIsCurrency0;
        bool registered;
        PoolKey poolKey;
    }

    address public factory;
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
    event FactorySet(address indexed factory);

    error NotFactory();
    error AlreadySet();
    error NotRegistered();

    constructor(IPoolManager pm, address owner_) BaseHook(pm) Ownable(owner_) {}

    /// @notice One-time wiring by the owner during setup; ownership is renounced
    ///         right after, so this can never change again. The fee split, pair
    ///         and rewards are fully autonomous once set.
    function setFactory(address factory_) external onlyOwner {
        require(factory_ != address(0), "factory=0");
        factory = factory_;
        emit FactorySet(factory_);
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
        _poolOf[token] = id;
        emit PoolRegistered(token, id, pair, taxBps);
    }

    function config(PoolId id) external view returns (PoolConfig memory) {
        return _config[id];
    }

    // ---------------------------------------------------------------------
    // afterSwap: skim the tax
    // ---------------------------------------------------------------------

    function _afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        PoolConfig storage c = _config[key.toId()];
        if (!c.registered || c.taxBps == 0) return (BaseHook.afterSwap.selector, int128(0));

        bool exactInput = params.amountSpecified < 0;
        bool unspecifiedIsCurrency1 = (params.zeroForOne == exactInput);
        Currency unspecified = unspecifiedIsCurrency1 ? key.currency1 : key.currency0;
        int128 unspecifiedAmount = unspecifiedIsCurrency1 ? delta.amount1() : delta.amount0();

        uint256 magnitude = unspecifiedAmount < 0 ? uint256(uint128(-unspecifiedAmount)) : uint256(uint128(unspecifiedAmount));
        uint256 fee = (magnitude * c.taxBps) / BPS;
        if (fee == 0) return (BaseHook.afterSwap.selector, int128(0));

        poolManager.take(unspecified, address(this), fee);

        bool feeIsToken = Currency.unwrap(unspecified) == c.token;
        if (feeIsToken) tokenFees[c.token] += fee;
        else pairFees[c.token] += fee;
        emit FeeAccrued(c.token, !feeIsToken, fee);

        return (BaseHook.afterSwap.selector, int128(int256(fee)));
    }

    // ---------------------------------------------------------------------
    // harvest: normalise to pair, split 80/20 creator/holders
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

        uint256 tf = tokenFees[token];
        if (tf > 0) {
            tokenFees[token] = 0;
            Currency tokenCurrency = c.tokenIsCurrency0 ? c.poolKey.currency0 : c.poolKey.currency1;
            pairFees[token] += _swap(c.poolKey, tokenCurrency, tf, minPairOut);
        }

        uint256 total = pairFees[token];
        if (total == 0) {
            emit Harvested(token, 0, 0);
            return;
        }
        pairFees[token] = 0;

        uint256 toHolders = (total * HOLDER_FEE_BPS) / BPS;
        uint256 toCreator = total - toHolders;

        if (toHolders > 0) {
            IERC20(c.pair).safeTransfer(token, toHolders);
            IQuiverToken(token).distributeRewards(toHolders);
        }
        if (toCreator > 0) IERC20(c.pair).safeTransfer(c.creator, toCreator);

        emit Harvested(token, toHolders, toCreator);
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
