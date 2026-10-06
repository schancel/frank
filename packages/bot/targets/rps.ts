import { join } from "path";
import { FrankBotHost } from "@frank/bot-framework";
import { RpsBot } from "../src/bots/rps-bot";

async function main() {
  const stateDir =
    process.env.RPS_BOT_STATE_DIR ??
    process.env.BOT_STATE_DIR ??
    join(process.env.HOME ?? "/tmp", ".frank-bots");

  const host = new FrankBotHost({
    stateDir,
    relayBaseUrl: process.env.E2E_DEMO_RELAY_URL,
    rpcUrl: process.env.MONAD_TESTNET_HTTP_RPC_URL ?? process.env.MONAD_RPC_URL,
  });

  await host.register(new RpsBot());
  await host.start();
  console.log(
    "[rps-target] RPS Arena Bot running with Canonical Directory publication"
  );

  const shutdown = async () => {
    console.log("[rps-target] Shutting down gracefully...");
    await host.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[rps-target] Fatal error:", err);
  process.exit(1);
});
