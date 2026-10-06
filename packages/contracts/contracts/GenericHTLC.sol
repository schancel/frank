// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title GenericHTLC
 * @notice Universal Hash Time Locked Contract supporting atomic cross-chain swaps and batch withdrawals.
 * Supports both sha256 (eCash/Bitcoin standard) and keccak256 (EVM standard) hashlocks.
 */
contract GenericHTLC {
    struct Lock {
        address sender;
        address recipient;
        bytes32 hashLock;
        uint256 amount;
        uint256 expiresAt;
        bool withdrawn;
        bool refunded;
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
        bytes32 hashLock,
        uint256 amount,
        uint256 expiresAt
    );

    event Withdrawn(
        bytes32 indexed lockId,
        address indexed recipient,
        bytes preimage
    );

    event Refunded(
        bytes32 indexed lockId,
        address indexed sender,
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

    /**
     * @notice Locks funds with a cryptographic hashlock and expiry timeout.
     * @param lockId Unique lock identifier.
     * @param recipient Address entitled to claim funds upon revealing preimage.
     * @param hashLock Cryptographic hash commitment (sha256 or keccak256).
     * @param duration Lock duration in seconds until refund activates.
     */
    function lock(
        bytes32 lockId,
        address recipient,
        bytes32 hashLock,
        uint256 duration
    ) external payable nonReentrant {
        if (locks[lockId].sender != address(0)) revert LockAlreadyExists();
        if (recipient == address(0)) revert InvalidZeroAddress();
        if (msg.value == 0) revert ZeroAmount();
        if (duration == 0) revert LockExpired();

        locks[lockId] = Lock({
            sender: msg.sender,
            recipient: recipient,
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
            hashLock,
            msg.value,
            block.timestamp + duration
        );
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
     * @param lockIds Array of lock identifiers.
     * @param preimage Secret bytes unlocking all specified locks.
     */
    function batchWithdraw(bytes32[] calldata lockIds, bytes calldata preimage) external nonReentrant {
        for (uint256 i = 0; i < lockIds.length; i++) {
            _withdrawInternal(lockIds[i], preimage);
        }
    }

    /**
     * @notice Refunds locked funds to original sender after timelock expires.
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

        (bool success, ) = payable(l.sender).call{value: amount}("");
        if (!success) revert TransferFailed();

        emit Refunded(lockId, l.sender, amount);
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
