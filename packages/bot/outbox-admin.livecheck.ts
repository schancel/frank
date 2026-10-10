/**
 * Operator tool for what a game or shop bot still owes (`src/bots/money.ts`).
 * STOP THE BOT FIRST: its state database is single-process.
 *
 *   yarn tsx outbox-admin.livecheck.ts <bot state dir> <bot id> list
 *       Every message the bot has not finished with:
 *         owed     written down, not delivered yet (the bot keeps sending it)
 *         pending  received with money and not settled (the bot refunds it at its next start)
 *         failed   the relay ended its delivery: NOT delivered, not counted as sent, and a round
 *                  or hand that waits for it is waiting for you
 *   yarn tsx outbox-admin.livecheck.ts <bot state dir> <bot id> retry <id> --i-checked-the-chain
 *       Sends a FAILED message again, as a new message, when the bot next starts. The wallet says
 *       only that the relay ended the first attempt, not that its signed transfers can never
 *       land: look the recipient up on an explorer first. If they did land, a retry pays twice.
 *
 * `<bot state dir>` is the directory the bot's host was given (the launcher's
 * `<state dir>/bots/<bot>/state`); `<bot id>` is `dice`, `rps`, `raffle`, `vendor` or `blackjack`.
 * A refund needs no action: a message left pending is refunded by the bot itself.
 */
import { existsSync } from "fs";
import { join } from "path";
import { LevelBotStateStore } from "@frank/bot-framework";
import type { BotContext } from "@frank/bot-framework";
import { Outbox } from "./src/bots/money";

async function main() {
  const [dir, botId, verb, id, flag] = process.argv.slice(2);
  if (!dir || !botId || (verb !== "list" && verb !== "retry"))
    throw new Error(
      "usage: outbox-admin.livecheck.ts <bot state dir> <bot id> list | retry <id> --i-checked-the-chain"
    );
  const location = [join(dir, botId, "state"), join(dir, botId), dir].find(
    (candidate) => existsSync(join(candidate, "CURRENT"))
  );
  if (!location) throw new Error(`No bot state database under ${dir}`);
  const state = await LevelBotStateStore.open(location);
  const ctx = { state } as unknown as BotContext;
  const outbox = new Outbox(botId);
  try {
    if (verb === "retry") {
      if (!id || flag !== "--i-checked-the-chain")
        throw new Error("retry needs <id> and --i-checked-the-chain");
      if (!(await outbox.retry(ctx, id)))
        throw new Error(`No failed message "${id}"`);
      console.log(`${id}: owed again; it is sent when the bot next starts`);
      return;
    }
    const { owed, pending, failed } = await outbox.list(ctx);
    for (const entry of failed)
      console.log(
        `failed   ${entry.id}  to ${entry.to}  ${entry.valueWei} wei  attempt ${entry.attempt}`
      );
    for (const entry of owed)
      console.log(
        `owed     ${entry.id}  to ${entry.to}  ${entry.valueWei} wei${
          entry.attempt ? `  attempt ${entry.attempt} (with the wallet)` : ""
        }${entry.awaits?.length ? `  waiting for ${entry.awaits.length} transfer(s)` : ""}`
      );
    for (const entry of pending)
      console.log(
        `pending  ${entry.digest}  from ${entry.peer}  ${entry.payments
          .reduce((sum, payment) => sum + BigInt(payment.valueWei), 0n)
          .toString()} wei stated`
      );
    if (!owed.length && !pending.length && !failed.length)
      console.log("nothing owed, pending or failed");
  } finally {
    await state.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
