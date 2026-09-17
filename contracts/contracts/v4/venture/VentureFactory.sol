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

import {QuiverToken} from "../QuiverToken.sol";
import {VentureFeeHook} from "./VentureFeeHook.sol";
import {FounderVesting} from "./FounderVesting.sol";
import {VestingDeployer} from "./VestingDeployer.sol";
import {VentureTokenDeployer} from "./VentureTokenDeployer.sol";

interface IWETH9V {
    function deposit() external payable;
}

interface ISwapRouterV3V {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @title VentureFactory
/// @notice Startup-funding launchpad for the Robinhood chain: a founder
///         launches a coin that represents their venture, the public funds it
///         on a linear bonding curve in plain ETH, and hitting the target
///         graduates the coin into a factory-locked Uniswap V4 pool governed
///         by the founder's own fee policy (VentureFeeHook): separate buy and
///         sell taxes (0-4% each) split across dev wallet / holder dividends /
///         auto-liquidity / a market-making bid wall, plus the protocol fee
///         on every trade.
///
///         Raise mechanics, designed against the documented failure modes of
///         open bonding curves (sniper cohorts, order-splitting, dead curves):
///
///           - Integral pricing: buys are priced by the closed-form integral of
///             the linear curve, so splitting an order across transactions
///             yields exactly the same tokens as one buy. There is nothing to
///             game with ordering.
///           - Per-wallet spend cap (founder-set, default 2% of target).
///           - Hard graduation: finalize() only once the ETH target is raised
///             (or the curve sells out). The founder takes their declared cut
///             of the raise (max 30%); the remainder becomes pool liquidity.
///           - All-or-nothing: if the deadline passes below target, the raise
///             aborts and every buyer refunds their full spend against
///             returning their tokens. The founder's vested allocation burns.
///           - Founder skin-in-the-game: the founder allocation (max 15% of
///             supply) sits in a linear vesting escrow that only starts at
///             graduation.
///
///         Compliance note: tokens launched here are open ERC-20s, matching
///         the chain's native stock-token model (compliance at the primary
///         market, not per transfer). A transfer-validation module
///         (ERC-7943-style isTransferAllowed + identity registry) would attach
///         inside QuiverToken._update / at buy() if a gated mode is added.
contract VentureFactory is Ownable, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;
    uint256 public constant TOTAL_SUPPLY_WHOLE = 1_000_000_000;
    uint256 public constant CURVE_SUPPLY_WHOLE = 600_000_000; // 60% sold on the curve
    uint256 public constant START_MCAP_USD_8 = 3_000 * 1e8; // FDV at the first buy
    uint256 public constant MAX_TARGET_WEI = 1_000_000 ether;
    uint64 public constant MIN_RAISE_SECS = 1 days;
    uint64 public constant MAX_RAISE_SECS = 14 days;
    uint32 public constant MIN_VESTING_SECS = 90 days;
    uint32 public constant MAX_VESTING_SECS = 730 days;
    uint16 public constant MAX_FOUNDER_RAISE_BPS = 3_000; // <= 30% of the raise
    uint16 public constant MAX_FOUNDER_SUPPLY_BPS = 1_500; // <= 15% of supply
    uint16 public constant MAX_CURVE_FEE_BPS = 300; // ceiling on both curve fees
    uint64 public constant MIN_SWEEP_DELAY = 180 days;
    int24 public constant TICK_SPACING = 60;
    uint24 public constant LP_FEE = 0;
    uint16 internal constant BPS = 10_000;

    IPoolManager public immutable poolManager;
    VentureFeeHook public immutable hook;
    IWETH9V public immutable weth;
    ISwapRouterV3V public immutable v3Router;
    VestingDeployer public immutable vestingDeployer;
    VentureTokenDeployer public immutable tokenDeployer;
    address public immutable protocolAdmin;

    /// @notice Protocol fee on curve buys, taken off the incoming value before
    ///         the curve is quoted, so `spentWei` records net escrow.
    uint16 public immutable curveBuyFeeBps;
    /// @notice Protocol fee on curve sells, taken out of the proceeds.
    uint16 public immutable curveSellFeeBps;

    bool public launchesPaused;

    /// @notice Flat fee to open a listing. Prices out spam as much as it earns.
    uint256 public creationFeeWei;
    /// @notice Open-mode graduation trigger, in raised wei. Frozen per listing
    ///         at launch so a live curve never has its finish line moved. The
    ///         optimum is empirical, hence settable rather than immutable.
    uint256 public graduationRaiseWei = 5 ether;
    /// @notice How long an aborted raise's escrow stays claimable.
    uint64 public sweepDelaySecs = 365 days;
    /// @notice Open-mode creator's share of the curve fee, in bps of the fee.
    uint16 public creatorCurveShareBps = 1_000;

    /// @notice Pull-payment ledger. Nothing in the trade path makes an external
    ///         call to a fee recipient: a treasury that cannot receive ETH must
    ///         never be able to brick every buy on the platform.
    mapping(address recipient => uint256 wei_) public feesAccrued;

    /// @notice `Guaranteed` is all-or-nothing with a target, a deadline and a
    ///         full refund on failure; curve sells are capped at the seller's
    ///         cost basis so the refund stays funded. `Open` has no target, no
    ///         deadline and no refund, graduates on `graduationRaiseWei`, and
    ///         lets the curve run uncapped in both directions.
    enum RaiseMode { Guaranteed, Open }

    struct Listing {
        address creator;
        address pair;
        uint16 taxBps;
        uint64 createdAt;
        bytes32 poolId; // 0 until graduated
    }

    struct Curve {
        uint128 basePriceWei; // p0: wei per whole token at zero sold
        uint128 slopeQ;       // k (Q18): wei-per-whole-token increase per whole token sold
        uint64 deadline;
        bool finalized;
        bool aborted;
        uint16 founderRaiseBps;
        uint256 soldWhole;    // whole tokens sold on the curve
        uint256 raisedWei;
        uint256 targetRaiseWei;
        uint256 maxBuyWei;    // per-wallet spend cap
        RaiseMode mode;
        uint64 abortedAt;     // 0 until abort(); starts the sweep clock
        bool swept;
        bytes v3Path;         // WETH -> ... -> pair (empty when pair IS WETH)
    }

    struct Position {
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
    }

    mapping(address token => Listing) public listings;
    mapping(address token => Curve) internal _curves;
    mapping(address token => address) public vestingOf;
    mapping(address token => VentureFeeHook.FeePolicy) public feePolicyOf;
    mapping(address token => Position) public tokenPositions;
    mapping(address token => Position) public pairPositions;
    mapping(address token => mapping(address buyer => uint256)) public spentWei;
    mapping(address token => mapping(address buyer => uint256)) public boughtTokens; // token-wei
    address[] public allTokens;
    mapping(address creator => address[]) internal _tokensByCreator;

    struct LaunchParams {
        string name;
        string symbol;
        string metadataURI; // JSON: description, logo, links + pitch/sector
        address pair;       // trading quote + dividend currency
        uint16 buyTaxBps;   // 0..400: founder tax on buys after graduation
        uint16 sellTaxBps;  // 0..400: founder tax on sells after graduation
        address devWallet;  // dev-fee recipient; 0 => the founder
        uint16 devBps;      // the four buckets split the founder tax and
        uint16 dividendBps; // must sum to 10_000
        uint16 liquidityBps;
        uint16 mmBps;
        uint256 ethUsdPrice8;    // ETH USD price, 8dp (sizes the curve start)
        uint256 targetRaiseWei;  // graduation trigger
        uint64 raiseDurationSecs;
        uint256 maxBuyWei;       // 0 => targetRaiseWei / 50
        uint16 founderRaiseBps;  // 0..3000: cut of the raise paid at graduation
        uint16 founderSupplyBps; // 0..1500: vested founder allocation
        uint32 vestingSecs;      // required when founderSupplyBps > 0
        RaiseMode mode;          // Guaranteed (AON raise) or Open (free curve)
        bytes v3Path;            // WETH -> ... -> pair route for finalize
    }

    event Launched(
        address indexed token,
        address indexed creator,
        address indexed pair,
        uint16 taxBps,
        uint256 targetRaiseWei,
        uint64 deadline,
        address vesting
    );
    event CurveBuy(address indexed token, address indexed buyer, uint256 ethIn, uint256 tokensOut, uint128 priceWei);
    event Graduated(
        address indexed token, bytes32 poolId, uint256 raisedWei, uint256 founderCutWei, uint256 pairSeeded
    );
    event Aborted(address indexed token, uint256 raisedWei, uint256 burned);
    event Refunded(address indexed token, address indexed buyer, uint256 ethOut, uint256 tokensReturned);
    event CurveSell(
        address indexed token, address indexed seller, uint256 ethOut, uint256 tokensIn, uint128 priceWei, uint256 feeWei
    );
    event FeeAccrued(address indexed token, address indexed recipient, uint256 amount);
    event FeesWithdrawn(address indexed recipient, uint256 amount);
    event Swept(address indexed token, uint256 amount);
    event ParamsSet(uint256 creationFeeWei, uint256 graduationRaiseWei, uint64 sweepDelaySecs, uint16 creatorCurveShareBps);
    event Collected(address indexed token, uint256 tokenAmount, uint256 pairAmount, address indexed recipient);
    event LaunchesPausedSet(bool paused);

    error LaunchesPaused_();
    error InvalidParams();
    error BadVanity();
    error NotProtocolAdmin();
    error CurveClosed();
    error CurveLive();
    error AlreadyFinalized();
    error NotAborted();
    error CapExceeded();
    error NothingToRefund();
    error NothingToSell();
    error SlippageExceeded();
    error SweepTooEarly();
    error AlreadySwept();
    error FeeTooHigh();
    error EthTransferFailed();
    error NotPoolManager();

    modifier onlyProtocolAdmin() {
        if (msg.sender != protocolAdmin) revert NotProtocolAdmin();
        _;
    }

    constructor(
        address owner_,
        address protocolAdmin_,
        IPoolManager poolManager_,
        VentureFeeHook hook_,
        address weth_,
        ISwapRouterV3V v3Router_,
        VestingDeployer vestingDeployer_,
        VentureTokenDeployer tokenDeployer_,
        uint16 curveBuyFeeBps_,
        uint16 curveSellFeeBps_
    ) Ownable(owner_) {
        require(protocolAdmin_ != address(0), "admin=0");
        if (curveBuyFeeBps_ > MAX_CURVE_FEE_BPS || curveSellFeeBps_ > MAX_CURVE_FEE_BPS) revert FeeTooHigh();
        curveBuyFeeBps = curveBuyFeeBps_;
        curveSellFeeBps = curveSellFeeBps_;
        protocolAdmin = protocolAdmin_;
        poolManager = poolManager_;
        hook = hook_;
        weth = IWETH9V(weth_);
        v3Router = v3Router_;
        vestingDeployer = vestingDeployer_;
        tokenDeployer = tokenDeployer_;
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function pause() external onlyProtocolAdmin {
        launchesPaused = true;
        emit LaunchesPausedSet(true);
    }

    function resume() external onlyProtocolAdmin {
        launchesPaused = false;
        emit LaunchesPausedSet(false);
    }

    /// @notice Tune the parameters whose optimum is empirical. The curve fees
    ///         themselves are immutable; these are not, because a graduation
    ///         threshold guessed before launch can never be the right one.
    ///         Applies to new launches only: `graduationRaiseWei` is copied
    ///         into the curve at launch, so no live raise moves.
    function setParams(
        uint256 creationFeeWei_,
        uint256 graduationRaiseWei_,
        uint64 sweepDelaySecs_,
        uint16 creatorCurveShareBps_
    ) external onlyProtocolAdmin {
        if (graduationRaiseWei_ == 0 || graduationRaiseWei_ > MAX_TARGET_WEI) revert InvalidParams();
        if (sweepDelaySecs_ < MIN_SWEEP_DELAY) revert InvalidParams();
        if (creatorCurveShareBps_ > 5_000) revert InvalidParams();
        creationFeeWei = creationFeeWei_;
        graduationRaiseWei = graduationRaiseWei_;
        sweepDelaySecs = sweepDelaySecs_;
        creatorCurveShareBps = creatorCurveShareBps_;
        emit ParamsSet(creationFeeWei_, graduationRaiseWei_, sweepDelaySecs_, creatorCurveShareBps_);
    }

    // ---------------------------------------------------------------------
    // Fee ledger: accrue in the trade path, withdraw out of band
    // ---------------------------------------------------------------------

    function _accrue(address token, address to, uint256 amount) internal {
        if (amount == 0 || to == address(0)) return;
        feesAccrued[to] += amount;
        emit FeeAccrued(token, to, amount);
    }

    /// @dev Referrer first, then the Open-mode creator's share, remainder to
    ///      the protocol treasury. Nothing here calls out to the recipients.
    function _splitCurveFee(address token, uint256 fee) internal {
        if (fee == 0) return;
        uint256 remaining = fee;
        address ref = hook.referrerOf(msg.sender);
        if (ref != address(0) && ref != msg.sender) {
            uint256 toRef = (fee * hook.refShareBps()) / BPS;
            _accrue(token, ref, toRef);
            remaining -= toRef;
        }
        if (_curves[token].mode == RaiseMode.Open && creatorCurveShareBps > 0) {
            uint256 toCreator = (fee * creatorCurveShareBps) / BPS;
            _accrue(token, listings[token].creator, toCreator);
            remaining -= toCreator;
        }
        _accrue(token, hook.platformTreasury(), remaining);
    }

    /// @notice Withdraw everything accrued to the caller.
    function withdrawFees() external nonReentrant returns (uint256 amount) {
        amount = feesAccrued[msg.sender];
        if (amount == 0) revert NothingToRefund();
        feesAccrued[msg.sender] = 0;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert EthTransferFailed();
        emit FeesWithdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Launch: deploy the token, escrow the founder allocation, open the curve
    // ---------------------------------------------------------------------

    function launch(LaunchParams calldata p, bytes32 salt) external payable nonReentrant returns (address token) {
        if (launchesPaused) revert LaunchesPaused_();
        if (msg.value < creationFeeWei) revert InvalidParams();
        if (bytes(p.name).length == 0 || bytes(p.symbol).length == 0) revert InvalidParams();
        if (p.buyTaxBps > hook.MAX_SIDE_TAX_BPS() || p.sellTaxBps > hook.MAX_SIDE_TAX_BPS()) revert InvalidParams();
        if (uint256(p.devBps) + p.dividendBps + p.liquidityBps + p.mmBps != BPS) revert InvalidParams();
        if (p.ethUsdPrice8 == 0) revert InvalidParams();
        if (p.pair == address(0) || p.pair.code.length == 0) revert InvalidParams();
        if (p.pair != address(weth) && p.v3Path.length == 0) revert InvalidParams();
        bool open = p.mode == RaiseMode.Open;
        // Open mode has no deadline and no cut of a raise: the creator is paid
        // out of curve fees instead, so there is nothing to hold to a target.
        if (!open && (p.raiseDurationSecs < MIN_RAISE_SECS || p.raiseDurationSecs > MAX_RAISE_SECS)) {
            revert InvalidParams();
        }
        if (open && p.founderRaiseBps != 0) revert InvalidParams();
        if (p.founderRaiseBps > MAX_FOUNDER_RAISE_BPS) revert InvalidParams();
        if (p.founderSupplyBps > MAX_FOUNDER_SUPPLY_BPS) revert InvalidParams();
        if (p.founderSupplyBps > 0 && (p.vestingSecs < MIN_VESTING_SECS || p.vestingSecs > MAX_VESTING_SECS)) {
            revert InvalidParams();
        }
        // One trigger serves both modes: Guaranteed uses the founder's target,
        // Open takes the protocol's graduation threshold, frozen here.
        uint256 target = open ? graduationRaiseWei : p.targetRaiseWei;
        if (target == 0 || target > MAX_TARGET_WEI) revert InvalidParams();

        // p0: whole-supply FDV of START_MCAP_USD at the first curve buy.
        uint256 p0 = Math.mulDiv(START_MCAP_USD_8, 1e18, TOTAL_SUPPLY_WHOLE * p.ethUsdPrice8);
        // The 1e15 ceiling (start FDV <= 1M ETH) keeps every curve-math
        // intermediate comfortably inside uint256 for the life of the raise.
        if (p0 == 0 || p0 > 1e15) revert InvalidParams();

        // k (Q18) such that selling the whole curve raises exactly the target:
        // target = p0*C + k*C^2/2  =>  k = 2*(target - p0*C)/C^2.
        uint256 baseCost = p0 * CURVE_SUPPLY_WHOLE;
        if (target < baseCost) revert InvalidParams(); // curve slope must be >= 0
        uint256 slopeQ =
            Math.mulDiv(2 * (target - baseCost), 1e18, CURVE_SUPPLY_WHOLE * CURVE_SUPPLY_WHOLE);
        if (slopeQ > type(uint128).max) revert InvalidParams();

        // A per-wallet cap is a fairness device for an all-or-nothing raise.
        // Open mode is a market; it does not have one.
        uint256 maxBuy = open ? type(uint256).max : (p.maxBuyWei == 0 ? target / 50 : p.maxBuyWei);
        if (maxBuy < target / 200) revert InvalidParams(); // cap can't make the raise impossible

        token = tokenDeployer.deployToken(
            salt, p.name, p.symbol, p.metadataURI, TOTAL_SUPPLY, msg.sender, p.buyTaxBps, p.pair
        );
        if (uint160(token) & 0xffff != 0x4663) revert BadVanity();
        if (token == p.pair) revert InvalidParams();

        // Vesting escrow first, so it can go on the dividend exclusion list.
        address vesting;
        if (p.founderSupplyBps > 0) {
            vesting = address(vestingDeployer.deploy(token, msg.sender, uint64(p.vestingSecs)));
            vestingOf[token] = vesting;
        }

        address[] memory ex = new address[](vesting == address(0) ? 2 : 3);
        ex[0] = address(poolManager);
        ex[1] = address(this);
        if (vesting != address(0)) ex[2] = vesting;
        tokenDeployer.initHook(token, address(hook), ex);

        if (vesting != address(0)) {
            IERC20(token).safeTransfer(vesting, (TOTAL_SUPPLY * p.founderSupplyBps) / BPS);
        }

        _curves[token] = Curve({
            basePriceWei: uint128(p0),
            slopeQ: uint128(slopeQ),
            deadline: open ? type(uint64).max : uint64(block.timestamp) + p.raiseDurationSecs,
            finalized: false,
            aborted: false,
            founderRaiseBps: p.founderRaiseBps,
            soldWhole: 0,
            raisedWei: 0,
            targetRaiseWei: target,
            maxBuyWei: maxBuy,
            mode: p.mode,
            abortedAt: 0,
            swept: false,
            v3Path: p.v3Path
        });
        feePolicyOf[token] = VentureFeeHook.FeePolicy({
            devWallet: p.devWallet == address(0) ? msg.sender : p.devWallet,
            buyTaxBps: p.buyTaxBps,
            sellTaxBps: p.sellTaxBps,
            devBps: p.devBps,
            dividendBps: p.dividendBps,
            liquidityBps: p.liquidityBps,
            mmBps: p.mmBps
        });
        listings[token] =
            Listing({creator: msg.sender, pair: p.pair, taxBps: p.buyTaxBps, createdAt: uint64(block.timestamp), poolId: 0});
        allTokens.push(token);
        _tokensByCreator[msg.sender].push(token);

        if (creationFeeWei > 0) _accrue(token, hook.platformTreasury(), creationFeeWei);
        if (msg.value > creationFeeWei) {
            (bool back,) = payable(msg.sender).call{value: msg.value - creationFeeWei}("");
            if (!back) revert EthTransferFailed();
        }

        emit Launched(token, msg.sender, p.pair, p.buyTaxBps, target, _curves[token].deadline, vesting);
    }

    // ---------------------------------------------------------------------
    // Curve math
    // ---------------------------------------------------------------------

    /// @notice Current curve price, wei per whole token.
    function priceNow(address token) public view returns (uint128) {
        Curve storage c = _curves[token];
        if (c.basePriceWei == 0) revert InvalidParams();
        return uint128(uint256(c.basePriceWei) + Math.mulDiv(c.slopeQ, c.soldWhole, 1e18));
    }

    /// @notice Exact integral cost, in wei, of buying `qWhole` whole tokens
    ///         starting from `fromSoldWhole` sold.
    function curveCost(address token, uint256 qWhole, uint256 fromSoldWhole) public view returns (uint256) {
        Curve storage c = _curves[token];
        // q*p0 + k*(S*q + q^2/2), computed as k*(2Sq + q^2)/2 in Q18.
        return qWhole * c.basePriceWei
            + Math.mulDiv(c.slopeQ, 2 * fromSoldWhole * qWhole + qWhole * qWhole, 2e18);
    }

    /// @notice Whole tokens bought by spending `valueWei` from the current
    ///         point on the curve — the closed-form inverse of curveCost, so
    ///         pricing is path-independent (order splitting changes nothing).
    function tokensForValue(address token, uint256 valueWei) public view returns (uint256 qWhole) {
        Curve storage c = _curves[token];
        uint256 k = c.slopeQ;
        if (k == 0) return valueWei / c.basePriceWei;
        // Solve (k/2)q^2 + b*q - 1e18*v = 0 with b = 1e18*p0 + k*S.
        uint256 b = 1e18 * uint256(c.basePriceWei) + k * c.soldWhole;
        uint256 disc = b * b + 2 * k * (1e18 * valueWei);
        qWhole = (Math.sqrt(disc) - b) / k;
    }

    // ---------------------------------------------------------------------
    // Buy on the curve
    // ---------------------------------------------------------------------

    function buy(address token) external payable nonReentrant returns (uint256 tokensOut) {
        Curve storage c = _curves[token];
        if (c.basePriceWei == 0) revert InvalidParams();
        if (c.finalized || c.aborted) revert CurveClosed();
        if (block.timestamp >= c.deadline && c.raisedWei < c.targetRaiseWei) revert CurveClosed();
        if (c.raisedWei >= c.targetRaiseWei || c.soldWhole >= CURVE_SUPPLY_WHOLE) revert CurveClosed();
        if (msg.value == 0) revert InvalidParams();

        // The entry fee comes off the incoming value before the curve is
        // quoted, so spentWei records what actually reaches escrow. Booking it
        // gross would leave refund liability above escrow by exactly the take.
        uint256 feeIn = (msg.value * curveBuyFeeBps) / BPS;
        uint256 netValue = msg.value - feeIn;
        if (netValue == 0) revert InvalidParams();

        uint256 q = tokensForValue(token, netValue);
        uint256 remaining = CURVE_SUPPLY_WHOLE - c.soldWhole;
        if (q > remaining) q = remaining;
        if (q == 0) revert InvalidParams();

        uint256 spend = curveCost(token, q, c.soldWhole) + 1; // round the cost up
        if (spend > netValue) spend = netValue;
        if (spentWei[token][msg.sender] + spend > c.maxBuyWei) revert CapExceeded();

        uint128 price = priceNow(token);
        c.soldWhole += q;
        c.raisedWei += spend;
        spentWei[token][msg.sender] += spend;
        tokensOut = q * 1e18;
        boughtTokens[token][msg.sender] += tokensOut;

        IERC20(token).safeTransfer(msg.sender, tokensOut);
        _splitCurveFee(token, feeIn);
        if (netValue > spend) {
            (bool ok,) = payable(msg.sender).call{value: netValue - spend}("");
            if (!ok) revert EthTransferFailed();
        }
        emit CurveBuy(token, msg.sender, spend, tokensOut, price);
    }

    // ---------------------------------------------------------------------
    // Sell back to the curve
    // ---------------------------------------------------------------------

    /// @notice Return `qWhole` tokens to the curve for ETH. The claim belongs
    ///         to the address that bought on the curve: tokens acquired by
    ///         plain transfer carry no curve position, exactly as with refund().
    /// @dev    In Guaranteed mode the payout is capped at the seller's pro-rata
    ///         cost basis. That cap is a solvency requirement, not a policy:
    ///         escrow is `B - S` and refund liability is `B - C`, so refunds
    ///         stay funded iff `C >= S`. Uncapped, an early buyer could sell
    ///         into later buyers' ETH and leave the rest short.
    function sell(address token, uint256 qWhole, uint256 minEthOut)
        external
        nonReentrant
        returns (uint256 ethOut)
    {
        Curve storage c = _curves[token];
        if (c.basePriceWei == 0) revert InvalidParams();
        if (c.finalized || c.aborted) revert CurveClosed();
        // High-water lock: once the graduation trigger is crossed the curve is
        // frozen both ways, so a sell cannot drag a funded raise back under it.
        if (c.raisedWei >= c.targetRaiseWei || c.soldWhole >= CURVE_SUPPLY_WHOLE) revert CurveClosed();

        uint256 owned = boughtTokens[token][msg.sender];
        if (owned == 0 || qWhole == 0) revert NothingToSell();
        uint256 qMax = owned / 1e18;
        uint256 q = qWhole > qMax ? qMax : qWhole;
        if (q == 0 || q > c.soldWhole) revert NothingToSell();

        uint256 tokenWei = q * 1e18;
        uint256 costBasis = Math.mulDiv(spentWei[token][msg.sender], tokenWei, owned);
        uint256 gross = curveCost(token, q, c.soldWhole - q);
        if (c.mode == RaiseMode.Guaranteed && gross > costBasis) gross = costBasis;
        if (gross > c.raisedWei) gross = c.raisedWei;

        uint256 fee = (gross * curveSellFeeBps) / BPS;
        ethOut = gross - fee;
        if (ethOut < minEthOut) revert SlippageExceeded();

        spentWei[token][msg.sender] -= costBasis;
        boughtTokens[token][msg.sender] = owned - tokenWei;
        c.soldWhole -= q;
        c.raisedWei -= gross;

        // Tokens go back to factory inventory so the curve can resell them.
        IERC20(token).safeTransferFrom(msg.sender, address(this), tokenWei);
        _splitCurveFee(token, fee);
        (bool ok,) = payable(msg.sender).call{value: ethOut}("");
        if (!ok) revert EthTransferFailed();
        emit CurveSell(token, msg.sender, ethOut, tokenWei, priceNow(token), fee);
    }

    // ---------------------------------------------------------------------
    // Graduation: target hit -> pay the founder cut, seed the locked pool
    // ---------------------------------------------------------------------

    function finalize(address token) external nonReentrant returns (bytes32 poolId) {
        Curve storage c = _curves[token];
        Listing storage l = listings[token];
        if (c.basePriceWei == 0) revert InvalidParams();
        if (c.finalized) revert AlreadyFinalized();
        if (c.aborted) revert CurveClosed();
        if (c.raisedWei < c.targetRaiseWei && c.soldWhole < CURVE_SUPPLY_WHOLE) revert CurveLive();
        c.finalized = true;

        // 1) Founder's declared cut of the raise, straight to the founder.
        uint256 founderCut = (c.raisedWei * c.founderRaiseBps) / BPS;
        if (founderCut > 0) {
            (bool ok,) = payable(l.creator).call{value: founderCut}("");
            if (!ok) revert EthTransferFailed();
        }

        // 2) Remaining ETH -> pair token (liquidity side).
        uint256 poolEth = c.raisedWei - founderCut;
        address pair = l.pair;
        uint256 pairAmount;
        if (poolEth > 0) {
            weth.deposit{value: poolEth}();
            if (pair == address(weth)) {
                pairAmount = poolEth;
            } else {
                IERC20(address(weth)).forceApprove(address(v3Router), poolEth);
                pairAmount = v3Router.exactInput(
                    ISwapRouterV3V.ExactInputParams({
                        path: c.v3Path,
                        recipient: address(this),
                        amountIn: poolEth,
                        amountOutMinimum: 0
                    })
                );
            }
        }

        // 3) Closing curve price, converted to pair units per whole token.
        uint256 priceEnd = uint256(c.basePriceWei) + Math.mulDiv(c.slopeQ, c.soldWhole, 1e18);
        uint256 priceQ = (pair == address(weth) || pairAmount == 0 || poolEth == 0)
            ? priceEnd
            : Math.mulDiv(priceEnd, pairAmount, poolEth);
        if (priceQ == 0) revert InvalidParams();

        bool tokenIsCurrency0 = token < pair;
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(tokenIsCurrency0 ? token : pair),
            currency1: Currency.wrap(tokenIsCurrency0 ? pair : token),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });

        (uint160 sqrtPriceX96, int24 alignedEdge) = _poolStart(tokenIsCurrency0, priceQ);
        poolManager.initialize(key, sqrtPriceX96);

        int24 minTick = (TickMath.MIN_TICK / TICK_SPACING) * TICK_SPACING;
        int24 maxTick = (TickMath.MAX_TICK / TICK_SPACING) * TICK_SPACING;

        // 4a) Everything the factory still holds: single-sided token liquidity.
        uint256 unsold = IERC20(token).balanceOf(address(this));
        if (unsold > 0) {
            (int24 tl, int24 tu) = tokenIsCurrency0 ? (alignedEdge + TICK_SPACING, maxTick) : (minTick, alignedEdge);
            uint128 liq = tokenIsCurrency0
                ? LiquidityAmounts.getLiquidityForAmount0(
                    TickMath.getSqrtPriceAtTick(tl), TickMath.getSqrtPriceAtTick(tu), unsold
                )
                : LiquidityAmounts.getLiquidityForAmount1(
                    TickMath.getSqrtPriceAtTick(tl), TickMath.getSqrtPriceAtTick(tu), unsold
                );
            if (liq > 0) {
                tokenPositions[token] = Position({tickLower: tl, tickUpper: tu, liquidity: liq});
                poolManager.unlock(abi.encode(uint8(0), abi.encode(key, tl, tu, liq)));
            }
        }

        // 4b) Raised pair tokens: single-sided buy support under the price.
        if (pairAmount > 0) {
            (int24 tl, int24 tu) = tokenIsCurrency0 ? (minTick, alignedEdge) : (alignedEdge + TICK_SPACING, maxTick);
            uint128 liq = tokenIsCurrency0
                ? LiquidityAmounts.getLiquidityForAmount1(
                    TickMath.getSqrtPriceAtTick(tl), TickMath.getSqrtPriceAtTick(tu), pairAmount
                )
                : LiquidityAmounts.getLiquidityForAmount0(
                    TickMath.getSqrtPriceAtTick(tl), TickMath.getSqrtPriceAtTick(tu), pairAmount
                );
            if (liq > 0) {
                pairPositions[token] = Position({tickLower: tl, tickUpper: tu, liquidity: liq});
                poolManager.unlock(abi.encode(uint8(0), abi.encode(key, tl, tu, liq)));
            }
        }

        poolId = PoolId.unwrap(key.toId());
        l.poolId = poolId;
        hook.registerPool(key, token, pair, feePolicyOf[token], tokenIsCurrency0);

        // 5) Start the founder's vesting clock.
        address vesting = vestingOf[token];
        if (vesting != address(0)) FounderVesting(vesting).start();

        emit Graduated(token, poolId, c.raisedWei, founderCut, pairAmount);
    }

    // ---------------------------------------------------------------------
    // Failure path: deadline passed below target -> abort and refund
    // ---------------------------------------------------------------------

    /// @notice Anyone can flip a dead raise into the refundable state. Burns
    ///         the founder's escrowed allocation and the factory's remaining
    ///         inventory; buyers then pull refunds individually.
    function abort(address token) external nonReentrant {
        Curve storage c = _curves[token];
        if (c.basePriceWei == 0) revert InvalidParams();
        if (c.finalized) revert AlreadyFinalized();
        if (c.aborted) revert CurveClosed();
        if (block.timestamp < c.deadline) revert CurveLive();
        if (c.raisedWei >= c.targetRaiseWei || c.soldWhole >= CURVE_SUPPLY_WHOLE) revert CurveLive();
        c.aborted = true;
        c.abortedAt = uint64(block.timestamp);

        address vesting = vestingOf[token];
        if (vesting != address(0)) FounderVesting(vesting).reclaim();

        QuiverToken qt = QuiverToken(payable(token));
        uint256 held = qt.balanceOf(address(this));
        if (held > 0) qt.burn(held);
        emit Aborted(token, c.raisedWei, held);
    }

    /// @notice Return the full bought amount, get the full spend back. Tokens
    ///         must be approved to the factory first; they are burned.
    function refund(address token) external nonReentrant returns (uint256 ethOut) {
        Curve storage c = _curves[token];
        if (!c.aborted) revert NotAborted();
        if (c.swept) revert AlreadySwept();
        uint256 tokensBack = boughtTokens[token][msg.sender];
        ethOut = spentWei[token][msg.sender];
        if (tokensBack == 0 || ethOut == 0) revert NothingToRefund();
        boughtTokens[token][msg.sender] = 0;
        spentWei[token][msg.sender] = 0;
        // Keep raisedWei equal to the ETH this raise still holds, so the two
        // ledgers stay in step and sweepUnclaimed knows what is genuinely left.
        c.raisedWei -= ethOut;

        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensBack);
        QuiverToken(payable(token)).burn(tokensBack);

        (bool ok,) = payable(msg.sender).call{value: ethOut}("");
        if (!ok) revert EthTransferFailed();
        emit Refunded(token, msg.sender, ethOut, tokensBack);
    }

    /// @notice Sweep escrow left behind long after an aborted raise. A curve
    ///         claim is keyed to the buying address, so a backer who moves
    ///         their tokens away can no longer refund and their ETH would
    ///         otherwise sit here forever. The window is deliberately long and
    ///         the claim page stays open for all of it.
    function sweepUnclaimed(address token) external nonReentrant returns (uint256 amount) {
        Curve storage c = _curves[token];
        if (!c.aborted) revert NotAborted();
        if (c.swept) revert AlreadySwept();
        if (block.timestamp < uint256(c.abortedAt) + sweepDelaySecs) revert SweepTooEarly();
        amount = c.raisedWei;
        c.swept = true;
        c.raisedWei = 0;
        _accrue(token, hook.platformTreasury(), amount);
        emit Swept(token, amount);
    }

    // ---------------------------------------------------------------------
    // PoolManager callback: settle whatever the add owes
    // ---------------------------------------------------------------------

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (uint8 action, bytes memory payload) = abi.decode(data, (uint8, bytes));

        if (action == 0) {
            (PoolKey memory key, int24 tl, int24 tu, uint128 liq) = abi.decode(payload, (PoolKey, int24, int24, uint128));
            (BalanceDelta delta,) = poolManager.modifyLiquidity(
                key,
                ModifyLiquidityParams({tickLower: tl, tickUpper: tu, liquidityDelta: int256(uint256(liq)), salt: bytes32(0)}),
                ""
            );
            _settleNegative(key.currency0, delta.amount0());
            _settleNegative(key.currency1, delta.amount1());
            return "";
        }

        (PoolKey memory k2, Position memory pos, address recipient) = abi.decode(payload, (PoolKey, Position, address));
        (BalanceDelta d2,) = poolManager.modifyLiquidity(
            k2,
            ModifyLiquidityParams({
                tickLower: pos.tickLower,
                tickUpper: pos.tickUpper,
                liquidityDelta: -int256(uint256(pos.liquidity)),
                salt: bytes32(0)
            }),
            ""
        );
        uint256 amt0 = _takePositive(k2.currency0, d2.amount0(), recipient);
        uint256 amt1 = _takePositive(k2.currency1, d2.amount1(), recipient);
        return abi.encode(amt0, amt1);
    }

    function _settleNegative(Currency currency, int128 amount) internal {
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

    /// @notice LP recovery lever, gated to the immutable protocolAdmin; drains
    ///         both factory-held positions of `token` to `recipient`.
    function collect(address token, address recipient) external onlyProtocolAdmin nonReentrant {
        if (recipient == address(0)) revert InvalidParams();
        Listing storage l = listings[token];
        bool tokenIsCurrency0 = token < l.pair;
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(tokenIsCurrency0 ? token : l.pair),
            currency1: Currency.wrap(tokenIsCurrency0 ? l.pair : token),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        uint256 t;
        uint256 p;
        if (tokenPositions[token].liquidity > 0) {
            Position memory pos = tokenPositions[token];
            delete tokenPositions[token];
            bytes memory r = poolManager.unlock(abi.encode(uint8(1), abi.encode(key, pos, recipient)));
            (uint256 a0, uint256 a1) = abi.decode(r, (uint256, uint256));
            (t, p) = tokenIsCurrency0 ? (a0, a1) : (a1, a0);
        }
        if (pairPositions[token].liquidity > 0) {
            Position memory pos = pairPositions[token];
            delete pairPositions[token];
            bytes memory r = poolManager.unlock(abi.encode(uint8(1), abi.encode(key, pos, recipient)));
            (uint256 a0, uint256 a1) = abi.decode(r, (uint256, uint256));
            (uint256 t2, uint256 p2) = tokenIsCurrency0 ? (a0, a1) : (a1, a0);
            t += t2;
            p += p2;
        }
        emit Collected(token, t, p, recipient);
    }

    // ---------------------------------------------------------------------
    // Pool start pricing (identical to the proven Hammr placement)
    // ---------------------------------------------------------------------

    function _poolStart(bool tokenIsCurrency0, uint256 priceQ)
        internal
        pure
        returns (uint160 sqrtPriceX96, int24 alignedEdge)
    {
        uint160 target = tokenIsCurrency0
            ? uint160(Math.sqrt(Math.mulDiv(priceQ, 1 << 192, 1e18)))
            : uint160(Math.sqrt(Math.mulDiv(1e18, 1 << 192, priceQ)));
        int24 tick = TickMath.getTickAtSqrtPrice(target);
        int24 aligned = (tick / TICK_SPACING) * TICK_SPACING;
        if (tick < 0 && tick % TICK_SPACING != 0) aligned -= TICK_SPACING;
        alignedEdge = aligned;
        sqrtPriceX96 = TickMath.getSqrtPriceAtTick(tokenIsCurrency0 ? aligned : aligned + TICK_SPACING);
        if (!tokenIsCurrency0) alignedEdge = aligned + TICK_SPACING;
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

    function curveState(address token)
        external
        view
        returns (
            uint64 deadline,
            uint128 price,
            uint256 soldWhole,
            uint256 remainingWhole,
            uint256 raisedWei,
            uint256 targetRaiseWei,
            bool finalized,
            bool aborted
        )
    {
        Curve storage c = _curves[token];
        deadline = c.deadline;
        price = c.basePriceWei == 0 ? 0 : priceNow(token);
        soldWhole = c.soldWhole;
        remainingWhole = CURVE_SUPPLY_WHOLE - c.soldWhole;
        raisedWei = c.raisedWei;
        targetRaiseWei = c.targetRaiseWei;
        finalized = c.finalized;
        aborted = c.aborted;
    }

    function terms(address token)
        external
        view
        returns (
            uint16 founderRaiseBps,
            uint256 maxBuyWei,
            address vesting,
            uint128 basePriceWei,
            uint128 slopeQ,
            RaiseMode mode,
            bool swept
        )
    {
        Curve storage c = _curves[token];
        founderRaiseBps = c.founderRaiseBps;
        maxBuyWei = c.maxBuyWei;
        vesting = vestingOf[token];
        basePriceWei = c.basePriceWei;
        slopeQ = c.slopeQ;
        mode = c.mode;
        swept = c.swept;
    }

    receive() external payable {}
}
