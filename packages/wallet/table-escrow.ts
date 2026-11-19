/**
 * A game table's buy-in escrow on GenericHTLC v2, as the arbiter (a poker or liar's dice bot)
 * and each player use it. Headless: no UI, no bot framework, no messaging.
 *
 * The table model (owner design 2026-11-18):
 * - The arbiter derives the table's 32-byte preimage from its own account
 *   (`frank/table-htlc-preimage/v1`, `./table-preimage`); the hash lock is its sha256.
 * - Each player locks exactly the buy-in, in the native coin, from its wallet's main account
 *   (the account `sendContractCall` sends from): recipient the arbiter's main account, refund
 *   address the player's main account, hash lock the table's, deadline the table's start plus
 *   {@link TABLE_BUY_IN_LOCK_SECONDS}. Every buy-in lock at a table has the same deadline.
 * - The player's join item names its lock (`lockId`), the account it locked from, and that
 *   account's signature authorizing this identity to sit with this lock at this table
 *   (`./table-join`); the arbiter checks the signature, recomputes the id from the table's terms
 *   and that account, reads `locks(lockId)` and seats the player only for an open lock with
 *   exactly those terms ({@link checkTableBuyIn}).
 * - The arbiter settles with `batchDistribute` (recipient-only) and the preimage; if it never
 *   does, each player refunds its own lock from the deadline on ({@link refundTableBuyIn}).
 *
 * Every call goes through the wallet's contract-call path with a `table-htlc` record
 * (`EvmTableHtlcCallRecord`), so it is journaled before it is signed and re-sent byte for byte.
 */
import { getAddress } from "ethers";
import type { BlockTag, Provider } from "ethers";
import type { ChainAddress, ContractCallHandle } from "./chain/chain-wallet";
import type { EvmTableHtlcCallRecord } from "./storage/evm-native-operation-journal";
import { MAX_TABLE_HTLC_LOCKS } from "./storage/evm-native-operation-journal";
import { encodeBatchDistributeCall } from "./game-escrow";
import { verifyTableJoin, type TableJoinSigner } from "./table-join";
import {
  HTLC_NATIVE_TOKEN,
  encodeHtlcLock,
  encodeHtlcRefund,
  htlcLockId,
  readHtlcLock,
  type EvmHtlcLock,
  type EvmHtlcTerms,
} from "./swap-escrow";

/** How long a buy-in stays locked: the table's start plus a day. */
export const TABLE_BUY_IN_LOCK_SECONDS = 24 * 60 * 60;
/** A table id: 16 bytes the arbiter draws, as 32 lowercase hex digits without `0x`. */
export const TABLE_ID_PATTERN = /^[0-9a-f]{32}$/;

/** What every buy-in lock at one table shares. The player learns it from the arbiter's table
 * item; the arbiter fixes it when it opens the table. */
export interface TableEscrowTerms {
  /** The arbiter's main account: every lock's recipient, the only account that may
   * `batchDistribute` them. */
  arbiter: string;
  /** sha256 of the table's preimage, 0x and 64 hex digits. */
  hashLock: string;
  /** The buy-in, in wei. Positive. */
  buyInWei: bigint;
  /** Absolute deadline, block-time seconds: the table's start plus a day. */
  expiresAt: bigint;
}

/** The deadline of a table that started at `startedAtSeconds`. */
export function tableBuyInExpiry(startedAtSeconds: number | bigint): bigint {
  return BigInt(startedAtSeconds) + BigInt(TABLE_BUY_IN_LOCK_SECONDS);
}

/** The lock `player` (its main account) opens at this table: native, exactly the buy-in, the
 * player itself as refund address. */
export function tableBuyInTerms(
  table: TableEscrowTerms,
  player: string
): EvmHtlcTerms {
  return {
    recipient: table.arbiter,
    refundAddress: player,
    token: HTLC_NATIVE_TOKEN,
    amount: table.buyInWei,
    hashLock: table.hashLock,
    expiresAt: table.expiresAt,
  };
}

/** The GenericHTLC id of `player`'s buy-in lock at this table, lowercase. */
export function tableBuyInLockId(table: TableEscrowTerms, player: string): string {
  return htlcLockId(player, tableBuyInTerms(table, player)).toLowerCase();
}

function requireTable(game: string, tableId: string): void {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(game) || game.length > 64)
    throw new Error("A table's game is its plugin item type");
  if (!TABLE_ID_PATTERN.test(tableId))
    throw new Error("A table id is 16 bytes of lowercase hex");
}

/** A contract call with its journal record, ready for the wallet's `sendContractCall`. */
export interface TableHtlcCall {
  to: string;
  data: string;
  value: bigint;
  record: EvmTableHtlcCallRecord;
}

export function tableBuyInLockCall(params: {
  contract: string;
  game: string;
  tableId: string;
  table: TableEscrowTerms;
  player: string;
}): TableHtlcCall {
  requireTable(params.game, params.tableId);
  const lockId = tableBuyInLockId(params.table, params.player);
  return {
    ...encodeHtlcLock(params.contract, tableBuyInTerms(params.table, params.player)),
    record: {
      kind: "table-htlc",
      action: "lock",
      game: params.game,
      tableId: params.tableId,
      lockIds: [lockId],
    },
  };
}

export function tableBuyInRefundCall(params: {
  contract: string;
  game: string;
  tableId: string;
  lockId: string;
}): TableHtlcCall {
  requireTable(params.game, params.tableId);
  const lockId = params.lockId.toLowerCase();
  return {
    ...encodeHtlcRefund(params.contract, lockId),
    record: {
      kind: "table-htlc",
      action: "refund",
      game: params.game,
      tableId: params.tableId,
      lockIds: [lockId],
    },
  };
}

/** One payout of a settled table: an amount to an account, in wei. */
export interface TablePayout {
  recipient: string;
  amount: bigint;
}

/** The arbiter's settlement: every seated lock, the payouts (summing to the locked total, as
 * the contract requires) and the table's preimage. */
export function tableDistributeCall(params: {
  contract: string;
  game: string;
  tableId: string;
  lockIds: string[];
  payouts: TablePayout[];
  preimage: Uint8Array;
}): TableHtlcCall {
  requireTable(params.game, params.tableId);
  const lockIds = params.lockIds.map(id => id.toLowerCase());
  if (lockIds.length === 0 || lockIds.length > MAX_TABLE_HTLC_LOCKS)
    throw new Error(`A table distributes 1..${MAX_TABLE_HTLC_LOCKS} locks`);
  if (params.payouts.length === 0 || params.payouts.some(p => p.amount <= 0n))
    throw new Error("Every payout of a table is a positive amount");
  return {
    to: getAddress(params.contract),
    data: encodeBatchDistributeCall({
      lockIds,
      payouts: params.payouts.map(p => ({
        recipient: getAddress(p.recipient),
        amount: p.amount,
      })),
      preimage: params.preimage,
    }),
    value: 0n,
    record: {
      kind: "table-htlc",
      action: "distribute",
      game: params.game,
      tableId: params.tableId,
      lockIds,
    },
  };
}

/** Why a join's lock does not seat its player. */
export type TableBuyInRefusal =
  | "not-authorized"
  | "lock-id-mismatch"
  | "no-lock"
  | "lock-not-open"
  | "terms-mismatch"
  | "deadline-too-close";

export type TableBuyInCheck =
  | { seated: true; lock: EvmHtlcLock }
  | { seated: false; reason: TableBuyInRefusal };

/**
 * Whether the lock a join names seats its player: the id recomputed from the table's terms and
 * the account the player says it locked from must be the id it names, and the chain must hold
 * that lock open with exactly those terms and sender. `minRemainingSeconds` refuses a lock whose
 * deadline is too close to settle before (`nowSeconds` from the caller's clock). First of all,
 * `signature` must be `account`'s `frank/table-join/v1` authorization for `joiner` (the identity
 * the join comes from) to sit with this lock at this table on this network: anyone can read a
 * lock id from the chain, only its owner can lend it to an identity.
 */
export async function checkTableBuyIn(params: {
  reader: Pick<Provider, "call">;
  chainIdentifier: string;
  contract: string;
  game: string;
  tableId: string;
  table: TableEscrowTerms;
  lockId: string;
  account: string;
  joiner: string;
  signature: string;
  nowSeconds: number;
  minRemainingSeconds?: number;
  blockTag?: BlockTag;
}): Promise<TableBuyInCheck> {
  if (
    !verifyTableJoin(
      {
        chainIdentifier: params.chainIdentifier,
        contract: params.contract,
        game: params.game,
        tableId: params.tableId,
        lockId: params.lockId,
        joiner: params.joiner,
      },
      params.account,
      params.signature
    )
  )
    return { seated: false, reason: "not-authorized" };
  let expected: string;
  try {
    expected = tableBuyInLockId(params.table, params.account);
  } catch {
    return { seated: false, reason: "lock-id-mismatch" };
  }
  if (expected !== params.lockId.toLowerCase())
    return { seated: false, reason: "lock-id-mismatch" };
  if (
    BigInt(params.nowSeconds) + BigInt(params.minRemainingSeconds ?? 0) >=
    params.table.expiresAt
  )
    return { seated: false, reason: "deadline-too-close" };
  const lock = await readHtlcLock(params.reader, params.contract, expected, {
    ...(params.blockTag === undefined ? {} : { blockTag: params.blockTag }),
  });
  if (!lock) return { seated: false, reason: "no-lock" };
  if (lock.state !== "open") return { seated: false, reason: "lock-not-open" };
  const terms = tableBuyInTerms(params.table, params.account);
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  // `readHtlcLock` already checked that the stored terms give this id; checked again here
  // field by field, so a refusal never rests on that alone.
  if (
    !same(lock.sender, params.account) ||
    !same(lock.recipient, terms.recipient) ||
    !same(lock.refundAddress, terms.refundAddress) ||
    !same(lock.token, terms.token) ||
    lock.amount !== terms.amount ||
    !same(lock.hashLock, terms.hashLock) ||
    lock.expiresAt !== terms.expiresAt
  )
    return { seated: false, reason: "terms-mismatch" };
  return { seated: true, lock };
}

/** The chain reads the player's side makes: an ethers provider, or the wallet's own reader
 * (`evmReader`). A head block without a time is never taken as past a deadline. */
export interface TableEscrowReader {
  call(tx: { to: string; data: string }): Promise<string>;
  getBlock(tag: "latest"): Promise<{ timestamp?: number | bigint } | null>;
  getTransactionReceipt(hash: string): Promise<{ status: number | null } | null>;
  getFeeData(): Promise<{ maxFeePerGas: bigint | null; gasPrice: bigint | null }>;
}

/** What a player's wallet needs to lock and refund a buy-in: its contract-call path. */
export interface TableEscrowWallet {
  sendContractCall?(params: {
    to: ChainAddress;
    data: string;
    value: bigint;
    gasLimit?: bigint;
    record?: EvmTableHtlcCallRecord;
  }): Promise<ContractCallHandle>;
  getContractCallFunds?(): Promise<{ mainAddress: string }>;
}

function contractCallsOf(wallet: TableEscrowWallet) {
  const { sendContractCall, getContractCallFunds } = wallet;
  if (!sendContractCall || !getContractCallFunds)
    throw new Error("This wallet cannot make contract calls");
  return {
    send: (call: TableHtlcCall, gasLimit?: bigint) =>
      sendContractCall.call(wallet, {
        to: { raw: call.to },
        data: call.data,
        value: call.value,
        ...(gasLimit === undefined ? {} : { gasLimit }),
        record: call.record,
      }),
    mainAddress: async () => getAddress((await getContractCallFunds.call(wallet)).mainAddress),
  };
}

/**
 * The player's side of joining: lock the buy-in from the wallet's main account and sign the
 * join's authorization for `joiner` (the player's identity address) with that account. Resolves
 * once the lock is handed to the network, with what the join item carries (`lockId`, `account`,
 * `signature`). The caller waits for the lock to be included before it sends the join; the
 * arbiter seats only an open lock on chain.
 */
export async function lockTableBuyIn(params: {
  wallet: TableEscrowWallet;
  signer: TableJoinSigner;
  joiner: string;
  contract: string;
  game: string;
  tableId: string;
  table: TableEscrowTerms;
  gasLimit?: bigint;
}): Promise<{ lockId: string; account: string; signature: string; call: ContractCallHandle }> {
  const calls = contractCallsOf(params.wallet);
  const account = await calls.mainAddress();
  if (getAddress(params.signer.account()) !== account)
    throw new Error("The join signer is not the account the lock is sent from");
  const call = tableBuyInLockCall({ ...params, player: account });
  const lockId = call.record.lockIds[0]!;
  const signature = params.signer.signTableJoin({
    contract: params.contract,
    game: params.game,
    tableId: params.tableId,
    lockId,
    joiner: params.joiner,
  });
  const handle = await calls.send(call, params.gasLimit);
  return { lockId, account, signature, call: handle };
}

/**
 * The player's way out when the arbiter never settles: from the deadline on, refund the lock to
 * its refund address (the player's main account). Reads the lock first: refuses one that is not
 * open, not past its deadline (by the latest block's time), or not this wallet's.
 */
export async function refundTableBuyIn(params: {
  wallet: TableEscrowWallet;
  reader: Pick<TableEscrowReader, "call" | "getBlock">;
  contract: string;
  game: string;
  tableId: string;
  lockId: string;
  gasLimit?: bigint;
}): Promise<ContractCallHandle> {
  const calls = contractCallsOf(params.wallet);
  const lock = await readHtlcLock(params.reader, params.contract, params.lockId);
  if (!lock) throw new Error("No such buy-in lock");
  if (lock.state !== "open") throw new Error(`The buy-in lock is ${lock.state}`);
  if (lock.refundAddress.toLowerCase() !== (await calls.mainAddress()).toLowerCase())
    throw new Error("The buy-in lock does not refund to this wallet");
  const head = await params.reader.getBlock("latest");
  if (head?.timestamp === undefined || BigInt(head.timestamp) < lock.expiresAt)
    throw new Error("The buy-in lock is not past its deadline yet");
  return calls.send(tableBuyInRefundCall(params), params.gasLimit);
}

/** Gas allowed for a buy-in lock when sizing what to move into the main account first. The
 * signed gas limit is the wallet's own estimate (plus its margin); this only sizes the move. */
export const TABLE_LOCK_GAS_ALLOWANCE = 300_000n;

/** How long a join waits to see its lock (or a funding move) in a block, and how often it looks. */
export interface TableEscrowTiming {
  pollMs: number;
  inclusionTimeoutMs: number;
  sleep(ms: number): Promise<void>;
}
export const DEFAULT_TABLE_ESCROW_TIMING: TableEscrowTiming = {
  pollMs: 1_500,
  inclusionTimeoutMs: 120_000,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

/** Where a join or a refund is. */
export type TableEscrowProgress =
  | { stage: "checking" }
  | { stage: "funding"; moveWei: bigint }
  | { stage: "locking" }
  | { stage: "lock-sent"; txHash: string }
  | { stage: "locked"; txHash?: string }
  | { stage: "refund-sent"; txHash: string };

export type TableEscrowFailure =
  /** The wallet's accounts together cannot pay the buy-in and the lock's network fee. */
  | "insufficient-funds"
  /** The lock's transaction is in a block and failed: nothing is locked. */
  | "lock-reverted"
  /** The lock (or the move funding it) was handed to the network and is not in a block yet: it
   * may still land. Joining again continues the same lock; it never locks twice. */
  | "lock-pending"
  /** This account's lock at this table is already withdrawn or refunded. */
  | "lock-closed"
  /** The refund's transaction is in a block and failed. */
  | "refund-reverted"
  /** The refund was handed to the network and is not in a block yet. */
  | "refund-pending";

export class TableEscrowError extends Error {
  constructor(
    readonly reason: TableEscrowFailure,
    message: string,
    readonly txHash?: string
  ) {
    super(message);
    this.name = "TableEscrowError";
  }
}

/** A table call this wallet journaled, as the join and refund find it again. */
interface JournaledCall {
  operationId: string;
  txHash: string;
}

/** What the player's side of the table escrow needs of its wallet beyond the call itself: its
 * funds, the move into the main account, and its journal, to continue an earlier call. */
export interface TableJoinWallet extends TableEscrowWallet {
  getContractCallFunds?(): Promise<{
    mainAddress: string;
    mainBalance?: bigint;
    otherBalance?: bigint;
  }>;
  fundMainAccount?(params: { value: bigint }): Promise<unknown>;
  resumeLegacySend?(operationId: string): Promise<unknown>;
  resumeNativeOperation?(operationId: string): Promise<unknown>;
  getNativeOperations?(): readonly {
    operationId: string;
    kind: string;
    cancelled: boolean;
    record?: { kind: string; action?: string; lockIds?: string[] };
    members: readonly { signed?: { transactionHash: string } }[];
  }[];
}

/** This wallet's journaled table calls of `action` on `lockId` that were signed, newest first. */
function journaledTableCalls(
  wallet: TableJoinWallet,
  action: "lock" | "refund",
  lockId: string
): JournaledCall[] {
  const id = lockId.toLowerCase();
  return (wallet.getNativeOperations?.() ?? [])
    .flatMap(row => {
      const signed = row.members[0]?.signed;
      return row.kind === "contract" &&
        !row.cancelled &&
        row.record?.kind === "table-htlc" &&
        row.record.action === action &&
        row.record.lockIds?.length === 1 &&
        row.record.lockIds[0] === id &&
        signed
        ? [{ operationId: row.operationId, txHash: signed.transactionHash }]
        : [];
    })
    .reverse();
}

/** The receipt of `txHash` once it is in a block, or null when it is not within the timeout. */
async function awaitInclusion(
  reader: Pick<TableEscrowReader, "getTransactionReceipt">,
  txHash: string,
  timing: TableEscrowTiming
): Promise<{ status: number | null } | null> {
  for (let waited = 0; ; waited += timing.pollMs) {
    const receipt = await reader.getTransactionReceipt(txHash).catch(() => null);
    if (receipt) return receipt;
    if (waited >= timing.inclusionTimeoutMs) return null;
    await timing.sleep(timing.pollMs);
  }
}

/** A submission whose outcome the wallet could not learn still names the exact operation. */
function submittedOperation(error: unknown): string | undefined {
  const e = error as {
    transaction?: { txHash?: unknown };
    operation?: { operationId?: unknown };
  } | null;
  return typeof e?.transaction?.txHash === "string" && typeof e.operation?.operationId === "string"
    ? e.operation.operationId
    : undefined;
}

/** Moves `value` into the main account and waits for it; a move that was handed out and not yet
 * seen is continued (the same operation), never started again. */
async function fundMain(wallet: TableJoinWallet, value: bigint, timing: TableEscrowTiming) {
  if (!wallet.fundMainAccount)
    throw new TableEscrowError("insufficient-funds", "The main account cannot be funded from this wallet's other accounts");
  try {
    await wallet.fundMainAccount({ value });
  } catch (error) {
    const pending = submittedOperation(error);
    if (!pending || !wallet.resumeLegacySend) throw error;
    for (let waited = 0; ; waited += timing.pollMs) {
      await timing.sleep(timing.pollMs);
      try {
        await wallet.resumeLegacySend(pending);
        return;
      } catch (again) {
        if (!submittedOperation(again)) throw again;
        if (waited >= timing.inclusionTimeoutMs)
          throw new TableEscrowError("lock-pending", "Moving the buy-in into the main account has not confirmed yet");
      }
    }
  }
}

/** Waits for a handed-out table call and lets the wallet read its inclusion into its journal
 * (which starts the note to self carrying its `table-htlc-record`). */
async function settleTableCall(
  wallet: TableJoinWallet,
  reader: Pick<TableEscrowReader, "getTransactionReceipt">,
  call: JournaledCall,
  timing: TableEscrowTiming,
  failures: { reverted: TableEscrowFailure; pending: TableEscrowFailure }
): Promise<void> {
  const receipt = await awaitInclusion(reader, call.txHash, timing);
  if (!receipt)
    throw new TableEscrowError(failures.pending, "The transaction is not in a block yet; it may still land", call.txHash);
  try {
    // Nothing is re-sent for a transaction already in a block: the wallet reads it into its
    // journal and sends the note to self. A note not sent yet is the wallet's to retry.
    await wallet.resumeNativeOperation?.(call.operationId);
  } catch {
    /* A reverted call, or a note not sent yet: what the chain says is below. */
  }
  if (receipt.status !== 1)
    throw new TableEscrowError(failures.reverted, "The transaction failed on chain", call.txHash);
}

/** An earlier call of this wallet for `lockId` that may still land: continued and waited for.
 * One that reverted is skipped (it changed nothing). False when there is none. */
async function continueEarlier(
  wallet: TableJoinWallet,
  reader: Pick<TableEscrowReader, "getTransactionReceipt">,
  action: "lock" | "refund",
  lockId: string,
  timing: TableEscrowTiming,
  onSent: (txHash: string) => void
): Promise<JournaledCall | undefined> {
  for (const earlier of journaledTableCalls(wallet, action, lockId)) {
    const receipt = await reader.getTransactionReceipt(earlier.txHash).catch(() => null);
    if (receipt && receipt.status !== 1) continue;
    // Not in a block yet: the same signed bytes are handed out again.
    if (!receipt) await wallet.resumeNativeOperation?.(earlier.operationId).catch(() => undefined);
    onSent(earlier.txHash);
    await settleTableCall(
      wallet,
      reader,
      earlier,
      timing,
      action === "lock"
        ? { reverted: "lock-reverted", pending: "lock-pending" }
        : { reverted: "refund-reverted", pending: "refund-pending" }
    );
    return earlier;
  }
  return undefined;
}

/**
 * The player's whole join, headless: makes sure this account's buy-in lock at the table is open
 * on chain and returns what the join item names (`buyInLock`), signed for `joiner`.
 *
 * - The lock id follows from the table's terms and the main account, so every device of the
 *   account finds the same lock. An open one is reused (nothing is sent); one already withdrawn
 *   or refunded is refused (`lock-closed`).
 * - A lock this wallet journaled and handed out earlier is continued (the same signed bytes),
 *   never sent twice; one that reverted locked nothing, and a new lock is sent.
 * - Otherwise, if the main account cannot pay the buy-in and the lock's fee, the shortfall moves
 *   in from the wallet's other accounts first (the contract-call consolidation), then the lock
 *   is sent and waited for.
 *
 * A lock not in a block within the timeout rejects with `lock-pending` and its transaction: it
 * may still land, and joining again continues it.
 */
export async function joinTableWithBuyIn(params: {
  wallet: TableJoinWallet;
  reader: Pick<TableEscrowReader, "call" | "getTransactionReceipt" | "getFeeData">;
  signer: TableJoinSigner;
  joiner: string;
  contract: string;
  game: string;
  tableId: string;
  table: TableEscrowTerms;
  onProgress?: (progress: TableEscrowProgress) => void;
  timing?: TableEscrowTiming;
}): Promise<{ lockId: string; account: string; signature: string; txHash?: string }> {
  const { wallet, reader, onProgress } = params;
  const timing = params.timing ?? DEFAULT_TABLE_ESCROW_TIMING;
  requireTable(params.game, params.tableId);
  onProgress?.({ stage: "checking" });
  const account = await contractCallsOf(wallet).mainAddress();
  if (getAddress(params.signer.account()) !== account)
    throw new Error("The join signer is not the account the lock is sent from");
  const lockId = tableBuyInLockId(params.table, account);
  const authorized = (txHash?: string) => ({
    lockId,
    account,
    signature: params.signer.signTableJoin({
      contract: params.contract,
      game: params.game,
      tableId: params.tableId,
      lockId,
      joiner: params.joiner,
    }),
    ...(txHash === undefined ? {} : { txHash }),
  });
  const onChain = await readHtlcLock(reader, params.contract, lockId);
  if (onChain?.state === "open") {
    onProgress?.({ stage: "locked" });
    return authorized();
  }
  if (onChain)
    throw new TableEscrowError("lock-closed", `Your buy-in lock at this table is ${onChain.state}`);

  const earlier = await continueEarlier(wallet, reader, "lock", lockId, timing, txHash =>
    onProgress?.({ stage: "lock-sent", txHash })
  );
  if (earlier) {
    onProgress?.({ stage: "locked", txHash: earlier.txHash });
    return authorized(earlier.txHash);
  }

  const funds = await wallet.getContractCallFunds!();
  if (funds.mainBalance !== undefined) {
    const fee = await reader.getFeeData();
    const maxFeePerGas = fee.maxFeePerGas ?? fee.gasPrice;
    if (maxFeePerGas == null) throw new Error("Network fee quote unavailable");
    const needed = params.table.buyInWei + TABLE_LOCK_GAS_ALLOWANCE * maxFeePerGas;
    if (funds.mainBalance < needed) {
      const moveWei = needed - funds.mainBalance;
      if ((funds.otherBalance ?? 0n) < moveWei)
        throw new TableEscrowError("insufficient-funds", "Not enough for the buy-in and its network fee");
      onProgress?.({ stage: "funding", moveWei });
      await fundMain(wallet, moveWei, timing);
    }
  }
  onProgress?.({ stage: "locking" });
  const locked = await lockTableBuyIn(params);
  onProgress?.({ stage: "lock-sent", txHash: locked.call.txHash });
  await settleTableCall(wallet, reader, locked.call, timing, {
    reverted: "lock-reverted",
    pending: "lock-pending",
  });
  onProgress?.({ stage: "locked", txHash: locked.call.txHash });
  return { lockId, account, signature: locked.signature, txHash: locked.call.txHash };
}

/**
 * The player's refund after the deadline, headless: refunds this account's lock (checked as
 * {@link refundTableBuyIn} checks it) and waits for it. A refund this wallet already handed out
 * is continued, never sent twice. Resolves with the refund's transaction once it is in a block.
 */
export async function refundTableBuyInAndWait(params: {
  wallet: TableJoinWallet;
  reader: Pick<TableEscrowReader, "call" | "getBlock" | "getTransactionReceipt">;
  contract: string;
  game: string;
  tableId: string;
  lockId: string;
  onProgress?: (progress: TableEscrowProgress) => void;
  timing?: TableEscrowTiming;
}): Promise<{ txHash: string }> {
  const { wallet, reader, onProgress } = params;
  const timing = params.timing ?? DEFAULT_TABLE_ESCROW_TIMING;
  const onSent = (txHash: string) => onProgress?.({ stage: "refund-sent", txHash });
  const earlier = await continueEarlier(wallet, reader, "refund", params.lockId, timing, onSent);
  if (earlier) return { txHash: earlier.txHash };
  const handle = await refundTableBuyIn(params);
  onSent(handle.txHash);
  await settleTableCall(wallet, reader, handle, timing, {
    reverted: "refund-reverted",
    pending: "refund-pending",
  });
  return { txHash: handle.txHash };
}
