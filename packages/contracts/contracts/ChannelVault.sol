// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ChannelVault
 * @notice 2-of-2 state channel escrow with anti-hostage timelock escape hatches.
 * Supports arbitrary winner payouts (including one-time DKSAP stealth addresses)
 * verified by a 2-of-2 joint signer signature.
 */
contract ChannelVault {
    struct Session {
        address player;
        address dealer;
        uint256 playerDeposit;
        uint256 dealerCover;
        address jointSigner;
        uint256 expiresAt;
        bool settled;
    }

    mapping(bytes32 => Session) public sessions;

    // Reentrancy guard state
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status = _NOT_ENTERED;

    modifier nonReentrant() {
        require(_status != _ENTERED, "ReentrancyGuard: reentrant call");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    event Deposited(
        bytes32 indexed sessionId,
        address indexed player,
        address indexed dealer,
        uint256 playerDeposit,
        address jointSigner,
        uint256 expiresAt
    );

    event CoverDeposited(
        bytes32 indexed sessionId,
        address indexed dealer,
        uint256 dealerCover
    );

    event Settled(
        bytes32 indexed sessionId,
        address indexed winner,
        uint256 payout,
        uint256 remainder
    );

    event Refunded(
        bytes32 indexed sessionId,
        uint256 playerRefund,
        uint256 dealerRefund
    );

    error SessionAlreadyExists();
    error SessionNotFound();
    error SessionAlreadySettled();
    error SessionExpired();
    error SessionNotExpired();
    error InvalidSignature();
    error InvalidPayout();
    error TransferFailed();
    error InvalidZeroAddress();
    error Unauthorized();

    /**
     * @notice Locks player funds for a 2-party state channel session.
     * @param sessionId Unique session identifier.
     * @param dealer Address of the counterparty/dealer.
     * @param jointSigner Address of the 2-of-2 joint signer.
     * @param duration Duration in seconds until the anti-hostage timelock expires.
     */
    function deposit(
        bytes32 sessionId,
        address dealer,
        address jointSigner,
        uint256 duration
    ) external payable nonReentrant {
        if (sessions[sessionId].player != address(0)) revert SessionAlreadyExists();
        if (dealer == address(0) || jointSigner == address(0)) revert InvalidZeroAddress();
        if (duration == 0) revert SessionExpired();

        sessions[sessionId] = Session({
            player: msg.sender,
            dealer: dealer,
            playerDeposit: msg.value,
            dealerCover: 0,
            jointSigner: jointSigner,
            expiresAt: block.timestamp + duration,
            settled: false
        });

        emit Deposited(
            sessionId,
            msg.sender,
            dealer,
            msg.value,
            jointSigner,
            block.timestamp + duration
        );
    }

    /**
     * @notice Allows dealer to deposit collateral / cover for the game session.
     * @param sessionId Unique session identifier.
     */
    function depositCover(bytes32 sessionId) external payable nonReentrant {
        Session storage session = sessions[sessionId];
        if (session.player == address(0)) revert SessionNotFound();
        if (session.settled) revert SessionAlreadySettled();
        if (block.timestamp >= session.expiresAt) revert SessionExpired();
        if (msg.sender != session.dealer) revert Unauthorized();

        session.dealerCover += msg.value;
        emit CoverDeposited(sessionId, msg.sender, msg.value);
    }

    /**
     * @notice Settles session payout signed by the 2-of-2 joint signer.
     * @param sessionId Unique session identifier.
     * @param winner Recipient of payout (can be a fresh DKSAP stealth address).
     * @param payout Amount of native currency to pay to winner.
     * @param jointSig Signature from session.jointSigner over (sessionId, winner, payout, vault, chainid).
     */
    function settle(
        bytes32 sessionId,
        address winner,
        uint256 payout,
        bytes calldata jointSig
    ) external nonReentrant {
        Session storage session = sessions[sessionId];
        if (session.player == address(0)) revert SessionNotFound();
        if (session.settled) revert SessionAlreadySettled();
        if (block.timestamp >= session.expiresAt) revert SessionExpired();
        if (winner == address(0)) revert InvalidZeroAddress();

        uint256 totalPot = session.playerDeposit + session.dealerCover;
        if (payout > totalPot) revert InvalidPayout();

        // Verify joint signature
        bytes32 messageHash = keccak256(
            abi.encodePacked(
                "\x19Ethereum Signed Message:\n32",
                keccak256(abi.encode(sessionId, winner, payout, address(this), block.chainid))
            )
        );

        address recovered = recoverSigner(messageHash, jointSig);
        if (recovered != session.jointSigner) revert InvalidSignature();

        session.settled = true;
        uint256 remainder = totalPot - payout;

        // Payout to winner
        if (payout > 0) {
            (bool success, ) = payable(winner).call{value: payout}("");
            if (!success) revert TransferFailed();
        }

        // Return remainder: if player won, remainder returns to dealer; if dealer won, remainder returns to player
        if (remainder > 0) {
            address refundRecipient = (winner == session.player) ? session.dealer : session.player;
            (bool remSuccess, ) = payable(refundRecipient).call{value: remainder}("");
            if (!remSuccess) revert TransferFailed();
        }

        emit Settled(sessionId, winner, payout, remainder);
    }

    /**
     * @notice Anti-Hostage Escape Hatch: Unilaterally refunds both parties if session expires unsettled.
     * Neither party can lock or grief the other's funds.
     * @param sessionId Unique session identifier.
     */
    function refundTimeout(bytes32 sessionId) external nonReentrant {
        Session storage session = sessions[sessionId];
        if (session.player == address(0)) revert SessionNotFound();
        if (session.settled) revert SessionAlreadySettled();
        if (block.timestamp < session.expiresAt) revert SessionNotExpired();

        session.settled = true;
        uint256 pRefund = session.playerDeposit;
        uint256 dRefund = session.dealerCover;

        if (pRefund > 0) {
            (bool pSuccess, ) = payable(session.player).call{value: pRefund}("");
            if (!pSuccess) revert TransferFailed();
        }

        if (dRefund > 0) {
            (bool dSuccess, ) = payable(session.dealer).call{value: dRefund}("");
            if (!dSuccess) revert TransferFailed();
        }

        emit Refunded(sessionId, pRefund, dRefund);
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
