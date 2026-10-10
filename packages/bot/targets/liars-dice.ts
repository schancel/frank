import { join } from "path";
import { FrankBotHost } from "@frank/bot-framework";
import { LiarsDiceBot } from "../src/bots/liars-dice-bot";

async function main() {
  const stateDir =
    process.env.LIARS_DICE_BOT_STATE_DIR ??
    process.env.BOT_STATE_DIR ??
    join(process.env.HOME ?? "/tmp", ".frank-bots");

  const host = new FrankBotHost({
    stateDir,
    relayBaseUrl: process.env.E2E_DEMO_RELAY_URL,
    rpcUrl: process.env.MONAD_TESTNET_HTTP_RPC_URL ?? process.env.MONAD_RPC_URL,
  });

  await host.register(new LiarsDiceBot());
  await host.start();
  console.log(
    "[liars-dice-target] Liar's Dice (Perudo) Bot running with Canonical Directory publication"
  );

  const shutdown = async () => {
    console.log("[liars-dice-target] Shutting down gracefully...");
    await host.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[liars-dice-target] Fatal error:", err);
    process.exit(1);
  });
}
