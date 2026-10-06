// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title TablePotVault
 * @notice Multiplayer group table vault with host-signed settlement and unilateral emergency refund.
 * @dev Supports group games (Raffle, Poker, Table Pots) with off-chain coordination,
 *      stealth payouts, and a timelocked escape hatch if the host bot goes offline.
 */
contract TablePotVault {
    // -------------------------------------------------------------------------
    // Storage & Types
    // -------------------------------------------------------------------------

    struct Payout {
        address recipient;
        uint256 amount;
    }

    struct Table {
        address host;
        uint256 buyIn;
        uint256 totalPot;
        uint256 expiresAt;
        bool settled;
        address[] players;
    }

    /// @notice tableId => Table details
    mapping(bytes32 => Table) public tables;

    /// @notice tableId => player => amount contributed
    mapping(bytes32 => mapping(address => uint256)) public playerContributions;

    /// @notice tableId => host seed pot
    mapping(bytes32 => uint256) public hostSeeds;

    // Reentrancy guard
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event TableCreated(
        bytes32 indexed tableId,
        address indexed host,
        uint256 buyIn,
        uint256 seedPot,
        uint256 expiresAt
    );

    event PlayerJoined(
        bytes32 indexed tableId,
        address indexed player,
        uint256 amount,
        uint256 totalPot
    );

    event TableSettled(
        bytes32 indexed tableId,
        uint256 totalDistributed,
        uint256 remainderToHost,
        uint256 payoutCount
    );

    event PlayerRefunded(
        bytes32 indexed tableId,
        address indexed player,
        uint256 amount
    );

    event HostRefunded(
        bytes32 indexed tableId,
        address indexed host,
        uint256 amount
    );

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error TableAlreadyExists();
    error TableDoesNotExist();
    error TableAlreadySettled();
    error TableExpired();
    error TableNotExpired();
    error IncorrectBuyIn();
    error ZeroDuration();
    error PayoutExceedsPot();
    error InvalidHostSignature();
    error InvalidSignatureLength();
    error InvalidSignatureS();
    error InvalidSignatureV();
    error TransferFailed();
    error ReentrantCall();
    error NoRefundAvailable();

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
    // Table Lifecycle
    // -------------------------------------------------------------------------

    /**
     * @notice Create a new table with fixed buy-in and timelock duration.
     * @param tableId Unique identifier for the table.
     * @param buyInAmount Required contribution per player in wei.
     * @param duration Lifetime in seconds before emergency refund is unlocked.
     */
    function createTable(
        bytes32 tableId,
        uint256 buyInAmount,
        uint256 duration
    ) external payable nonReentrant {
        if (duration == 0) revert ZeroDuration();
        if (tables[tableId].expiresAt != 0) revert TableAlreadyExists();

        uint256 expiresAt = block.timestamp + duration;

        Table storage t = tables[tableId];
        t.host = msg.sender;
        t.buyIn = buyInAmount;
        t.totalPot = msg.value;
        t.expiresAt = expiresAt;
        t.settled = false;

        if (msg.value > 0) {
            hostSeeds[tableId] = msg.value;
        }

        emit TableCreated(tableId, msg.sender, buyInAmount, msg.value, expiresAt);
    }

    /**
     * @notice Player deposits buy-in to join the table pot.
     * @param tableId Target table identifier.
     */
    function buyIn(bytes32 tableId) external payable nonReentrant {
        Table storage t = tables[tableId];
        if (t.expiresAt == 0) revert TableDoesNotExist();
        if (t.settled) revert TableAlreadySettled();
        if (block.timestamp >= t.expiresAt) revert TableExpired();
        if (t.buyIn > 0 && msg.value != t.buyIn) revert IncorrectBuyIn();

        if (playerContributions[tableId][msg.sender] == 0) {
            t.players.push(msg.sender);
        }

        playerContributions[tableId][msg.sender] += msg.value;
        t.totalPot += msg.value;

        emit PlayerJoined(tableId, msg.sender, msg.value, t.totalPot);
    }

    /**
     * @notice Settle table pot and distribute multi-recipient payouts atomically.
     *         Callable either directly by the table host or by anyone providing a valid host signature.
     * @param tableId Target table identifier.
     * @param payouts Array of recipient addresses (stealth addresses supported) and amounts.
     * @param hostSig Host ECDSA signature over the settlement digest, or empty if msg.sender == host.
     */
    function settleTable(
        bytes32 tableId,
        Payout[] calldata payouts,
        bytes calldata hostSig
    ) external nonReentrant {
        Table storage t = tables[tableId];
        if (t.expiresAt == 0) revert TableDoesNotExist();
        if (t.settled) revert TableAlreadySettled();
        if (block.timestamp >= t.expiresAt) revert TableExpired();

        // Validate signature if not called directly by host
        if (msg.sender != t.host) {
            bytes32 digest = keccak256(
                abi.encode(block.chainid, address(this), tableId, payouts)
            );
            _verifySigner(digest, hostSig, t.host);
        }

        t.settled = true;

        uint256 totalPot = t.totalPot;
        uint256 distributed = 0;

        for (uint256 i = 0; i < payouts.length; i++) {
            distributed += payouts[i].amount;
            if (distributed > totalPot) revert PayoutExceedsPot();
            if (payouts[i].amount > 0) {
                _sendEther(payouts[i].recipient, payouts[i].amount);
            }
        }

        uint256 remainder = totalPot - distributed;
        if (remainder > 0 && t.host != address(0)) {
            _sendEther(t.host, remainder);
        }

        emit TableSettled(tableId, distributed, remainder, payouts.length);
    }

    /**
     * @notice Emergency refund for an individual seated player or host.
     *         Available unilaterally if block.timestamp >= table.expiresAt and table is not settled.
     * @param tableId Target table identifier.
     */
    function claimRefund(bytes32 tableId) external nonReentrant {
        Table storage t = tables[tableId];
        if (t.expiresAt == 0) revert TableDoesNotExist();
        if (t.settled) revert TableAlreadySettled();
        if (block.timestamp < t.expiresAt) revert TableNotExpired();

        uint256 amount = playerContributions[tableId][msg.sender];
        if (msg.sender == t.host && hostSeeds[tableId] > 0) {
            amount += hostSeeds[tableId];
            hostSeeds[tableId] = 0;
        }

        if (amount == 0) revert NoRefundAvailable();

        playerContributions[tableId][msg.sender] = 0;
        _sendEther(msg.sender, amount);

        emit PlayerRefunded(tableId, msg.sender, amount);
    }

    /**
     * @notice Batch emergency refund executing refunds for all players.
     * @param tableId Target table identifier.
     */
    function emergencyRefund(bytes32 tableId) external nonReentrant {
        Table storage t = tables[tableId];
        if (t.expiresAt == 0) revert TableDoesNotExist();
        if (t.settled) revert TableAlreadySettled();
        if (block.timestamp < t.expiresAt) revert TableNotExpired();

        t.settled = true;

        // Refund all players
        for (uint256 i = 0; i < t.players.length; i++) {
            address player = t.players[i];
            uint256 amount = playerContributions[tableId][player];
            if (amount > 0) {
                playerContributions[tableId][player] = 0;
                _sendEther(player, amount);
                emit PlayerRefunded(tableId, player, amount);
            }
        }

        // Refund host seed
        uint256 seed = hostSeeds[tableId];
        if (seed > 0) {
            hostSeeds[tableId] = 0;
            _sendEther(t.host, seed);
            emit HostRefunded(tableId, t.host, seed);
        }
    }

    // -------------------------------------------------------------------------
    // View Functions
    // -------------------------------------------------------------------------

    function getTable(bytes32 tableId) external view returns (
        address host,
        uint256 buyInAmount,
        uint256 totalPot,
        uint256 expiresAt,
        bool isSettled,
        uint256 playerCount
    ) {
        Table storage t = tables[tableId];
        return (t.host, t.buyIn, t.totalPot, t.expiresAt, t.settled, t.players.length);
    }

    function getPlayers(bytes32 tableId) external view returns (address[] memory) {
        return tables[tableId].players;
    }

    // -------------------------------------------------------------------------
    // Internal Helpers
    // -------------------------------------------------------------------------

    function _sendEther(address to, uint256 amount) internal {
        (bool success, ) = payable(to).call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    function _verifySigner(
        bytes32 digest,
        bytes calldata signature,
        address expectedSigner
    ) internal pure {
        bytes32 ethSignedDigest = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)
        );

        address recovered = _recoverSigner(ethSignedDigest, signature);
        if (recovered != expectedSigner) {
            recovered = _recoverSigner(digest, signature);
        }

        if (recovered != expectedSigner) revert InvalidHostSignature();
    }

    function _recoverSigner(bytes32 hash, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) revert InvalidSignatureLength();

        bytes32 r;
        bytes32 s;
        uint8 v;

        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 0x20))
            v := byte(0, calldataload(add(signature.offset, 0x40)))
        }

        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert InvalidSignatureS();
        }
        if (v != 27 && v != 28) {
            revert InvalidSignatureV();
        }

        return ecrecover(hash, v, r, s);
    }
}
