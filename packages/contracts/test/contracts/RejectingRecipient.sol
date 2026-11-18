// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IOwedHtlc {
    function claimOwed(address token) external;
}

/// A contract that refuses native coin until told to accept it, then collects what it is owed.
contract RejectingRecipient {
    bool public accepting;

    function setAccepting(bool accepting_) external {
        accepting = accepting_;
    }

    function claim(IOwedHtlc htlc, address token) external {
        htlc.claimOwed(token);
    }

    receive() external payable {
        require(accepting, "RejectingRecipient: refused");
    }
}
