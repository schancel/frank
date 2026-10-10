import { join } from "path";
import { FrankBotHost } from "@frank/bot-framework";
import {
  BlackjackDealerBot,
  RaffleBot,
  VendorBot,
  QwenBot,
  FaucetBot,
  ChatRoomBot,
  RpsBot,
  SatoshiDiceBot,
} from "../src/bots";

async function main() {
  const stateDir =
    process.env.BOT_STATE_DIR ??
    process.env.FRANK_DEMO_STATE_DIR ??
    join(process.env.HOME ?? "/tmp", ".frank-bots");

  const host = new FrankBotHost({
    stateDir,
    relayBaseUrl: process.env.E2E_DEMO_RELAY_URL,
    rpcUrl: process.env.MONAD_TESTNET_HTTP_RPC_URL ?? process.env.MONAD_RPC_URL,
  });

  // Every Frank bot on the one host, sharing its funding wallet and nonce sequence. A bot that
  // cannot be built or registered (the Qwen bot without its model variables, say) is reported
  // by name and left out; the others run.
  const failed = await host.registerAll([
    () => new BlackjackDealerBot(),
    () => new RaffleBot(),
    () => new VendorBot(),
    () => new QwenBot(),
    () => new FaucetBot(),
    () => new ChatRoomBot(),
    () => new RpsBot(),
    () => new SatoshiDiceBot(),
  ]);
  if (failed.length)
    console.error(
      `[all-bots-target] NOT RUNNING: ${failed.join(", ")}. See the errors above.`
    );

  await host.start();
  console.log(
    "[all-bots-target] FrankBotHost running all bots (blackjack, raffle, vendor, qwen, faucet, lobby, rps, dice) with shared EVMNonceSequencer and canonical directories"
  );

  const shutdown = async () => {
    console.log("[all-bots-target] Shutting down gracefully...");
    await host.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[all-bots-target] Fatal error:", err);
    process.exit(1);
  });
}
