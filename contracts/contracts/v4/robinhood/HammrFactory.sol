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
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {QuiverToken} from "../QuiverToken.sol";
import {RhFinalHook} from "./RhFinalHook.sol";

interface IWETH9H {
    function deposit() external payable;
}

interface ISwapRouterV3H {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @title HammrFactory
/// @notice Dutch-auction launcher for the Robinhood-chain pair=reward model.
///         Every coin launches as a falling-price auction in plain ETH: the
///         price starts at 10x the floor and decays linearly for AUCTION_SECS
///         (or until the allocation sells out). Finalize converts the raised
///         ETH into the coin's chosen pair token and seeds a two-sided,
///         factory-locked Uniswap V4 pool around the closing price, with the
///         same hook economics as copair: every trade fee is split 80% to
///         holders (paid in the pair token) / 20% to the creator.
contract HammrFactory is Ownable, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;
    uint256 public constant TOTAL_SUPPLY_WHOLE = 1_000_000_000;
    uint256 public constant AUCTION_SUPPLY = 500_000_000 ether; // 50% auctioned
    uint256 public constant FLOOR_MCAP_USD_8 = 3_000 * 1e8;
    uint256 public constant START_MULTIPLE = 10; // start price = 10x floor
    uint64 public constant AUCTION_SECS = 1 hours;
    int24 public constant TICK_SPACING = 60;
    uint24 public constant LP_FEE = 0;
    uint16 public constant MAX_TAX_BPS = 1000;

    IPoolManager public immutable poolManager;
    RhFinalHook public immutable hook;
    IWETH9H public immutable weth;
    ISwapRouterV3H public immutable v3Router;
    address public immutable protocolAdmin;

    bool public launchesPaused;

    struct Listing {
        address creator;
        address pair;
        uint16 taxBps;
        uint64 createdAt;
        bytes32 poolId; // 0 until finalized
    }

    struct Auction {
        uint64 startTime;
        uint64 endTime;
        uint128 floorPriceWei;  // wei per whole token at the floor
        uint128 startPriceWei;  // wei per whole token at t0
        uint128 lastPriceWei;   // price of the final sale (clearing price)
        uint256 sold;           // token-wei sold
        uint256 raisedWei;      // ETH raised
        bool finalized;
        uint256 pairUsdPrice8;  // pair USD price snapshot for the zero-raise fallback
        bytes v3Path;           // WETH -> ... -> pair (empty when pair IS WETH)
    }

    struct Position {
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
    }

    mapping(address token => Listing) public listings;
    mapping(address token => Auction) public auctions;
    mapping(address token => Position) public tokenPositions;
    mapping(address token => Position) public pairPositions;
    address[] public allTokens;
    mapping(address creator => address[]) internal _tokensByCreator;

    struct LaunchParams {
        string name;
        string symbol;
        string metadataURI;
        address pair;
        uint16 taxBps;
        uint256 pairUsdPrice8; // pair token USD price, 8dp
        uint256 ethUsdPrice8;  // ETH USD price, 8dp
        bytes v3Path;          // WETH -> ... -> pair route for finalize
    }

    event Launched(address indexed token, address indexed creator, address indexed pair, uint16 taxBps, uint64 endTime);
    event Bought(address indexed token, address indexed buyer, uint256 ethIn, uint256 tokensOut, uint128 priceWei);
    event Finalized(address indexed token, bytes32 poolId, uint256 sold, uint256 raisedWei, uint256 pairSeeded);
    event Collected(address indexed token, uint256 tokenAmount, uint256 pairAmount, address indexed recipient);
    event LaunchesPausedSet(bool paused);

    error LaunchesPaused_();
    error InvalidParams();
    error BadVanity();
    error NotProtocolAdmin();
    error AuctionClosed();
    error AuctionLive();
    error AlreadyFinalized();

    modifier onlyProtocolAdmin() {
        if (msg.sender != protocolAdmin) revert NotProtocolAdmin();
        _;
    }

    constructor(
        address owner_,
        address protocolAdmin_,
        IPoolManager poolManager_,
        RhFinalHook hook_,
        address weth_,
        ISwapRouterV3H v3Router_
    ) Ownable(owner_) {
        require(protocolAdmin_ != address(0), "admin=0");
        protocolAdmin = protocolAdmin_;
        poolManager = poolManager_;
        hook = hook_;
        weth = IWETH9H(weth_);
        v3Router = v3Router_;
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

    // ---------------------------------------------------------------------
    // Launch: deploy the token and open the auction
    // ---------------------------------------------------------------------

    function launch(LaunchParams calldata p, bytes32 salt) external nonReentrant returns (address token) {
        if (launchesPaused) revert LaunchesPaused_();
        if (bytes(p.name).length == 0 || bytes(p.symbol).length == 0) revert InvalidParams();
        if (p.taxBps > MAX_TAX_BPS) revert InvalidParams();
        if (p.pairUsdPrice8 == 0 || p.ethUsdPrice8 == 0) revert InvalidParams();
        if (p.pair == address(0) || p.pair.code.length == 0) revert InvalidParams();
        if (p.pair != address(weth) && p.v3Path.length == 0) revert InvalidParams();

        QuiverToken qt = new QuiverToken{salt: salt}(
            p.name, p.symbol, p.metadataURI, TOTAL_SUPPLY, msg.sender, address(this), p.taxBps, p.pair
        );
        token = address(qt);
        if (uint160(token) & 0xffff != 0x4663) revert BadVanity();
        if (token == p.pair) revert InvalidParams();

        address[] memory ex = new address[](2);
        ex[0] = address(poolManager);
        ex[1] = address(this);
        qt.initHook(address(hook), ex);

        // Floor: whole-supply mcap of FLOOR_MCAP_USD in ETH terms.
        uint256 floorWei = Math.mulDiv(FLOOR_MCAP_USD_8, 1e18, TOTAL_SUPPLY_WHOLE * p.ethUsdPrice8);
        if (floorWei == 0 || floorWei > type(uint128).max / START_MULTIPLE) revert InvalidParams();

        auctions[token] = Auction({
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp) + AUCTION_SECS,
            floorPriceWei: uint128(floorWei),
            startPriceWei: uint128(floorWei * START_MULTIPLE),
            lastPriceWei: uint128(floorWei),
            sold: 0,
            raisedWei: 0,
            finalized: false,
            pairUsdPrice8: p.pairUsdPrice8,
            v3Path: p.v3Path
        });
        listings[token] = Listing({creator: msg.sender, pair: p.pair, taxBps: p.taxBps, createdAt: uint64(block.timestamp), poolId: 0});
        allTokens.push(token);
        _tokensByCreator[msg.sender].push(token);

        emit Launched(token, msg.sender, p.pair, p.taxBps, uint64(block.timestamp) + AUCTION_SECS);
    }

    /// @notice Current auction price (wei per whole token), linearly decaying.
    function priceNow(address token) public view returns (uint128) {
        Auction storage a = auctions[token];
        if (a.startTime == 0) revert InvalidParams();
        if (block.timestamp >= a.endTime) return a.floorPriceWei;
        uint256 elapsed = block.timestamp - a.startTime;
        uint256 span = a.endTime - a.startTime;
        uint256 p = a.startPriceWei - Math.mulDiv(a.startPriceWei - a.floorPriceWei, elapsed, span);
        return uint128(p);
    }

    /// @notice Buy at the current price. Excess ETH beyond the remaining
    ///         allocation is refunded.
    function buy(address token) external payable nonReentrant returns (uint256 tokensOut) {
        Auction storage a = auctions[token];
        if (a.startTime == 0) revert InvalidParams();
        if (a.finalized || block.timestamp >= a.endTime || a.sold >= AUCTION_SUPPLY) revert AuctionClosed();
        if (msg.value == 0) revert InvalidParams();

        uint128 p = priceNow(token);
        tokensOut = Math.mulDiv(msg.value, 1e18, p);
        uint256 remaining = AUCTION_SUPPLY - a.sold;
        uint256 spend = msg.value;
        if (tokensOut > remaining) {
            tokensOut = remaining;
            spend = Math.mulDiv(tokensOut, p, 1e18) + 1; // round the cost up
            if (spend > msg.value) spend = msg.value;
        }

        a.sold += tokensOut;
        a.raisedWei += spend;
        a.lastPriceWei = p;
        IERC20(token).safeTransfer(msg.sender, tokensOut);
        if (msg.value > spend) {
            (bool ok, ) = payable(msg.sender).call{value: msg.value - spend}("");
            require(ok, "refund");
        }
        emit Bought(token, msg.sender, spend, tokensOut, p);
    }

    /// @notice Close the auction: convert raised ETH to the pair token and seed
    ///         the trading pool two-sided around the closing price. Anyone can
    ///         call once the auction has sold out or expired.
    function finalize(address token) external nonReentrant returns (bytes32 poolId) {
        Auction storage a = auctions[token];
        Listing storage l = listings[token];
        if (a.startTime == 0) revert InvalidParams();
        if (a.finalized) revert AlreadyFinalized();
        if (block.timestamp < a.endTime && a.sold < AUCTION_SUPPLY) revert AuctionLive();
        a.finalized = true;

        address pair = l.pair;
        // 1) Raised ETH -> pair token.
        uint256 pairAmount;
        if (a.raisedWei > 0) {
            weth.deposit{value: a.raisedWei}();
            if (pair == address(weth)) {
                pairAmount = a.raisedWei;
            } else {
                IERC20(address(weth)).forceApprove(address(v3Router), a.raisedWei);
                pairAmount = v3Router.exactInput(
                    ISwapRouterV3H.ExactInputParams({path: a.v3Path, recipient: address(this), amountIn: a.raisedWei, amountOutMinimum: 0})
                );
            }
        }

        // 2) Closing price in pair units per whole token.
        uint256 priceQ; // pair-wei per whole token
        if (pairAmount > 0 && a.raisedWei > 0) {
            // clearing ETH price x realized pair-per-ETH rate
            priceQ = Math.mulDiv(uint256(a.lastPriceWei), pairAmount, a.raisedWei);
        } else {
            // nothing sold: fall back to the $3k floor via the pair USD snapshot
            uint8 pairDec = _tryDecimals(pair);
            priceQ = Math.mulDiv(FLOOR_MCAP_USD_8, 10 ** pairDec, TOTAL_SUPPLY_WHOLE * a.pairUsdPrice8);
        }
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

        // 3a) Unsold tokens: single-sided on the token side of the price.
        uint256 unsold = TOTAL_SUPPLY - a.sold;
        if (unsold > 0) {
            (int24 tl, int24 tu) = tokenIsCurrency0 ? (alignedEdge + TICK_SPACING, maxTick) : (minTick, alignedEdge);
            uint128 liq = tokenIsCurrency0
                ? LiquidityAmounts.getLiquidityForAmount0(TickMath.getSqrtPriceAtTick(tl), TickMath.getSqrtPriceAtTick(tu), unsold)
                : LiquidityAmounts.getLiquidityForAmount1(TickMath.getSqrtPriceAtTick(tl), TickMath.getSqrtPriceAtTick(tu), unsold);
            if (liq > 0) {
                tokenPositions[token] = Position({tickLower: tl, tickUpper: tu, liquidity: liq});
                poolManager.unlock(abi.encode(uint8(0), abi.encode(key, tl, tu, liq)));
            }
        }

        // 3b) Raised pair tokens: single-sided on the pair side (buy support).
        if (pairAmount > 0) {
            (int24 tl, int24 tu) = tokenIsCurrency0 ? (minTick, alignedEdge) : (alignedEdge + TICK_SPACING, maxTick);
            uint128 liq = tokenIsCurrency0
                ? LiquidityAmounts.getLiquidityForAmount1(TickMath.getSqrtPriceAtTick(tl), TickMath.getSqrtPriceAtTick(tu), pairAmount)
                : LiquidityAmounts.getLiquidityForAmount0(TickMath.getSqrtPriceAtTick(tl), TickMath.getSqrtPriceAtTick(tu), pairAmount);
            if (liq > 0) {
                pairPositions[token] = Position({tickLower: tl, tickUpper: tu, liquidity: liq});
                poolManager.unlock(abi.encode(uint8(0), abi.encode(key, tl, tu, liq)));
            }
        }

        poolId = PoolId.unwrap(key.toId());
        l.poolId = poolId;
        hook.registerPool(key, token, pair, l.creator, l.taxBps, tokenIsCurrency0);
        emit Finalized(token, poolId, a.sold, a.raisedWei, pairAmount);
    }

    // ---------------------------------------------------------------------
    // PoolManager callback: settle whatever the add owes
    // ---------------------------------------------------------------------

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(poolManager), "not pool manager");
        (uint8 action, bytes memory payload) = abi.decode(data, (uint8, bytes));

        if (action == 0) {
            (PoolKey memory key, int24 tl, int24 tu, uint128 liq) = abi.decode(payload, (PoolKey, int24, int24, uint128));
            (BalanceDelta delta, ) = poolManager.modifyLiquidity(
                key, ModifyLiquidityParams({tickLower: tl, tickUpper: tu, liquidityDelta: int256(uint256(liq)), salt: bytes32(0)}), ""
            );
            _settleNegative(key.currency0, delta.amount0());
            _settleNegative(key.currency1, delta.amount1());
            return "";
        }

        (PoolKey memory k2, Position memory pos, address recipient) = abi.decode(payload, (PoolKey, Position, address));
        (BalanceDelta d2, ) = poolManager.modifyLiquidity(
            k2, ModifyLiquidityParams({tickLower: pos.tickLower, tickUpper: pos.tickUpper, liquidityDelta: -int256(uint256(pos.liquidity)), salt: bytes32(0)}), ""
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
        uint256 t; uint256 p;
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
            t += t2; p += p2;
        }
        emit Collected(token, t, p, recipient);
    }

    // ---------------------------------------------------------------------
    // Pricing internals
    // ---------------------------------------------------------------------

    function _tryDecimals(address token) internal view returns (uint8) {
        try IERC20Metadata(token).decimals() returns (uint8 d) {
            return d;
        } catch {
            return 18;
        }
    }

    /// @dev Pool start price aligned to spacing; returns the aligned edge tick
    ///      used to place the two single-sided positions on either side.
    function _poolStart(bool tokenIsCurrency0, uint256 priceQ) internal pure returns (uint160 sqrtPriceX96, int24 alignedEdge) {
        uint160 target = tokenIsCurrency0
            ? uint160(Math.sqrt(Math.mulDiv(priceQ, 1 << 192, 1e18)))
            : uint160(Math.sqrt(Math.mulDiv(1e18, 1 << 192, priceQ)));
        int24 tick = TickMath.getTickAtSqrtPrice(target);
        int24 aligned = (tick / TICK_SPACING) * TICK_SPACING;
        if (tick < 0 && tick % TICK_SPACING != 0) aligned -= TICK_SPACING;
        alignedEdge = aligned;
        // Start exactly between the two books: on the aligned tick for the
        // token-is-0 case mirrors RhFinalFactory's proven placement.
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

    function auctionState(address token)
        external
        view
        returns (uint64 endTime, uint128 price, uint256 sold, uint256 remaining, uint256 raisedWei, bool finalized)
    {
        Auction storage a = auctions[token];
        endTime = a.endTime;
        price = a.startTime == 0 ? 0 : priceNow(token);
        sold = a.sold;
        remaining = AUCTION_SUPPLY - a.sold;
        raisedWei = a.raisedWei;
        finalized = a.finalized;
    }

    receive() external payable {}
}
