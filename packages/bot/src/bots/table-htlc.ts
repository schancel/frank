/**
 * A game table's GenericHTLC v2 escrow, as the parked poker and liars-dice bots hold it: one
 * 32-byte preimage per table, its sha256 hash lock, and the id of each player's buy-in lock.
 * Every value here is what GenericHTLC v2 computes (`htlcHashLock`, `htlcLockId` from
 * `@frank/wallet/swap-escrow`); nothing is re-derived here.
 *
 * The table model the contract fixes: each player locks the buy-in with the table's hash lock
 * and the arbiter (the bot) as recipient, because only the recipient of every lock in a batch may
 * call `batchDistribute`, which splits the pot with the preimage.
 *
 * Not decided yet, and not wired: the bots never call `lock` or `batchDistribute`, and settling
 * a table returns `TABLE_SETTLEMENT_UNSUPPORTED`. Open:
 * - where the preimage comes from. The bots draw it at random per table and hold it in memory;
 *   AGENTS.md §5 would have the arbiter derive it from its account material and the table facts,
 *   which needs a custody derivation and a bot-context capability that do not exist;
 * - the buy-in lock terms (paying account, refund address, deadline, amount) and how the bot
 *   learns each player's lock: a game item carrying the terms, or the chain's `Locked` event.
 *   A lock id needs the paying account, which is not the player's identity address.
 */
import {
  htlcHashLock,
  htlcLockId,
  type EvmHtlcTerms,
} from "@frank/wallet/swap-escrow";

export interface TableHtlcEscrow {
  /** 32 bytes, 0x-prefixed hex. Released only in the settling `batchDistribute`. */
  preimage: string;
  /** `sha256(preimage)`: the hash lock of every buy-in lock at the table. */
  hashLock: string;
}

/** What settling a table gives until its escrow is wired to GenericHTLC (the open decisions
 * above): an explicit unsupported result. No transaction is sent and no value moves. */
export interface TableSettlementUnsupported {
  readonly status: "unsupported";
  readonly reason: string;
}

export const TABLE_SETTLEMENT_UNSUPPORTED: TableSettlementUnsupported = Object.freeze({
  status: "unsupported",
  reason:
    "table escrow is not supported yet. No buy-in was locked, so no pot moves and nothing is paid out.",
});

export function tableHtlcEscrow(preimage: Uint8Array): TableHtlcEscrow {
  const hashLock = htlcHashLock(preimage);
  return { preimage: "0x" + Buffer.from(preimage).toString("hex"), hashLock };
}

/** The terms of a player's buy-in lock that the table does not fix. */
export type TableBuyInTerms = Omit<EvmHtlcTerms, "recipient" | "hashLock">;

/**
 * The GenericHTLC id of the buy-in lock `lockSender` (the account that sends `lock`) opens at
 * this table with `terms`: recipient the arbiter, hash lock the table's.
 */
export function tableBuyInLockId(
  escrow: Pick<TableHtlcEscrow, "hashLock">,
  arbiter: string,
  lockSender: string,
  terms: TableBuyInTerms
): string {
  return htlcLockId(lockSender, {
    ...terms,
    recipient: arbiter,
    hashLock: escrow.hashLock,
  });
}
