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
import {RhHook} from "./RhHook.sol";

/// @title RhFactory
/// @notice One-transaction launcher for the Robinhood-chain launchpad fork.
///         It mints a fixed-supply token and opens a Uniswap V4 pool that pairs
///         the token against a creator-chosen token (a curated Robinhood
///         tokenized stock, or - when the any-pair toggle is on - any onchain
///         token). That paired token is the pool's quote AND the holder reward:
///         80% of every trade fee flows to holders in it (via the hook harvest),
///         20% to the platform.
///
///         The whole supply seeds single-sided at a ~$3,000 starting market
///         cap, sized from a pair-token USD price passed at launch (read off
///         the pair token's own market). Curators can lock the set of pairs to
///         the allowlist by turning the any-pair toggle off.
contract RhFactory is Ownable, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether; // 1e27
    uint256 public constant TOTAL_SUPPLY_WHOLE = 1_000_000_000; // 1e9 tokens
    uint256 public constant INITIAL_MARKET_CAP_USD_8 = 3_000 * 1e8; // $3,000, 8dp
    int24 public constant TICK_SPACING = 60;
    uint24 public constant LP_FEE = 0; // the hook tax is the only fee
    uint16 public constant MAX_TAX_BPS = 1000; // 10%

    IPoolManager public immutable poolManager;
    RhHook public immutable hook;

    /// @notice When true, a creator may pair against ANY onchain token, not
    ///         just an allowlisted one. Curators flip this off to restrict
    ///         launches to the vetted allowlist.
    bool public anyPairEnabled = true;
    bool public launchesPaused;

    struct Listing {
        address creator;
        address pair;
        uint16 taxBps;
        uint64 createdAt;
        bytes32 poolId;
    }

    /// @notice Curated pair/reward tokens (Robinhood stocks + vetted memes).
    ///         Always launchable regardless of the any-pair toggle.
    mapping(address pair => bool) public pairListed;

    mapping(address token => Listing) public listings;
    address[] public allTokens;
    mapping(address creator => address[]) internal _tokensByCreator;

    struct Position {
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity; // remaining factory-held liquidity
    }
    mapping(address token => Position) public positions;

    struct LaunchParams {
        string name;
        string symbol;
        string metadataURI;
        address pair; // pair + reward token
        uint16 taxBps; // 0..1000
        uint256 pairUsdPrice8; // USD price of one whole pair token, 8dp
    }

    event Launched(
        address indexed token,
        address indexed creator,
        address indexed pair,
        uint16 taxBps,
        bytes32 poolId
    );
    event PairListed(address indexed pair);
    event PairDelisted(address indexed pair);
    event AnyPairSet(bool enabled);
    event PositionUnwound(
        address indexed token,
        uint128 liquidityRemoved,
        uint256 tokenAmount,
        uint256 pairAmount,
        address indexed recipient
    );
    event LaunchesPausedSet(bool paused);

    error LaunchesPaused();
    error InvalidParams();
    error PairNotAllowed();
    error BadPair();
    error BadVanity();
    error NotProtocolAdmin();

    /// @notice Permanent protocol administrator. The ONLY privilege that
    ///         survives `renounceOwnership()`: it gates `unwindPosition` and is
    ///         independent of Ownable's `owner()`. Immutable, set once.
    address public immutable protocolAdmin;

    modifier onlyProtocolAdmin() {
        if (msg.sender != protocolAdmin) revert NotProtocolAdmin();
        _;
    }

    constructor(
        address owner_,
        address protocolAdmin_,
        IPoolManager poolManager_,
        RhHook hook_
    ) Ownable(owner_) {
        require(protocolAdmin_ != address(0), "admin=0");
        protocolAdmin = protocolAdmin_;
        poolManager = poolManager_;
        hook = hook_;
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function listPair(address pair) external onlyOwner {
        require(pair != address(0), "pair=0");
        pairListed[pair] = true;
        emit PairListed(pair);
    }

    function delistPair(address pair) external onlyOwner {
        pairListed[pair] = false;
        emit PairDelisted(pair);
    }

    function setAnyPairEnabled(bool enabled) external onlyOwner {
        anyPairEnabled = enabled;
        emit AnyPairSet(enabled);
    }

    function setLaunchesPaused(bool paused) external onlyOwner {
        launchesPaused = paused;
        emit LaunchesPausedSet(paused);
    }

    // ---------------------------------------------------------------------
    // Launch
    // ---------------------------------------------------------------------

    /// @param salt CREATE2 salt, mined off-chain so the token address ends in
    ///        0x4663 and sorts on the intended side of the pair.
    function launch(LaunchParams calldata p, bytes32 salt)
        external
        nonReentrant
        returns (address token, bytes32 poolId)
    {
        if (launchesPaused) revert LaunchesPaused();
        if (bytes(p.name).length == 0 || bytes(p.symbol).length == 0) revert InvalidParams();
        if (p.taxBps > MAX_TAX_BPS) revert InvalidParams();
        if (p.pairUsdPrice8 == 0) revert InvalidParams();
        _checkPair(p.pair);

        // 1. Mint the token via CREATE2; the factory holds the whole supply.
        //    The pair token doubles as the reward token.
        QuiverToken qt = new QuiverToken{salt: salt}(
            p.name,
            p.symbol,
            p.metadataURI,
            TOTAL_SUPPLY,
            msg.sender,
            address(this),
            p.taxBps,
            p.pair
        );
        token = address(qt);
        if (uint160(token) & 0xffff != 0x4663) revert BadVanity();
        if (token == p.pair) revert BadPair();

        // 2. Pair the token against the chosen token; currencies sort by address.
        bool tokenIsCurrency0 = token < p.pair;
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(tokenIsCurrency0 ? token : p.pair),
            currency1: Currency.wrap(tokenIsCurrency0 ? p.pair : token),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });

        // 3. Exclude the pool endpoints from dividends, wire the hook.
        address[] memory ex = new address[](2);
        ex[0] = address(poolManager);
        ex[1] = address(this);
        qt.initHook(address(hook), ex);

        // 4. Price the pool at the $3,000 start cap and seed the full supply
        //    single-sided (token only) in the range adjacent to spot.
        uint256 priceQ = _priceQ(p.pair, p.pairUsdPrice8);
        (uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper) = _initialPosition(tokenIsCurrency0, priceQ);
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

        // 5. Register with the hook so trades are taxed and rewarded.
        poolId = PoolId.unwrap(key.toId());
        hook.registerPool(key, token, p.pair, msg.sender, p.taxBps, tokenIsCurrency0);

        listings[token] = Listing({
            creator: msg.sender,
            pair: p.pair,
            taxBps: p.taxBps,
            createdAt: uint64(block.timestamp),
            poolId: poolId
        });
        allTokens.push(token);
        _tokensByCreator[msg.sender].push(token);

        emit Launched(token, msg.sender, p.pair, p.taxBps, poolId);
    }

    /// @dev A pair must be a real contract token, and either allowlisted or
    ///      permitted by the any-pair toggle.
    function _checkPair(address pair) internal view {
        if (pair == address(0) || pair.code.length == 0) revert BadPair();
        if (!pairListed[pair] && !anyPairEnabled) revert PairNotAllowed();
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
            // the pair side must net to zero (we deposit no pair token).
            int128 tokenOwed = tokenIsCurrency0 ? delta.amount0() : delta.amount1();
            int128 pairOwed = tokenIsCurrency0 ? delta.amount1() : delta.amount0();
            require(pairOwed >= 0, "pair owed");
            if (tokenOwed < 0) {
                Currency tokenCurrency = tokenIsCurrency0 ? key.currency0 : key.currency1;
                uint256 amt = uint256(uint128(-tokenOwed));
                poolManager.sync(tokenCurrency);
                IERC20(Currency.unwrap(tokenCurrency)).safeTransfer(address(poolManager), amt);
                poolManager.settle();
            }
            return "";
        }

        // action 1 = unwind: remove `removed` liquidity, send token + pair to recipient.
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
        (uint256 tokenAmount, uint256 pairAmount) = tokenIsCurrency0 ? (amt0, amt1) : (amt1, amt0);
        return abi.encode(tokenAmount, pairAmount);
    }

    function _takePositive(Currency currency, int128 amount, address to) internal returns (uint256 value) {
        if (amount <= 0) return 0;
        value = uint256(uint128(amount));
        poolManager.take(currency, to, value);
    }

    // ---------------------------------------------------------------------
    // Liquidity unwind (protocol admin)
    // ---------------------------------------------------------------------

    /// @notice Remove `liquidityBps` of a token's factory-held liquidity and
    ///         send the returned token + pair token to `recipient`. Callable
    ///         ONLY by the immutable `protocolAdmin`; survives ownership
    ///         renounce. A disclosed liquidity-recovery lever.
    function unwindPosition(address token, uint16 liquidityBps, address recipient)
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

        bytes memory res = poolManager.unlock(
            abi.encode(uint8(1), abi.encode(key, pos.tickLower, pos.tickUpper, removed, recipient, tokenIsCurrency0))
        );
        (tokenAmount, pairAmount) = abi.decode(res, (uint256, uint256));
        emit PositionUnwound(token, removed, tokenAmount, pairAmount, recipient);
    }

    // ---------------------------------------------------------------------
    // Pricing
    // ---------------------------------------------------------------------

    /// @dev Pair-token smallest units per one launched-token smallest unit, in
    ///      1e18 fixed point. Derived from the $3,000 start cap and the pair
    ///      token's USD price, generalised to the pair token's decimals.
    ///        tokenUsdPrice(whole) = $3,000 / 1e9
    ///        priceInPair(whole)   = tokenUsdPrice / pairUsdPrice
    ///        priceQ(1e18)         = priceInPair * 10^pairDec / 10^18
    function _priceQ(address pair, uint256 pairUsdPrice8) internal view returns (uint256 priceQ) {
        uint8 pairDec = _tryDecimals(pair);
        // Launched token is 18 decimals, so the 1e18 fixed-point scale and the
        // token's 10^18 cancel, leaving:
        //   priceQ = INITIAL_MARKET_CAP_USD_8 * 10^pairDec
        //            / (TOTAL_SUPPLY_WHOLE * pairUsdPrice8)
        // in units of (pair smallest / token smallest) * 1e18.
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

    /// @dev Initial pool price snapped to a tick, plus the token-only range
    ///      adjacent to it, so the whole supply seeds one side.
    function _initialPosition(bool tokenIsCurrency0, uint256 priceQ)
        internal
        pure
        returns (uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper)
    {
        // sqrtPrice = sqrt(price(token1/token0)) * 2^96. priceQ is pair-per-token
        // in 1e18 fixed point, so it is the token1/token0 price when the token
        // is currency0, and its reciprocal when the token is currency1.
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
