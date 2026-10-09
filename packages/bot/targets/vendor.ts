import { join } from "path";
import { FrankBotHost } from "@frank/bot-framework";
import { VendorBot } from "../src/bots/vendor-bot";

async function main() {
  const stateDir =
    process.env.VENDOR_BOT_STATE_DIR ??
    process.env.BOT_STATE_DIR ??
    join(process.env.HOME ?? "/tmp", ".frank-bots");

  const host = new FrankBotHost({
    stateDir,
    relayBaseUrl: process.env.E2E_DEMO_RELAY_URL,
    rpcUrl: process.env.MONAD_TESTNET_HTTP_RPC_URL ?? process.env.MONAD_RPC_URL,
  });

  const catalogDir = process.env.VENDOR_BOT_CATALOG_DIR;

  await host.register(new VendorBot({ catalogDir }));
  await host.start();
  console.log(
    "[vendor-target] Vendor Bot running with Canonical Directory publication"
  );

  const shutdown = async () => {
    console.log("[vendor-target] Shutting down gracefully...");
    await host.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[vendor-target] Fatal error:", err);
    process.exit(1);
  });
}
