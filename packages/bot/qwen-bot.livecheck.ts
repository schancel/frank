import { join } from "path";
import { FrankBotHost } from "@frank/bot-framework";
import { QwenBot } from "./src/bots/qwen-bot";

async function main() {
  const stateDir =
    process.env.QWEN_BOT_STATE_DIR ??
    process.env.BOT_STATE_DIR ??
    join(process.env.HOME ?? "/tmp", ".frank-bots", "qwen");

  const host = new FrankBotHost({
    stateDir,
    relayBaseUrl: process.env.E2E_DEMO_RELAY_URL,
    rpcUrl:
      process.env.MONAD_TESTNET_HTTP_RPC_URL ?? process.env.MONAD_RPC_URL,
  });

  await host.register(new QwenBot());
  await host.start();
  console.log(
    "[qwen] Qwen Bot running with FrankBotHost and Canonical Directory"
  );
  await host.waitUntilStopped();
}

main().catch((err) => {
  console.error("Qwen bot failed:", err);
  process.exit(1);
});
