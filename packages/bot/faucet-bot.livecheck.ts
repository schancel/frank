import { join } from "path";
import { FrankBotHost } from "@frank/bot-framework";
import { FaucetBot } from "./src/bots/faucet-bot";

async function main() {
  const stateDir =
    process.env.FAUCET_STATE_DIR ??
    process.env.BOT_STATE_DIR ??
    join(process.env.HOME ?? "/tmp", ".frank-bots", "faucet");

  const host = new FrankBotHost({
    stateDir,
    relayBaseUrl: process.env.E2E_DEMO_RELAY_URL,
    rpcUrl:
      process.env.MONAD_TESTNET_HTTP_RPC_URL ?? process.env.MONAD_RPC_URL,
  });

  await host.register(new FaucetBot());
  await host.start();
  console.log(
    `Faucet wallet: ${host.fundingWalletAddress ?? "ready"}`
  );
  console.log(
    "[faucet] Faucet Bot running with FrankBotHost and Canonical Directory"
  );
  await host.waitUntilStopped();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Faucet bot failed:", err);
    process.exit(1);
  });
}
