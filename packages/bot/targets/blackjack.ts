import { join } from "path";
import { FrankBotHost } from "@frank/bot-framework";
import { BlackjackDealerBot } from "../src/bots/blackjack-bot";

async function main() {
  const stateDir =
    process.env.BLACKJACK_BOT_STATE_DIR ??
    process.env.BOT_STATE_DIR ??
    join(process.env.HOME ?? "/tmp", ".frank-bots");

  const host = new FrankBotHost({
    stateDir,
    relayBaseUrl: process.env.E2E_DEMO_RELAY_URL,
    rpcUrl: process.env.MONAD_RPC_URL,
  });

  await host.register(new BlackjackDealerBot());
  await host.start();
  console.log(
    "[blackjack-target] Blackjack Dealer Bot running with Canonical Directory publication"
  );

  const shutdown = async () => {
    console.log("[blackjack-target] Shutting down gracefully...");
    await host.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[blackjack-target] Fatal error:", err);
  process.exit(1);
});
