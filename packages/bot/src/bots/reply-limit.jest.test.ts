/**
 * The per-peer reply budget each hosted bot declares to the host. A game is many replies to one
 * player (a blackjack hand is three to six), so the game bots declare the game budget; the others
 * declare nothing and get the host's default of twenty an hour.
 */
import {
  DEFAULT_MAX_REPLIES_PER_PEER,
  GAME_MAX_REPLIES_PER_PEER,
  type FrankBotDefinition,
} from "@frank/bot-framework";
import { BOT_ROLE_GAME } from "@frank/codec";
import {
  BlackjackDealerBot,
  ChatRoomBot,
  FaucetBot,
  QwenBot,
  RaffleBot,
  RpsBot,
  SatoshiDiceBot,
  VendorBot,
} from "./index";

const bots: FrankBotDefinition[] = [
  new BlackjackDealerBot(),
  new RpsBot(),
  new SatoshiDiceBot(),
  new RaffleBot(),
  new ChatRoomBot(),
  new FaucetBot(),
  new QwenBot({ config: { mode: "stub" } }),
  new VendorBot({ catalogItems: [] }),
];

describe("reply budget per peer declared by each bot", () => {
  it("is the game budget of 300 an hour for every game bot, and the default of 20 for the rest", () => {
    expect(DEFAULT_MAX_REPLIES_PER_PEER).toBe(20);
    expect(GAME_MAX_REPLIES_PER_PEER).toBe(300);
    const declared = Object.fromEntries(
      bots.map((bot) => [bot.id, bot.maxRepliesPerPeer])
    );
    expect(declared).toEqual({
      blackjack: 300,
      rps: 300,
      dice: 300,
      raffle: 300,
      lobby: undefined,
      faucet: undefined,
      qwen: undefined,
      vendor: undefined,
    });
    for (const bot of bots)
      expect(bot.maxRepliesPerPeer !== undefined).toBe(
        bot.getProfile().botRole === BOT_ROLE_GAME
      );
  });
});
