import type { ReceivedPayment } from "@frank/wallet/chain";
import type { BotContext, BotStateStore } from "./types";

/** Claims are made one at a time in this process, whoever makes them (the host for the stamp a
 * reply may carry, a bot for a stake or a price), so two messages naming one transfer can never
 * both be credited with it. */
let turn: Promise<unknown> = Promise.resolve();

/**
 * Credits the confirmed transfer `txHash` to the message `digest` in a bot's state, unless
 * another message already has it. One transfer counts for one message, ever: the record
 * (`received:<tx hash>`) is never removed. Returns whether `digest` holds the transfer.
 */
export function claimTransfer(
  state: BotStateStore,
  txHash: string,
  digest: string
): Promise<boolean> {
  const run = async () => {
    const key = `received:${txHash.toLowerCase()}`;
    const creditedTo = await state.get(key);
    if (creditedTo === undefined) await state.put(key, digest);
    return creditedTo === undefined || creditedTo === digest;
  };
  const next = turn.then(run, run);
  turn = next.catch(() => undefined);
  return next;
}

/** Read the wallet's evidence, excluding stealth funds and records for another message.
 * This does not infer receipt from a peer claim, a transaction hash or current spendability. */
export async function checkStampPayments(
  ctx: Pick<BotContext, "checkMessagePayment">,
  digest: string
): Promise<readonly ReceivedPayment[]> {
  const evidence = await ctx.checkMessagePayment(digest);
  const owner = digest.replace(/^0x/, "").toLowerCase();
  return evidence.payments.filter(
    (payment) =>
      payment.origin === "stamp" &&
      payment.payloadDigest !== undefined &&
      payment.payloadDigest.replace(/^0x/, "").toLowerCase() === owner
  );
}
