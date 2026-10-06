// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title TablePotVault
 * @notice Multi-player group table escrow for decentralized games (Poker, Liar's Dice, Raffles).
 * Table referee/host signs a multi-output payout manifest distributing pot funds to winners
 * (supporting one-time DKSAP stealth addresses). Includes emergency unilateral refunds if host disappears.
 */
contract TablePotVault {
    struct Table {
        address host;
        uint256 buyIn;
        uint256 totalPot;
        uint256 expiresAt;
        bool settled;
        address[] players;
    }

    struct Payout {
        address recipient;
        uint256 amount;
    }

    mapping(bytes32 => Table) public tables;
    mapping(bytes32 => mapping(address => bool)) public hasJoined;
    mapping(bytes32 => mapping(address => bool)) public hasRefunded;

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

    event TableCreated(
        bytes32 indexed tableId,
        address indexed host,
        uint256 buyIn,
        uint256 expiresAt
    );

    event PlayerJoined(
        bytes32 indexed tableId,
        address indexed player,
        uint256 buyIn
    );

    event TableSettled(
        bytes32 indexed tableId,
        uint256 totalPayout,
        uint256 remainderRefundedToHost
    );

    event EmergencyRefunded(
        bytes32 indexed tableId,
        address indexed player,
        uint256 refundAmount
    );

    error TableAlreadyExists();
    error TableNotFound();
    error TableAlreadySettled();
    error TableExpired();
    error TableNotExpired();
    error InvalidBuyIn();
    error PlayerAlreadyJoined();
    error PlayerNotJoined();
    error PlayerAlreadyRefunded();
    error InvalidSignature();
    error InvalidPayoutSum();
    error TransferFailed();
    error InvalidZeroAddress();

    /**
     * @notice Creates a new multi-player game table.
     * @param tableId Unique table identifier.
     * @param buyInAmount Exact buy-in amount required per player.
     * @param duration Duration in seconds until emergency refunds activate.
     */
    function createTable(
        bytes32 tableId,
        uint256 buyInAmount,
        uint256 duration
    ) external nonReentrant {
        if (tables[tableId].host != address(0)) revert TableAlreadyExists();
        if (duration == 0) revert TableExpired();

        tables[tableId].host = msg.sender;
        tables[tableId].buyIn = buyInAmount;
        tables[tableId].expiresAt = block.timestamp + duration;
        tables[tableId].settled = false;

        emit TableCreated(tableId, msg.sender, buyInAmount, block.timestamp + duration);
    }

    /**
     * @notice Allows a player to deposit the required buy-in and join the table.
     * @param tableId Unique table identifier.
     */
    function buyIn(bytes32 tableId) external payable nonReentrant {
        Table storage table = tables[tableId];
        if (table.host == address(0)) revert TableNotFound();
        if (table.settled) revert TableAlreadySettled();
        if (block.timestamp >= table.expiresAt) revert TableExpired();
        if (msg.value != table.buyIn) revert InvalidBuyIn();
        if (hasJoined[tableId][msg.sender]) revert PlayerAlreadyJoined();

        hasJoined[tableId][msg.sender] = true;
        table.players.push(msg.sender);
        table.totalPot += msg.value;

        emit PlayerJoined(tableId, msg.sender, msg.value);
    }

    /**
     * @notice Settles pot distribution signed by the table host/referee.
     * Payouts can be sent directly to winners' one-time DKSAP stealth addresses.
     * @param tableId Unique table identifier.
     * @param payouts Array of recipient addresses and their payout amounts.
     * @param hostSig Signature from table.host over the payouts manifest.
     */
    function settleTable(
        bytes32 tableId,
        Payout[] calldata payouts,
        bytes calldata hostSig
    ) external nonReentrant {
        Table storage table = tables[tableId];
        if (table.host == address(0)) revert TableNotFound();
        if (table.settled) revert TableAlreadySettled();
        if (block.timestamp >= table.expiresAt) revert TableExpired();

        uint256 totalPayout = 0;
        for (uint256 i = 0; i < payouts.length; i++) {
            if (payouts[i].recipient == address(0)) revert InvalidZeroAddress();
            totalPayout += payouts[i].amount;
        }

        if (totalPayout > table.totalPot) revert InvalidPayoutSum();

        // Verify host signature over manifest
        bytes32 messageHash = keccak256(
            abi.encodePacked(
                "\x19Ethereum Signed Message:\n32",
                keccak256(abi.encode(tableId, payouts, address(this), block.chainid))
            )
        );

        address recovered = recoverSigner(messageHash, hostSig);
        if (recovered != table.host) revert InvalidSignature();

        table.settled = true;
        uint256 remainder = table.totalPot - totalPayout;

        // Disburse payouts atomically
        for (uint256 i = 0; i < payouts.length; i++) {
            if (payouts[i].amount > 0) {
                (bool success, ) = payable(payouts[i].recipient).call{value: payouts[i].amount}("");
                if (!success) revert TransferFailed();
            }
        }

        // Refund any excess remainder to the host
        if (remainder > 0) {
            (bool remSuccess, ) = payable(table.host).call{value: remainder}("");
            if (!remSuccess) revert TransferFailed();
        }

        emit TableSettled(tableId, totalPayout, remainder);
    }

    /**
     * @notice Emergency unilateral refund for seated players if the host goes dark past expiresAt.
     * @param tableId Unique table identifier.
     */
    function emergencyRefund(bytes32 tableId) external nonReentrant {
        Table storage table = tables[tableId];
        if (table.host == address(0)) revert TableNotFound();
        if (table.settled) revert TableAlreadySettled();
        if (block.timestamp < table.expiresAt) revert TableNotExpired();
        if (!hasJoined[tableId][msg.sender]) revert PlayerNotJoined();
        if (hasRefunded[tableId][msg.sender]) revert PlayerAlreadyRefunded();

        hasRefunded[tableId][msg.sender] = true;
        uint256 refundAmount = table.buyIn;

        if (refundAmount > 0) {
            (bool success, ) = payable(msg.sender).call{value: refundAmount}("");
            if (!success) revert TransferFailed();
        }

        emit EmergencyRefunded(tableId, msg.sender, refundAmount);
    }

    /**
     * @notice Returns list of seated players for a table.
     */
    function getPlayers(bytes32 tableId) external view returns (address[] memory) {
        return tables[tableId].players;
    }

    /**
     * @dev Recovers signer address from 65-byte ECDSA signature.
     */
    function recoverSigner(bytes32 hash, bytes calldata sig) public pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) {
            v += 27;
        }
        if (v != 27 && v != 28) {
            return address(0);
        }
        return ecrecover(hash, v, r, s);
    }
}
