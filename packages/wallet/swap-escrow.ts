/**
 * Cross-Chain Atomic Swap Escrow Services & Calldata Builders.
 *
 * Provides typed transaction builders, PDA resolvers, deterministic preimage derivation,
 * and lock state evaluators for GenericHTLC on EVM (Monad/Ethereum) and generic-htlc on Solana.
 */
import {
  AbiCoder,
  concat,
  getBytes,
  hexlify,
  Interface,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import { sha256 } from "@noble/hashes/sha256";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { fromHex, toHex } from "@frank/codec";
import {
  PROTOCOL_CHAINS,
  requireChainContract,
} from "./chain/chains-registry";
import {
  buildSolanaHtlcLockInstruction,
  buildSolanaHtlcWithdrawInstruction,
  buildSolanaHtlcRefundInstruction,
  findSolanaLockPda,
  SOLANA_GENERIC_HTLC_PROGRAM_ID,
} from "./solana-game-escrow";
import type {
  SolanaHtlcLockParams,
  SolanaHtlcWithdrawParams,
  SolanaHtlcRefundParams,
} from "./solana-game-escrow";

export const EVM_GENERIC_HTLC_ABI = [
  "function lock(bytes32 lockId, address recipient, address refundAddress, bytes32 hashLock, uint256 duration) external payable",
  "function lock(bytes32 lockId, address recipient, bytes32 hashLock, uint256 duration) external payable",
  "function withdraw(bytes32 lockId, bytes calldata preimage) external",
  "function refund(bytes32 lockId) external",
  "function batchDistribute(bytes32[] calldata lockIds, tuple(address recipient, uint256 amount)[] calldata payouts, bytes calldata preimage) external",
  "function batchWithdraw(bytes32[] calldata lockIds, bytes calldata preimage) external",
  "function locks(bytes32 lockId) external view returns (address sender, address recipient, address refundAddress, bytes32 hashLock, uint256 amount, uint256 expiresAt, bool withdrawn, bool refunded)",
];

export const evmHtlcInterface = new Interface(EVM_GENERIC_HTLC_ABI);

export type SwapLockStatus =
  | "unfunded"
  | "locked"
  | "withdrawn"
  | "refunded"
  | "expired";

export interface SwapLockRecord {
  lockId: string;
  sender: string;
  recipient: string;
  refundAddress: string;
  hashLock: string;
  amount: bigint;
  expiresAt: number;
  withdrawn: boolean;
  refunded: boolean;
  isExpired: boolean;
  status: SwapLockStatus;
}

export type SwapStepPhase =
  | "offer_pending"
  | "maker_lock_needed"
  | "taker_lock_needed"
  | "ready_to_claim"
  | "preimage_revealed"
  | "settled"
  | "expired_refundable"
  | "cancelled";

export interface EvmHtlcLockTxParams {
  lockId: string | Uint8Array;
  recipient: string;
  /** Where the funds return after the timelock: the sender's own address. Never the recipient. */
  refundAddress: string;
  hashLock: string | Uint8Array;
  durationSeconds: bigint | number;
  amountWei: bigint;
  /** The GenericHTLC address on the lock's network; see `resolveHtlcContract`. */
  contractAddress: string;
}

export interface EvmHtlcWithdrawTxParams {
  lockId: string | Uint8Array;
  preimage: string | Uint8Array;
  /** The GenericHTLC address on the lock's network; see `resolveHtlcContract`. */
  contractAddress: string;
}

export interface EvmHtlcRefundTxParams {
  lockId: string | Uint8Array;
  /** The GenericHTLC address on the lock's network; see `resolveHtlcContract`. */
  contractAddress: string;
}

/**
 * Normalizes an identifier or hash to a 32-byte Uint8Array.
 */
export function to32ByteHash(input: string | Uint8Array): Uint8Array {
  if (typeof input === "string") {
    const clean = input.startsWith("0x") ? input.slice(2) : input;
    if (clean.length === 64) {
      return fromHex(clean);
    }
    // If not a 64-char hex string, hash the UTF-8 bytes to ensure exactly 32 bytes
    return sha256(toUtf8Bytes(input));
  }
  if (input.length === 32) return input;
  return sha256(input);
}

/**
 * Normalizes input to 0x-prefixed 32-byte hex string.
 */
export function toBytes32Hex(input: string | Uint8Array): string {
  const bytes = to32ByteHash(input);
  return "0x" + toHex(bytes);
}

/**
 * Derives a preimage and SHA256 hashlock from a swapId and a secret seed.
 *
 * The seed is what makes the preimage secret: the swapId is in the offer and on chain. It
 * must be 32 bytes that only the party creating the hash lock knows. There is no default.
 */
export function deriveSwapSecret(params: {
  swapId: string | Uint8Array;
  seed: Uint8Array;
}): {
  preimage: Uint8Array;
  hashLock: Uint8Array;
  preimageHex: string;
  hashLockHex: string;
} {
  const swapIdBytes = to32ByteHash(params.swapId);
  const tag = toUtf8Bytes("frank:swap-secret:v1:");
  const entropy = params.seed;
  if (!(entropy instanceof Uint8Array) || entropy.length !== 32) {
    throw new Error("deriveSwapSecret needs a 32-byte secret seed");
  }
  if (entropy.every((byte) => byte === 0)) {
    throw new Error("deriveSwapSecret refuses an all-zero seed");
  }

  const preimage = sha256(concat([tag, swapIdBytes, entropy]));
  const hashLock = sha256(preimage);

  return {
    preimage,
    hashLock,
    preimageHex: "0x" + toHex(preimage),
    hashLockHex: "0x" + toHex(hashLock),
  };
}

/**
 * Resolves the HTLC contract or program ID for a canonical `chainIdentifier`.
 * Throws for an unknown identifier, for a chain family without an HTLC, and for a network
 * the contract is not deployed on. There is no default network and no default address.
 */
export function resolveHtlcContract(chainIdentifier: string): {
  family: "evm" | "solana";
  contractAddress: string;
} {
  const entry = PROTOCOL_CHAINS[chainIdentifier];
  if (!entry) {
    throw new Error(`Unknown chain identifier "${chainIdentifier}"`);
  }
  if (entry.family !== "evm" && entry.family !== "solana") {
    throw new Error(`HTLC swaps are not supported on ${chainIdentifier}`);
  }
  return {
    family: entry.family,
    contractAddress: requireChainContract(chainIdentifier, "htlc"),
  };
}

/**
 * Encodes calldata and payload to call GenericHTLC.lock on EVM chains.
 */
export function encodeEvmHtlcLock(params: EvmHtlcLockTxParams): {
  to: string;
  data: string;
  value: bigint;
} {
  const htlc = params.contractAddress;
  const lockId = toBytes32Hex(params.lockId);
  const hashLock = toBytes32Hex(params.hashLock);
  const refund = params.refundAddress;
  if (!refund) {
    throw new Error("encodeEvmHtlcLock needs the sender's refund address");
  }
  if (refund.toLowerCase() === params.recipient.toLowerCase()) {
    throw new Error("The refund address of a lock must not be its recipient");
  }

  const data = evmHtlcInterface.encodeFunctionData(
    "lock(bytes32,address,address,bytes32,uint256)",
    [lockId, params.recipient, refund, hashLock, BigInt(params.durationSeconds)]
  );

  return {
    to: htlc,
    data,
    value: params.amountWei,
  };
}

/**
 * Encodes calldata to call GenericHTLC.withdraw on EVM chains.
 */
export function encodeEvmHtlcWithdraw(params: EvmHtlcWithdrawTxParams): {
  to: string;
  data: string;
} {
  const htlc = params.contractAddress;
  const lockId = toBytes32Hex(params.lockId);
  const preimageBytes =
    typeof params.preimage === "string"
      ? fromHex(
          params.preimage.startsWith("0x")
            ? params.preimage.slice(2)
            : params.preimage
        )
      : params.preimage;

  const data = evmHtlcInterface.encodeFunctionData("withdraw", [
    lockId,
    preimageBytes,
  ]);

  return {
    to: htlc,
    data,
  };
}

/**
 * Encodes calldata to call GenericHTLC.refund on EVM chains.
 */
export function encodeEvmHtlcRefund(params: EvmHtlcRefundTxParams): {
  to: string;
  data: string;
} {
  const htlc = params.contractAddress;
  const lockId = toBytes32Hex(params.lockId);

  const data = evmHtlcInterface.encodeFunctionData("refund", [lockId]);

  return {
    to: htlc,
    data,
  };
}

/**
 * Decodes the raw lock tuple returned from GenericHTLC.locks(lockId).
 */
export function decodeEvmHtlcLockState(params: {
  lockId: string | Uint8Array;
  result: [string, string, string, string, bigint, bigint, boolean, boolean];
  currentTimestampSec?: number;
}): SwapLockRecord {
  const [
    sender,
    recipient,
    refundAddress,
    hashLock,
    amount,
    expiresAt,
    withdrawn,
    refunded,
  ] = params.result;

  const lockIdHex = toBytes32Hex(params.lockId);
  const now = params.currentTimestampSec ?? Math.floor(Date.now() / 1000);
  const exp = Number(expiresAt);
  const isExpired = exp > 0 && now >= exp;

  let status: SwapLockStatus = "unfunded";
  if (sender !== "0x0000000000000000000000000000000000000000") {
    if (withdrawn) {
      status = "withdrawn";
    } else if (refunded) {
      status = "refunded";
    } else if (isExpired) {
      status = "expired";
    } else {
      status = "locked";
    }
  }

  return {
    lockId: lockIdHex,
    sender,
    recipient,
    refundAddress,
    hashLock,
    amount,
    expiresAt: exp,
    withdrawn,
    refunded,
    isExpired,
    status,
  };
}

/**
 * Decodes binary account state from Solana generic-htlc LockState PDA.
 *
 * Account Layout (148 bytes):
 * - is_initialized: 1b (offset 0)
 * - lock_id: 32b (offset 1)
 * - sender: 32b (offset 33)
 * - recipient: 32b (offset 65)
 * - refund_address: 32b (offset 97)
 * - hash_lock: 32b (offset 129)
 * - amount: 8b LE (offset 161)
 * - expires_at: 8b LE (offset 169)
 * - withdrawn: 1b (offset 177)
 * - refunded: 1b (offset 178)
 * - bump: 1b (offset 179)
 * Total with borsh layout:
 * - is_initialized: 1b (0)
 * - lock_id: 32b (1..33)
 * - sender: 32b (33..65)
 * - recipient: 32b (65..97)
 * - refund_address: 32b (97..129)
 * - hash_lock: 32b (129..161)
 * - amount: 8b (161..169)
 * - expires_at: 8b (169..177)
 * - withdrawn: 1b (177)
 * - refunded: 1b (178)
 * - bump: 1b (179)
 */
export function decodeSolanaHtlcLockState(params: {
  lockId: string | Uint8Array;
  accountData: Uint8Array;
  currentTimestampSec?: number;
}): SwapLockRecord | null {
  const data = params.accountData;
  if (data.length < 148 && data.length < 145) {
    return null;
  }

  const isInit = data[0] === 1;
  if (!isInit) return null;

  const lockIdHex = toBytes32Hex(data.slice(1, 33));
  const senderPubkey = new PublicKey(data.slice(33, 65)).toBase58();
  const recipientPubkey = new PublicKey(data.slice(65, 97)).toBase58();
  const refundPubkey = new PublicKey(data.slice(97, 129)).toBase58();
  const hashLockHex = "0x" + toHex(data.slice(129, 161));

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const amount = view.getBigUint64(161, true);
  const expiresAt = Number(view.getBigInt64(169, true));
  const withdrawn = data[177] === 1;
  const refunded = data[178] === 1;

  const now = params.currentTimestampSec ?? Math.floor(Date.now() / 1000);
  const isExpired = expiresAt > 0 && now >= expiresAt;

  let status: SwapLockStatus = "locked";
  if (withdrawn) {
    status = "withdrawn";
  } else if (refunded) {
    status = "refunded";
  } else if (isExpired) {
    status = "expired";
  }

  return {
    lockId: lockIdHex,
    sender: senderPubkey,
    recipient: recipientPubkey,
    refundAddress: refundPubkey,
    hashLock: hashLockHex,
    amount,
    expiresAt,
    withdrawn,
    refunded,
    isExpired,
    status,
  };
}

/**
 * Builds Solana instruction for locking funds in generic-htlc.
 */
export async function buildSolanaSwapLockInstruction(params: {
  sender: PublicKey | string;
  recipient: PublicKey | string;
  refundAddress?: PublicKey | string;
  lockId: string | Uint8Array;
  hashLock: string | Uint8Array;
  amountLamports: bigint | number;
  durationSeconds: bigint | number;
  programId?: PublicKey | string;
}): Promise<TransactionInstruction> {
  return buildSolanaHtlcLockInstruction({
    sender: params.sender,
    recipient: params.recipient,
    refundAddress: params.refundAddress,
    lockId: to32ByteHash(params.lockId),
    hashLock: to32ByteHash(params.hashLock),
    amountLamports: params.amountLamports,
    durationSeconds: params.durationSeconds,
    programId: params.programId,
  });
}

/**
 * Builds Solana instruction for withdrawing (claiming) funds from generic-htlc with a preimage.
 */
export async function buildSolanaSwapWithdrawInstruction(params: {
  caller: PublicKey | string;
  recipient: PublicKey | string;
  lockId: string | Uint8Array;
  preimage: string | Uint8Array;
  programId?: PublicKey | string;
}): Promise<TransactionInstruction> {
  return buildSolanaHtlcWithdrawInstruction({
    caller: params.caller,
    recipient: params.recipient,
    lockId: to32ByteHash(params.lockId),
    preimage: params.preimage,
    programId: params.programId,
  });
}

/**
 * Builds Solana instruction for refunding expired funds from generic-htlc.
 */
export async function buildSolanaSwapRefundInstruction(params: {
  caller: PublicKey | string;
  lockId: string | Uint8Array;
  refundAddress?: PublicKey | string;
  programId?: PublicKey | string;
}): Promise<TransactionInstruction> {
  return buildSolanaHtlcRefundInstruction({
    caller: params.caller,
    lockId: to32ByteHash(params.lockId),
    refundAddress: params.refundAddress ?? params.caller,
    programId: params.programId,
  });
}

/**
 * Comprehensive cross-chain swap status evaluator.
 */
export function evaluateSwapStepPhase(params: {
  isMaker: boolean;
  offerStatus: "pending" | "accepted" | "settled" | "cancelled" | "expired";
  legALock?: SwapLockRecord | null;
  legBLock?: SwapLockRecord | null;
  preimageRevealed?: boolean;
}): {
  phase: SwapStepPhase;
  canLock: boolean;
  canClaim: boolean;
  canRefund: boolean;
  claimPreimageRequired: boolean;
  summary: string;
} {
  const { isMaker, offerStatus, legALock, legBLock, preimageRevealed } = params;

  if (offerStatus === "cancelled") {
    return {
      phase: "cancelled",
      canLock: false,
      canClaim: false,
      canRefund: false,
      claimPreimageRequired: false,
      summary: "Swap cancelled",
    };
  }

  const legAFunded = legALock && legALock.status !== "unfunded";
  const legBFunded = legBLock && legBLock.status !== "unfunded";

  // Both completed/withdrawn
  if (legALock?.status === "withdrawn" && legBLock?.status === "withdrawn") {
    return {
      phase: "settled",
      canLock: false,
      canClaim: false,
      canRefund: false,
      claimPreimageRequired: false,
      summary: "Swap completed and settled on both chains",
    };
  }

  // Check for expired refundability
  if (isMaker && legALock?.status === "expired" && !legBFunded) {
    return {
      phase: "expired_refundable",
      canLock: false,
      canClaim: false,
      canRefund: true,
      claimPreimageRequired: false,
      summary: "Offered leg timelock expired; refund available",
    };
  }
  if (!isMaker && legBLock?.status === "expired") {
    return {
      phase: "expired_refundable",
      canLock: false,
      canClaim: false,
      canRefund: true,
      claimPreimageRequired: false,
      summary: "Counter leg timelock expired; refund available",
    };
  }

  // Both legs locked or Leg B claimed -> Ready to claim!
  if (
    legALock?.status === "locked" &&
    (legBLock?.status === "locked" ||
      legBLock?.status === "withdrawn" ||
      preimageRevealed)
  ) {
    if (isMaker) {
      if (legBLock?.status === "locked") {
        return {
          phase: "ready_to_claim",
          canLock: false,
          canClaim: true,
          canRefund: false,
          claimPreimageRequired: false, // Maker already owns preimage
          summary: "Both legs locked. Maker ready to claim and reveal preimage",
        };
      }
    } else {
      // Taker waits for Maker to claim Leg B or receives preimage
      if (preimageRevealed || legBLock?.status === "withdrawn") {
        return {
          phase: "preimage_revealed",
          canLock: false,
          canClaim: true,
          canRefund: false,
          claimPreimageRequired: true,
          summary: "Preimage revealed on chain. Taker ready to claim Leg A",
        };
      }
      return {
        phase: "ready_to_claim",
        canLock: false,
        canClaim: false,
        canRefund: false,
        claimPreimageRequired: false,
        summary:
          "Counter-leg locked. Waiting for maker to claim and reveal secret",
      };
    }
  }

  // Leg A locked, Leg B unfunded
  if (legALock?.status === "locked" && !legBFunded) {
    if (isMaker) {
      return {
        phase: "taker_lock_needed",
        canLock: false,
        canClaim: false,
        canRefund: false,
        claimPreimageRequired: false,
        summary: "Leg A locked. Waiting for counterparty to lock counter-leg",
      };
    } else {
      return {
        phase: "taker_lock_needed",
        canLock: true,
        canClaim: false,
        canRefund: false,
        claimPreimageRequired: false,
        summary: "Maker locked Leg A. Counterparty ready to lock counter-leg",
      };
    }
  }

  // Offer pending before any deposit
  if (offerStatus === "pending" || !legAFunded) {
    return {
      phase: isMaker ? "maker_lock_needed" : "offer_pending",
      canLock: isMaker,
      canClaim: false,
      canRefund: false,
      claimPreimageRequired: false,
      summary: isMaker
        ? "Offer created. Lock offered funds into HTLC contract"
        : "Offer received. Waiting for acceptance",
    };
  }

  return {
    phase: "offer_pending",
    canLock: false,
    canClaim: false,
    canRefund: false,
    claimPreimageRequired: false,
    summary: "Swap pending",
  };
}
