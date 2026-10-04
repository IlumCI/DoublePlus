// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Test double for a hostile wallet. It forwards arbitrary calls (so
///         it can buy, sell, refund, launch and withdraw as msg.sender), and
///         when ETH arrives it misbehaves in a configurable way:
///
///           Mode.Reenter  replays `payload` against `target` from inside the
///                         receive, and records whether the reentry succeeded
///           Mode.Revert   refuses the ETH
///           Mode.Burn     burns all forwarded gas
///           Mode.Bomb     returns ~1 MB of data from the fallback, to make a
///                         caller that copies return data run out of gas
///
///         The suite asserts that each mode can only ever hurt the attacker's
///         own transaction, never other users or the escrow.
contract VentureAttacker {
    enum Mode { Accept, Reenter, Revert, Burn, Bomb }

    Mode public mode;
    address public target;
    bytes public payload;
    uint256 public reentries;
    uint256 public reentrySuccesses;
    bytes public lastReentryError;

    function arm(Mode m, address t, bytes calldata p) external {
        mode = m;
        target = t;
        payload = p;
    }

    function exec(address to, bytes calldata data) external payable returns (bytes memory) {
        (bool ok, bytes memory ret) = to.call{value: msg.value}(data);
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
        return ret;
    }

    receive() external payable {
        _misbehave();
    }

    fallback() external payable {
        _misbehave();
    }

    function _misbehave() internal {
        if (mode == Mode.Reenter) {
            reentries++;
            (bool ok, bytes memory err) = target.call(payload);
            if (ok) reentrySuccesses++;
            else lastReentryError = err;
        } else if (mode == Mode.Revert) {
            revert("no thanks");
        } else if (mode == Mode.Burn) {
            while (true) {}
        } else if (mode == Mode.Bomb) {
            assembly { return(0, 1000000) }
        }
    }
}
