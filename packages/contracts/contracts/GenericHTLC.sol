// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IERC20.sol";

/**
 * @title GenericHTLC (v2)
 * @notice Hash time locked escrow of native coin or an ERC-20 token, for cross-chain atomic
 * swaps and pooled game escrows.
 *
 * - A lock's identity is derived from its sender and all of its terms (`lockIdOf`), so no one
 *   can take another sender's lock id first, and the same sender cannot open the same terms twice.
 * - The deadline is absolute: `withdraw` works strictly before `expiresAt`, `refund` from
 *   `expiresAt` on. Windows never overlap. A lock lasts at most `MAX_LOCK_DURATION`.
 * - The hash lock is sha256 of a 32-byte preimage (the eCash/Bitcoin HTLC convention). Once a
 *   lock is withdrawn its preimage stays readable in `locks(lockId)`.
 * - Every payout goes through `_pay`. A payment the destination refuses (a contract that
 *   rejects coin, a token that refuses the transfer) is credited to `owed[to][token]` and
 *   emits `PaymentDeferred`; the destination collects it with `claimOwed`. A refusing
 *   destination therefore cannot block the other side of a lock from settling.
 * - Tokens that deliver less than `amount` (fee-on-transfer) are refused.
 * - Every entry point that moves value is non-reentrant.
 */
contract GenericHTLC {
    enum State {
        None,
        Open,
        Withdrawn,
        Refunded
    }

    struct Lock {
        address sender;
        address recipient;
        address refundAddress;
        address token;
        bytes32 hashLock;
        uint256 amount;
        uint64 expiresAt;
        State state;
        bytes32 preimage;
    }

    struct Payout {
        address recipient;
        uint256 amount;
    }

    /// The longest a lock may stay open: `expiresAt` is at most this far after the lock's block.
    uint256 public constant MAX_LOCK_DURATION = 30 days;

    /// Gas forwarded with a native payout made inside withdraw, refund or a batch. A destination
    /// that needs more (or refuses) is paid through `owed` and collects with `claimOwed`.
    uint256 public constant PAYMENT_GAS = 100_000;

    mapping(bytes32 => Lock) public locks;

    /// Deferred payouts: owed[destination][token], token address(0) for the native coin.
    mapping(address => mapping(address => uint256)) public owed;

    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status = _NOT_ENTERED;

    modifier nonReentrant() {
        if (_status == _ENTERED) revert ReentrantCall();
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
        uint64 expiresAt
    );

    event Withdrawn(bytes32 indexed lockId, address indexed recipient, bytes32 preimage);

    event BatchDistributed(bytes32[] lockIds, Payout[] payouts, bytes32 preimage);

    event Refunded(bytes32 indexed lockId, address indexed refundAddress, uint256 amount);

    event PaymentDeferred(address indexed to, address indexed token, uint256 amount);

    event OwedClaimed(address indexed creditor, address indexed token, address to, uint256 amount);

    error LockAlreadyExists();
    error LockNotFound();
    error AlreadyWithdrawn();
    error AlreadyRefunded();
    error LockExpired();
    error LockNotExpired();
    error InvalidExpiry();
    error InvalidPreimage();
    error InvalidZeroAddress();
    error InvalidValue();
    error UnsupportedToken();
    error TransferFailed();
    error ZeroAmount();
    error InvalidPayoutSum();
    error EmptyBatch();
    error TokenMismatch();
    error Unauthorized();
    error NothingOwed();
    error ReentrantCall();

    /**
     * @notice The id a lock with these terms gets when `sender` opens it.
     */
    function lockIdOf(
        address sender,
        address recipient,
        address refundAddress,
        address token,
        uint256 amount,
        bytes32 hashLock,
        uint64 expiresAt
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(sender, recipient, refundAddress, token, amount, hashLock, expiresAt));
    }

    /**
     * @notice Locks `amount` of `token` (address(0): the native coin, sent as exactly `msg.value`)
     * for `recipient` against `hashLock = sha256(preimage)` until the absolute time `expiresAt`,
     * after which it can only be refunded to `refundAddress`.
     * @return lockId `lockIdOf(msg.sender, recipient, refundAddress, token, amount, hashLock, expiresAt)`.
     */
    function lock(
        address recipient,
        address refundAddress,
        address token,
        uint256 amount,
        bytes32 hashLock,
        uint64 expiresAt
    ) external payable nonReentrant returns (bytes32 lockId) {
        if (recipient == address(0) || refundAddress == address(0)) revert InvalidZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (expiresAt <= block.timestamp || expiresAt > block.timestamp + MAX_LOCK_DURATION) {
            revert InvalidExpiry();
        }

        lockId = lockIdOf(msg.sender, recipient, refundAddress, token, amount, hashLock, expiresAt);
        if (locks[lockId].state != State.None) revert LockAlreadyExists();

        if (token == address(0)) {
            if (msg.value != amount) revert InvalidValue();
        } else {
            if (msg.value != 0) revert InvalidValue();
            _pullExact(token, msg.sender, amount);
        }

        locks[lockId] = Lock({
            sender: msg.sender,
            recipient: recipient,
            refundAddress: refundAddress,
            token: token,
            hashLock: hashLock,
            amount: amount,
            expiresAt: expiresAt,
            state: State.Open,
            preimage: bytes32(0)
        });

        emit Locked(lockId, msg.sender, token, recipient, refundAddress, hashLock, amount, expiresAt);
    }

    /**
     * @notice Pays an open lock to its recipient for the preimage. Anyone may send it: the payout
     * always goes to `lock.recipient`. Only strictly before `expiresAt`.
     */
    function withdraw(bytes32 lockId, bytes32 preimage) external nonReentrant {
        Lock storage l = _claimable(lockId, preimage);
        l.state = State.Withdrawn;
        l.preimage = preimage;
        _pay(l.recipient, l.token, l.amount);
        emit Withdrawn(lockId, l.recipient, preimage);
    }

    /**
     * @notice Withdraws several locks sharing one preimage, each paid to its own recipient.
     */
    function batchWithdraw(bytes32[] calldata lockIds, bytes32 preimage) external nonReentrant {
        if (lockIds.length == 0) revert EmptyBatch();
        for (uint256 i = 0; i < lockIds.length; i++) {
            Lock storage l = _claimable(lockIds[i], preimage);
            l.state = State.Withdrawn;
            l.preimage = preimage;
            _pay(l.recipient, l.token, l.amount);
            emit Withdrawn(lockIds[i], l.recipient, preimage);
        }
    }

    /**
     * @notice Pools locks sharing one preimage and splits the pool between `payouts`, which must
     * add up to exactly the pooled amount.
     *
     * Only the recipient of every lock in the batch may call this: here the caller chooses who is
     * paid, and a preimage is public as soon as it appears in any pending transaction. A table that
     * wants an arbiter to split the pot names that arbiter as the recipient of each player's lock.
     */
    function batchDistribute(
        bytes32[] calldata lockIds,
        Payout[] calldata payouts,
        bytes32 preimage
    ) external nonReentrant {
        if (lockIds.length == 0 || payouts.length == 0) revert EmptyBatch();

        address token = locks[lockIds[0]].token;
        uint256 totalPool = 0;
        for (uint256 i = 0; i < lockIds.length; i++) {
            Lock storage l = _claimable(lockIds[i], preimage);
            if (l.recipient != msg.sender) revert Unauthorized();
            if (l.token != token) revert TokenMismatch();
            l.state = State.Withdrawn;
            l.preimage = preimage;
            totalPool += l.amount;
            emit Withdrawn(lockIds[i], l.recipient, preimage);
        }

        uint256 totalPayout = 0;
        for (uint256 j = 0; j < payouts.length; j++) {
            if (payouts[j].recipient == address(0)) revert InvalidZeroAddress();
            if (payouts[j].amount == 0) revert ZeroAmount();
            totalPayout += payouts[j].amount;
        }
        if (totalPayout != totalPool) revert InvalidPayoutSum();

        for (uint256 j = 0; j < payouts.length; j++) {
            _pay(payouts[j].recipient, token, payouts[j].amount);
        }

        emit BatchDistributed(lockIds, payouts, preimage);
    }

    /**
     * @notice Pays an open lock back to its refund address, from `expiresAt` on. Anyone may send it.
     */
    function refund(bytes32 lockId) external nonReentrant {
        Lock storage l = locks[lockId];
        _requireOpen(l);
        if (block.timestamp < l.expiresAt) revert LockNotExpired();
        l.state = State.Refunded;
        _pay(l.refundAddress, l.token, l.amount);
        emit Refunded(lockId, l.refundAddress, l.amount);
    }

    /**
     * @notice Pays everything owed to the caller in `token` (address(0): native coin) to `to`, with
     * all the gas the call has. `to` may be the caller itself, or another address for a caller
     * that cannot receive the asset. Reverts, keeping the credit, if the payment fails.
     */
    function claimOwed(address token, address to) external nonReentrant {
        if (to == address(0)) revert InvalidZeroAddress();
        uint256 amount = owed[msg.sender][token];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender][token] = 0;
        if (token == address(0)) {
            (bool ok, ) = payable(to).call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            if (!_tokenTransfer(token, to, amount)) revert TransferFailed();
        }
        emit OwedClaimed(msg.sender, token, to, amount);
    }

    function _requireOpen(Lock storage l) private view {
        State state = l.state;
        if (state == State.None) revert LockNotFound();
        if (state == State.Withdrawn) revert AlreadyWithdrawn();
        if (state == State.Refunded) revert AlreadyRefunded();
    }

    /// The open lock `lockId`, if it can be withdrawn now with `preimage`.
    function _claimable(bytes32 lockId, bytes32 preimage) private view returns (Lock storage l) {
        l = locks[lockId];
        _requireOpen(l);
        // Withdraw and refund windows are disjoint: once refund is possible, withdraw is not.
        if (block.timestamp >= l.expiresAt) revert LockExpired();
        if (sha256(abi.encodePacked(preimage)) != l.hashLock) revert InvalidPreimage();
    }

    /// Takes exactly `amount` of `token` from `from`; a token that delivers anything else is refused.
    function _pullExact(address token, address from, uint256 amount) private {
        if (token.code.length == 0) revert UnsupportedToken();
        uint256 before = IERC20(token).balanceOf(address(this));
        (bool ok, bytes memory data) = token.call(
            abi.encodeCall(IERC20.transferFrom, (from, address(this), amount))
        );
        if (!_succeeded(ok, data)) revert TransferFailed();
        if (IERC20(token).balanceOf(address(this)) - before != amount) revert UnsupportedToken();
    }

    /// Pays `amount` of `token` to `to`, or credits it to `owed[to][token]` if the payment fails.
    function _pay(address to, address token, uint256 amount) private {
        bool ok;
        if (token == address(0)) {
            // No return data is copied, so a destination cannot make this payout run out of gas.
            assembly {
                ok := call(PAYMENT_GAS, to, amount, 0, 0, 0, 0)
            }
        } else {
            ok = _tokenTransfer(token, to, amount);
        }
        if (!ok) {
            owed[to][token] += amount;
            emit PaymentDeferred(to, token, amount);
        }
    }

    function _tokenTransfer(address token, address to, uint256 amount) private returns (bool) {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        return _succeeded(ok, data);
    }

    /// A token call succeeded: it did not revert and returned nothing or `true`.
    function _succeeded(bool ok, bytes memory data) private pure returns (bool) {
        if (!ok) return false;
        if (data.length == 0) return true;
        return data.length >= 32 && abi.decode(data, (uint256)) == 1;
    }
}
