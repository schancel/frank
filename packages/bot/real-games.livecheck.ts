/**
 * One real game per bot: the real relay binary, Monad testnet, the real bot host and real
 * wallets. Nothing is simulated. Not part of CI (it spends testnet funds and takes minutes).
 *
 *   FUNDED_BOT_HOST_DIR=<a COPY of a bot host state dir whose bots are funded> \
 *   yarn tsx real-games.livecheck.ts            # GAMES=dice,rps,vendor,raffle,blackjack
 *
 * Use a copy (`cp -c -R ~/.frank-demo/bot-host <dir>`), never a state dir a demo is using: the
 * bots here write their own records into it, and the raffle's round record is reset.
 * Configuration is the harness's (`demo/real-stack.ts`): MONAD_TESTNET_HTTP_RPC_URL and a
 * funding wallet (FRANK_TEST_WALLET_JSON, else E2E_DEMO_MAIN_WALLET_JSON; do not use the latter
 * while a demo is running) from the environment or the repo's `.env`; CASHWEBD_BIN for a
 * prebuilt relay. Stakes are 0.0005 MON. Two player accounts are funded (0.08 and 0.03 MON) and
 * what they have left is sent back to the funding wallet at the end.
 *
 * Per game it checks what a player's app checks, and that the money is on chain:
 *   dice      table -> bet (stake as message value) -> result; reveal verified; payout on chain
 *   rps       start -> move with a stake -> resolve; reveal verified; payout on chain if owed
 *   vendor    an unpaid request is refused; a paid one delivers the picture
 *   raffle    two entrants; the draw verifies against the announce; the pot is on chain to the winner
 *   blackjack challenge -> bet -> deal -> stand -> reveal, folded with the shared state machine;
 *             what the outcome owes is on chain
 * Exit code 1 if any game fails.
 */
import { join } from "path";
import { FrankBotHost } from "@frank/bot-framework";
import {
  verifyDiceResult,
  dicePayoutWei,
} from "@frank/wallet/message-item-plugins/dice/fair";
import { verifyRpsResult } from "@frank/wallet/message-item-plugins/rps/fair";
import { verifyRaffleDrawAgainstThread } from "@frank/wallet/message-item-plugins/raffle/draw";
import {
  buildBet,
  foldHand,
  playerStep,
  payoutWei,
  type HandEvent,
} from "@frank/wallet/message-item-plugins/blackjack/hand";
import {
  realStackEnv,
  startRealStack,
  type RealWallet,
} from "./demo/real-stack";
import { SatoshiDiceBot } from "./src/bots/satoshi-dice-bot";
import { RpsBot } from "./src/bots/rps-bot";
import { VendorBot } from "./src/bots/vendor-bot";
import { RaffleBot } from "./src/bots/raffle-bot";
import { BlackjackDealerBot } from "./src/bots/blackjack-bot";

const STAMP = 100_000_000_000_000n; // 0.0001
const STAKE = 500_000_000_000_000n; // 0.0005
const only = (process.env.GAMES ?? "dice,rps,vendor,raffle,blackjack").split(
  ","
);
const say = (...a: unknown[]) =>
  console.log(new Date().toISOString().slice(11, 19), ...a);

async function main() {
  const env = realStackEnv();
  process.env.MONAD_TESTNET_HTTP_RPC_URL = env.MONAD_TESTNET_HTTP_RPC_URL;
  process.env.FRANK_NETWORK_TAG = "MONT";
  for (const k of [
    "E2E_DEMO_MAIN_WALLET_JSON",
    "E2E_DEMO_MAIN_WALLET_PRIVATE_KEY",
    "FRANK_DEMO_FAUCET_WALLET_JSON",
  ])
    delete process.env[k];
  env.FRANK_TEST_WALLET_JSON ??= env.E2E_DEMO_MAIN_WALLET_JSON;
  const stack = await startRealStack({ env });
  say("relay", stack.relayUrl, "state", stack.stateDir);
  const before = await stack.provider.getBalance(stack.fundingAddress);
  const botDir = process.env.FUNDED_BOT_HOST_DIR;
  if (!botDir)
    throw new Error(
      "Set FUNDED_BOT_HOST_DIR to a copy of a funded bot host state dir"
    );
  {
    // The raffle round the copied state holds is another build's record: start a fresh one.
    const { LevelBotStateStore } = await import("@frank/bot-framework");
    const raffleState = await LevelBotStateStore.open(
      join(botDir, "bots", "raffle", "state")
    );
    await raffleState.del("current_round");
    await raffleState.close();
  }
  for (const id of ["dice", "rps", "vendor", "raffle", "blackjack"])
    process.env[`${id.toUpperCase()}_BOT_IDENTITY_JSON`] = join(
      botDir,
      `${id}.json`
    );
  const host = new FrankBotHost({
    stateDir: botDir,
    relayBaseUrl: stack.relayUrl,
    rpcUrl: stack.rpcUrl.split(",")[0],
    stampValueWei: STAMP,
    watchRegistrations: false,
    pollIntervalMs: 2000,
  });
  const image =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const bots = {
    dice: () => new SatoshiDiceBot(),
    rps: () => new RpsBot(),
    vendor: () =>
      new VendorBot({
        catalogItems: [
          { itemId: "pic", description: "A picture", priceWei: STAKE, image },
        ],
      }),
    raffle: () => new RaffleBot({ entryPriceWei: STAKE, maxEntries: 2 }),
    blackjack: () =>
      new BlackjackDealerBot({ minWagerWei: STAKE, maxWagerWei: STAKE * 2n }),
  } as const;
  const failed = await host.registerAll(
    only.map((id) => bots[id as keyof typeof bots])
  );
  if (failed.length) throw new Error(`bots failed to register: ${failed}`);
  const fund = async (to: string, wei: bigint) => {
    try {
      await stack.fund(to, wei);
    } catch (e) {
      say(
        "funding failed once, retrying:",
        (e instanceof Error ? e.message : String(e)).slice(0, 80)
      );
      await new Promise((r) => setTimeout(r, 5000));
      await stack.fund(to, wei);
    }
  };
  const at: Record<string, string> = {};
  for (const id of only) {
    const inst = (host as any).instances.get(id);
    at[id] = inst.context.address;
    const main = (await inst.wallet.getReceiveAddress()).raw;
    say(
      "bot",
      id,
      at[id],
      "identity",
      (await stack.provider.getBalance(at[id])).toString(),
      "main",
      (await stack.provider.getBalance(main)).toString()
    );
  }
  await host.start();
  const alice = await stack.openWallet("alice", { stampValueWei: STAMP });
  await fund(alice.mainAccount, 80_000_000_000_000_000n);
  const results: Record<string, string> = {};
  const item = (m: any, type: string) =>
    m.items.find((i: any) => i.type === type);
  const game = async (id: string, run: () => Promise<string>) => {
    if (!only.includes(id)) return;
    try {
      results[id] = "OK: " + (await run());
    } catch (e) {
      results[id] = "FAILED: " + (e instanceof Error ? e.message : e);
    }
    say(id, results[id]);
  };
  const onChain = async (m: any) => {
    let total = 0n;
    for (const p of m.stampPayments) {
      const r = await stack.provider.getTransactionReceipt(p.txHash);
      const tx = await stack.provider.getTransaction(p.txHash);
      if (
        r?.status === 1 &&
        tx &&
        tx.to?.toLowerCase() === p.destinationAddress.toLowerCase() &&
        tx.value === p.valueWei
      )
        total += p.valueWei;
    }
    return total;
  };

  await game("dice", async () => {
    await alice.send(at.dice, [{ type: "text", text: "hi" }]);
    const offer = item(
      await alice.receive((m) => item(m, "dice")?.action === "table"),
      "dice"
    );
    const bet = {
      type: "dice",
      action: "roll",
      rollId: offer.rollId,
      commitment: offer.commitment,
      clientSeed: "c3".repeat(16),
      target: 64000,
      wagerWei: STAKE.toString(),
    } as any;
    await alice.send(at.dice, [bet], STAKE);
    const msg = await alice.receive(
      (m) =>
        item(m, "dice")?.action === "result" &&
        item(m, "dice").rollId === offer.rollId,
      240_000
    );
    const result = item(msg, "dice");
    const check = verifyDiceResult(result, bet);
    if (!check.ok) throw new Error("not verified: " + check.reason);
    const paid = await onChain(msg);
    if (paid < BigInt(result.payoutWei))
      throw new Error(`payout ${result.payoutWei} but ${paid} on chain`);
    return `rolled ${result.luckyNumber} win=${result.isWin} payout ${
      result.payoutWei
    } (expected ${
      result.isWin ? dicePayoutWei(STAKE, 64000) : 0n
    }); ${paid} wei confirmed on chain to the player's stamp addresses; verified`;
  });

  await game("rps", async () => {
    await alice.send(at.rps, [{ type: "text", text: "/rps" }]);
    const start = item(
      await alice.receive((m) => item(m, "rps")?.action === "start"),
      "rps"
    );
    const mine = {
      type: "rps",
      action: "move",
      matchId: start.matchId,
      commitHash: start.commitHash,
      playerMove: "rock",
      wagerWei: STAKE.toString(),
    } as any;
    await alice.send(at.rps, [mine], STAKE);
    const msg = await alice.receive(
      (m) =>
        item(m, "rps")?.action === "resolve" &&
        item(m, "rps").matchId === start.matchId,
      240_000
    );
    const result = item(msg, "rps");
    const check = verifyRpsResult(result, mine);
    if (!check.ok) throw new Error("not verified: " + check.reason);
    const owed =
      result.outcome === "win"
        ? STAKE * 2n
        : result.outcome === "tie"
        ? STAKE
        : 0n;
    const paid = await onChain(msg);
    if (paid < owed) throw new Error(`owed ${owed} but ${paid} on chain`);
    return `rock vs ${result.botMove}: ${result.outcome}; owed ${owed}, ${paid} wei confirmed on chain; verified`;
  });

  await game("vendor", async () => {
    await alice.send(at.vendor, [
      { type: "digital-goods", action: "request", itemId: "pic" } as any,
    ]);
    const refusal = await alice.receive(
      (m) => item(m, "digital-goods")?.action === "error",
      240_000
    );
    await alice.send(
      at.vendor,
      [{ type: "digital-goods", action: "request", itemId: "pic" } as any],
      STAKE
    );
    const got = await alice.receive(
      (m) => item(m, "digital-goods")?.action === "fulfill",
      240_000
    );
    return `unpaid request refused ("${item(refusal, "text")?.text?.slice(
      0,
      60
    )}..."), paid request delivered (${got.items
      .map((i: any) => i.type)
      .join(",")})`;
  });

  await game("raffle", async () => {
    const bob = await stack.openWallet("bob", { stampValueWei: STAMP });
    await fund(bob.mainAccount, 30_000_000_000_000_000n);
    const enter = async (w: RealWallet) => {
      await w.send(at.raffle, [{ type: "text", text: "hi" }]);
      const announce = item(
        await w.receive((m) => item(m, "raffle")?.action === "announce"),
        "raffle"
      );
      await w.send(
        at.raffle,
        [
          {
            type: "raffle",
            raffleId: announce.raffleId,
            action: "enter",
          } as any,
        ],
        STAKE
      );
      return announce;
    };
    const announce = await enter(alice);
    await alice.receive((m) => item(m, "raffle")?.action === "joined", 240_000);
    await enter(bob);
    const drawOf = (w: RealWallet) =>
      w.receive(
        (m) =>
          item(m, "raffle")?.action === "draw" &&
          item(m, "raffle").raffleId === announce.raffleId,
        300_000
      );
    const [a, b] = await Promise.all([drawOf(alice), drawOf(bob)]);
    const draw = item(a, "raffle");
    const check = verifyRaffleDrawAgainstThread(draw, [announce]);
    if (!check?.valid) throw new Error("draw not verified: " + check?.reason);
    const winnerMsg =
      draw.winnerAddress.toLowerCase() === alice.address.toLowerCase() ? a : b;
    const paid = await onChain(winnerMsg);
    if (paid < BigInt(draw.potWei))
      throw new Error(`pot ${draw.potWei} but ${paid} on chain`);
    return `2 entrants, winner ${draw.winnerAddress}, pot ${draw.potWei}, ${paid} wei confirmed on chain to the winner; draw verified`;
  });

  await game("blackjack", async () => {
    const SEED = "aa".repeat(32);
    const events: HandEvent[] = [];
    const sendHand = async (it: any, stamp?: bigint) => {
      const digest = await alice.send(at.blackjack, [it], stamp);
      events.push({
        item: it,
        from: alice.address,
        to: at.blackjack,
        stampWei: stamp ?? STAMP,
        digest,
      });
    };
    const next = async (action: string) => {
      const m = await alice.receive(
        (x) =>
          item(x, "blackjack-hand")?.action === action &&
          !events.some((e) => e.digest === x.payloadDigest),
        300_000
      );
      events.push({
        item: item(m, "blackjack-hand"),
        from: at.blackjack,
        to: alice.address,
        stampWei: m.stampValueWei,
        digest: m.payloadDigest,
      });
      return m;
    };
    await alice.send(at.blackjack, [{ type: "text", text: "deal me in" }]);
    await next("challenge");
    await sendHand(buildBet(foldHand(events).state, SEED), STAKE);
    await next("deal");
    let state = foldHand(events).state!;
    if (state.phase === "player_turn") {
      await sendHand(playerStep(state, "stand", SEED));
    }
    const reveal = await next("reveal");
    state = foldHand(events).state!;
    if (state.phase !== "resolved")
      throw new Error("hand not resolved: " + state.phase);
    const owed = payoutWei(state.outcome!, STAKE, false);
    const paid = await onChain(reveal);
    if (paid < owed) throw new Error(`owed ${owed} but ${paid} on chain`);
    return `outcome ${state.outcome}, owed ${owed}, ${paid} wei confirmed on chain; every card computed from the opened links`;
  });

  await host.stop().catch(() => undefined);
  // What the players have left goes back to the funding wallet.
  const returned = await stack.sweep().catch((e) => {
    say(
      "players' leftovers NOT returned:",
      e instanceof Error ? e.message : e,
      "- their keys are under",
      stack.stateDir
    );
    return 0n;
  });
  say("returned to the funding wallet (wei):", returned.toString());
  await stack.stop();
  const after = await new (
    await import("ethers")
  ).JsonRpcProvider(stack.rpcUrl.split(",")[0]).getBalance(
    stack.fundingAddress
  );
  say("RESULTS", JSON.stringify(results, null, 1));
  say(
    "funding wallet spent (wei):",
    (before - after).toString(),
    "bot state kept in",
    botDir
  );
  process.exit(
    Object.values(results).some((r) => r.startsWith("FAILED")) ? 1 : 0
  );
}
if (require.main === module) {
  main().catch((e) => {
    console.error("run failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
