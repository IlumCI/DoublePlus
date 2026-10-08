// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IVentureRouterFor} from "./VentureLimitOrders.sol";
import {ISwapRouterV3} from "./VentureRouter.sol";

interface IWETH9 {
    function withdraw(uint256) external;
}

interface IPayoutToken {
    function claimForAgent(address holder) external returns (uint256);
    function rewardToken() external view returns (address);
}

/// @title VenturePayouts
/// @notice Pays a 5x-tier holder's dividends in what they choose: ETH, more of
///         the coin itself, or any token one Uniswap V3 route away from WETH
///         (a stablecoin, a tokenized stock). The holder points a coin's
///         payoutAgent here and records a preference; from then on the keeper
///         (or the holder) collects and converts. Funds only ever leave toward
///         the holder, and every conversion carries a minimum out.
contract VenturePayouts is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    enum Kind { Eth, Coin, Route }

    struct Pref {
        Kind kind;
        bytes path; // Route only: V3 path WETH -> ... -> asset
    }

    IVentureRouterFor public immutable router;
    ISwapRouterV3 public immutable v3Router;
    address public immutable weth;
    address public keeper;

    mapping(address holder => Pref) internal _prefOf;

    event PrefSet(address indexed holder, Kind kind, bytes path);
    event Paid(address indexed coin, address indexed holder, Kind kind, uint256 rewardIn, uint256 out);
    event KeeperSet(address keeper);

    error NotAllowed();
    error BadRoute();
    error PayFailed();

    constructor(IVentureRouterFor router_, ISwapRouterV3 v3Router_, address weth_, address keeper_) Ownable(msg.sender) {
        router = router_;
        v3Router = v3Router_;
        weth = weth_;
        keeper = keeper_;
    }

    receive() external payable {
        if (msg.sender != weth) revert NotAllowed();
    }

    function setKeeper(address k) external onlyOwner {
        keeper = k;
        emit KeeperSet(k);
    }

    function setPref(Kind kind, bytes calldata path) external {
        if (kind == Kind.Route) {
            // tokenIn(20) [fee(3) token(20)]+, starting at WETH
            if (path.length < 43 || (path.length - 20) % 23 != 0 || address(bytes20(path[:20])) != weth) revert BadRoute();
        } else if (path.length != 0) {
            revert BadRoute();
        }
        _prefOf[msg.sender] = Pref(kind, path);
        emit PrefSet(msg.sender, kind, path);
    }

    function prefOf(address holder) external view returns (Kind kind, bytes memory path) {
        Pref storage p = _prefOf[holder];
        return (p.kind, p.path);
    }

    /// @notice Collect and convert one holder's rewards on one coin. The holder
    ///         may always call it for themselves; anyone else must be the keeper.
    function collect(address coin, address holder, uint256 minOut) external nonReentrant returns (uint256) {
        if (msg.sender != holder && msg.sender != keeper) revert NotAllowed();
        return _collect(coin, holder, minOut);
    }

    /// @notice Keeper batch; a holder whose collection fails is skipped.
    function collectMany(address coin, address[] calldata holders, uint256[] calldata minOuts) external {
        if (msg.sender != keeper) revert NotAllowed();
        for (uint256 i; i < holders.length; ++i) {
            try this.collectOne(coin, holders[i], minOuts[i]) {} catch {}
        }
    }

    function collectOne(address coin, address holder, uint256 minOut) external nonReentrant returns (uint256) {
        if (msg.sender != address(this)) revert NotAllowed();
        return _collect(coin, holder, minOut);
    }

    function _collect(address coin, address holder, uint256 minOut) private returns (uint256 out) {
        IPayoutToken t = IPayoutToken(coin);
        if (t.rewardToken() != weth) revert BadRoute();
        uint256 amount = t.claimForAgent(holder);
        if (amount == 0) return 0;
        Pref memory p = _prefOf[holder];
        if (p.kind == Kind.Route) {
            IERC20(weth).forceApprove(address(v3Router), amount);
            out = v3Router.exactInput(
                ISwapRouterV3.ExactInputParams({path: p.path, recipient: holder, amountIn: amount, amountOutMinimum: minOut})
            );
        } else {
            IWETH9(weth).withdraw(amount);
            if (p.kind == Kind.Coin) {
                out = router.buyFor{value: amount}(coin, "", minOut, holder);
                IERC20(coin).safeTransfer(holder, out);
            } else {
                out = amount;
                (bool ok,) = payable(holder).call{value: amount}("");
                if (!ok) revert PayFailed();
            }
        }
        emit Paid(coin, holder, p.kind, amount, out);
    }
}
