// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title GenericHTLC
 * @notice Universal Hash Time-Locked Contract (HTLC) for atomic swaps and escrows.
 * @dev Supports both Keccak256 (EVM native) and SHA256 (Bitcoin, Lightning, cross-chain standard)
 *      hashlocks with unilateral timelock refunds.
 */
contract GenericHTLC {
    // -------------------------------------------------------------------------
    // Storage & Types
    // -------------------------------------------------------------------------

    struct Lock {
        address sender;
        address recipient;
        uint256 amount;
        bytes32 hashLock;
        uint256 expiresAt;
        bool withdrawn;
        bool refunded;
        bytes preimage;
    }

    /// @notice lockId => Lock details
    mapping(bytes32 => Lock) public locks;

    // Reentrancy guard
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event HTLCLocked(
        bytes32 indexed lockId,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        bytes32 hashLock,
        uint256 expiresAt
    );

    event HTLCWithdrawn(
        bytes32 indexed lockId,
        address indexed recipient,
        bytes preimage,
        uint256 amount
    );

    event HTLCRefunded(
        bytes32 indexed lockId,
        address indexed sender,
        uint256 amount
    );

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error LockAlreadyExists();
    error LockDoesNotExist();
    error AlreadyWithdrawn();
    error AlreadyRefunded();
    error LockExpired();
    error LockNotExpired();
    error ZeroAmount();
    error ZeroRecipient();
    error ZeroDuration();
    error InvalidPreimage();
    error LengthMismatch();
    error TransferFailed();
    error ReentrantCall();

    // -------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------

    modifier nonReentrant() {
        if (_status == _ENTERED) revert ReentrantCall();
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    constructor() {
        _status = _NOT_ENTERED;
    }

    // -------------------------------------------------------------------------
    // HTLC Operations
    // -------------------------------------------------------------------------

    /**
     * @notice Lock funds under a hashlock and timelock.
     * @param lockId Unique 32-byte identifier for the lock.
     * @param recipient Address entitled to claim funds with the preimage.
     * @param hashLock The hash of the preimage (either keccak256 or sha256).
     * @param duration Time in seconds until the sender can unilaterally refund.
     */
    function lock(
        bytes32 lockId,
        address recipient,
        bytes32 hashLock,
        uint256 duration
    ) external payable nonReentrant {
        if (msg.value == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroRecipient();
        if (duration == 0) revert ZeroDuration();
        if (locks[lockId].expiresAt != 0) revert LockAlreadyExists();

        uint256 expiresAt = block.timestamp + duration;

        locks[lockId] = Lock({
            sender: msg.sender,
            recipient: recipient,
            amount: msg.value,
            hashLock: hashLock,
            expiresAt: expiresAt,
            withdrawn: false,
            refunded: false,
            preimage: ""
        });

        emit HTLCLocked(lockId, msg.sender, recipient, msg.value, hashLock, expiresAt);
    }

    /**
     * @notice Withdraw funds by revealing the preimage corresponding to hashLock.
     * @param lockId Lock identifier.
     * @param preimage Secret preimage byte array.
     */
    function withdraw(
        bytes32 lockId,
        bytes calldata preimage
    ) public nonReentrant {
        _withdrawInternal(lockId, preimage);
    }

    /**
     * @notice Batch withdraw multiple HTLC locks with their respective preimages.
     * @param lockIds Array of lock identifiers.
     * @param preimages Array of preimages corresponding to each lockId.
     */
    function batchWithdraw(
        bytes32[] calldata lockIds,
        bytes[] calldata preimages
    ) external nonReentrant {
        if (lockIds.length != preimages.length) revert LengthMismatch();
        for (uint256 i = 0; i < lockIds.length; i++) {
            _withdrawInternal(lockIds[i], preimages[i]);
        }
    }

    /**
     * @notice Unilaterally refund funds back to the sender after timelock expiration.
     * @param lockId Lock identifier.
     */
    function refund(bytes32 lockId) external nonReentrant {
        Lock storage l = locks[lockId];
        if (l.expiresAt == 0) revert LockDoesNotExist();
        if (l.withdrawn) revert AlreadyWithdrawn();
        if (l.refunded) revert AlreadyRefunded();
        if (block.timestamp < l.expiresAt) revert LockNotExpired();

        l.refunded = true;
        uint256 amount = l.amount;

        _sendEther(l.sender, amount);

        emit HTLCRefunded(lockId, l.sender, amount);
    }

    // -------------------------------------------------------------------------
    // View Functions
    // -------------------------------------------------------------------------

    function getLock(bytes32 lockId) external view returns (Lock memory) {
        return locks[lockId];
    }

    // -------------------------------------------------------------------------
    // Internal Helpers
    // -------------------------------------------------------------------------

    function _withdrawInternal(bytes32 lockId, bytes calldata preimage) internal {
        Lock storage l = locks[lockId];
        if (l.expiresAt == 0) revert LockDoesNotExist();
        if (l.withdrawn) revert AlreadyWithdrawn();
        if (l.refunded) revert AlreadyRefunded();
        if (block.timestamp >= l.expiresAt) revert LockExpired();

        // Check either keccak256 or sha256 to support both EVM native and Bitcoin/Lightning preimages
        if (
            keccak256(preimage) != l.hashLock &&
            sha256(preimage) != l.hashLock
        ) {
            revert InvalidPreimage();
        }

        l.withdrawn = true;
        l.preimage = preimage;
        uint256 amount = l.amount;
        address recipient = l.recipient;

        _sendEther(recipient, amount);

        emit HTLCWithdrawn(lockId, recipient, preimage, amount);
    }

    function _sendEther(address to, uint256 amount) internal {
        (bool success, ) = payable(to).call{value: amount}("");
        if (!success) revert TransferFailed();
    }
}
