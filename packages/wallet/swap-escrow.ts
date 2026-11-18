/**
 * Cross-Chain Atomic Swap Escrow Services & Calldata Builders.
 *
 * EVM: strict calldata encoders, the lock id and a lock reader for GenericHTLC v2
 * (`htlcLockId`, `encodeHtlcLock`/`Withdraw`/`Refund`, `readHtlcLock`). Solana: instruction
 * builders and the state decoder for generic-htlc.
 */
import {
  AbiCoder,
  getAddress,
  hexlify,
  Interface,
  isAddress,
  keccak256,
  sha256,
  ZeroAddress,
} from "ethers";
import type { BlockTag, Provider } from "ethers";
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

/**
 * GenericHTLC v2, as Frank calls it: the parameter and return types of the compiled contract
 * (`packages/contracts/artifacts/GenericHTLC.json`, rebuilt from
 * `packages/contracts/contracts/GenericHTLC.sol` by `yarn --cwd packages/contracts build`).
 * `swap-escrow.jest.test.ts` checks this list against that artifact in both directions.
 */
export const EVM_GENERIC_HTLC_ABI = [
  "function MAX_LOCK_DURATION() external view returns (uint256)",
  "function PAYMENT_GAS() external view returns (uint256)",
  "function lockIdOf(address sender, address recipient, address refundAddress, address token, uint256 amount, bytes32 hashLock, uint64 expiresAt) external pure returns (bytes32)",
  "function lock(address recipient, address refundAddress, address token, uint256 amount, bytes32 hashLock, uint64 expiresAt) external payable returns (bytes32 lockId)",
  "function withdraw(bytes32 lockId, bytes32 preimage) external",
  "function refund(bytes32 lockId) external",
  "function batchWithdraw(bytes32[] lockIds, bytes32 preimage) external",
  "function batchDistribute(bytes32[] lockIds, tuple(address recipient, uint256 amount)[] payouts, bytes32 preimage) external",
  "function claimOwed(address token, address to) external",
  "function locks(bytes32 lockId) external view returns (address sender, address recipient, address refundAddress, address token, bytes32 hashLock, uint256 amount, uint64 expiresAt, uint8 state, bytes32 preimage)",
  "function owed(address to, address token) external view returns (uint256)",
  "event Locked(bytes32 indexed lockId, address indexed sender, address indexed token, address recipient, address refundAddress, bytes32 hashLock, uint256 amount, uint64 expiresAt)",
  "event Withdrawn(bytes32 indexed lockId, address indexed recipient, bytes32 preimage)",
  "event BatchDistributed(bytes32[] lockIds, tuple(address recipient, uint256 amount)[] payouts, bytes32 preimage)",
  "event Refunded(bytes32 indexed lockId, address indexed refundAddress, uint256 amount)",
  "event PaymentDeferred(address indexed to, address indexed token, uint256 amount)",
  "event OwedClaimed(address indexed creditor, address indexed token, address to, uint256 amount)",
] as const;

export const evmHtlcInterface = new Interface(EVM_GENERIC_HTLC_ABI);

/** The native coin, as GenericHTLC's `token`. */
export const HTLC_NATIVE_TOKEN = ZeroAddress;

const UINT64_MAX = (1n << 64n) - 1n;

/** The terms of one GenericHTLC lock. With the sender, they determine its id. */
export interface EvmHtlcTerms {
  recipient: string;
  /** Where the funds return from `expiresAt` on. Explicit; Frank's own locks never use the recipient. */
  refundAddress: string;
  /** An ERC-20 address, or `HTLC_NATIVE_TOKEN` for the native coin. */
  token: string;
  /** In the token's (or the native coin's) smallest unit. Positive. */
  amount: bigint;
  /** sha256 of the 32-byte preimage, as 0x-prefixed 32-byte hex. */
  hashLock: string;
  /** Absolute deadline in seconds since the epoch, by the chain's block timestamp. */
  expiresAt: bigint;
}

/** A GenericHTLC lock as `locks(lockId)` reports it. */
export interface EvmHtlcLock extends EvmHtlcTerms {
  lockId: string;
  sender: string;
  state: "open" | "withdrawn" | "refunded";
  /** The preimage the lock was withdrawn with; null until it is withdrawn. */
  preimage: string | null;
}

const LOCK_STATES = [null, "open", "withdrawn", "refunded"] as const;

function requireAddress(value: unknown, what: string, allowZero = false): string {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error(`GenericHTLC ${what} must be a 20-byte address`);
  }
  const address = getAddress(value);
  if (!allowZero && address === ZeroAddress) {
    throw new Error(`GenericHTLC ${what} must not be the zero address`);
  }
  return address;
}

function requireBytes32(value: unknown, what: string): string {
  if (value instanceof Uint8Array) {
    if (value.length !== 32) throw new Error(`GenericHTLC ${what} must be exactly 32 bytes`);
    return hexlify(value);
  }
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`GenericHTLC ${what} must be exactly 32 bytes of 0x-prefixed hex`);
  }
  return value.toLowerCase();
}

/** Terms the contract can hold: what `lockIdOf` and `locks` accept. */
function requireTerms(terms: EvmHtlcTerms): EvmHtlcTerms {
  const recipient = requireAddress(terms.recipient, "recipient");
  const refundAddress = requireAddress(terms.refundAddress, "refund address");
  const token = requireAddress(terms.token, "token", true);
  if (typeof terms.amount !== "bigint" || terms.amount <= 0n) {
    throw new Error("GenericHTLC amount must be a positive bigint");
  }
  if (
    typeof terms.expiresAt !== "bigint" ||
    terms.expiresAt <= 0n ||
    terms.expiresAt > UINT64_MAX
  ) {
    throw new Error("GenericHTLC expiresAt must be a positive uint64 bigint of seconds");
  }
  return {
    recipient,
    refundAddress,
    token,
    amount: terms.amount,
    hashLock: requireBytes32(terms.hashLock, "hash lock"),
    expiresAt: terms.expiresAt,
  };
}

/**
 * The id GenericHTLC gives the lock `sender` opens with `terms`: `lockIdOf`, computed here.
 * Both parties of a swap compute it from the signed terms and find the lock on chain by it.
 */
export function htlcLockId(sender: string, terms: EvmHtlcTerms): string {
  const t = requireTerms(terms);
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "address", "uint256", "bytes32", "uint64"],
      [
        requireAddress(sender, "sender"),
        t.recipient,
        t.refundAddress,
        t.token,
        t.amount,
        t.hashLock,
        t.expiresAt,
      ]
    )
  );
}

/**
 * The transaction that opens a lock with `terms` on the GenericHTLC at `contractAddress`.
 * A native lock carries exactly `amount` as value; a token lock carries none (the sender
 * approves the contract for `amount` first). Refuses a refund address equal to the recipient.
 */
export function encodeHtlcLock(
  contractAddress: string,
  terms: EvmHtlcTerms
): { to: string; data: string; value: bigint } {
  const t = requireTerms(terms);
  // The contract allows it, but such a lock pays the recipient on either branch.
  if (t.refundAddress === t.recipient) {
    throw new Error("The refund address of a lock must not be its recipient");
  }
  return {
    to: requireAddress(contractAddress, "contract"),
    data: evmHtlcInterface.encodeFunctionData("lock", [
      t.recipient,
      t.refundAddress,
      t.token,
      t.amount,
      t.hashLock,
      t.expiresAt,
    ]),
    value: t.token === HTLC_NATIVE_TOKEN ? t.amount : 0n,
  };
}

/** The transaction that pays lock `lockId` to its recipient for the 32-byte `preimage`. */
export function encodeHtlcWithdraw(
  contractAddress: string,
  lockId: string | Uint8Array,
  preimage: string | Uint8Array
): { to: string; data: string; value: bigint } {
  return {
    to: requireAddress(contractAddress, "contract"),
    data: evmHtlcInterface.encodeFunctionData("withdraw", [
      requireBytes32(lockId, "lock id"),
      requireBytes32(preimage, "preimage"),
    ]),
    value: 0n,
  };
}

/** The transaction that pays lock `lockId` back to its refund address, from its deadline on. */
export function encodeHtlcRefund(
  contractAddress: string,
  lockId: string | Uint8Array
): { to: string; data: string; value: bigint } {
  return {
    to: requireAddress(contractAddress, "contract"),
    data: evmHtlcInterface.encodeFunctionData("refund", [
      requireBytes32(lockId, "lock id"),
    ]),
    value: 0n,
  };
}

/**
 * Decodes what `locks(lockId)` returned. Null when there is no such lock. Throws for an
 * unknown state, for a lock whose recorded terms do not give `lockId`, and for a withdrawn
 * lock whose preimage does not hash to its hash lock (either way, not GenericHTLC v2).
 */
export function decodeHtlcLock(
  lockId: string | Uint8Array,
  returnData: string
): EvmHtlcLock | null {
  const id = requireBytes32(lockId, "lock id");
  const r = evmHtlcInterface.decodeFunctionResult("locks", returnData);
  const stateIndex = Number(r.state);
  if (!Number.isInteger(stateIndex) || stateIndex < 0 || stateIndex >= LOCK_STATES.length) {
    throw new Error(`GenericHTLC lock ${id} has unknown state ${String(r.state)}`);
  }
  const state = LOCK_STATES[stateIndex];
  if (state === null) return null;
  const terms: EvmHtlcTerms = {
    recipient: r.recipient,
    refundAddress: r.refundAddress,
    token: r.token,
    amount: r.amount,
    hashLock: r.hashLock,
    expiresAt: r.expiresAt,
  };
  const sender = getAddress(r.sender);
  if (htlcLockId(sender, terms).toLowerCase() !== id) {
    throw new Error(`GenericHTLC lock ${id} does not match its recorded terms`);
  }
  let preimage: string | null = null;
  if (state === "withdrawn") {
    preimage = requireBytes32(r.preimage, "preimage");
    if (sha256(preimage).toLowerCase() !== String(r.hashLock).toLowerCase()) {
      throw new Error(`GenericHTLC lock ${id} was withdrawn with a preimage that does not match it`);
    }
  }
  return { lockId: id, sender, ...requireTerms(terms), state, preimage };
}

/**
 * Reads lock `lockId` from the GenericHTLC at `contractAddress`. Null when there is no such
 * lock. `blockTag` reads it as of a given block (for example one known to be final).
 */
export async function readHtlcLock(
  provider: Pick<Provider, "call">,
  contractAddress: string,
  lockId: string | Uint8Array,
  options: { blockTag?: BlockTag } = {}
): Promise<EvmHtlcLock | null> {
  const id = requireBytes32(lockId, "lock id");
  const returnData = await provider.call({
    to: requireAddress(contractAddress, "contract"),
    data: evmHtlcInterface.encodeFunctionData("locks", [id]),
    ...(options.blockTag === undefined ? {} : { blockTag: options.blockTag }),
  });
  return decodeHtlcLock(id, returnData);
}

/** The lock state the Solana generic-htlc decoder reports. */
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

/** A 32-byte value given as bytes or as 64 hex digits (0x optional). Nothing is hashed. */
function bytes32Of(input: string | Uint8Array, what: string): Uint8Array {
  if (input instanceof Uint8Array) {
    if (input.length === 32) return input;
  } else if (typeof input === "string") {
    const clean = input.startsWith("0x") ? input.slice(2) : input;
    if (/^[0-9a-fA-F]{64}$/.test(clean)) return fromHex(clean);
  }
  throw new Error(`generic-htlc ${what} must be exactly 32 bytes`);
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

  const lockIdHex = "0x" + toHex(data.slice(1, 33));
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
    lockId: bytes32Of(params.lockId, "lock id"),
    hashLock: bytes32Of(params.hashLock, "hash lock"),
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
    lockId: bytes32Of(params.lockId, "lock id"),
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
    lockId: bytes32Of(params.lockId, "lock id"),
    refundAddress: params.refundAddress ?? params.caller,
    programId: params.programId,
  });
}
