// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IHtlc {
    function withdraw(bytes32 lockId, bytes calldata preimage) external;
}

/// A lock recipient that, when paid, tries to withdraw a second lock from inside the payment.
contract ReentrantRecipient {
    IHtlc public immutable htlc;
    bytes32 public secondLockId;
    bytes public preimage;
    bool public attempted;
    bool public reentrySucceeded;

    constructor(IHtlc htlc_) {
        htlc = htlc_;
    }

    function arm(bytes32 secondLockId_, bytes calldata preimage_) external {
        secondLockId = secondLockId_;
        preimage = preimage_;
    }

    receive() external payable {
        if (attempted) return;
        attempted = true;
        try htlc.withdraw(secondLockId, preimage) {
            reentrySucceeded = true;
        } catch {}
    }
}
