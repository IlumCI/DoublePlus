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

import {FlywheelHook} from "../robinhood/FlywheelHook.sol";
import {IB20FactoryMin, IB20TokenMin} from "./IB20Min.sol";

/// @title B20FlyFactory
/// @notice Base-chain launcher for the flywheel model. Every coin is a native
///         B-20 token minted through Base's B20Factory precompile: fixed 1B
///         supply, admin renounced at birth, with only the ownerless hook
///         holding BURN_ROLE for the weekly buyback burns. Coins pair against
///         WETH or a curated B20/wrapped stock token (creator's choice), seed
///         single-sided at a ~$3,000 start cap, and support an atomic dev buy.
interface IWETHLike {
    function deposit() external payable;
}

contract B20FlyFactory is Ownable, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;
    uint256 public constant TOTAL_SUPPLY_WHOLE = 1_000_000_000;
    uint256 public constant INITIAL_MARKET_CAP_USD_8 = 3_000 * 1e8;
    int24 public constant TICK_SPACING = 60;
    uint24 public constant LP_FEE = 0;
    uint16 public constant MAX_TAX_BPS = 1000;

    IPoolManager public immutable poolManager;
    FlywheelHook public immutable hook;
    address public immutable weth;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    IB20FactoryMin public immutable b20Factory;

    /// @notice Launch metadata (logo, description, links) per coin; B-20
    ///         tokens carry no metadataURI so the factory is the registry.
    mapping(address token => string) public metadataURIOf;


    /// @dev Locked to the curated pair list. The flywheel hook accounts in
    ///      WETH, so stock pairs stay unlistable until the stock-aware hook
    ///      ships; protocolAdmin lists pairs, never arbitrary ones.
    bool public anyPairEnabled = false;
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

    constructor(address owner_, address protocolAdmin_, IPoolManager poolManager_, FlywheelHook hook_, address weth_, IB20FactoryMin b20Factory_) Ownable(owner_) {
        weth = weth_;
        require(address(b20Factory_) != address(0), "b20=0");
        b20Factory = b20Factory_;
        require(protocolAdmin_ != address(0), "admin=0");
        protocolAdmin = protocolAdmin_;
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
        if (p.taxBps != 100) revert InvalidParams();

        bytes memory createParams = abi.encode(
            IB20FactoryMin.B20AssetCreateParams({
                version: 1,
                name: p.name,
                symbol: p.symbol,
                initialAdmin: address(this),
                decimals: 18
            })
        );
        token = b20Factory.createB20(
            IB20FactoryMin.B20Variant.ASSET, salt, createParams, new bytes[](0)
        );
        IB20TokenMin b20 = IB20TokenMin(token);
        b20.grantRole(b20.MINT_ROLE(), address(this));
        b20.mint(address(this), TOTAL_SUPPLY);
        b20.revokeRole(b20.MINT_ROLE(), address(this));
        b20.grantRole(b20.BURN_ROLE(), address(hook));
        b20.renounceLastAdmin();
        metadataURIOf[token] = p.metadataURI;
        if (token == p.pair) revert BadPair();

        bool tokenIsCurrency0 = token < p.pair;
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(tokenIsCurrency0 ? token : p.pair),
            currency1: Currency.wrap(tokenIsCurrency0 ? p.pair : token),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });


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
