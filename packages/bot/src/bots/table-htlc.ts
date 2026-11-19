/**
 * A game table's GenericHTLC v2 buy-in escrow, as the poker and liars-dice bots (the arbiter)
 * hold it (`@frank/wallet/table-escrow` has the terms and calls both sides use).
 *
 * - Opening a table: the bot draws a 16-byte table id and derives the table's preimage from its
 *   own account (`ctx.tableSecrets`, `frank/table-htlc-preimage/v1`); the hash lock is its
 *   sha256. The arbiter is the bot wallet's main account (`ctx.contractCalls.account()`), the
 *   deadline the table's start plus a day. The terms go out in the table items (`escrow`).
 * - Seating: a player's structured join names its lock (`buyInLock`) with the locking account's
 *   signature letting this identity sit with it (`@frank/wallet/table-join`); the bot checks the
 *   signature, recomputes the id from the table's terms and the account and seats the player only
 *   for an open lock with exactly those terms on chain. The game's own join runs in the same step
 *   (`admit`): if the game refuses the player, no seat is recorded. Nothing else seats a player.
 * - Settling: the bot writes the payouts down, then sends `batchDistribute` with the preimage
 *   through the wallet's contract-call path (`ctx.contractCalls`, a `table-htlc` record, the locks'
 *   deadline as the call's). The call's id is written down when it is signed, before it is handed
 *   out. Each payout goes to the account the player locked from. A send that fails is retried in
 *   the background, as written, with backoff. A send waits at most
 *   `TABLE_MAIN_ACCOUNT_WAIT_MS` for a busy main account; giving up is such a failure.
 * - Watching: after a send the same background step looks at the chain again, with the same
 *   backoff, until the locks are withdrawn: a call not yet in a block is handed out again, a
 *   reverted one (receipt status 0) re-sent with the same payouts. Once every lock is withdrawn
 *   the record is dropped (`get` then returns nothing; a bot keeps its own record that the table
 *   is closed).
 * - After a restart (`recover`), a table whose game is gone is settled the way it was written
 *   down (a recorded settlement is resumed or re-sent as it was, never recomputed), or, with
 *   nothing written, by returning each buy-in. The preimage is derived again; it is never stored.
 *   Each table recovers on its own: one that fails is logged and retried later; startup never
 *   waits for it.
 * - If the bot never settles, each player refunds its own lock from the deadline on.
 *
 * Every seat, settlement and recovery step of one table runs alone (one lane per table), and
 * reads the table again after each wait. What is kept (in the bot's state store,
 * `table-escrow:<tableId>` and an index): the table's terms, its seats and its settlement. The
 * chain is the authority on each lock's state.
 */
import { randomBytes } from "crypto";
import type { BotContext } from "@frank/bot-framework";
import type { TableBuyInLockItem, TableEscrowItemTerms } from "@frank/cashweb/types/messages";
import { htlcHashLock, readHtlcLock } from "@frank/wallet/swap-escrow";
import {
  TABLE_ID_PATTERN,
  checkTableBuyIn,
  tableBuyInExpiry,
  tableDistributeCall,
  type TableBuyInRefusal,
  type TableEscrowTerms,
} from "@frank/wallet/table-escrow";

export type TableGame = "poker" | "liars-dice";

/** Seating closes this long before the deadline, so the table can still settle in time. */
export const TABLE_SEATING_MARGIN_SECONDS = 60 * 60;
/** Background retries of a settlement or a recovery: from this, doubling, up to the cap. */
export const TABLE_RETRY_BASE_MS = 5_000;
export const TABLE_RETRY_MAX_MS = 10 * 60_000;
/** How long a settlement's send waits for the main account's earlier payment to be seen on
 * chain before it gives up (and is retried in the background), so a player's message handler
 * does not wait on a busy account. */
export const TABLE_MAIN_ACCOUNT_WAIT_MS = 10_000;

export interface TableEscrowSeat {
  /** The player's identity address (the one it messages from). */
  player: string;
  /** Its buy-in lock, `0x` and 64 lowercase hex digits. */
  lockId: string;
  /** The account it locked from and the lock refunds to; where its payout goes. */
  account: string;
}

export interface TableEscrowPayout {
  recipient: string;
  amountWei: string;
}

export interface TableEscrowRecord {
  version: 1;
  game: TableGame;
  /** 16 bytes, 32 lowercase hex digits. */
  tableId: string;
  arbiter: string;
  hashLock: string;
  buyInWei: string;
  /** Seconds. */
  expiresAt: number;
  seats: TableEscrowSeat[];
  /** Written before the distribute is signed; its call's id once signed, before it is sent. */
  settlement?: {
    payouts: TableEscrowPayout[];
    operationId?: string;
    txHash?: string;
  };
}

/** Why a table cannot be opened: the bot's wallet lacks a capability the escrow needs. */
export interface TableEscrowUnavailable {
  readonly status: "unavailable";
  readonly reason: string;
}

/** The game's own join, run in the seating step: `ok` sits the player at the game. */
export type TableAdmit = () => { ok: true } | { ok: false; error: string };

export type TableSeatRefusal =
  | TableBuyInRefusal
  | "no-table"
  | "no-buy-in-lock"
  | "lock-already-seated"
  | "table-settled"
  | "unreadable";

export type TableSeatResult =
  | { seated: true }
  | { seated: false; reason: TableSeatRefusal }
  | { seated: false; reason: "game-refused"; error: string };

export type TableSettlementResult =
  | { status: "sent"; tableId: string; txHash: string; payouts: TableEscrowPayout[] }
  | { status: "resumed"; tableId: string; txHash: string }
  | { status: "settled"; tableId: string }
  | { status: "nothing-locked"; tableId: string }
  | { status: "retrying"; tableId: string; reason: string }
  | { status: "not-settleable"; tableId: string; reason: string };

/** The shares of a settlement, worked out from the table as it is when the settlement runs. */
export type TableShares = (
  record: Readonly<TableEscrowRecord>
) => Array<{ player: string; amountWei: bigint }>;

/** What a bot asks of its table escrow; `TableEscrows` is the one that uses the chain. */
export interface TableEscrowBook {
  open(ctx: BotContext, buyInWei: bigint): Promise<TableEscrowRecord | TableEscrowUnavailable>;
  get(tableId: string): Readonly<TableEscrowRecord> | undefined;
  /** Seats `player` for its lock and, in the same step, runs the game's join (`admit`). `lock`
   * absent (a text join): refused, `no-buy-in-lock`. */
  seat(
    ctx: BotContext,
    tableId: string,
    player: string,
    lock: TableBuyInLockItem | undefined,
    admit: TableAdmit
  ): Promise<TableSeatResult>;
  /** Pays the table out: `shares` by seated player, summing to the locked total. */
  settle(ctx: BotContext, tableId: string, shares: TableShares): Promise<TableSettlementResult>;
  /** After a restart: settles every kept table that `live` does not know, each on its own.
   * Never rejects; a table that fails is retried in the background. */
  recover(ctx: BotContext, live: (tableId: string) => boolean): Promise<TableSettlementResult[]>;
  /** Stops background retries and watching (the bot is stopping): no retry runs or is scheduled
   * from now on, and a step already running is finished before this resolves, so the bot's state
   * store and provider can then be closed. */
  stop(): Promise<void>;
}

export function tableEscrowItemTerms(record: Readonly<TableEscrowRecord>): TableEscrowItemTerms {
  return { arbiter: record.arbiter, hashLock: record.hashLock, expiresAt: record.expiresAt };
}

/** The locked pot: one buy-in per seat. */
export function tablePool(record: Readonly<TableEscrowRecord>): bigint {
  return BigInt(record.buyInWei) * BigInt(record.seats.length);
}

/** Every seat gets its buy-in back. */
export const returnBuyIns: TableShares = record =>
  record.seats.map(s => ({ player: s.player, amountWei: BigInt(record.buyInWei) }));

function termsOf(record: Readonly<TableEscrowRecord>): TableEscrowTerms {
  return {
    arbiter: record.arbiter,
    hashLock: record.hashLock,
    buyInWei: BigInt(record.buyInWei),
    expiresAt: BigInt(record.expiresAt),
  };
}

/** `pool` split by `weights` (whole wei, rounded down), the remainder to the largest weight, so
 * the parts sum to `pool` exactly. Zero weights get nothing. */
export function splitPool(
  pool: bigint,
  weights: Array<{ player: string; weight: bigint }>
): Array<{ player: string; amountWei: bigint }> {
  const live = weights.filter(w => w.weight > 0n);
  const total = live.reduce((sum, w) => sum + w.weight, 0n);
  if (total === 0n) throw new Error("Nobody holds a share of the pool");
  const parts = live.map(w => ({ player: w.player, amountWei: (pool * w.weight) / total }));
  const rest = pool - parts.reduce((sum, p) => sum + p.amountWei, 0n);
  let top = 0;
  for (let i = 1; i < live.length; i++) if (live[i]!.weight > live[top]!.weight) top = i;
  parts[top]!.amountWei += rest;
  return parts.filter(p => p.amountWei > 0n);
}

/** What a refused seat says to the player. */
export function seatRefusalText(result: Extract<TableSeatResult, { seated: false }>): string {
  switch (result.reason) {
    case "no-buy-in-lock":
      return "join from the app: it locks your buy-in first, and the join names that lock.";
    case "not-authorized":
      return "that buy-in lock is not yours to sit with: its account did not authorize you.";
    case "lock-id-mismatch":
    case "terms-mismatch":
      return "your buy-in lock does not have this table's terms.";
    case "no-lock":
      return "your buy-in lock is not on chain yet. Join again once it is.";
    case "lock-not-open":
      return "your buy-in lock is no longer open.";
    case "lock-already-seated":
      return "that buy-in lock already holds a seat.";
    case "deadline-too-close":
      return "this table is too close to its deadline to seat anyone.";
    case "table-settled":
      return "this table has settled.";
    case "unreadable":
      return "your buy-in lock could not be read from the chain. Try again.";
    case "game-refused":
      return `${result.error}. Your buy-in lock holds no seat; refund it after its deadline.`;
    case "no-table":
      return "no such table.";
  }
}

/** What a settlement says, in the game's summary. */
export function settlementText(
  result: TableSettlementResult,
  ctx: Pick<BotContext, "formatAmount">
): string {
  switch (result.status) {
    case "sent":
      return `Paid out on chain (${result.txHash}): ${result.payouts
        .map(p => `${ctx.formatAmount(BigInt(p.amountWei))} to ${p.recipient.slice(0, 8)}`)
        .join(", ")}.`;
    case "resumed":
      return `Payout re-sent (${result.txHash}).`;
    case "settled":
      return "Already paid out.";
    case "nothing-locked":
      return "No buy-in was locked, so nothing is paid out.";
    case "retrying":
      return `Payout written down, not sent yet (${result.reason}): the bot keeps trying.`;
    case "not-settleable":
      return `Not paid out: ${result.reason}`;
  }
}

const INDEX_KEY = "table-escrow:index";
const recordKey = (tableId: string) => `table-escrow:${tableId}`;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class TableEscrows implements TableEscrowBook {
  private readonly records = new Map<string, TableEscrowRecord>();
  private readonly lanes = new Map<string, Promise<unknown>>();
  private readonly retries = new Map<
    string,
    { attempt: number; timer?: NodeJS.Timeout; gameGone: boolean }
  >();
  private stopped = false;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly mainAccountWaitMs: number;

  constructor(
    readonly game: TableGame,
    options: { retryBaseMs?: number; retryMaxMs?: number; mainAccountWaitMs?: number } = {}
  ) {
    this.retryBaseMs = options.retryBaseMs ?? TABLE_RETRY_BASE_MS;
    this.retryMaxMs = options.retryMaxMs ?? TABLE_RETRY_MAX_MS;
    this.mainAccountWaitMs = options.mainAccountWaitMs ?? TABLE_MAIN_ACCOUNT_WAIT_MS;
  }

  get(tableId: string): Readonly<TableEscrowRecord> | undefined {
    return this.records.get(tableId);
  }

  /** Runs `task` after every earlier task of the same table, alone. */
  private lane<T>(tableId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(tableId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.lanes.set(tableId, tail);
    void tail.then(() => {
      if (this.lanes.get(tableId) === tail) this.lanes.delete(tableId);
    });
    return run;
  }

  /** In memory first, so a later step of the same lane never reads an older copy. */
  private async persist(ctx: BotContext, record: TableEscrowRecord): Promise<void> {
    this.records.set(record.tableId, record);
    const index = await this.index(ctx);
    if (!index.includes(record.tableId)) index.push(record.tableId);
    await ctx.state.batch([
      { type: "put", key: recordKey(record.tableId), value: JSON.stringify(record) },
      { type: "put", key: INDEX_KEY, value: JSON.stringify(index) },
    ]);
  }

  private async forget(ctx: BotContext, tableId: string): Promise<void> {
    this.records.delete(tableId);
    const index = (await this.index(ctx)).filter(id => id !== tableId);
    await ctx.state.batch([
      { type: "del", key: recordKey(tableId) },
      { type: "put", key: INDEX_KEY, value: JSON.stringify(index) },
    ]);
  }

  private async index(ctx: BotContext): Promise<string[]> {
    const raw = await ctx.state.get(INDEX_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  }

  async open(ctx: BotContext, buyInWei: bigint): Promise<TableEscrowRecord | TableEscrowUnavailable> {
    if (!ctx.tableSecrets || !ctx.contractCalls)
      return {
        status: "unavailable",
        reason: "this bot's wallet cannot hold a table escrow (no table secret or contract calls)",
      };
    if (buyInWei <= 0n) return { status: "unavailable", reason: "a table's buy-in must be positive" };
    try {
      ctx.contractCalls.htlcContract();
    } catch {
      return { status: "unavailable", reason: "no GenericHTLC is deployed on this network" };
    }
    const id = randomBytes(16);
    const preimage = ctx.tableSecrets.tablePreimage({ game: this.game, tableId: id });
    const hashLock = htlcHashLock(preimage);
    preimage.fill(0);
    const record: TableEscrowRecord = {
      version: 1,
      game: this.game,
      tableId: id.toString("hex"),
      arbiter: await ctx.contractCalls.account(),
      hashLock,
      buyInWei: buyInWei.toString(),
      expiresAt: Number(tableBuyInExpiry(nowSeconds())),
      seats: [],
    };
    await this.persist(ctx, record);
    return record;
  }

  seat(
    ctx: BotContext,
    tableId: string,
    player: string,
    lock: TableBuyInLockItem | undefined,
    admit: TableAdmit
  ): Promise<TableSeatResult> {
    return this.lane(tableId, async (): Promise<TableSeatResult> => {
      const before = this.records.get(tableId);
      if (!before || !ctx.contractCalls) return { seated: false, reason: "no-table" };
      if (before.settlement) return { seated: false, reason: "table-settled" };
      if (!lock) return { seated: false, reason: "no-buy-in-lock" };
      const lockId = lock.lockId.toLowerCase();
      const taken = (record: Readonly<TableEscrowRecord>): TableSeatResult | undefined => {
        const mine = record.seats.find(s => s.player.toLowerCase() === player.toLowerCase());
        if (mine) return mine.lockId === lockId ? { seated: true } : { seated: false, reason: "lock-already-seated" };
        if (record.seats.some(s => s.lockId === lockId)) return { seated: false, reason: "lock-already-seated" };
        return undefined;
      };
      const early = taken(before);
      if (early) return early;
      let check;
      try {
        check = await checkTableBuyIn({
          reader: ctx.provider,
          chainIdentifier: ctx.contractCalls.chainIdentifier,
          contract: ctx.contractCalls.htlcContract(),
          game: before.game,
          tableId,
          table: termsOf(before),
          lockId,
          account: lock.account,
          joiner: player,
          signature: lock.signature,
          nowSeconds: nowSeconds(),
          minRemainingSeconds: TABLE_SEATING_MARGIN_SECONDS,
        });
      } catch {
        return { seated: false, reason: "unreadable" };
      }
      if (!check.seated) return check;
      // Read again after the wait: only this lane writes the table, but nothing is assumed.
      const record = this.records.get(tableId);
      if (!record) return { seated: false, reason: "no-table" };
      if (record.settlement) return { seated: false, reason: "table-settled" };
      const late = taken(record);
      if (late) return late;
      // The game and the escrow take the player in one step: no seat without a player.
      const admitted = admit();
      if (!admitted.ok) return { seated: false, reason: "game-refused", error: admitted.error };
      await this.persist(ctx, {
        ...record,
        seats: [...record.seats, { player, lockId, account: check.lock.sender.toLowerCase() }],
      });
      return { seated: true };
    });
  }

  settle(ctx: BotContext, tableId: string, shares: TableShares): Promise<TableSettlementResult> {
    return this.lane(tableId, () => this.settleNow(ctx, tableId, shares));
  }

  /** In the table's lane. */
  private async settleNow(
    ctx: BotContext,
    tableId: string,
    sharesOf: TableShares
  ): Promise<TableSettlementResult> {
    const record = this.records.get(tableId);
    if (!record) return { status: "not-settleable", tableId, reason: "no such table" };
    if (record.settlement)
      return { status: "not-settleable", tableId, reason: "the table is already being settled" };
    if (record.seats.length === 0) return { status: "nothing-locked", tableId };
    const pool = tablePool(record);
    const accountOf = new Map(record.seats.map(s => [s.player.toLowerCase(), s.account]));
    const merged = new Map<string, bigint>();
    let shares;
    try {
      shares = sharesOf(record);
    } catch (error) {
      return { status: "not-settleable", tableId, reason: reasonOf(error) };
    }
    for (const share of shares) {
      const account = accountOf.get(share.player.toLowerCase());
      if (!account)
        return { status: "not-settleable", tableId, reason: `${share.player} holds no seat` };
      if (share.amountWei <= 0n) continue;
      merged.set(account, (merged.get(account) ?? 0n) + share.amountWei);
    }
    const payouts = [...merged].map(([recipient, amount]) => ({ recipient, amountWei: amount.toString() }));
    const total = [...merged.values()].reduce((sum, v) => sum + v, 0n);
    if (total !== pool)
      return { status: "not-settleable", tableId, reason: `the payouts (${total}) are not the pot (${pool})` };
    // Written down before anything is signed: a retry or a restart sends exactly this.
    await this.persist(ctx, { ...record, settlement: { payouts } });
    return this.sendSettlement(ctx, tableId, false);
  }

  /** In the table's lane: sends the written settlement. A failure is retried in the background. */
  private async sendSettlement(
    ctx: BotContext,
    tableId: string,
    gameGone: boolean
  ): Promise<TableSettlementResult> {
    const record = this.records.get(tableId)!;
    const calls = ctx.contractCalls;
    if (!calls || !ctx.tableSecrets)
      return { status: "not-settleable", tableId, reason: "no contract calls" };
    if (nowSeconds() >= record.expiresAt)
      return {
        status: "not-settleable",
        tableId,
        reason: "the buy-in locks are past their deadline: each player refunds its own",
      };
    const payouts = record.settlement!.payouts;
    try {
      const preimage = ctx.tableSecrets.tablePreimage({
        game: record.game,
        tableId: Buffer.from(tableId, "hex"),
      });
      let call;
      try {
        if (htlcHashLock(preimage) !== record.hashLock)
          throw new Error("the derived preimage does not open this table's hash lock");
        call = tableDistributeCall({
          contract: calls.htlcContract(),
          game: record.game,
          tableId,
          lockIds: record.seats.map(s => s.lockId),
          payouts: payouts.map(p => ({ recipient: p.recipient, amount: BigInt(p.amountWei) })),
          preimage,
        });
      } finally {
        preimage.fill(0);
      }
      const keep = async (signed: { operationId: string; txHash: string }) => {
        const now = this.records.get(tableId)!;
        await this.persist(ctx, {
          ...now,
          settlement: { payouts, operationId: signed.operationId, txHash: signed.txHash },
        });
      };
      const sent = await calls.send({
        ...call,
        deadline: record.expiresAt,
        // The call's id is kept once signed, before anyone has the bytes: no window in which a
        // handed-out call is not written down.
        onSigned: keep,
        // A busy main account does not hold the ending player's message: the send gives up,
        // having signed nothing, and is retried in the background.
        mainAccountWaitMs: this.mainAccountWaitMs,
      });
      await keep(sent);
      // Handed out: watched from now on, from a fresh backoff, until the chain shows the locks
      // withdrawn (not in a block: handed out again; reverted: re-sent as written).
      this.clearRetry(tableId);
      this.scheduleRetry(ctx, tableId, gameGone);
      return { status: "sent", tableId, txHash: sent.txHash, payouts };
    } catch (error) {
      const reason = reasonOf(error);
      console.warn(`[table-escrow] table ${tableId}: settlement not sent (${reason}); retrying`);
      this.scheduleRetry(ctx, tableId, gameGone);
      return { status: "retrying", tableId, reason };
    }
  }

  /** Stopped by `stop`, or the host is stopping: nothing new is started in the background. */
  private stopping(ctx: BotContext): boolean {
    return this.stopped || ctx.stopping?.aborted === true;
  }

  private scheduleRetry(ctx: BotContext, tableId: string, gameGone: boolean): void {
    if (this.stopping(ctx)) return;
    const entry = this.retries.get(tableId) ?? { attempt: 0, gameGone };
    if (entry.timer) clearTimeout(entry.timer);
    const delay = Math.min(this.retryBaseMs * 2 ** entry.attempt, this.retryMaxMs);
    entry.attempt += 1;
    entry.gameGone = entry.gameGone || gameGone;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (this.stopping(ctx)) return;
      void this.lane(tableId, () => this.reconcileSafely(ctx, tableId, entry.gameGone));
    }, delay);
    entry.timer.unref?.();
    this.retries.set(tableId, entry);
  }

  private clearRetry(tableId: string): void {
    const entry = this.retries.get(tableId);
    if (entry?.timer) clearTimeout(entry.timer);
    this.retries.delete(tableId);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const entry of this.retries.values()) if (entry.timer) clearTimeout(entry.timer);
    this.retries.clear();
    // A step already running (a retry, a recovery, a settlement) uses the state store and the
    // provider: it finishes before they close. Once stopped, it schedules nothing after itself.
    while (this.lanes.size) await Promise.allSettled([...this.lanes.values()]);
  }

  async recover(ctx: BotContext, live: (tableId: string) => boolean): Promise<TableSettlementResult[]> {
    const results: TableSettlementResult[] = [];
    let index: string[];
    try {
      index = await this.index(ctx);
    } catch (error) {
      console.warn(`[table-escrow] the kept tables could not be read (${reasonOf(error)})`);
      return results;
    }
    for (const tableId of index) {
      if (this.stopping(ctx)) break;
      if (!TABLE_ID_PATTERN.test(tableId)) continue;
      try {
        const raw = await ctx.state.get(recordKey(tableId));
        if (!raw) continue;
        const record = JSON.parse(raw) as TableEscrowRecord;
        if (record.version !== 1 || record.game !== this.game) continue;
        this.records.set(tableId, record);
      } catch (error) {
        console.warn(`[table-escrow] table ${tableId}: unreadable record (${reasonOf(error)}); skipped`);
        continue;
      }
      if (live(tableId) || this.stopping(ctx)) continue;
      results.push(await this.lane(tableId, () => this.reconcileSafely(ctx, tableId, true)));
    }
    return results;
  }

  /** In the table's lane: one recovery step that never throws; a failure is retried later. */
  private async reconcileSafely(
    ctx: BotContext,
    tableId: string,
    gameGone: boolean
  ): Promise<TableSettlementResult> {
    try {
      const result = await this.reconcile(ctx, tableId, gameGone);
      // A call handed out again is looked at again later, until the chain shows it. A call sent
      // (or a send that failed) has already scheduled its next look.
      if (result.status === "resumed") this.scheduleRetry(ctx, tableId, gameGone);
      else if (result.status !== "retrying" && result.status !== "sent") this.clearRetry(tableId);
      return result;
    } catch (error) {
      const reason = reasonOf(error);
      console.warn(`[table-escrow] table ${tableId}: recovery failed (${reason}); retrying`);
      this.scheduleRetry(ctx, tableId, gameGone);
      return { status: "retrying", tableId, reason };
    }
  }

  /** In the table's lane. */
  private async reconcile(
    ctx: BotContext,
    tableId: string,
    gameGone: boolean
  ): Promise<TableSettlementResult> {
    const record = this.records.get(tableId);
    if (!record) return { status: "settled", tableId };
    if (record.seats.length === 0) {
      if (gameGone) await this.forget(ctx, tableId);
      return { status: "nothing-locked", tableId };
    }
    const calls = ctx.contractCalls;
    if (!calls) return { status: "not-settleable", tableId, reason: "no contract calls" };
    const contract = calls.htlcContract();
    const locks = await Promise.all(record.seats.map(s => readHtlcLock(ctx.provider, contract, s.lockId)));
    if (locks.every(l => l?.state === "withdrawn")) {
      await this.forget(ctx, tableId);
      return { status: "settled", tableId };
    }
    // Every lock is refunded or withdrawn: nothing is left to settle, and nothing to keep.
    if (locks.every(l => l?.state === "withdrawn" || l?.state === "refunded")) {
      await this.forget(ctx, tableId);
      return { status: "not-settleable", tableId, reason: "the buy-in locks were refunded" };
    }
    if (!locks.every(l => l?.state === "open"))
      return {
        status: "not-settleable",
        tableId,
        reason: "a buy-in lock is no longer open: the remaining players refund their own",
      };
    if (nowSeconds() >= record.expiresAt)
      return {
        status: "not-settleable",
        tableId,
        reason: "the buy-in locks are past their deadline: each player refunds its own",
      };
    const settlement = record.settlement;
    if (settlement?.operationId && settlement.txHash) {
      const receipt = await ctx.provider.getTransactionReceipt(settlement.txHash);
      // Not in a block yet: the same signed bytes are handed out again.
      if (!receipt) {
        await calls.resume(settlement.operationId);
        return { status: "resumed", tableId, txHash: settlement.txHash };
      }
      // In a block with the locks still open, it can only have reverted: the same payouts, sent
      // again. A successful call that left them open is not GenericHTLC v2; nothing is sent.
      if (receipt.status !== 0) {
        // The locks were read before the receipt: the settlement may have landed in between.
        const again = await Promise.all(
          record.seats.map(s => readHtlcLock(ctx.provider, contract, s.lockId))
        );
        if (again.every(l => l?.state === "withdrawn")) {
          await this.forget(ctx, tableId);
          return { status: "settled", tableId };
        }
        // Still open after a successful settlement: looked at again later (a node behind the
        // receipt), never cleared and never sent twice.
        throw new Error("the settlement landed and the buy-in locks still read open");
      }
    }
    if (settlement) return this.sendSettlement(ctx, tableId, gameGone);
    // Nothing was written down: the game is gone, so each player gets its buy-in back.
    if (gameGone) return this.settleNow(ctx, tableId, returnBuyIns);
    return { status: "not-settleable", tableId, reason: "the table has no settlement" };
  }
}
