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

/// @notice Minimal Uniswap V3 SwapRouter surface (SwapRouter02-style, no
///         deadline) for the pair -> mainPair leg of the buyback.
interface ISwapRouterV3 {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @title RhBuybackHook
/// @notice Fee vault for the Robinhood-chain launchpad's buyback model. A coin
///         pairs against a chosen stock or meme; every trade pays a per-token
///         tax skimmed in `afterSwap`. On `harvest`, everything is normalised to
///         the coin's pair token and split:
///
///           1. creator  — 50%: pushed to the creator, in the pair token.
///           2. platform — 10%: sent to the fee recipient, in the pair token.
///           3. buyback   — 40%: accrued per pair token, later used by
///                          `buybackBurn` to buy the official token and BURN it.
///
///         Holders receive nothing directly; the buyback of the official token
///         is the shared upside. The official token is the first coin launched
///         on the factory, set once via `setMainToken`.
contract RhBuybackHook is BaseHook, Ownable, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    uint16 internal constant BPS = 10_000;
    uint16 public constant CREATOR_FEE_BPS = 5_000; // 50%
    uint16 public constant PLATFORM_FEE_BPS = 1_000; // 10%
    // Remainder (40%) funds the official-token buyback.

    struct PoolConfig {
        address token; // launched coin
        address pair; // pair token (stock/meme)
        address creator;
        uint16 taxBps;
        bool tokenIsCurrency0;
        bool registered;
        PoolKey poolKey;
    }

    address public factory;
    address public feeRecipient; // platform 10% sink
    /// @notice The official token bought back and burned (first launch).
    address public mainToken;
    /// @notice Uniswap V3 router for the pair -> mainPair buyback hop.
    ISwapRouterV3 public immutable v3Router;

    /// @notice Immutable admin that keeps its powers after `renounceOwnership()`.
    ///         Gates the admin setters below so ownership can be renounced (the
    ///         explorer shows owner() == 0) while this hardcoded, source-visible
    ///         address still administers the hook.
    address public immutable admin;

    modifier onlyAdmin() {
        require(msg.sender == admin, "not admin");
        _;
    }

    mapping(PoolId => PoolConfig) internal _config;
    mapping(address => PoolId) internal _poolOf;
    /// @notice token => launched-coin fees awaiting harvest (from buys).
    mapping(address => uint256) public tokenFees;
    /// @notice token => pair-token fees awaiting harvest (from sells).
    mapping(address => uint256) public pairFees;
    /// @notice pair token => accrued buyback funds (in that pair token).
    mapping(address => uint256) public pairBuyback;

    struct SwapAction {
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
    }

    event PoolRegistered(address indexed token, PoolId indexed id, address pair, uint16 taxBps);
    event FeeAccrued(address indexed token, bool pairToken, uint256 amount);
    event Harvested(address indexed token, uint256 toCreator, uint256 toPlatform, uint256 toBuyback);
    event BuybackBurned(address indexed pair, uint256 spent, uint256 burned);
    event FeeRecipientSet(address indexed recipient);
    event MainTokenSet(address indexed token);
    event FactorySet(address indexed factory);

    error NotFactory();
    error AlreadySet();
    error NotRegistered();
    error NoMainToken();

    constructor(IPoolManager pm, address owner_, address admin_, address feeRecipient_, ISwapRouterV3 v3Router_)
        BaseHook(pm)
        Ownable(owner_)
    {
        require(feeRecipient_ != address(0) && admin_ != address(0), "zero");
        admin = admin_;
        feeRecipient = feeRecipient_;
        v3Router = v3Router_;
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setFactory(address factory_) external onlyAdmin {
        require(factory_ != address(0), "factory=0");
        factory = factory_;
        emit FactorySet(factory_);
    }

    function setFeeRecipient(address recipient) external onlyAdmin {
        require(recipient != address(0), "fee=0");
        feeRecipient = recipient;
        emit FeeRecipientSet(recipient);
    }

    /// @notice Set the official token bought back and burned. Intended to be the
    ///         first coin launched on the factory.
    function setMainToken(address token) external onlyAdmin {
        require(token != address(0), "main=0");
        mainToken = token;
        emit MainTokenSet(token);
    }

    // ---------------------------------------------------------------------
    // Hook permissions + registration
    // ---------------------------------------------------------------------

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

    function _afterSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) internal override returns (bytes4, int128) {
        PoolConfig storage c = _config[key.toId()];
        if (!c.registered || c.taxBps == 0) return (BaseHook.afterSwap.selector, int128(0));

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
        if (feeIsToken) tokenFees[c.token] += fee;
        else pairFees[c.token] += fee;
        emit FeeAccrued(c.token, !feeIsToken, fee);

        return (BaseHook.afterSwap.selector, int128(int256(fee)));
    }

    // ---------------------------------------------------------------------
    // harvest: normalise to pair, split 50/10/40
    // ---------------------------------------------------------------------

    function harvest(address token) external nonReentrant {
        _harvest(token, 0);
    }

    /// @param minPairOut slippage floor on the internal token->pair conversion.
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
            emit Harvested(token, 0, 0, 0);
            return;
        }
        pairFees[token] = 0;

        uint256 toCreator = (total * CREATOR_FEE_BPS) / BPS;
        uint256 toPlatform = (total * PLATFORM_FEE_BPS) / BPS;
        uint256 toBuyback = total - toCreator - toPlatform;

        if (toCreator > 0) IERC20(c.pair).safeTransfer(c.creator, toCreator);
        if (toPlatform > 0) IERC20(c.pair).safeTransfer(feeRecipient, toPlatform);
        if (toBuyback > 0) pairBuyback[c.pair] += toBuyback;

        emit Harvested(token, toCreator, toPlatform, toBuyback);
    }

    // ---------------------------------------------------------------------
    // buybackBurn: buy the official token with the accrued pot and burn it
    // ---------------------------------------------------------------------

    /// @notice Spend a pair token's accrued buyback pot to buy the official
    ///         token and burn it. Permissionless (a keeper calls it); the pot
    ///         only ever converts into burned mainToken, never leaves.
    /// @param pair       the pair token whose buyback pot to spend.
    /// @param v3PathToMainPair Uniswap V3 path pair -> ... -> mainPair (empty
    ///        when the pair already IS the main token's pair).
    /// @param minMainOut slippage floor on the mainToken received before burn.
    function buybackBurn(address pair, bytes calldata v3PathToMainPair, uint256 minMainOut)
        external
        nonReentrant
        returns (uint256 burned)
    {
        address main = mainToken;
        if (main == address(0)) revert NoMainToken();
        PoolConfig storage mc = _config[_poolOf[main]];
        if (!mc.registered) revert NotRegistered();

        uint256 pot = pairBuyback[pair];
        if (pot == 0) {
            emit BuybackBurned(pair, 0, 0);
            return 0;
        }
        pairBuyback[pair] = 0;

        // 1. pair -> mainPair over V3 (skip if the pair already is mainPair).
        uint256 mainPairAmount;
        if (pair == mc.pair) {
            mainPairAmount = pot;
        } else {
            IERC20(pair).forceApprove(address(v3Router), pot);
            mainPairAmount = v3Router.exactInput(
                ISwapRouterV3.ExactInputParams({path: v3PathToMainPair, recipient: address(this), amountIn: pot, amountOutMinimum: 0})
            );
        }

        // 2. mainPair -> mainToken through the official token's own V4 pool.
        Currency mainPairCurrency = mc.tokenIsCurrency0 ? mc.poolKey.currency1 : mc.poolKey.currency0;
        burned = _swap(mc.poolKey, mainPairCurrency, mainPairAmount, minMainOut);

        // 3. Burn the bought official token.
        if (burned > 0) IQuiverToken(main).burn(burned);
        emit BuybackBurned(pair, pot, burned);
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
