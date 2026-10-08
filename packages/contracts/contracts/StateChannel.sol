// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IERC20.sol";

/**
 * @title StateChannel
 * @notice Universal symmetric 2-party state channel with monotonic sequence checkpoints,
 * cooperative instant close, dispute challenge windows (Nitro / Perun pattern),
 * and ERC-20 token support alongside native coin.
 * Completely application-agnostic: supports games (Blackjack, Poker), streaming micropayments, etc.
 */
contract StateChannel {
    struct Channel {
        address[2] participants;      // [partyA, partyB]
        address token;                // address(0) for native ETH/MON, non-zero for ERC-20
        uint256[2] balances;          // [balanceA, balanceB]
        uint256 currentSeq;           // Monotonically increasing sequence number
        uint256 challengeDuration;    // Challenge period in seconds (e.g. 1 hour)
        uint256 challengeExpiresAt;   // 0 if cooperative; timestamp if disputed/checkpointed
        bool settled;                 // True once funds are withdrawn
    }

    mapping(bytes32 => Channel) public channels;

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

    event ChannelOpened(
        bytes32 indexed channelId,
        address indexed partyA,
        address indexed partyB,
        address token,
        uint256 depositA,
        uint256 challengeDuration
    );

    event ChannelJoined(
        bytes32 indexed channelId,
        address indexed partyB,
        uint256 depositB
    );

    event Checkpointed(
        bytes32 indexed channelId,
        uint256 seq,
        uint256[2] balances,
        uint256 challengeExpiresAt
    );

    event ChannelSettled(
        bytes32 indexed channelId,
        uint256[2] finalBalances,
        bool cooperative
    );

    event ChannelRefunded(
        bytes32 indexed channelId,
        address indexed partyA,
        uint256 amount
    );

    error ChannelAlreadyExists();
    error ChannelNotFound();
    error ChannelAlreadySettled();
    error ChannelExpired();
    error ChallengeNotExpired();
    error ChallengeNotActive();
    error StaleSequence();
    error InvalidBalanceSum();
    error InvalidSignature();
    error TransferFailed();
    error InvalidZeroAddress();
    error Unauthorized();
    error ZeroDuration();

    /**
     * @notice Initializes a symmetric 2-party state channel with ERC-20 token or native coin.
     * @param channelId Unique channel identifier.
     * @param peer Counterparty address.
     * @param token Address of ERC-20 token, or address(0) for native coin.
     * @param depositA Amount to fund from partyA.
     * @param challengeDuration Challenge window duration in seconds for unilateral checkpoints.
     */
    function openChannel(
        bytes32 channelId,
        address peer,
        address token,
        uint256 depositA,
        uint256 challengeDuration
    ) public payable nonReentrant {
        _openInternal(channelId, peer, token, depositA, challengeDuration);
    }

    /**
     * @notice Backward-compatible overload for native coin state channels.
     * @param channelId Unique channel identifier.
     * @param peer Counterparty address.
     * @param challengeDuration Challenge window duration in seconds for unilateral checkpoints.
     */
    function openChannel(
        bytes32 channelId,
        address peer,
        uint256 challengeDuration
    ) external payable nonReentrant {
        _openInternal(channelId, peer, address(0), msg.value, challengeDuration);
    }

    function _openInternal(
        bytes32 channelId,
        address peer,
        address token,
        uint256 depositA,
        uint256 challengeDuration
    ) internal {
        if (channels[channelId].participants[0] != address(0)) revert ChannelAlreadyExists();
        if (peer == address(0) || peer == msg.sender) revert InvalidZeroAddress();
        if (challengeDuration == 0) revert ZeroDuration();

        if (token == address(0)) {
            if (msg.value != depositA) revert TransferFailed();
        } else {
            if (msg.value != 0) revert TransferFailed();
            if (depositA > 0) {
                bool success = IERC20(token).transferFrom(msg.sender, address(this), depositA);
                if (!success) revert TransferFailed();
            }
        }

        channels[channelId] = Channel({
            participants: [msg.sender, peer],
            token: token,
            balances: [depositA, 0],
            currentSeq: 0,
            challengeDuration: challengeDuration,
            challengeExpiresAt: 0,
            settled: false
        });

        emit ChannelOpened(channelId, msg.sender, peer, token, depositA, challengeDuration);
    }

    /**
     * @notice Counterparty joins the channel and funds their initial balance with explicit deposit amount.
     * Supports both native coin and ERC-20 channels.
     * @param channelId Unique channel identifier.
     * @param depositB Amount to fund from partyB.
     */
    function joinChannel(bytes32 channelId, uint256 depositB) public payable nonReentrant {
        _joinInternal(channelId, depositB);
    }

    /**
     * @notice Backward-compatible overload for joining native coin channels.
     * @param channelId Unique channel identifier.
     */
    function joinChannel(bytes32 channelId) external payable nonReentrant {
        _joinInternal(channelId, msg.value);
    }

    function _joinInternal(bytes32 channelId, uint256 depositB) internal {
        Channel storage ch = channels[channelId];
        if (ch.participants[0] == address(0)) revert ChannelNotFound();
        if (ch.settled) revert ChannelAlreadySettled();
        if (msg.sender != ch.participants[1]) revert Unauthorized();

        if (ch.token == address(0)) {
            if (msg.value != depositB) revert TransferFailed();
            ch.balances[1] += msg.value;
            emit ChannelJoined(channelId, msg.sender, msg.value);
        } else {
            if (msg.value != 0) revert TransferFailed();
            if (depositB > 0) {
                bool success = IERC20(ch.token).transferFrom(msg.sender, address(this), depositB);
                if (!success) revert TransferFailed();
            }
            ch.balances[1] += depositB;
            emit ChannelJoined(channelId, msg.sender, depositB);
        }
    }

    /**
     * @notice Checkpoints the latest off-chain state on-chain without distributing funds.
     * Enforces monotonic sequence numbers (`seq > currentSeq`).
     * Prevents the "sore loser" attack: either party can lock in progress before going offline.
     * @param channelId Unique channel identifier.
     * @param seq Monotonically increasing sequence number.
     * @param balances Current agreed balance distribution [balanceA, balanceB].
     * @param sig0 Signature from participants[0] over (channelId, seq, balances, false, contract, chainid).
     * @param sig1 Signature from participants[1] over (channelId, seq, balances, false, contract, chainid).
     */
    function checkpoint(
        bytes32 channelId,
        uint256 seq,
        uint256[2] calldata balances,
        bytes calldata sig0,
        bytes calldata sig1
    ) external nonReentrant {
        Channel storage ch = channels[channelId];
        if (ch.participants[0] == address(0)) revert ChannelNotFound();
        if (ch.settled) revert ChannelAlreadySettled();
        if (seq <= ch.currentSeq) revert StaleSequence();

        uint256 total = ch.balances[0] + ch.balances[1];
        if (balances[0] + balances[1] != total) revert InvalidBalanceSum();

        bytes32 digest = getCheckpointDigest(channelId, seq, balances, false);
        if (recoverSigner(digest, sig0) != ch.participants[0]) revert InvalidSignature();
        if (recoverSigner(digest, sig1) != ch.participants[1]) revert InvalidSignature();

        ch.currentSeq = seq;
        ch.balances[0] = balances[0];
        ch.balances[1] = balances[1];
        ch.challengeExpiresAt = block.timestamp + ch.challengeDuration;

        emit Checkpointed(channelId, seq, balances, ch.challengeExpiresAt);
    }

    /**
     * @notice Cooperatively settles and closes the channel immediately with zero challenge delay.
     * Payouts can be routed to arbitrary destination addresses (e.g. fresh DKSAP stealth addresses).
     * Supports both native coin and ERC-20 channels.
     * @param channelId Unique channel identifier.
     * @param seq Final sequence number (must be >= currentSeq).
     * @param balances Final agreed balance distribution [balanceA, balanceB].
     * @param payout0 Destination address for participants[0] balance (defaults to participants[0] if 0).
     * @param payout1 Destination address for participants[1] balance (defaults to participants[1] if 0).
     * @param sig0 Signature from participants[0] with isFinal = true.
     * @param sig1 Signature from participants[1] with isFinal = true.
     */
    function closeCooperative(
        bytes32 channelId,
        uint256 seq,
        uint256[2] calldata balances,
        address payout0,
        address payout1,
        bytes calldata sig0,
        bytes calldata sig1
    ) public nonReentrant {
        Channel storage ch = channels[channelId];
        if (ch.participants[0] == address(0)) revert ChannelNotFound();
        if (ch.settled) revert ChannelAlreadySettled();
        if (seq < ch.currentSeq) revert StaleSequence();

        uint256 total = ch.balances[0] + ch.balances[1];
        if (balances[0] + balances[1] != total) revert InvalidBalanceSum();

        bytes32 digest = getCloseDigest(channelId, seq, balances, payout0, payout1, true);
        if (recoverSigner(digest, sig0) != ch.participants[0]) revert InvalidSignature();
        if (recoverSigner(digest, sig1) != ch.participants[1]) revert InvalidSignature();

        ch.settled = true;
        ch.balances[0] = balances[0];
        ch.balances[1] = balances[1];

        address dest0 = payout0 == address(0) ? ch.participants[0] : payout0;
        address dest1 = payout1 == address(0) ? ch.participants[1] : payout1;

        if (ch.token == address(0)) {
            if (balances[0] > 0) {
                (bool s0, ) = payable(dest0).call{value: balances[0]}("");
                if (!s0) revert TransferFailed();
            }

            if (balances[1] > 0) {
                (bool s1, ) = payable(dest1).call{value: balances[1]}("");
                if (!s1) revert TransferFailed();
            }
        } else {
            if (balances[0] > 0) {
                bool s0 = IERC20(ch.token).transfer(dest0, balances[0]);
                if (!s0) revert TransferFailed();
            }

            if (balances[1] > 0) {
                bool s1 = IERC20(ch.token).transfer(dest1, balances[1]);
                if (!s1) revert TransferFailed();
            }
        }

        emit ChannelSettled(channelId, balances, true);
    }

    /**
     * @notice Overload for closeCooperative defaulting payouts to participants' original addresses.
     */
    function closeCooperative(
        bytes32 channelId,
        uint256 seq,
        uint256[2] calldata balances,
        bytes calldata sig0,
        bytes calldata sig1
    ) external {
        closeCooperative(channelId, seq, balances, address(0), address(0), sig0, sig1);
    }

    /**
     * @notice Settles and disburses funds after a challenge window has expired with no higher seq submitted.
     * Guarantees that an honest party receives their checkpointed balance even if peer abandons.
     * Supports both native coin and ERC-20 channels.
     * @param channelId Unique channel identifier.
     */
    function closeAfterChallenge(bytes32 channelId) external nonReentrant {
        Channel storage ch = channels[channelId];
        if (ch.participants[0] == address(0)) revert ChannelNotFound();
        if (ch.settled) revert ChannelAlreadySettled();
        if (ch.challengeExpiresAt == 0) revert ChallengeNotActive();
        if (block.timestamp < ch.challengeExpiresAt) revert ChallengeNotExpired();

        ch.settled = true;
        uint256 bal0 = ch.balances[0];
        uint256 bal1 = ch.balances[1];

        if (ch.token == address(0)) {
            if (bal0 > 0) {
                (bool s0, ) = payable(ch.participants[0]).call{value: bal0}("");
                if (!s0) revert TransferFailed();
            }

            if (bal1 > 0) {
                (bool s1, ) = payable(ch.participants[1]).call{value: bal1}("");
                if (!s1) revert TransferFailed();
            }
        } else {
            if (bal0 > 0) {
                bool s0 = IERC20(ch.token).transfer(ch.participants[0], bal0);
                if (!s0) revert TransferFailed();
            }

            if (bal1 > 0) {
                bool s1 = IERC20(ch.token).transfer(ch.participants[1], bal1);
                if (!s1) revert TransferFailed();
            }
        }

        emit ChannelSettled(channelId, [bal0, bal1], false);
    }

    /**
     * @notice Unilaterally refunds partyA if partyB never joined and funding timeout elapsed.
     * Supports both native coin and ERC-20 channels.
     * @param channelId Unique channel identifier.
     */
    function refundTimeout(bytes32 channelId) external nonReentrant {
        Channel storage ch = channels[channelId];
        if (ch.participants[0] == address(0)) revert ChannelNotFound();
        if (ch.settled) revert ChannelAlreadySettled();
        if (ch.balances[1] != 0 || ch.currentSeq != 0) revert Unauthorized();
        if (msg.sender != ch.participants[0]) revert Unauthorized();

        ch.settled = true;
        uint256 amount = ch.balances[0];

        if (amount > 0) {
            if (ch.token == address(0)) {
                (bool success, ) = payable(ch.participants[0]).call{value: amount}("");
                if (!success) revert TransferFailed();
            } else {
                bool success = IERC20(ch.token).transfer(ch.participants[0], amount);
                if (!success) revert TransferFailed();
            }
        }

        emit ChannelRefunded(channelId, ch.participants[0], amount);
    }

    /**
     * @notice Computes EIP-191 personal_sign hash for intermediate checkpoint state.
     */
    function getCheckpointDigest(
        bytes32 channelId,
        uint256 seq,
        uint256[2] calldata balances,
        bool isFinal
    ) public view returns (bytes32) {
        bytes32 innerPayload = keccak256(
            abi.encode(channelId, seq, balances, isFinal, address(this), block.chainid)
        );
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", innerPayload));
    }

    /**
     * @notice Computes EIP-191 personal_sign hash for final cooperative close.
     */
    function getCloseDigest(
        bytes32 channelId,
        uint256 seq,
        uint256[2] calldata balances,
        address payout0,
        address payout1,
        bool isFinal
    ) public view returns (bytes32) {
        bytes32 innerPayload = keccak256(
            abi.encode(channelId, seq, balances, payout0, payout1, isFinal, address(this), block.chainid)
        );
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", innerPayload));
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
