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

interface IFlyBurn {
    function burn(uint256 amount) external;
}

/// @title FlywheelHook
/// @notice Fee engine for the flywheel launchpad. Every coin pairs with ETH
///         (WETH) at a flat 1% fee skimmed in `afterSwap`; the first seconds
///         pay a sniper premium. On `harvest` everything is normalised to
///         WETH and split:
///
///           1. deployer  — 20%, pushed straight to the creator's wallet
///           2. platform  — 25%, to the immutable treasury
///           3. community — 25% + the whole sniper premium, pooled; every
///              week a permissionless `resolveEpoch` buys back and burns the
///              epoch's top-3 coins by volume (50/30/20)
///           4. traders   — 30%, pooled per weekly epoch and claimable
///              pro-rata to each trader's routed volume. On-chain from day
///              one; no points program, no promises.
///
///         There is no owner: `factory`, `treasury`, and `weth` are
///         immutable, so no recipient can ever be redirected and neither
///         pool can be withdrawn by anyone outside the mechanism.
contract FlywheelHook is BaseHook, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    uint16 internal constant BPS = 10_000;
    uint16 public constant DEPLOYER_BPS = 2_000;  // 20% creator fee stream
    uint16 public constant PLATFORM_BPS = 2_500;  // 25% platform treasury
    uint16 public constant COMMUNITY_BPS = 2_500; // 25% weekly buyback+burn
    // remaining 30% -> trader rewards, claimable per epoch
    uint16 public constant BASE_TAX_BPS = 100;    // 1% flat trade fee
    uint256 public constant EPOCH = 7 days;

    /// @notice The launchpad factory; fixed at deploy via a nonce-predicted
    ///         address, can never be changed.
    address public immutable factory;
    /// @notice Platform treasury; fixed at deploy, can never be redirected.
    address public immutable treasury;
    /// @notice Canonical WETH (every pot is denominated in it).
    address public immutable weth;
    /// @notice Epoch anchor: epoch e spans [genesis + e*EPOCH, +EPOCH).
    uint256 public immutable genesis;

    struct PoolConfig {
        address token;
        address pair;
        address creator;
        uint16 taxBps;
        uint64 launchTime;
        bool tokenIsCurrency0;
        bool registered;
        PoolKey poolKey;
    }

    mapping(PoolId => PoolConfig) internal _config;
    mapping(address => PoolId) internal _poolOf;
    /// @notice token => coin-denominated fees awaiting harvest (base bucket).
    mapping(address => uint256) public tokenFees;
    /// @notice token => WETH-denominated fees awaiting harvest (base bucket).
    mapping(address => uint256) public pairFees;
    /// @notice Sniper premium awaiting harvest, on top of the base buckets.
    mapping(address => uint256) public tokenFeesSniper;
    mapping(address => uint256) public pairFeesSniper;

    /// @notice Rolling community pot (WETH), spent by resolveEpoch.
    uint256 public communityPot;
    /// @notice WETH pooled for traders, per epoch of harvest.
    mapping(uint256 => uint256) public traderPot;
    /// @notice Routed volume per trader per epoch, in WETH terms.
    mapping(uint256 => mapping(address => uint256)) public traderVol;
    mapping(uint256 => uint256) public totalTraderVol;
    /// @notice Volume per token per epoch, in WETH terms (buyback leaderboard).
    mapping(uint256 => mapping(address => uint256)) public tokenVol;
    /// @notice The epoch's live top-3 tokens by volume, best first.
    mapping(uint256 => address[3]) internal _top;
    mapping(uint256 => bool) public epochResolved;
    mapping(uint256 => mapping(address => bool)) public traderClaimed;

    struct SwapAction {
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
    }

    event PoolRegistered(address indexed token, PoolId indexed id, address pair, uint16 taxBps);
    event FeeAccrued(address indexed token, bool pairToken, uint256 amount);
    event Harvested(address indexed token, uint256 toDeployer, uint256 toCommunity, uint256 toTraders);
    event EpochResolved(uint256 indexed epoch, address[3] top, uint256 potSpent);
    event Buyback(uint256 indexed epoch, address indexed token, uint256 wethIn, uint256 burned);
    event TraderClaimed(uint256 indexed epoch, address indexed trader, uint256 amount);

    error NotFactory();
    error AlreadySet();
    error NotRegistered();
    error EpochOpen();
    error AlreadyResolved();
    error AlreadyClaimed();
    error NothingToClaim();

    constructor(IPoolManager pm, address factory_, address treasury_, address weth_) BaseHook(pm) {
        require(factory_ != address(0) && treasury_ != address(0) && weth_ != address(0), "zero");
        factory = factory_;
        treasury = treasury_;
        weth = weth_;
        genesis = block.timestamp;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory p) {
        p.afterSwap = true;
        p.afterSwapReturnDelta = true;
    }

    /// @notice The current weekly epoch index.
    function currentEpoch() public view returns (uint256) {
        return (block.timestamp - genesis) / EPOCH;
    }

    /// @notice The epoch's top-3 tokens by routed volume, best first.
    function topTokens(uint256 epoch) external view returns (address[3] memory) {
        return _top[epoch];
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
        c.launchTime = uint64(block.timestamp);
        _poolOf[token] = id;
        emit PoolRegistered(token, id, pair, taxBps);
    }

    function config(PoolId id) external view returns (PoolConfig memory) {
        return _config[id];
    }

    // ---------------------------------------------------------------------
    // afterSwap: skim the fee, track volume + trader accrual
    // ---------------------------------------------------------------------

    function _afterSwap(address sender, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata hookData)
        internal
        override
        returns (bytes4, int128)
    {
        PoolConfig storage c = _config[key.toId()];
        if (!c.registered) return (BaseHook.afterSwap.selector, int128(0));
        // Sniper schedule: 15% in the first 5s, 5% until 15s, then the 1%
        // base. The factory only swaps inside launch (the atomic dev buy).
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

        // Flywheel accounting, all in WETH terms: the pair-side leg of the
        // swap is the volume. Feeds the weekly buyback leaderboard, and, when
        // the router passed the trader along, that trader's reward share.
        {
            int128 pairDelta = c.tokenIsCurrency0 ? delta.amount1() : delta.amount0();
            uint256 vol = pairDelta < 0 ? uint256(uint128(-pairDelta)) : uint256(uint128(pairDelta));
            if (vol > 0) {
                uint256 e = currentEpoch();
                uint256 nv = tokenVol[e][c.token] + vol;
                tokenVol[e][c.token] = nv;
                _bumpTop(e, c.token, nv);
                if (hookData.length == 32) {
                    address trader = abi.decode(hookData, (address));
                    if (trader != address(0)) {
                        traderVol[e][trader] += vol;
                        totalTraderVol[e] += vol;
                    }
                }
            }
        }

        return (BaseHook.afterSwap.selector, int128(int256(fee)));
    }

    /// @dev Keep the epoch's top-3 list current for `token` at volume `nv`.
    function _bumpTop(uint256 e, address token, uint256 nv) internal {
        address[3] storage top = _top[e];
        uint256 pos = 3;
        for (uint256 i; i < 3; ++i) {
            if (top[i] == token) {
                pos = i;
                break;
            }
        }
        if (pos == 3) {
            // Not ranked yet: must beat (or fill) the last slot.
            if (top[2] != address(0) && tokenVol[e][top[2]] >= nv) return;
            pos = 2;
            top[2] = token;
        }
        // Bubble up while bigger than the slot above (empty counts as smaller).
        while (pos > 0 && (top[pos - 1] == address(0) || tokenVol[e][top[pos - 1]] < nv)) {
            (top[pos - 1], top[pos]) = (top[pos], top[pos - 1]);
            --pos;
        }
    }

    // ---------------------------------------------------------------------
    // harvest: normalise to WETH, split 20/25/25/30
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
            uint256 sniperOut = (out * tfs) / (tf + tfs);
            pairFeesSniper[token] += sniperOut;
            pairFees[token] += out - sniperOut;
        }

        uint256 base = pairFees[token];
        uint256 sniper = pairFeesSniper[token];
        if (base + sniper == 0) {
            emit Harvested(token, 0, 0, 0);
            return;
        }
        pairFees[token] = 0;
        pairFeesSniper[token] = 0;

        uint256 toDeployer = (base * DEPLOYER_BPS) / BPS;
        uint256 toPlatform = (base * PLATFORM_BPS) / BPS;
        uint256 toCommunity = (base * COMMUNITY_BPS) / BPS + sniper;
        uint256 toTraders = base - toDeployer - toPlatform - ((base * COMMUNITY_BPS) / BPS);

        if (toDeployer > 0) IERC20(c.pair).safeTransfer(c.creator, toDeployer);
        if (toPlatform > 0) IERC20(c.pair).safeTransfer(treasury, toPlatform);
        communityPot += toCommunity;
        traderPot[currentEpoch()] += toTraders;

        emit Harvested(token, toDeployer, toCommunity, toTraders);
    }

    // ---------------------------------------------------------------------
    // The weekly flywheel: buy back and burn the top-3, pay the traders
    // ---------------------------------------------------------------------

    /// @notice After an epoch ends, anyone can fire the buyback: the whole
    ///         community pot market-buys the epoch's top-3 coins (50/30/20)
    ///         and burns them. Slots without a coin roll their share over.
    function resolveEpoch(uint256 epoch) external nonReentrant {
        if (block.timestamp < genesis + (epoch + 1) * EPOCH) revert EpochOpen();
        if (epochResolved[epoch]) revert AlreadyResolved();
        epochResolved[epoch] = true;

        uint256 pot = communityPot;
        if (pot == 0) {
            emit EpochResolved(epoch, _top[epoch], 0);
            return;
        }
        communityPot = 0;

        address[3] memory top = _top[epoch];
        uint16[3] memory w = [uint16(5_000), uint16(3_000), uint16(2_000)];
        uint256 spent;
        for (uint256 i; i < 3; ++i) {
            address token = top[i];
            if (token == address(0)) continue;
            uint256 amt = (pot * w[i]) / BPS;
            if (amt == 0) continue;
            PoolConfig storage c = _config[_poolOf[token]];
            Currency pairCurrency = c.tokenIsCurrency0 ? c.poolKey.currency1 : c.poolKey.currency0;
            uint256 got = _swap(c.poolKey, pairCurrency, amt, 0);
            if (got > 0) IFlyBurn(token).burn(got);
            spent += amt;
            emit Buyback(epoch, token, amt, got);
        }
        // Whatever was not spendable rolls into the next epoch's pot.
        communityPot += pot - spent;
        emit EpochResolved(epoch, top, spent);
    }

    /// @notice Claim your WETH share of a finished epoch's trader pot,
    ///         pro-rata to the volume you routed that week.
    function claimTrader(uint256 epoch) external nonReentrant returns (uint256 amount) {
        if (block.timestamp < genesis + (epoch + 1) * EPOCH) revert EpochOpen();
        if (traderClaimed[epoch][msg.sender]) revert AlreadyClaimed();
        uint256 vol = traderVol[epoch][msg.sender];
        uint256 total = totalTraderVol[epoch];
        if (vol == 0 || total == 0) revert NothingToClaim();
        traderClaimed[epoch][msg.sender] = true;
        amount = (traderPot[epoch] * vol) / total;
        if (amount > 0) IERC20(weth).safeTransfer(msg.sender, amount);
        emit TraderClaimed(epoch, msg.sender, amount);
    }

    /// @notice A trader's claimable WETH for an epoch (0 while it is open).
    function traderClaimable(uint256 epoch, address trader) external view returns (uint256) {
        if (traderClaimed[epoch][trader]) return 0;
        uint256 total = totalTraderVol[epoch];
        if (total == 0) return 0;
        return (traderPot[epoch] * traderVol[epoch][trader]) / total;
    }

    // ---------------------------------------------------------------------
    // Swap plumbing (via PoolManager.unlock)
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
