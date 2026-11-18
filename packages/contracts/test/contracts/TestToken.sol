// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// A plain ERC-20 for the tests. Anyone can mint, and anyone can stop an address from
/// receiving transfers (as tokens with a deny list do). Not deployed anywhere.
contract TestToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
    }

    function setBlocked(address who, bool value) external {
        blocked[who] = value;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(!blocked[to], "TestToken: blocked");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        require(!blocked[to], "TestToken: blocked");
        allowance[from][msg.sender] -= value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
        return true;
    }
}
