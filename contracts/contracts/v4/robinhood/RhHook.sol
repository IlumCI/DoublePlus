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

/// @title RhHook
/// @notice Singleton Uniswap V4 hook and fee vault for the Robinhood-chain
///         launchpad fork. Each launched token pairs against a creator-chosen
///         token (a Robinhood tokenized stock or any onchain meme token). That
///         paired token is BOTH the trading quote (buys and sells settle in it)
///         AND the holder reward.
///
///         Every swap pays a per-token tax fixed at launch, skimmed in
///         `afterSwap` so ALL trades through the pool are taxed, not only those
///         routed via the app. Skimmed fees accrue per token; `harvest`
///         normalises everything to the pair token and splits it:
///
///           1. holders  — 80%: sent to the token's dividend tracker
///                         (QuiverToken.distributeRewards), credited pro-rata.
///           2. platform — 20%: sent to the platform treasury.
///
///         The creator earns no direct fee cut; their upside is holding the
///         token and the factory-held LP. Because the reward, the quote and the
///         pair are the same token, no unwrap or second swap hop is needed.
contract RhHook is BaseHook, Ownable, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    uint16 internal constant BPS = 10_000;

    /// @notice Holder share of every harvest, in bps. The remainder funds the
    ///         platform treasury.
    uint16 public constant HOLDER_FEE_BPS = 8_000;

    struct PoolConfig {
        address token; // the launched QuiverToken
        address pair; // the chosen pair/reward token (pool quote + dividend)
        address creator;
        uint16 taxBps;
        bool tokenIsCurrency0; // orientation of the launched token in the pool
        bool registered;
        PoolKey poolKey; // the launched token's own pair pool
    }

    /// @notice Factory allowed to register pools. Set once by the owner.
    address public factory;
    /// @notice Where the platform's 20% share (in the pair token) is sent.
    address public platformTreasury;

    mapping(PoolId => PoolConfig) internal _config;
    /// @notice token => pair-token fees awaiting harvest (from sells).
    mapping(address => uint256) public pairFees;
    /// @notice token => launched-token fees awaiting harvest (from buys).
    mapping(address => uint256) public tokenFees;
    mapping(address => PoolId) internal _poolOf;

    struct SwapAction {
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
    }

    event PoolRegistered(address indexed token, PoolId indexed id, address pair, uint16 taxBps);
    event FeeAccrued(address indexed token, bool pairToken, uint256 amount);
    event Harvested(address indexed token, uint256 toHolders, uint256 toPlatform);
    event PlatformTreasurySet(address indexed treasury);
    event FactorySet(address indexed factory);

    error NotFactory();
    error AlreadySet();
    error NotRegistered();

    constructor(IPoolManager pm, address owner_, address treasury_)
        BaseHook(pm)
        Ownable(owner_)
    {
        require(treasury_ != address(0), "zero");
        platformTreasury = treasury_;
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setFactory(address factory_) external onlyOwner {
        require(factory_ != address(0), "factory=0");
        factory = factory_;
        emit FactorySet(factory_);
    }

    function setPlatformTreasury(address treasury_) external onlyOwner {
        require(treasury_ != address(0), "treasury=0");
        platformTreasury = treasury_;
        emit PlatformTreasurySet(treasury_);
    }

    // ---------------------------------------------------------------------
    // Hook permissions
    // ---------------------------------------------------------------------

    function getHookPermissions() public pure override returns (Hooks.Permissions memory p) {
        p.afterSwap = true;
        p.afterSwapReturnDelta = true;
    }

    // ---------------------------------------------------------------------
    // Registration (factory only)
    // ---------------------------------------------------------------------

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
    // afterSwap: skim the tax on every trade
    // ---------------------------------------------------------------------

    function _afterSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) internal override returns (bytes4, int128) {
        PoolConfig storage c = _config[key.toId()];
        if (!c.registered || c.taxBps == 0) return (BaseHook.afterSwap.selector, int128(0));

        // Charge the tax in the swap's UNSPECIFIED currency, so it applies to
        // both exact-input (fee out of the output) and exact-output (fee added
        // to the input) trades. No swap through the pool can dodge the fee.
        bool exactInput = params.amountSpecified < 0;
        bool unspecifiedIsCurrency1 = (params.zeroForOne == exactInput);
        Currency unspecified = unspecifiedIsCurrency1 ? key.currency1 : key.currency0;
        int128 unspecifiedAmount = unspecifiedIsCurrency1 ? delta.amount1() : delta.amount0();

        uint256 magnitude = unspecifiedAmount < 0
            ? uint256(uint128(-unspecifiedAmount))
            : uint256(uint128(unspecifiedAmount));
        uint256 fee = (magnitude * c.taxBps) / BPS;
        if (fee == 0) return (BaseHook.afterSwap.selector, int128(0));

        poolManager.take(unspecified, address(this), fee);

        bool feeIsToken = Currency.unwrap(unspecified) == c.token;
        if (feeIsToken) {
            tokenFees[c.token] += fee;
        } else {
            pairFees[c.token] += fee;
        }
        emit FeeAccrued(c.token, !feeIsToken, fee);

        return (BaseHook.afterSwap.selector, int128(int256(fee)));
    }

    // ---------------------------------------------------------------------
    // harvest: normalise to the pair token, split 80/20, push
    // ---------------------------------------------------------------------

    /// @notice Permissionless harvest with no slippage bound on the internal
    ///         token->pair swap. Convenient but sandwichable; prefer
    ///         `harvestBounded` from a keeper that can compute expected output.
    function harvest(address token) external nonReentrant {
        _harvest(token, 0);
    }

    /// @notice Harvest with a slippage floor on the token->pair conversion, so a
    ///         sandwich attacker can't skim the holder share. `minPairOut` zero
    ///         disables the bound. A keeper computes it from the live pool price.
    function harvestBounded(address token, uint256 minPairOut) external nonReentrant {
        _harvest(token, minPairOut);
    }

    function _harvest(address token, uint256 minPairOut) private {
        PoolConfig storage c = _config[_poolOf[token]];
        if (!c.registered) revert NotRegistered();

        // 1. Convert launched-token fees (from buys) into the pair token.
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

        // Split 80/20: holders 80% (dust to platform).
        uint256 toHolders = (total * HOLDER_FEE_BPS) / BPS;
        uint256 toPlatform = total - toHolders;

        if (toHolders > 0) {
            // Fund the dividend tracker, then credit all eligible holders.
            IERC20(c.pair).safeTransfer(token, toHolders);
            IQuiverToken(token).distributeRewards(toHolders);
        }
        if (toPlatform > 0) {
            IERC20(c.pair).safeTransfer(platformTreasury, toPlatform);
        }

        emit Harvested(token, toHolders, toPlatform);
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

    /// @dev Settle what we owe / take what we're owed for one currency.
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
