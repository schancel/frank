import { join } from "path";
import { FrankBotHost } from "@frank/bot-framework";
import { RaffleBot } from "../src/bots/raffle-bot";

async function main() {
  const stateDir =
    process.env.RAFFLE_BOT_STATE_DIR ??
    process.env.BOT_STATE_DIR ??
    join(process.env.HOME ?? "/tmp", ".frank-bots");

  const host = new FrankBotHost({
    stateDir,
    relayBaseUrl: process.env.E2E_DEMO_RELAY_URL,
    rpcUrl: process.env.MONAD_TESTNET_HTTP_RPC_URL ?? process.env.MONAD_RPC_URL,
  });

  const maxEntries = process.env.RAFFLE_BOT_MAX_ENTRIES
    ? parseInt(process.env.RAFFLE_BOT_MAX_ENTRIES, 10)
    : undefined;
  const entryPriceWei = process.env.RAFFLE_BOT_ENTRY_PRICE_WEI
    ? BigInt(process.env.RAFFLE_BOT_ENTRY_PRICE_WEI)
    : undefined;

  await host.register(new RaffleBot({ maxEntries, entryPriceWei }));
  await host.start();
  console.log(
    "[raffle-target] Raffle Bot running with Canonical Directory publication"
  );

  const shutdown = async () => {
    console.log("[raffle-target] Shutting down gracefully...");
    await host.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[raffle-target] Fatal error:", err);
  process.exit(1);
});
