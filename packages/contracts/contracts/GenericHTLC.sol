// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title GenericHTLC
 * @notice Universal Hash Time Locked Contract supporting atomic cross-chain swaps,
 * batch sweeps, multi-party group table escrows, and explicit refund addresses.
 * Supports both sha256 (eCash/Bitcoin standard) and keccak256 (EVM standard) hashlocks.
 */
contract GenericHTLC {
    struct Lock {
        address sender;
        address recipient;
        address refundAddress;
        bytes32 hashLock;
        uint256 amount;
        uint256 expiresAt;
        bool withdrawn;
        bool refunded;
    }

    struct Payout {
        address recipient;
        uint256 amount;
    }

    mapping(bytes32 => Lock) public locks;

    // Reentrancy guard
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status = _NOT_ENTERED;

    modifier nonReentrant() {
        require(_status != _ENTERED, "ReentrancyGuard: reentrant call");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    event Locked(
        bytes32 indexed lockId,
        address indexed sender,
        address indexed recipient,
        address refundAddress,
        bytes32 hashLock,
        uint256 amount,
        uint256 expiresAt
    );

    event Withdrawn(
        bytes32 indexed lockId,
        address indexed recipient,
        bytes preimage
    );

    event BatchDistributed(
        bytes32[] lockIds,
        Payout[] payouts,
        bytes preimage
    );

    event Refunded(
        bytes32 indexed lockId,
        address indexed refundAddress,
        uint256 amount
    );

    error LockAlreadyExists();
    error LockNotFound();
    error AlreadyWithdrawn();
    error AlreadyRefunded();
    error LockExpired();
    error LockNotExpired();
    error InvalidPreimage();
    error InvalidZeroAddress();
    error TransferFailed();
    error ZeroAmount();
    error InvalidPayoutSum();
    error EmptyBatch();

    /**
     * @notice Locks funds with a cryptographic hashlock, explicit refund address, and expiry timeout.
     * @param lockId Unique lock identifier.
     * @param recipient Address entitled to claim funds upon revealing preimage.
     * @param refundAddress Explicit destination address to receive funds upon timelock expiry.
     * @param hashLock Cryptographic hash commitment (sha256 or keccak256).
     * @param duration Lock duration in seconds until refund activates.
     */
    function lock(
        bytes32 lockId,
        address recipient,
        address refundAddress,
        bytes32 hashLock,
        uint256 duration
    ) public payable nonReentrant {
        if (locks[lockId].sender != address(0)) revert LockAlreadyExists();
        if (recipient == address(0)) revert InvalidZeroAddress();
        if (msg.value == 0) revert ZeroAmount();
        if (duration == 0) revert LockExpired();

        address destRefund = refundAddress == address(0) ? msg.sender : refundAddress;

        locks[lockId] = Lock({
            sender: msg.sender,
            recipient: recipient,
            refundAddress: destRefund,
            hashLock: hashLock,
            amount: msg.value,
            expiresAt: block.timestamp + duration,
            withdrawn: false,
            refunded: false
        });

        emit Locked(
            lockId,
            msg.sender,
            recipient,
            destRefund,
            hashLock,
            msg.value,
            block.timestamp + duration
        );
    }

    /**
     * @notice Backward-compatible lock overload defaulting refundAddress to msg.sender.
     */
    function lock(
        bytes32 lockId,
        address recipient,
        bytes32 hashLock,
        uint256 duration
    ) external payable {
        lock(lockId, recipient, msg.sender, hashLock, duration);
    }

    /**
     * @notice Withdraws locked funds to recipient by revealing the secret preimage.
     * Can be invoked by anyone (or recipient), but payout is strictly sent to lock.recipient.
     * @param lockId Unique lock identifier.
     * @param preimage Secret bytes whose sha256 or keccak256 matches lock.hashLock.
     */
    function withdraw(bytes32 lockId, bytes calldata preimage) external nonReentrant {
        _withdrawInternal(lockId, preimage);
    }

    /**
     * @notice Batch-withdraws multiple locks sharing the same preimage in one atomic transaction.
     * Each lock's amount is delivered directly to its designated lock.recipient.
     * @param lockIds Array of lock identifiers.
     * @param preimage Secret bytes unlocking all specified locks.
     */
    function batchWithdraw(bytes32[] calldata lockIds, bytes calldata preimage) external nonReentrant {
        if (lockIds.length == 0) revert EmptyBatch();
        for (uint256 i = 0; i < lockIds.length; i++) {
            _withdrawInternal(lockIds[i], preimage);
        }
    }

    /**
     * @notice Multi-winner distribution for group table escrows and tournaments.
     * Pools multiple locks sharing the same preimage and distributes funds directly
     * to a list of recipients and amounts in a single atomic transaction.
     * Any dust or remainder returns to the first lock's refund address.
     * @param lockIds Array of participant lock identifiers.
     * @param payouts Array of recipient addresses and their respective amounts.
     * @param preimage Secret bytes unlocking all specified locks.
     */
    function batchDistribute(
        bytes32[] calldata lockIds,
        Payout[] calldata payouts,
        bytes calldata preimage
    ) external nonReentrant {
        if (lockIds.length == 0 || payouts.length == 0) revert EmptyBatch();

        uint256 totalPool = 0;
        for (uint256 i = 0; i < lockIds.length; i++) {
            Lock storage l = locks[lockIds[i]];
            if (l.sender == address(0)) revert LockNotFound();
            if (l.withdrawn) revert AlreadyWithdrawn();
            if (l.refunded) revert AlreadyRefunded();

            if (sha256(preimage) != l.hashLock && keccak256(preimage) != l.hashLock) {
                revert InvalidPreimage();
            }

            l.withdrawn = true;
            totalPool += l.amount;
        }

        uint256 totalPayout = 0;
        for (uint256 j = 0; j < payouts.length; j++) {
            if (payouts[j].recipient == address(0)) revert InvalidZeroAddress();
            if (payouts[j].amount == 0) revert ZeroAmount();
            totalPayout += payouts[j].amount;

            (bool pSuccess, ) = payable(payouts[j].recipient).call{value: payouts[j].amount}("");
            if (!pSuccess) revert TransferFailed();
        }

        if (totalPayout > totalPool) revert InvalidPayoutSum();

        // Any leftover remainder returns to the primary refund address
        uint256 remainder = totalPool - totalPayout;
        if (remainder > 0) {
            address refundDest = locks[lockIds[0]].refundAddress;
            (bool remSuccess, ) = payable(refundDest).call{value: remainder}("");
            if (!remSuccess) revert TransferFailed();
        }

        emit BatchDistributed(lockIds, payouts, preimage);
    }

    /**
     * @notice Refunds locked funds to the explicit refundAddress after timelock expires.
     * Completely prevents stranded funds when locks are funded from ephemeral addresses.
     * @param lockId Unique lock identifier.
     */
    function refund(bytes32 lockId) external nonReentrant {
        Lock storage l = locks[lockId];
        if (l.sender == address(0)) revert LockNotFound();
        if (l.withdrawn) revert AlreadyWithdrawn();
        if (l.refunded) revert AlreadyRefunded();
        if (block.timestamp < l.expiresAt) revert LockNotExpired();

        l.refunded = true;
        uint256 amount = l.amount;

        (bool success, ) = payable(l.refundAddress).call{value: amount}("");
        if (!success) revert TransferFailed();

        emit Refunded(lockId, l.refundAddress, amount);
    }

    function _withdrawInternal(bytes32 lockId, bytes calldata preimage) internal {
        Lock storage l = locks[lockId];
        if (l.sender == address(0)) revert LockNotFound();
        if (l.withdrawn) revert AlreadyWithdrawn();
        if (l.refunded) revert AlreadyRefunded();

        // Support both sha256 and keccak256
        if (sha256(preimage) != l.hashLock && keccak256(preimage) != l.hashLock) {
            revert InvalidPreimage();
        }

        l.withdrawn = true;
        uint256 amount = l.amount;

        (bool success, ) = payable(l.recipient).call{value: amount}("");
        if (!success) revert TransferFailed();

        emit Withdrawn(lockId, l.recipient, preimage);
    }
}
