/**
 * A table escrow book for the game bots' unit tests of game play: it seats every join, lock or
 * not, and records each settlement instead of sending it. A narrow seam for game rules only;
 * nothing here is evidence about the escrow. The real book (`TableEscrows`), its lock checks and
 * its `batchDistribute` are exercised on a real EVM node in `table-htlc.anvil.jest.test.ts`.
 */
import { createHash } from "crypto";
import type { BotContext } from "@frank/bot-framework";
import type { TableBuyInLockItem } from "@frank/cashweb/types/messages";
import type {
  TableEscrowBook,
  TableEscrowRecord,
  TableGame,
  TableSeatResult,
  TableSettlementResult,
} from "./table-htlc";
export function seatingEscrowBook(game: TableGame) {
  const records = new Map<string, TableEscrowRecord>();
  const settlements: Array<{ tableId: string; shares: Array<{ player: string; amountWei: bigint }> }> = [];
  let count = 0;
  const hex = (text: string) => createHash("sha256").update(text).digest("hex");
  const book: TableEscrowBook = {
    async open(_ctx: BotContext, buyInWei: bigint) {
      const tableId = hex(`table-${++count}`).slice(0, 32);
      const record: TableEscrowRecord = {
        version: 1,
        game,
        tableId,
        arbiter: "0x" + "b0".repeat(20),
        hashLock: "0x" + hex(`lock-${tableId}`),
        buyInWei: buyInWei.toString(),
        expiresAt: Math.floor(Date.now() / 1000) + 86_400,
        seats: [],
      };
      records.set(tableId, record);
      return record;
    },
    get: tableId => records.get(tableId),
    async seat(_ctx, tableId, player, lock?: TableBuyInLockItem): Promise<TableSeatResult> {
      const record = records.get(tableId);
      if (!record) return { seated: false, reason: "no-table" };
      record.seats.push({
        player,
        lockId: lock?.lockId ?? "0x" + hex(`seat-${tableId}-${player}`),
        account: lock?.account ?? player,
      });
      return { seated: true };
    },
    async settle(_ctx, tableId, shares): Promise<TableSettlementResult> {
      const record = records.get(tableId)!;
      const pool = BigInt(record.buyInWei) * BigInt(record.seats.length);
      const total = shares.reduce((sum, s) => sum + s.amountWei, 0n);
      if (total !== pool) return { status: "not-settleable", tableId, reason: "not the pot" };
      settlements.push({ tableId, shares });
      record.settlement = {
        payouts: shares.map(s => ({ recipient: s.player, amountWei: s.amountWei.toString() })),
      };
      return { status: "sent", tableId, txHash: "0x" + hex(`settle-${tableId}`), payouts: record.settlement.payouts };
    },
    async recover() {
      return [];
    },
  };
  return { book, settlements };
}
