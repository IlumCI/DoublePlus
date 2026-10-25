// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IQuiverToken} from "../interfaces/IQuiverToken.sol";

interface IWETHDesk {
    function deposit() external payable;
    function withdraw(uint256) external;
    function transfer(address, uint256) external returns (bool);
}

interface IDeskFactory {
    function curveBuyFeeBps() external view returns (uint16);
    function curveSellFeeBps() external view returns (uint16);
    function creatorCurveShareBps() external view returns (uint16);
    function feePolicyOf(address coin)
        external
        view
        returns (address devWallet, uint16 buyTaxBps, uint16 sellTaxBps, uint16 devBps, uint16 dividendBps, uint16 liquidityBps, uint16 mmBps);
    function listings(address coin) external view returns (address creator, address, uint16, uint64, bytes32);
    function terms(address coin) external view returns (uint16, uint256, address, uint128, uint128, uint8 mode, bool);
    function curveState(address coin)
        external
        view
        returns (uint64, uint128, uint256, uint256, uint256, uint256, bool finalized, bool aborted);
    function buy(address coin, uint256 minTokensOut) external payable returns (uint256);
}

interface IDeskHook {
    function referrerOf(address user) external view returns (address);
    function REFEREE_DISCOUNT_BPS() external view returns (uint16);
    function refShareBps() external view returns (uint16);
    function potShareBps() external view returns (uint16);
    function potTimer() external view returns (uint64);
    function potMinBuyWei() external view returns (uint256);
    function platformTreasury() external view returns (address);
    function modulesOf(address coin) external view returns (uint16, uint16, uint16 jackpotBps, uint16 jackpotEvery, bool, bool);
    function curveDividends(address coin, uint256 amount) external;
}

interface IDeskRouter {
    function buyFor(address coin, bytes calldata v3Path, uint256 minCoinOut, address trader)
        external
        payable
        returns (uint256);
}

/// @title VentureCurveDesk
/// @notice Everything a curve trade pays, from a coin's first trade rather
///         than from graduation. The factory quotes each curve trade here
///         (charge) and forwards the curve fee and the founder tax with it
///         (curveTrade). All of it is paid in WETH, which a recipient can
///         never refuse, so no payout can block a trade.
///
///           - Curve fee: the trader's referrer first, then an open curve's
///             creator share, then the pot's share; the rest to the treasury.
///             Shares and the referee discount are the hook's, so a coin pays
///             by the same rules on the curve as in its pool.
///           - Founder tax, by the coin's own policy: dev and dividends are
///             paid at once (dividends to the dev while no holder is
///             eligible), the jackpot module's share builds the coin's
///             jackpot, and the liquidity and market-making shares build its
///             buyback.
///           - Pot: each buy of at least the hook's potMinBuyWei takes the
///             lead and restarts the hook's potTimer; when it runs out the
///             leader wins, paid on the next trade or by claimPot.
///           - Jackpot: every Nth qualifying buy (one per signer per block)
///             wins it.
///           - Buyback (fire): anyone can spend a coin's buyback on the coin
///             and burn what it buys: on an open curve through the factory,
///             after graduation through the router. A target raise's buyback
///             waits for graduation, and a failed raise's goes to the dev
///             wallet, as does a jackpot nobody won by then (graduation adds
///             it to the buyback).
contract VentureCurveDesk is ReentrancyGuard {
    uint256 private constant BPS = 10_000;

    IWETHDesk public immutable weth;
    address private immutable _deployer;
    IDeskFactory public factory;
    IDeskHook public hook;
    IDeskRouter public router;

    struct Pot {
        uint128 eth;
        uint64 deadline;
        address leader;
    }

    struct Jackpot {
        uint128 eth;
        uint64 buys;
    }

    mapping(address coin => Pot) public potOf;
    mapping(address coin => Jackpot) public jackpotOf;
    mapping(address coin => uint256) public buybackOf;
    mapping(bytes32 => uint256) private _countedAt; // keccak(coin, tx.origin) => block

    event CurveCharged(
        address indexed coin, address indexed trader, address indexed referrer, bool isBuy, uint256 fee, uint256 tax, uint256 toReferrer, uint256 toCreator, uint256 toPot
    );
    event TaxSplit(address indexed coin, uint256 dev, uint256 dividends, uint256 jackpot, uint256 buyback);
    event PotLeader(address indexed coin, address indexed leader, uint64 deadline);
    event PotWon(address indexed coin, address indexed winner, uint256 amount);
    event JackpotWon(address indexed coin, address indexed winner, uint256 amount, uint64 buyNumber);
    event Buyback(address indexed coin, uint256 ethIn, uint256 burned);

    error NotFactory();
    error AlreadyInit();
    error NothingToFire();
    error RaiseOpen();
    error PotNotWon();

    constructor(address weth_) {
        weth = IWETHDesk(weth_);
        _deployer = msg.sender;
    }

    /// @notice One-time wiring, by the deployer: the factory and hook are
    ///         deployed with this desk's address, the router after them.
    function init(IDeskFactory factory_, IDeskHook hook_, IDeskRouter router_) external {
        if (msg.sender != _deployer || address(factory) != address(0)) revert AlreadyInit();
        factory = factory_;
        hook = hook_;
        router = router_;
    }

    /// @notice What a curve trade of `amount` wei pays: the curve fee (less
    ///         the referee discount when `trader` has a referrer) and the
    ///         coin's founder tax for that side.
    function charge(address coin, address trader, uint256 amount, bool isBuy)
        external
        view
        returns (uint256 fee, uint256 tax)
    {
        fee = (amount * (isBuy ? factory.curveBuyFeeBps() : factory.curveSellFeeBps())) / BPS;
        if (hook.referrerOf(trader) != address(0)) fee -= (fee * hook.REFEREE_DISCOUNT_BPS()) / BPS;
        (, uint16 buyTax, uint16 sellTax,,,,) = factory.feePolicyOf(coin);
        tax = (amount * (isBuy ? buyTax : sellTax)) / BPS;
    }

    /// @notice Called by the factory on every curve trade, with the curve fee
    ///         and the founder tax as value. `size` is a buy's ETH into the
    ///         curve (0 on a sell).
    function curveTrade(address coin, address trader, bool isBuy, uint256 fee, uint256 size) external payable {
        if (msg.sender != address(factory)) revert NotFactory();
        weth.deposit{value: msg.value}();
        _payPot(coin);

        address ref = hook.referrerOf(trader);
        uint256 toRef;
        if (ref != address(0) && ref != trader) {
            toRef = (fee * hook.refShareBps()) / BPS;
            _send(ref, toRef);
        }
        uint256 toCreator;
        (,,,,, uint8 mode,) = factory.terms(coin);
        if (mode == 1) {
            toCreator = (fee * factory.creatorCurveShareBps()) / BPS;
            (address creator,,,,) = factory.listings(coin);
            _send(creator, toCreator);
        }
        uint256 toPot = (fee * hook.potShareBps()) / BPS;
        Pot storage p = potOf[coin];
        p.eth += uint128(toPot);
        _send(hook.platformTreasury(), fee - toRef - toCreator - toPot);

        uint256 tax = msg.value - fee;
        (,, uint16 jackpotBps, uint16 jackpotEvery,,) = hook.modulesOf(coin);
        if (tax > 0) _splitTax(coin, tax, jackpotBps);

        // The desk's own buybacks never lead the pot or count for the jackpot.
        if (isBuy && trader != address(this) && size >= hook.potMinBuyWei()) {
            uint64 deadline = uint64(block.timestamp) + hook.potTimer();
            p.leader = trader;
            p.deadline = deadline;
            emit PotLeader(coin, trader, deadline);
            if (jackpotEvery > 0) _countJackpot(coin, trader, jackpotEvery);
        }
        emit CurveCharged(coin, trader, ref, isBuy, fee, tax, toRef, toCreator, toPot);
    }

    function _splitTax(address coin, uint256 tax, uint16 jackpotBps) private {
        (address dev,,, uint16 devBps, uint16 dividendBps,,) = factory.feePolicyOf(coin);
        uint256 toDev = (tax * devBps) / BPS;
        uint256 toDividends = (tax * dividendBps) / BPS;
        uint256 toJackpot = (tax * jackpotBps) / BPS;
        uint256 toBuyback = tax - toDev - toDividends - toJackpot;
        if (toDividends > 0) {
            if (IQuiverToken(coin).eligibleSupply() == 0) {
                toDev += toDividends;
                toDividends = 0;
            } else {
                weth.transfer(coin, toDividends);
                hook.curveDividends(coin, toDividends);
            }
        }
        _send(dev, toDev);
        if (toJackpot > 0) jackpotOf[coin].eth += uint128(toJackpot);
        buybackOf[coin] += toBuyback;
        emit TaxSplit(coin, toDev, toDividends, toJackpot, toBuyback);
    }

    function _payPot(address coin) private {
        Pot memory p = potOf[coin];
        if (p.leader == address(0) || block.timestamp < p.deadline) return;
        delete potOf[coin];
        _send(p.leader, p.eth);
        emit PotWon(coin, p.leader, p.eth);
    }

    /// @notice Pay out a won pot on a coin nobody is trading.
    function claimPot(address coin) external nonReentrant {
        Pot memory p = potOf[coin];
        if (p.leader == address(0) || block.timestamp < p.deadline) revert PotNotWon();
        _payPot(coin);
    }

    function _countJackpot(address coin, address trader, uint16 every) private {
        // One counted buy per signer per block, so one contract can't loop the
        // remaining buys inside a single transaction and take every jackpot.
        bytes32 k = keccak256(abi.encode(coin, tx.origin));
        if (_countedAt[k] == block.number) return;
        _countedAt[k] = block.number;
        Jackpot memory j = jackpotOf[coin];
        j.buys += 1;
        if (j.buys % every != 0) {
            jackpotOf[coin].buys = j.buys;
            return;
        }
        jackpotOf[coin] = Jackpot(0, j.buys);
        _send(trader, j.eth);
        emit JackpotWon(coin, trader, j.eth, j.buys);
    }

    /// @notice Spend a coin's buyback on the coin and burn what it buys.
    ///         `minOut` is the least the buy may return, in token-wei.
    function fire(address coin, uint256 minOut) external nonReentrant returns (uint256 burned) {
        uint256 amt = buybackOf[coin];
        buybackOf[coin] = 0;
        (,,,,,, bool finalized, bool aborted) = factory.curveState(coin);
        if (finalized || aborted) {
            amt += jackpotOf[coin].eth;
            jackpotOf[coin].eth = 0;
        }
        if (amt == 0) revert NothingToFire();
        if (aborted) {
            (address dev,,,,,,) = factory.feePolicyOf(coin);
            _send(dev, amt);
            return 0;
        }
        weth.withdraw(amt);
        if (finalized) {
            // trader 0: a buyback earns no referral and never leads the pot.
            burned = router.buyFor{value: amt}(coin, "", minOut, address(0));
        } else {
            (,,,,, uint8 mode,) = factory.terms(coin);
            if (mode != 1) revert RaiseOpen();
            burned = factory.buy{value: amt}(coin, minOut);
            // A buy that fills the curve returns what the curve didn't take.
            uint256 back = address(this).balance;
            if (back > 0) {
                weth.deposit{value: back}();
                buybackOf[coin] += back;
                amt -= back;
            }
        }
        IQuiverToken(coin).burn(burned);
        emit Buyback(coin, amt, burned);
    }

    function _send(address to, uint256 amount) private {
        if (amount > 0) weth.transfer(to, amount);
    }

    receive() external payable {}
}
