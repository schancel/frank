import { join } from "path";
import { FrankBotHost } from "@frank/bot-framework";
import { BlackjackDealerBot } from "../src/bots/blackjack-bot";

async function main() {
  const stateDir =
    process.env.BOT_STATE_DIR ??
    join(process.env.HOME ?? "/tmp", ".frank-bots");

  const host = new FrankBotHost({
    stateDir,
    relayBaseUrl: process.env.E2E_DEMO_RELAY_URL,
    rpcUrl: process.env.MONAD_RPC_URL,
  });

  // Register bots with the host
  await host.register(new BlackjackDealerBot());
  // Additional bot definitions can be registered here

  await host.start();
  console.log(
    "[all-bots-target] FrankBotHost running all bots with shared EVMNonceSequencer and canonical directories"
  );

  const shutdown = async () => {
    console.log("[all-bots-target] Shutting down gracefully...");
    await host.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[all-bots-target] Fatal error:", err);
  process.exit(1);
});
