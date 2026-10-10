/**
 * Every Frank bot in ONE process, on one `FrankBotHost`: one funding wallet and so one source of
 * nonces for it. This is what `yarn demo` runs. Each bot keeps its own identity and state under
 * `<BOT_STATE_DIR>/bots/<id>/`.
 *
 *   FRANK_BOTS   comma-separated bot ids to run (default: all of them)
 *
 * One bot failing to start is reported by name and does not stop the others. Lines the launcher
 * reads: `[all-bots] <id> registered`, `[all-bots] <id> FAILED to start: ...`, the host's own
 * `Bot "<id>" could not be started and is left out ...: <reason>` and `[all-bots] running: <ids>`.
 */
import { AsyncLocalStorage } from "async_hooks";
import { join } from "path";
import { FrankBotHost, type FrankBotDefinition } from "@frank/bot-framework";
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

const optionalWei = (name: string): bigint | undefined =>
  process.env[name] ? BigInt(process.env[name] as string) : undefined;

/** Every bot, by id, in start order. Options come from the same variables the single-bot
 * entry points read. */
export const BOT_FACTORIES: Record<string, () => FrankBotDefinition> = {
  blackjack: () =>
    new BlackjackDealerBot({
      minWagerWei: optionalWei("BLACKJACK_BOT_MIN_WAGER_WEI"),
      maxWagerWei: optionalWei("BLACKJACK_BOT_MAX_WAGER_WEI"),
    }),
  raffle: () =>
    new RaffleBot({
      maxEntries: process.env.RAFFLE_BOT_MAX_ENTRIES
        ? parseInt(process.env.RAFFLE_BOT_MAX_ENTRIES, 10)
        : undefined,
      entryPriceWei: optionalWei("RAFFLE_BOT_ENTRY_PRICE_WEI"),
    }),
  vendor: () =>
    new VendorBot({ catalogDir: process.env.VENDOR_BOT_CATALOG_DIR }),
  qwen: () => new QwenBot(),
  faucet: () => new FaucetBot(),
  lobby: () => new ChatRoomBot(),
  rps: () => new RpsBot(),
  dice: () => new SatoshiDiceBot(),
  "liars-dice": () => new LiarsDiceBot(),
  poker: () => new PokerBot(),
};

/** The bot ids to run: `FRANK_BOTS` if set (unknown ids are an error), otherwise all. */
export function selectedBotIds(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return Object.keys(BOT_FACTORIES);
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = ids.filter((id) => !(id in BOT_FACTORIES));
  if (unknown.length > 0)
    throw new Error(
      `FRANK_BOTS names unknown bot(s): ${unknown.join(", ")} (known: ${Object.keys(
        BOT_FACTORIES
      ).join(", ")})`
    );
  return ids;
}

// All bots write to one stdout, so every line written while a bot's code is running (its
// registration, its handlers, its timers) is prefixed with the bot's id unless it already is.
const currentBot = new AsyncLocalStorage<string>();

export function prefixLine(bot: string | undefined, first: unknown): unknown {
  if (!bot || typeof first !== "string") return first;
  return first.startsWith(`[${bot}]`) ? first : `[${bot}] ${first}`;
}

function installLogPrefix(): void {
  for (const level of ["log", "info", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (first?: unknown, ...rest: unknown[]) => {
      const bot = currentBot.getStore();
      if (bot && typeof first !== "string") original(`[${bot}]`, first, ...rest);
      else original(prefixLine(bot, first), ...rest);
    };
  }
}

/** The same bot, with each of its entry points run under its id for the log prefix. */
function named(bot: FrankBotDefinition): FrankBotDefinition {
  return new Proxy(bot, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) =>
        currentBot.run(target.id, () => value.apply(target, args));
    },
  });
}

async function main() {
  const stateDir =
    process.env.BOT_STATE_DIR ??
    process.env.FRANK_DEMO_STATE_DIR ??
    join(process.env.HOME ?? "/tmp", ".frank-bots");
  const ids = selectedBotIds(process.env.FRANK_BOTS);
  installLogPrefix();

  const host = new FrankBotHost({
    stateDir,
    relayBaseUrl: process.env.E2E_DEMO_RELAY_URL,
    rpcUrl: process.env.MONAD_TESTNET_HTTP_RPC_URL ?? process.env.MONAD_RPC_URL,
  });

  // One at a time, through the host's own `registerAll`: it reports a bot that cannot be built or
  // registered by name (with the reason) and leaves it out, and the others run.
  const running: string[] = [];
  for (const id of ids) {
    const failed = await currentBot.run(id, () =>
      host.registerAll([() => named(BOT_FACTORIES[id]())])
    );
    if (failed.length === 0) {
      running.push(id);
      console.log(`[all-bots] ${id} registered`);
    } else {
      console.error(`[all-bots] ${id} FAILED to start: see its error above`);
    }
  }
  if (running.length === 0) throw new Error("no bot could be started");

  await host.start();
  console.log(`[all-bots] running: ${running.join(", ")}`);

  const shutdown = async () => {
    console.log("[all-bots] Shutting down gracefully...");
    await host.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[all-bots] Fatal error:", err);
    process.exit(1);
  });
}
