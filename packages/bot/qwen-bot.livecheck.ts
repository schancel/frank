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

if (require.main === module) {
  main().catch((err) => {
    // The message, not a stack: a missing model variable is named in one line.
    console.error(
      "QWEN BOT FAILED: " + (err instanceof Error ? err.message : String(err))
    );
    process.exit(1);
  });
}
