// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IERC20.sol";

/**
 * @title GenericHTLC
 * @notice Universal Hash Time Locked Contract supporting atomic cross-chain swaps,
 * batch sweeps, multi-party group table escrows, explicit refund addresses,
 * ERC-20 tokens, and EIP-2612 atomic permits.
 * Supports both sha256 (eCash/Bitcoin standard) and keccak256 (EVM standard) hashlocks.
 */
contract GenericHTLC {
    struct Lock {
        address sender;
        address recipient;
        address refundAddress;
        address token;
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
        address indexed token,
        address recipient,
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
    error TokenMismatch();
    error Unauthorized();

    /**
     * @notice Locks funds (native coin or ERC-20 token) with a cryptographic hashlock, explicit refund address, and expiry timeout.
     * @param lockId Unique lock identifier.
     * @param recipient Address entitled to claim funds upon revealing preimage.
     * @param refundAddress Explicit destination address to receive funds upon timelock expiry.
     * @param token Address of ERC-20 token, or address(0) for native ETH/MON.
     * @param amount Quantity of tokens/native coins to lock.
     * @param hashLock Cryptographic hash commitment (sha256 or keccak256).
     * @param duration Lock duration in seconds until refund activates.
     */
    function lock(
        bytes32 lockId,
        address recipient,
        address refundAddress,
        address token,
        uint256 amount,
        bytes32 hashLock,
        uint256 duration
    ) public payable nonReentrant {
        _lockInternal(lockId, recipient, refundAddress, token, amount, hashLock, duration);
    }

    /**
     * @notice Convenience lock overload defaulting refundAddress to msg.sender for ERC-20 tokens or native coin.
     */
    function lock(
        bytes32 lockId,
        address recipient,
        address token,
        uint256 amount,
        bytes32 hashLock,
        uint256 duration
    ) external payable nonReentrant {
        _lockInternal(lockId, recipient, msg.sender, token, amount, hashLock, duration);
    }

    /**
     * @notice Backward-compatible lock overload for native coin with explicit refundAddress.
     */
    function lock(
        bytes32 lockId,
        address recipient,
        address refundAddress,
        bytes32 hashLock,
        uint256 duration
    ) public payable nonReentrant {
        _lockInternal(lockId, recipient, refundAddress, address(0), msg.value, hashLock, duration);
    }

    /**
     * @notice Backward-compatible lock overload for native coin defaulting refundAddress to msg.sender.
     */
    function lock(
        bytes32 lockId,
        address recipient,
        bytes32 hashLock,
        uint256 duration
    ) external payable nonReentrant {
        _lockInternal(lockId, recipient, msg.sender, address(0), msg.value, hashLock, duration);
    }

    /**
     * @notice Locks ERC-20 tokens using EIP-2612 permit signature for gasless 1-step atomic approval and lock.
     */
    function lockWithPermit(
        bytes32 lockId,
        address recipient,
        address refundAddress,
        address token,
        uint256 amount,
        bytes32 hashLock,
        uint256 duration,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) public nonReentrant {
        _lockWithPermitInternal(
            lockId,
            recipient,
            refundAddress,
            token,
            amount,
            hashLock,
            duration,
            deadline,
            v,
            r,
            s
        );
    }

    /**
     * @notice Convenience lockWithPermit overload defaulting refundAddress to msg.sender.
     */
    function lockWithPermit(
        bytes32 lockId,
        address recipient,
        address token,
        uint256 amount,
        bytes32 hashLock,
        uint256 duration,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        _lockWithPermitInternal(
            lockId,
            recipient,
            msg.sender,
            token,
            amount,
            hashLock,
            duration,
            deadline,
            v,
            r,
            s
        );
    }

    function _lockWithPermitInternal(
        bytes32 lockId,
        address recipient,
        address refundAddress,
        address token,
        uint256 amount,
        bytes32 hashLock,
        uint256 duration,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal {
        if (token == address(0)) revert InvalidZeroAddress();
        IERC20(token).permit(msg.sender, address(this), amount, deadline, v, r, s);
        _lockInternal(lockId, recipient, refundAddress, token, amount, hashLock, duration);
    }

    function _lockInternal(
        bytes32 lockId,
        address recipient,
        address refundAddress,
        address token,
        uint256 amount,
        bytes32 hashLock,
        uint256 duration
    ) internal {
        if (locks[lockId].sender != address(0)) revert LockAlreadyExists();
        if (recipient == address(0)) revert InvalidZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (duration == 0) revert LockExpired();

        if (token == address(0)) {
            if (msg.value != amount) revert TransferFailed();
        } else {
            if (msg.value != 0) revert TransferFailed();
            bool success = IERC20(token).transferFrom(msg.sender, address(this), amount);
            if (!success) revert TransferFailed();
        }

        address destRefund = refundAddress == address(0) ? msg.sender : refundAddress;

        locks[lockId] = Lock({
            sender: msg.sender,
            recipient: recipient,
            refundAddress: destRefund,
            token: token,
            hashLock: hashLock,
            amount: amount,
            expiresAt: block.timestamp + duration,
            withdrawn: false,
            refunded: false
        });

        emit Locked(
            lockId,
            msg.sender,
            token,
            recipient,
            destRefund,
            hashLock,
            amount,
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
     * Pools multiple locks sharing the same preimage and distributes the whole pool
     * to a list of recipients and amounts in a single atomic transaction.
     *
     * Only the recipient of every lock in the batch may call this. `withdraw` can be
     * called by anyone because it always pays `lock.recipient`; here the caller chooses
     * who is paid, so knowing the preimage is not enough: a preimage is public as soon
     * as it appears in any pending transaction. A table that wants an arbiter to split
     * the pot names that arbiter as the recipient of each player's lock.
     *
     * The payouts must add up to exactly the pooled amount.
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

        address token = locks[lockIds[0]].token;
        uint256 totalPool = 0;
        for (uint256 i = 0; i < lockIds.length; i++) {
            Lock storage l = locks[lockIds[i]];
            if (l.sender == address(0)) revert LockNotFound();
            if (l.recipient != msg.sender) revert Unauthorized();
            if (l.withdrawn) revert AlreadyWithdrawn();
            if (l.refunded) revert AlreadyRefunded();
            if (l.token != token) revert TokenMismatch();

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
        }

        if (totalPayout != totalPool) revert InvalidPayoutSum();

        for (uint256 j = 0; j < payouts.length; j++) {
            if (token == address(0)) {
                (bool pSuccess, ) = payable(payouts[j].recipient).call{value: payouts[j].amount}("");
                if (!pSuccess) revert TransferFailed();
            } else {
                bool pSuccess = IERC20(token).transfer(payouts[j].recipient, payouts[j].amount);
                if (!pSuccess) revert TransferFailed();
            }
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

        if (l.token == address(0)) {
            (bool success, ) = payable(l.refundAddress).call{value: amount}("");
            if (!success) revert TransferFailed();
        } else {
            bool success = IERC20(l.token).transfer(l.refundAddress, amount);
            if (!success) revert TransferFailed();
        }

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

        if (l.token == address(0)) {
            (bool success, ) = payable(l.recipient).call{value: amount}("");
            if (!success) revert TransferFailed();
        } else {
            bool success = IERC20(l.token).transfer(l.recipient, amount);
            if (!success) revert TransferFailed();
        }

        emit Withdrawn(lockId, l.recipient, preimage);
    }
}
