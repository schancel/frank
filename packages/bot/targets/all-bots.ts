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
  LiarsDiceBot,
  PokerBot,
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

  // Register all Frank bots with the unified host
  await host.register(new BlackjackDealerBot());
  await host.register(new RaffleBot());
  await host.register(new VendorBot());
  await host.register(new QwenBot());
  await host.register(new FaucetBot());
  await host.register(new ChatRoomBot());
  await host.register(new RpsBot());
  await host.register(new SatoshiDiceBot());
  await host.register(new LiarsDiceBot());
  await host.register(new PokerBot());

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

main().catch((err) => {
  console.error("[all-bots-target] Fatal error:", err);
  process.exit(1);
});
