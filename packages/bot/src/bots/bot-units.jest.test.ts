/**
 * What a bot says about money names the unit of the chain it is composed for: MONT on the
 * Monad testnet, as the app's cards do, and another network's own unit there. The bots are the
 * real ones; the formatter is the host's, over the real chain of each network.
 */
import type { BotContext, BotMessageContext } from "@frank/bot-framework";
import { getChainRegistryEntry } from "@frank/wallet/chain/chains-registry";

import { BlackjackDealerBot } from "./blackjack-bot";
import { harness } from "./bot-harness.testutil";
import { RaffleBot } from "./raffle-bot";
import { RpsBot } from "./rps-bot";
import { SatoshiDiceBot } from "./satoshi-dice-bot";

type Bot = {
  onMessage(message: BotMessageContext, ctx: BotContext): Promise<unknown>;
};

async function said(bot: Bot, chainIdentifier: string): Promise<string> {
  const h = harness(new Map(), chainIdentifier);
  await bot.onMessage(h.message([{ type: "text", text: "help" }]), h.ctx);
  return h.sent
    .flatMap((message) => message.items)
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("\n");
}

describe.each([
  ["monad-testnet", "MONT"],
  ["monad-mainnet", "MON"],
  ["monad-regtest", "MONR"],
])("a bot composed for %s", (chainIdentifier, unit) => {
  it(`is on a network whose registered unit is ${unit}`, () => {
    expect(getChainRegistryEntry(chainIdentifier)!.unit).toBe(unit);
  });

  it("dice names its table limit in that unit", async () => {
    expect(await said(new SatoshiDiceBot(), chainIdentifier)).toContain(
      `The most one roll pays is 0.98 ${unit}.`
    );
  });

  it("rock-paper-scissors names its table limit in that unit", async () => {
    expect(await said(new RpsBot(), chainIdentifier)).toContain(
      `up to 0.49 ${unit}:`
    );
  });

  it("blackjack names its table in that unit", async () => {
    // The harness dealer holds 1 coin: 0.02 kept back, a quarter of the rest covered.
    expect(await said(new BlackjackDealerBot(), chainIdentifier)).toContain(
      `bet between 0.01 ${unit} and 0.245 ${unit}.`
    );
  });

  it("the raffle names its entry price and pot in that unit", async () => {
    const text = await said(new RaffleBot(), chainIdentifier);
    expect(text).toMatch(
      new RegExp(`Entry is [0-9.]+ ${unit}, paid with your entry message; the winner takes all [0-9.]+ ${unit}\\.`)
    );
  });
});
