// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ChannelVault
 * @notice 2-of-2 State Channel settlement vault with anti-hostage timelock escape hatch.
 * @dev Agnostic settlement layer for Frank state channels and games.
 *      Game logic remains 100% off-chain; this contract enforces only cryptographic
 *      joint signatures and timelocked unilateral refund guarantees.
 */
contract ChannelVault {
    // -------------------------------------------------------------------------
    // Storage & Types
    // -------------------------------------------------------------------------

    struct Session {
        address player;
        address dealer;
        uint256 playerDeposit;
        uint256 dealerCover;
        address jointSigner;
        uint256 expiresAt;
        bool settled;
    }

    /// @notice sessionId => Session details
    mapping(bytes32 => Session) public sessions;

    // Reentrancy guard
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event ChannelOpened(
        bytes32 indexed sessionId,
        address indexed player,
        address indexed dealer,
        address jointSigner,
        uint256 playerDeposit,
        uint256 expiresAt
    );

    event CoverDeposited(
        bytes32 indexed sessionId,
        address indexed dealer,
        uint256 amount,
        uint256 totalCover
    );

    event PlayerToppedUp(
        bytes32 indexed sessionId,
        address indexed player,
        uint256 amount,
        uint256 totalPlayerDeposit
    );

    event ChannelSettled(
        bytes32 indexed sessionId,
        address indexed winner,
        uint256 payout,
        uint256 remainder,
        address remainderRecipient
    );

    event ChannelRefunded(
        bytes32 indexed sessionId,
        address indexed player,
        uint256 playerAmount,
        address indexed dealer,
        uint256 dealerAmount
    );

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error SessionAlreadyExists();
    error SessionDoesNotExist();
    error SessionAlreadySettled();
    error SessionExpired();
    error SessionNotExpired();
    error ZeroJointSigner();
    error ZeroDeposit();
    error ZeroDuration();
    error InvalidSignature();
    error InvalidSignatureLength();
    error InvalidSignatureS();
    error InvalidSignatureV();
    error PayoutExceedsPot();
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
    // Channel Lifecycle
    // -------------------------------------------------------------------------

    /**
     * @notice Open a new channel session by locking initial player deposit.
     * @param sessionId Unique 32-byte identifier for the channel session.
     * @param dealer The counterparty dealer/bot address.
     * @param jointSigner The co-signing authority address (e.g., Frank joint-signer).
     * @param duration Lifetime in seconds before the timelock escape hatch activates.
     */
    function openChannel(
        bytes32 sessionId,
        address dealer,
        address jointSigner,
        uint256 duration
    ) external payable nonReentrant {
        if (msg.value == 0) revert ZeroDeposit();
        if (jointSigner == address(0)) revert ZeroJointSigner();
        if (duration == 0) revert ZeroDuration();
        if (sessions[sessionId].expiresAt != 0) revert SessionAlreadyExists();

        uint256 expiresAt = block.timestamp + duration;

        sessions[sessionId] = Session({
            player: msg.sender,
            dealer: dealer,
            playerDeposit: msg.value,
            dealerCover: 0,
            jointSigner: jointSigner,
            expiresAt: expiresAt,
            settled: false
        });

        emit ChannelOpened(sessionId, msg.sender, dealer, jointSigner, msg.value, expiresAt);
    }

    /**
     * @notice Simplified deposit function meeting Ticket EVM-1 specification.
     *         If session does not exist, registers caller as player.
     *         If session exists and caller is dealer, tops up dealerCover.
     *         Otherwise tops up playerDeposit.
     */
    function deposit(
        bytes32 sessionId,
        address jointSigner,
        uint256 duration
    ) external payable nonReentrant {
        if (msg.value == 0) revert ZeroDeposit();

        Session storage s = sessions[sessionId];
        if (s.expiresAt == 0) {
            if (jointSigner == address(0)) revert ZeroJointSigner();
            if (duration == 0) revert ZeroDuration();
            uint256 expiresAt = block.timestamp + duration;

            s.player = msg.sender;
            s.dealer = address(0);
            s.playerDeposit = msg.value;
            s.dealerCover = 0;
            s.jointSigner = jointSigner;
            s.expiresAt = expiresAt;
            s.settled = false;

            emit ChannelOpened(sessionId, msg.sender, address(0), jointSigner, msg.value, expiresAt);
        } else {
            if (s.settled) revert SessionAlreadySettled();
            if (block.timestamp >= s.expiresAt) revert SessionExpired();

            if (msg.sender == s.dealer) {
                s.dealerCover += msg.value;
                emit CoverDeposited(sessionId, msg.sender, msg.value, s.dealerCover);
            } else {
                s.playerDeposit += msg.value;
                emit PlayerToppedUp(sessionId, msg.sender, msg.value, s.playerDeposit);
            }
        }
    }

    /**
     * @notice Dealer deposits cover funds for the session.
     * @param sessionId The channel session identifier.
     */
    function depositCover(bytes32 sessionId) external payable nonReentrant {
        if (msg.value == 0) revert ZeroDeposit();
        Session storage s = sessions[sessionId];
        if (s.expiresAt == 0) revert SessionDoesNotExist();
        if (s.settled) revert SessionAlreadySettled();
        if (block.timestamp >= s.expiresAt) revert SessionExpired();

        if (s.dealer == address(0)) {
            s.dealer = msg.sender;
        }

        s.dealerCover += msg.value;
        emit CoverDeposited(sessionId, msg.sender, msg.value, s.dealerCover);
    }

    /**
     * @notice Settle the channel and distribute payout to winner, remainder to counterparty.
     * @param sessionId Session identifier.
     * @param winner Address receiving the payout (supports one-time DKSAP stealth addresses).
     * @param payout Amount to transfer to winner in wei.
     * @param jointSig Signature from session.jointSigner over (chainId, vault, sessionId, winner, payout).
     */
    function settle(
        bytes32 sessionId,
        address winner,
        uint256 payout,
        bytes calldata jointSig
    ) external nonReentrant {
        Session storage s = sessions[sessionId];
        if (s.expiresAt == 0) revert SessionDoesNotExist();
        if (s.settled) revert SessionAlreadySettled();
        if (block.timestamp >= s.expiresAt) revert SessionExpired();

        uint256 totalPot = s.playerDeposit + s.dealerCover;
        if (payout > totalPot) revert PayoutExceedsPot();

        // Verify joint signature
        bytes32 digest = keccak256(
            abi.encode(block.chainid, address(this), sessionId, winner, payout)
        );
        _verifyJointSigner(digest, jointSig, s.jointSigner);

        s.settled = true;

        uint256 remainder = totalPot - payout;
        address remainderRecipient = address(0);

        // Send payout to winner
        if (payout > 0) {
            _sendEther(winner, payout);
        }

        // Return remainder to counterparty
        if (remainder > 0) {
            if (winner == s.player) {
                remainderRecipient = s.dealer != address(0) ? s.dealer : s.player;
            } else if (winner == s.dealer) {
                remainderRecipient = s.player;
            } else {
                // If stealth address was used, default remainder to dealer if present, else player
                remainderRecipient = s.dealer != address(0) ? s.dealer : s.player;
            }
            _sendEther(remainderRecipient, remainder);
        }

        emit ChannelSettled(sessionId, winner, payout, remainder, remainderRecipient);
    }

    /**
     * @notice Settle the channel with explicit two-way split.
     * @param sessionId Session identifier.
     * @param recipientA First recipient address.
     * @param amountA Amount for first recipient.
     * @param recipientB Second recipient address.
     * @param amountB Amount for second recipient.
     * @param jointSig Signature from session.jointSigner over (chainId, vault, sessionId, recipientA, amountA, recipientB, amountB).
     */
    function settleSplits(
        bytes32 sessionId,
        address recipientA,
        uint256 amountA,
        address recipientB,
        uint256 amountB,
        bytes calldata jointSig
    ) external nonReentrant {
        Session storage s = sessions[sessionId];
        if (s.expiresAt == 0) revert SessionDoesNotExist();
        if (s.settled) revert SessionAlreadySettled();
        if (block.timestamp >= s.expiresAt) revert SessionExpired();

        uint256 totalPot = s.playerDeposit + s.dealerCover;
        if (amountA + amountB > totalPot) revert PayoutExceedsPot();

        bytes32 digest = keccak256(
            abi.encode(block.chainid, address(this), sessionId, recipientA, amountA, recipientB, amountB)
        );
        _verifyJointSigner(digest, jointSig, s.jointSigner);

        s.settled = true;

        if (amountA > 0) {
            _sendEther(recipientA, amountA);
        }
        if (amountB > 0) {
            _sendEther(recipientB, amountB);
        }

        uint256 remaining = totalPot - (amountA + amountB);
        if (remaining > 0 && s.dealer != address(0)) {
            _sendEther(s.dealer, remaining);
        }

        emit ChannelSettled(sessionId, recipientA, amountA, amountB, recipientB);
    }

    /**
     * @notice Anti-Hostage Escape Hatch.
     *         If unspent when block.timestamp >= expiresAt, returns playerDeposit to player
     *         and dealerCover to dealer unilaterally.
     *         Neither party can lock or burn the other's funds.
     * @param sessionId Session identifier.
     */
    function refundTimeout(bytes32 sessionId) external nonReentrant {
        Session storage s = sessions[sessionId];
        if (s.expiresAt == 0) revert SessionDoesNotExist();
        if (s.settled) revert SessionAlreadySettled();
        if (block.timestamp < s.expiresAt) revert SessionNotExpired();

        s.settled = true;

        uint256 pDeposit = s.playerDeposit;
        uint256 dCover = s.dealerCover;
        address player = s.player;
        address dealer = s.dealer;

        if (pDeposit > 0) {
            _sendEther(player, pDeposit);
        }
        if (dCover > 0 && dealer != address(0)) {
            _sendEther(dealer, dCover);
        }

        emit ChannelRefunded(sessionId, player, pDeposit, dealer, dCover);
    }

    // -------------------------------------------------------------------------
    // View Functions
    // -------------------------------------------------------------------------

    function getSession(bytes32 sessionId) external view returns (Session memory) {
        return sessions[sessionId];
    }

    function totalBalance(bytes32 sessionId) external view returns (uint256) {
        Session storage s = sessions[sessionId];
        return s.playerDeposit + s.dealerCover;
    }

    // -------------------------------------------------------------------------
    // Internal Helpers
    // -------------------------------------------------------------------------

    function _sendEther(address to, uint256 amount) internal {
        (bool success, ) = payable(to).call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    function _verifyJointSigner(
        bytes32 digest,
        bytes calldata signature,
        address expectedSigner
    ) internal pure {
        bytes32 ethSignedDigest = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)
        );

        // Check Ethereum Signed Message prefix first
        address recovered = _recoverSigner(ethSignedDigest, signature);
        if (recovered != expectedSigner) {
            // Also accept raw digest (used by threshold/joint signers without eth prefix)
            recovered = _recoverSigner(digest, signature);
        }

        if (recovered != expectedSigner) revert InvalidSignature();
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

        // Enforce malleable s-value check (EIP-2)
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert InvalidSignatureS();
        }
        if (v != 27 && v != 28) {
            revert InvalidSignatureV();
        }

        return ecrecover(hash, v, r, s);
    }
}
