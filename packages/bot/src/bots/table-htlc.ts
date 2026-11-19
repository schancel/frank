/**
 * A game table's GenericHTLC v2 buy-in escrow, as the poker and liars-dice bots (the arbiter)
 * hold it (`@frank/wallet/table-escrow` has the terms and calls both sides use).
 *
 * - Opening a table: the bot draws a 16-byte table id and derives the table's preimage from its
 *   own account (`ctx.tableSecrets`, `frank/table-htlc-preimage/v1`); the hash lock is its
 *   sha256. The arbiter is the bot wallet's main account (`ctx.contractCalls.account()`), the
 *   deadline the table's start plus a day. The terms go out in the table items (`escrow`).
 * - Seating: a player's structured join names its lock (`buyInLock`); the bot recomputes the id
 *   from the table's terms and the player's account and seats the player only for an open lock
 *   with exactly those terms on chain. Nothing else seats a player.
 * - Settling: the bot writes the payouts down, then sends `batchDistribute` with the preimage
 *   through the wallet's contract-call path (`ctx.contractCalls`, a `table-htlc` record). Each
 *   payout goes to the account the player locked from.
 * - After a restart (`recover`), a table whose game is gone is settled the way it was written
 *   down (a recorded settlement is re-sent as it was, never recomputed), or, with nothing written,
 *   by returning each buy-in. The preimage is derived again; it is never stored.
 * - If the bot never settles, each player refunds its own lock from the deadline on.
 *
 * What is kept (in the bot's state store, `table-escrow:<tableId>` and an index): the table's
 * terms, its seats and its settlement. The chain is the authority on each lock's state.
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
  /** Written before the distribute is sent; then its call. */
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

export type TableSeatResult =
  | { seated: true }
  | { seated: false; reason: TableBuyInRefusal | "no-table" | "no-buy-in-lock" | "lock-already-seated" | "table-settled" | "unreadable" };

export type TableSettlementResult =
  | { status: "sent"; tableId: string; txHash: string; payouts: TableEscrowPayout[] }
  | { status: "resumed"; tableId: string; txHash: string }
  | { status: "settled"; tableId: string }
  | { status: "nothing-locked"; tableId: string }
  | { status: "not-settleable"; tableId: string; reason: string };

/** What a bot asks of its table escrow; `TableEscrows` is the one that uses the chain. */
export interface TableEscrowBook {
  open(ctx: BotContext, buyInWei: bigint): Promise<TableEscrowRecord | TableEscrowUnavailable>;
  get(tableId: string): Readonly<TableEscrowRecord> | undefined;
  /** Seats `player` for its lock. `lock` absent (a text join): refused, `no-buy-in-lock`. */
  seat(ctx: BotContext, tableId: string, player: string, lock?: TableBuyInLockItem): Promise<TableSeatResult>;
  /** Pays the table out: `shares` by seated player, summing to the locked total. */
  settle(ctx: BotContext, tableId: string, shares: Array<{ player: string; amountWei: bigint }>): Promise<TableSettlementResult>;
  /** After a restart: settles every kept table that `live` does not know. */
  recover(ctx: BotContext, live: (tableId: string) => boolean): Promise<TableSettlementResult[]>;
}

export function tableEscrowItemTerms(record: Readonly<TableEscrowRecord>): TableEscrowItemTerms {
  return { arbiter: record.arbiter, hashLock: record.hashLock, expiresAt: record.expiresAt };
}

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
    case "not-settleable":
      return `Not paid out: ${result.reason}`;
  }
}

const INDEX_KEY = "table-escrow:index";
const recordKey = (tableId: string) => `table-escrow:${tableId}`;
const nowSeconds = () => Math.floor(Date.now() / 1000);

export class TableEscrows implements TableEscrowBook {
  private readonly records = new Map<string, TableEscrowRecord>();

  constructor(readonly game: TableGame) {}

  get(tableId: string): Readonly<TableEscrowRecord> | undefined {
    return this.records.get(tableId);
  }

  private async persist(ctx: BotContext, record: TableEscrowRecord): Promise<void> {
    const index = await this.index(ctx);
    if (!index.includes(record.tableId)) index.push(record.tableId);
    await ctx.state.batch([
      { type: "put", key: recordKey(record.tableId), value: JSON.stringify(record) },
      { type: "put", key: INDEX_KEY, value: JSON.stringify(index) },
    ]);
    this.records.set(record.tableId, record);
  }

  private async forget(ctx: BotContext, tableId: string): Promise<void> {
    const index = (await this.index(ctx)).filter(id => id !== tableId);
    await ctx.state.batch([
      { type: "del", key: recordKey(tableId) },
      { type: "put", key: INDEX_KEY, value: JSON.stringify(index) },
    ]);
    this.records.delete(tableId);
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

  async seat(
    ctx: BotContext,
    tableId: string,
    player: string,
    lock?: TableBuyInLockItem
  ): Promise<TableSeatResult> {
    const record = this.records.get(tableId);
    if (!record || !ctx.contractCalls) return { seated: false, reason: "no-table" };
    if (record.settlement) return { seated: false, reason: "table-settled" };
    if (!lock) return { seated: false, reason: "no-buy-in-lock" };
    const lockId = lock.lockId.toLowerCase();
    const mine = record.seats.find(s => s.player.toLowerCase() === player.toLowerCase());
    if (mine) return mine.lockId === lockId ? { seated: true } : { seated: false, reason: "lock-already-seated" };
    if (record.seats.some(s => s.lockId === lockId)) return { seated: false, reason: "lock-already-seated" };
    let check;
    try {
      check = await checkTableBuyIn({
        reader: ctx.provider,
        contract: ctx.contractCalls.htlcContract(),
        table: termsOf(record),
        lockId,
        account: lock.account,
        nowSeconds: nowSeconds(),
        minRemainingSeconds: TABLE_SEATING_MARGIN_SECONDS,
      });
    } catch {
      return { seated: false, reason: "unreadable" };
    }
    if (!check.seated) return check;
    await this.persist(ctx, {
      ...record,
      seats: [...record.seats, { player, lockId, account: check.lock.sender.toLowerCase() }],
    });
    return { seated: true };
  }

  async settle(
    ctx: BotContext,
    tableId: string,
    shares: Array<{ player: string; amountWei: bigint }>
  ): Promise<TableSettlementResult> {
    const record = this.records.get(tableId);
    if (!record) return { status: "not-settleable", tableId, reason: "no such table" };
    if (record.settlement)
      return { status: "not-settleable", tableId, reason: "the table is already being settled" };
    if (record.seats.length === 0) return { status: "nothing-locked", tableId };
    const pool = BigInt(record.buyInWei) * BigInt(record.seats.length);
    const accountOf = new Map(record.seats.map(s => [s.player.toLowerCase(), s.account]));
    const merged = new Map<string, bigint>();
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
    // Written down before anything is signed: a restart re-sends exactly this.
    const written: TableEscrowRecord = { ...record, settlement: { payouts } };
    await this.persist(ctx, written);
    return this.sendSettlement(ctx, written);
  }

  private async sendSettlement(ctx: BotContext, record: TableEscrowRecord): Promise<TableSettlementResult> {
    const calls = ctx.contractCalls;
    if (!calls || !ctx.tableSecrets)
      return { status: "not-settleable", tableId: record.tableId, reason: "no contract calls" };
    if (nowSeconds() >= record.expiresAt)
      return {
        status: "not-settleable",
        tableId: record.tableId,
        reason: "the buy-in locks are past their deadline: each player refunds its own",
      };
    const payouts = record.settlement!.payouts;
    const preimage = ctx.tableSecrets.tablePreimage({
      game: record.game,
      tableId: Buffer.from(record.tableId, "hex"),
    });
    let call;
    try {
      if (htlcHashLock(preimage) !== record.hashLock)
        throw new Error("the derived preimage does not open this table's hash lock");
      call = tableDistributeCall({
        contract: calls.htlcContract(),
        game: record.game,
        tableId: record.tableId,
        lockIds: record.seats.map(s => s.lockId),
        payouts: payouts.map(p => ({ recipient: p.recipient, amount: BigInt(p.amountWei) })),
        preimage,
      });
    } finally {
      preimage.fill(0);
    }
    const sent = await calls.send(call);
    await this.persist(ctx, {
      ...record,
      settlement: { payouts, operationId: sent.operationId, txHash: sent.txHash },
    });
    return { status: "sent", tableId: record.tableId, txHash: sent.txHash, payouts };
  }

  async recover(ctx: BotContext, live: (tableId: string) => boolean): Promise<TableSettlementResult[]> {
    const results: TableSettlementResult[] = [];
    for (const tableId of await this.index(ctx)) {
      if (!TABLE_ID_PATTERN.test(tableId)) continue;
      const raw = await ctx.state.get(recordKey(tableId));
      if (!raw) continue;
      const record = JSON.parse(raw) as TableEscrowRecord;
      if (record.version !== 1 || record.game !== this.game) continue;
      this.records.set(tableId, record);
      if (live(tableId)) continue;
      results.push(await this.recoverOne(ctx, record));
    }
    return results;
  }

  private async recoverOne(ctx: BotContext, record: TableEscrowRecord): Promise<TableSettlementResult> {
    const { tableId } = record;
    if (record.seats.length === 0) {
      await this.forget(ctx, tableId);
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
    if (!locks.every(l => l?.state === "open"))
      return {
        status: "not-settleable",
        tableId,
        reason: "a buy-in lock is no longer open: the remaining players refund their own",
      };
    const settlement = record.settlement;
    if (settlement?.operationId && settlement.txHash) {
      const receipt = await ctx.provider.getTransactionReceipt(settlement.txHash);
      // Not in a block yet: the same signed bytes are handed out again.
      if (!receipt) {
        await calls.resume(settlement.operationId);
        return { status: "resumed", tableId, txHash: settlement.txHash };
      }
      // In a block and the locks are still open: it reverted. The same payouts, sent again.
    }
    if (settlement) return this.sendSettlement(ctx, record);
    // Nothing was written down: the game is gone, so each player gets its buy-in back.
    return this.settle(
      ctx,
      tableId,
      record.seats.map(s => ({ player: s.player, amountWei: BigInt(record.buyInWei) }))
    );
  }
}
