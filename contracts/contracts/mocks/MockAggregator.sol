// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Chainlink-compatible aggregator for tests.
contract MockAggregator {
    int256 public answer;
    uint8 public immutable decimals;

    constructor(int256 answer_, uint8 decimals_) {
        answer = answer_;
        decimals = decimals_;
    }

    function setAnswer(int256 answer_) external {
        answer = answer_;
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (1, answer, block.timestamp, block.timestamp, 1);
    }
}
