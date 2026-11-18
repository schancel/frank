// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IOwedHtlc {
    function claimOwed(address token, address to) external;
}

/// A contract that refuses native coin until told to accept it, then collects what it is owed,
/// to itself or to another address.
contract RejectingRecipient {
    bool public accepting;

    function setAccepting(bool accepting_) external {
        accepting = accepting_;
    }

    function claim(IOwedHtlc htlc, address token) external {
        htlc.claimOwed(token, address(this));
    }

    function claimTo(IOwedHtlc htlc, address token, address to) external {
        htlc.claimOwed(token, to);
    }

    receive() external payable {
        require(accepting, "RejectingRecipient: refused");
    }
}
