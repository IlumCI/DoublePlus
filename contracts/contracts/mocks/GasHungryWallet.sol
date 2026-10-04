// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Test double for a wallet whose receive burns more gas than a capped
///         push forwards: it accepts ETH from a full-gas call but not from one
///         limited to 50k. Forwards arbitrary calls so it can act as a buyer.
contract GasHungryWallet {
    mapping(uint256 => uint256) private sink;
    uint256 private next;

    function exec(address target, bytes calldata data) external payable returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call{value: msg.value}(data);
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
        return ret;
    }

    receive() external payable {
        // Fresh slots every time: three cold writes, well past 50k gas.
        for (uint256 i; i < 3; i++) sink[next++] = msg.value + 1;
    }
}
