import { join } from "path";
import { FrankBotHost } from "@frank/bot-framework";
import { BlackjackDealerBot } from "./src/bots/blackjack-bot";

async function main() {
  const stateDir =
    process.env.BLACKJACK_BOT_STATE_DIR ??
    process.env.BOT_STATE_DIR ??
    join(process.env.HOME ?? "/tmp", ".frank-bots", "blackjack");

  const minWagerWei = process.env.BLACKJACK_BOT_MIN_WAGER_WEI
    ? BigInt(process.env.BLACKJACK_BOT_MIN_WAGER_WEI)
    : undefined;
  const maxWagerWei = process.env.BLACKJACK_BOT_MAX_WAGER_WEI
    ? BigInt(process.env.BLACKJACK_BOT_MAX_WAGER_WEI)
    : undefined;

  const host = new FrankBotHost({
    stateDir,
    relayBaseUrl: process.env.E2E_DEMO_RELAY_URL,
    rpcUrl:
      process.env.MONAD_TESTNET_HTTP_RPC_URL ?? process.env.MONAD_RPC_URL,
  });

  await host.register(new BlackjackDealerBot({ minWagerWei, maxWagerWei }));
  await host.start();
  console.log(
    "[blackjack] Blackjack Dealer Bot running with FrankBotHost and Canonical Directory"
  );
  await host.waitUntilStopped();
}

main().catch((err) => {
  console.error("Blackjack bot failed:", err);
  process.exit(1);
});
