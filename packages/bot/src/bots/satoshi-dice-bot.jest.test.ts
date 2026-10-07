import {
  SatoshiDiceBot,
  calculateMultiplier,
  rollLuckyNumber,
  SATOSHI_DICE_MODULO,
} from "./satoshi-dice-bot";
import { createHash } from "crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  channelStateDigest,
  decodeDiceGamePayload,
  encodeDiceGamePayload,
  fromHex,
  toHex,
  validateChannelSequence,
  validateChannelTransition,
  verifyChannelSignatures,
  type CanonicalChannelUpdateItem,
  type DiceGamePayload,
} from "@frank/codec";
import type {
  BotContext,
  BotMessageContext,
  NewUserEvent,
} from "@frank/bot-framework";

describe("SatoshiDiceBot", () => {
  let bot: SatoshiDiceBot;
  let mockState: Map<string, string>;
  let mockContext: BotContext;
  let sentMessages: Array<{ to: string; items: any[] }>;
  let transferredFunds: Array<{ to: string; valueWei: bigint }>;

  beforeEach(() => {
    bot = new SatoshiDiceBot();
    mockState = new Map();
    sentMessages = [];
    transferredFunds = [];

    mockContext = {
      botId: "dice",
      address: "0xdddddddddddddddddddddddddddddddddddddddd",
      subject: "0xdddddddddddddddddddddddddddddddddddddddd",
      relayBaseUrl: "http://127.0.0.1:8098",
      networkTag: "MONT",
      provider: {} as any,
      state: {
        get: jest.fn(async (k: string) => mockState.get(k)),
        put: jest.fn(async (k: string, v: string) => {
          mockState.set(k, v);
        }),
        del: jest.fn(async (k: string) => {
          mockState.delete(k);
        }),
        list: jest.fn(async () => []),
        batch: jest.fn(async () => {}),
        sublevel: jest.fn(),
        close: jest.fn(async () => {}),
      },
      subscriptions: {} as any,
      lookupPeer: jest.fn(),
      sendMessage: jest.fn(async (to, items) => {
        sentMessages.push({ to, items });
        return { ok: true } as any;
      }),
      sendDirectMessage: jest.fn(async (to, items) => {
        sentMessages.push({ to, items });
        return { ok: true } as any;
      }),
      onNewUserRegistered: jest.fn(),
      sendTransfer: jest.fn(async ({ to, valueWei }) => {
        transferredFunds.push({ to, valueWei });
        return { txHash: "0xmockdicetx" };
      }),
      buildAndSignTransfer: jest.fn(),
      waitForReceipt: jest.fn(),
      getBalance: jest.fn(async () => 1_000_000_000_000_000_000n),
    };
  });

  test("calculates multipliers and house edge accurately", () => {
    // 50% target (32768): ~1.962x
    const m50 = calculateMultiplier(32768);
    expect(m50).toBeCloseTo(1.962, 2);

    // 25% target (16384): ~3.924x
    const m25 = calculateMultiplier(16384);
    expect(m25).toBeCloseTo(3.924, 2);

    // 10% target (6553): ~9.81x
    const m10 = calculateMultiplier(6553);
    expect(m10).toBeCloseTo(9.81, 1);

    // 1% target (655): ~98.15x
    const m1 = calculateMultiplier(655);
    expect(m1).toBeCloseTo(98.15, 1);

    // 0.1% target (65): ~989.1x
    const m01 = calculateMultiplier(65);
    expect(m01).toBeCloseTo(989.1, 1);

    // Invalid targets return 0
    expect(calculateMultiplier(0)).toBe(0);
    expect(calculateMultiplier(65536)).toBe(0);
  });

  test("derives deterministic 16-bit lucky number from SHA256", () => {
    const secret = "testsecret123";
    const nonce = "nonce456";
    const roll = rollLuckyNumber(secret, nonce);

    expect(typeof roll).toBe("number");
    expect(roll).toBeGreaterThanOrEqual(0);
    expect(roll).toBeLessThan(SATOSHI_DICE_MODULO);

    // Determinism
    expect(rollLuckyNumber(secret, nonce)).toBe(roll);

    // Verifying manual derivation
    const hash = createHash("sha256").update(`${secret}:${nonce}`).digest();
    expect(hash.readUInt16BE(0)).toBe(roll);
  });

  test("returns valid profile metadata", () => {
    const profile = bot.getProfile();
    expect(profile.name).toBe("Satoshi Dice");
    expect(profile.bot).toBe(true);
    expect(profile.avatarPng).toBeInstanceOf(Buffer);
  });

  test("proactively welcomes new users with dice announcement", async () => {
    const user: NewUserEvent = {
      address: "0x1111111111111111111111111111111111111111",
      registeredAtMs: Date.now(),
    };

    await bot.onNewUser(user, mockContext);
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].to).toBe(user.address);
    expect(sentMessages[0].items[0].text).toContain("Welcome to Satoshi Dice");
  });

  test("handles /help, /odds, /stats, and /verify", async () => {
    const player = "0x2222222222222222222222222222222222222222";
    const replies: any[] = [];

    const sendMsg = async (text: string) => {
      replies.length = 0;
      await bot.onMessage(
        {
          conversationId: "c1",
          peerAddress: player,
          peerSubject: player,
          timestampMs: Date.now(),
          payloadDigest: "0x11",
          items: [{ type: "text", text }],
          reply: jest.fn(async (items) => {
            replies.push(items);
          }),
        },
        mockContext
      );
    };

    // 1. /help
    await sendMsg("/help");
    expect(replies[0][0].text).toContain("Satoshi Dice Commands");

    // 2. /odds
    await sendMsg("/odds");
    expect(replies[0][0].text).toContain("Satoshi Dice Odds & Multipliers");
    expect(replies[0][0].text).toContain("Coin Flip");
    expect(replies[0][0].text).toContain("Moonshot");

    // 3. /stats
    await sendMsg("/stats");
    expect(replies[0][0].text).toContain("Satoshi Dice Global Statistics");
    expect(replies[0][0].text).toContain("Total Rolls:** 0");

    // 4. /verify
    await sendMsg("/verify secretA nonceB");
    expect(replies[0][0].text).toContain("Provable Fairness Verification");
    expect(replies[0][0].text).toContain("First 2 Bytes (BE):");
  });

  test("executes free /roll and reports provable fairness verification proof", async () => {
    const player = "0x2222222222222222222222222222222222222222";
    const replies: any[] = [];

    await bot.onMessage(
      {
        conversationId: "c1",
        peerAddress: player,
        peerSubject: player,
        timestampMs: Date.now(),
        payloadDigest: "0xabcdef",
        items: [{ type: "text", text: "/roll" }],
        reply: jest.fn(async (items) => {
          replies.push(items);
        }),
      },
      mockContext
    );

    const rollText = replies[0].find((i: any) => i.type === "text")?.text;
    const rollItem = replies[0].find((i: any) => i.type === "dice");
    expect(rollItem).toBeDefined();
    expect(rollItem?.action).toBe("result");
    expect(rollText).toContain("Satoshi Dice Roll Result");
    expect(rollText).toContain("Free Play Roll");
    expect(rollText).toContain("Target:** < 32768");
    expect(rollText).toContain("Fairness Verification Proof");
    expect(rollText).toContain("Server Secret:");
    expect(rollText).toContain("User Nonce:");
  });

  test("executes wagered /roll with target and records stats and payout transfer on win", async () => {
    const player = "0x3333333333333333333333333333333333333333";
    const replies: any[] = [];

    // Wager 0.05 MON on safe harbor (< 64000, 97.6% chance)
    await bot.onMessage(
      {
        conversationId: "c1",
        peerAddress: player,
        peerSubject: player,
        timestampMs: Date.now(),
        payloadDigest: "0x123456",
        items: [{ type: "text", text: "/roll 0.05 64000" }],
        reply: jest.fn(async (items) => {
          replies.push(items);
        }),
      },
      mockContext
    );

    const rollText = replies[0].find((i: any) => i.type === "text")?.text;
    const rollItem = replies[0].find((i: any) => i.type === "dice");
    expect(rollItem).toBeDefined();
    expect(rollItem?.action).toBe("result");
    expect(rollText).toContain("Satoshi Dice Roll Result");
    expect(rollText).toContain("Wager:** 0.05 MON");
    expect(rollText).toContain("Target:** < 64000");

    // Check stats updated
    const statsRaw = mockState.get("stats:global");
    expect(statsRaw).toBeDefined();
    const stats = JSON.parse(statsRaw!);
    expect(stats.totalRolls).toBe(1);
    expect(stats.totalWageredWei).toBe("50000000000000000");
  });

  describe("Type 24 Universal State Channel Integration", () => {
    const playerPriv = fromHex("01".repeat(32));
    const playerPub = secp256k1.getPublicKey(playerPriv, true);
    const playerPubHex = toHex(playerPub);

    const botPriv = fromHex("02".repeat(32));
    const botPub = secp256k1.getPublicKey(botPriv, true);
    const botPubHex = toHex(botPub);

    const signDer = (digest: Uint8Array, priv: Uint8Array): Uint8Array =>
      new Uint8Array(secp256k1.sign(digest, priv).toDERRawBytes());

    const channelId = "44".repeat(32);

    beforeEach(() => {
      bot = new SatoshiDiceBot({ signerPrivateKey: botPriv });
    });

    test("handles Type 24 channel-update messages with DiceGamePayload (appId dice-v1, satoshi-dice-v1, dice)", async () => {
      for (const appId of ["dice-v1", "satoshi-dice-v1", "dice"]) {
        const testChannelId = createHash("sha256").update(appId).digest("hex");
        const dicePayload: DiceGamePayload = {
          round: 1n,
          action: "roll",
          seedCommitment: fromHex("aa".repeat(32)),
          targetRoll: 50,
          wager: 1_000_000n,
        };
        const encodedDice = encodeDiceGamePayload(dicePayload);

        const allocations = [
          {
            networkTag: "mont",
            token: "",
            balances: [
              {
                participant: { keyType: 1, pubKey: playerPubHex },
                balance: "10000000",
              },
              {
                participant: { keyType: 1, pubKey: botPubHex },
                balance: "50000000",
              },
            ],
          },
        ];

        const digest = channelStateDigest({
          channelId: testChannelId,
          appId,
          sequenceNumber: 1,
          allocations,
          appState: encodedDice,
        });

        const playerSig = signDer(digest, playerPriv);

        const channelItem: CanonicalChannelUpdateItem = {
          type: "channel-update",
          channelId: testChannelId,
          appId,
          sequenceNumber: 1,
          allocations,
          appState: encodedDice,
          signatures: [
            {
              algorithm: 1,
              signer: { keyType: 1, pubKey: playerPubHex },
              signature: toHex(playerSig),
            },
          ],
        };

        const replies: any[] = [];
        await bot.onMessage(
          {
            conversationId: "c-channel-1",
            peerAddress: "0x1111111111111111111111111111111111111111",
            peerSubject: "0x1111111111111111111111111111111111111111",
            timestampMs: Date.now(),
            payloadDigest: "0x99",
            items: [channelItem as any],
            reply: jest.fn(async (items) => {
              replies.push(items);
            }),
          },
          mockContext
        );

        expect(replies).toHaveLength(1);
        const respItem = replies[0].find(
          (i: any) => i.type === "channel-update"
        ) as CanonicalChannelUpdateItem;
        expect(respItem).toBeDefined();
        expect(respItem.channelId).toBe(testChannelId);
        expect(respItem.appId).toBe(appId);
        expect(respItem.sequenceNumber).toBe(2);

        // State transition check between incoming and outgoing
        validateChannelTransition(channelItem, respItem);

        // Verify bot's signature on response
        expect(verifyChannelSignatures(respItem)).toBe(true);
        expect(respItem.signatures[0].signer.pubKey.toLowerCase()).toBe(
          botPubHex.toLowerCase()
        );

        // Verify decoded response payload
        const respDice = decodeDiceGamePayload(
          typeof respItem.appState === "string"
            ? fromHex(respItem.appState)
            : respItem.appState
        );
        expect(respDice.action).toBe("reveal");
        expect(respDice.round).toBe(1n);
        expect(respDice.revealSeed).toBeDefined();
        expect(respDice.seedCommitment).toBeDefined();
      }
    });

    test("enforces monotonic sequence numbers and state transition validation", async () => {
      const dicePayload: DiceGamePayload = {
        round: 1n,
        action: "roll",
        seedCommitment: fromHex("11".repeat(32)),
        targetRoll: 50,
        wager: 1_000_000n,
      };
      const encodedDice = encodeDiceGamePayload(dicePayload);

      const allocations = [
        {
          networkTag: "mont",
          token: "",
          balances: [
            {
              participant: { keyType: 1, pubKey: playerPubHex },
              balance: "10000000",
            },
            {
              participant: { keyType: 1, pubKey: botPubHex },
              balance: "50000000",
            },
          ],
        },
      ];

      const digest1 = channelStateDigest({
        channelId,
        appId: "dice-v1",
        sequenceNumber: 3,
        allocations,
        appState: encodedDice,
      });

      const itemSeq3: CanonicalChannelUpdateItem = {
        type: "channel-update",
        channelId,
        appId: "dice-v1",
        sequenceNumber: 3,
        allocations,
        appState: encodedDice,
        signatures: [
          {
            algorithm: 1,
            signer: { keyType: 1, pubKey: playerPubHex },
            signature: toHex(signDer(digest1, playerPriv)),
          },
        ],
      };

      const replies: any[] = [];
      const sendItem = async (item: CanonicalChannelUpdateItem) => {
        replies.length = 0;
        await bot.onMessage(
          {
            conversationId: "c-channel-seq",
            peerAddress: "0x1111111111111111111111111111111111111111",
            peerSubject: "0x1111111111111111111111111111111111111111",
            timestampMs: Date.now(),
            payloadDigest: "0x99",
            items: [item as any],
            reply: jest.fn(async (items) => {
              replies.push(items);
            }),
          },
          mockContext
        );
      };

      // 1. Send sequence 3 -> bot replies with sequence 4
      await sendItem(itemSeq3);
      expect(replies).toHaveLength(1);
      const respItem = replies[0].find((i: any) => i.type === "channel-update");
      expect(respItem.sequenceNumber).toBe(4);

      // 2. Replay stale sequence 3 -> bot rejects with sequence error
      await sendItem(itemSeq3);
      expect(replies).toHaveLength(1);
      const staleReply = replies[0].find((i: any) => i.type === "text")?.text;
      expect(staleReply).toContain("Channel sequence validation failed");

      // 3. Stale sequence 2 -> rejected
      const digestOld = channelStateDigest({
        channelId,
        appId: "dice-v1",
        sequenceNumber: 2,
        allocations,
        appState: encodedDice,
      });
      const itemSeq2: CanonicalChannelUpdateItem = {
        ...itemSeq3,
        sequenceNumber: 2,
        signatures: [
          {
            algorithm: 1,
            signer: { keyType: 1, pubKey: playerPubHex },
            signature: toHex(signDer(digestOld, playerPriv)),
          },
        ],
      };
      await sendItem(itemSeq2);
      expect(replies[0].find((i: any) => i.type === "text")?.text).toContain(
        "Channel sequence validation failed"
      );

      // 4. Future sequence 7 (> 4) -> accepted and advanced to 8
      const digest7 = channelStateDigest({
        channelId,
        appId: "dice-v1",
        sequenceNumber: 7,
        allocations,
        appState: encodedDice,
      });
      const itemSeq7: CanonicalChannelUpdateItem = {
        ...itemSeq3,
        sequenceNumber: 7,
        signatures: [
          {
            algorithm: 1,
            signer: { keyType: 1, pubKey: playerPubHex },
            signature: toHex(signDer(digest7, playerPriv)),
          },
        ],
      };
      await sendItem(itemSeq7);
      const resp7 = replies[0].find((i: any) => i.type === "channel-update");
      expect(resp7.sequenceNumber).toBe(8);
    });

    test("verifies incoming signatures and rejects invalid/tampered signatures", async () => {
      const dicePayload: DiceGamePayload = {
        round: 1n,
        action: "roll",
        seedCommitment: fromHex("aa".repeat(32)),
        targetRoll: 50,
        wager: 1_000_000n,
      };
      const encodedDice = encodeDiceGamePayload(dicePayload);

      const allocations = [
        {
          networkTag: "mont",
          token: "",
          balances: [
            {
              participant: { keyType: 1, pubKey: playerPubHex },
              balance: "10000000",
            },
            {
              participant: { keyType: 1, pubKey: botPubHex },
              balance: "50000000",
            },
          ],
        },
      ];

      // A. Corrupted signature bytes
      const badSigItem: CanonicalChannelUpdateItem = {
        type: "channel-update",
        channelId,
        appId: "dice-v1",
        sequenceNumber: 1,
        allocations,
        appState: encodedDice,
        signatures: [
          {
            algorithm: 1,
            signer: { keyType: 1, pubKey: playerPubHex },
            signature: "00".repeat(64),
          },
        ],
      };

      const replies: any[] = [];
      await bot.onMessage(
        {
          conversationId: "c-sig-fail",
          peerAddress: "0x1111111111111111111111111111111111111111",
          peerSubject: "0x1111111111111111111111111111111111111111",
          timestampMs: Date.now(),
          payloadDigest: "0x99",
          items: [badSigItem as any],
          reply: jest.fn(async (items) => {
            replies.push(items);
          }),
        },
        mockContext
      );

      expect(replies[0].find((i: any) => i.type === "text")?.text).toContain(
        "Channel signature verification failed"
      );

      // B. Missing signatures array
      replies.length = 0;
      const noSigItem = { ...badSigItem, signatures: [] };
      await bot.onMessage(
        {
          conversationId: "c-no-sig",
          peerAddress: "0x1111111111111111111111111111111111111111",
          peerSubject: "0x1111111111111111111111111111111111111111",
          timestampMs: Date.now(),
          payloadDigest: "0x99",
          items: [noSigItem as any],
          reply: jest.fn(async (items) => {
            replies.push(items);
          }),
        },
        mockContext
      );
      expect(replies[0].find((i: any) => i.type === "text")?.text).toContain(
        "must be signed"
      );
    });

    test("allocates correct payout balances on player win (conserving total balance)", async () => {
      // Force lucky roll = 1000 (< 32768, guaranteed win on 50% target)
      bot.setLuckyNumberOverride(1000);

      const wagerWei = 1_000_000n;
      const playerInitial = 10_000_000n;
      const botInitial = 50_000_000n;

      const dicePayload: DiceGamePayload = {
        round: 1n,
        action: "roll",
        seedCommitment: fromHex("aa".repeat(32)),
        targetRoll: 50,
        wager: wagerWei,
      };
      const encodedDice = encodeDiceGamePayload(dicePayload);

      const allocations = [
        {
          networkTag: "mont",
          token: "",
          balances: [
            {
              participant: { keyType: 1, pubKey: playerPubHex },
              balance: playerInitial.toString(),
            },
            {
              participant: { keyType: 1, pubKey: botPubHex },
              balance: botInitial.toString(),
            },
          ],
        },
      ];

      const digest = channelStateDigest({
        channelId,
        appId: "dice-v1",
        sequenceNumber: 1,
        allocations,
        appState: encodedDice,
      });

      const item: CanonicalChannelUpdateItem = {
        type: "channel-update",
        channelId,
        appId: "dice-v1",
        sequenceNumber: 1,
        allocations,
        appState: encodedDice,
        signatures: [
          {
            algorithm: 1,
            signer: { keyType: 1, pubKey: playerPubHex },
            signature: toHex(signDer(digest, playerPriv)),
          },
        ],
      };

      const replies: any[] = [];
      await bot.onMessage(
        {
          conversationId: "c-win",
          peerAddress: "0x1111111111111111111111111111111111111111",
          peerSubject: "0x1111111111111111111111111111111111111111",
          timestampMs: Date.now(),
          payloadDigest: "0x99",
          items: [item as any],
          reply: jest.fn(async (items) => {
            replies.push(items);
          }),
        },
        mockContext
      );

      const respItem = replies[0].find(
        (i: any) => i.type === "channel-update"
      ) as CanonicalChannelUpdateItem;
      expect(respItem).toBeDefined();

      const newBalances = respItem.allocations[0].balances;
      const newPlayerBal = BigInt(newBalances[0].balance.toString());
      const newBotBal = BigInt(newBalances[1].balance.toString());

      // Multiplier for 32768 is ~1.962. Expected payout = 1_962_000 wei.
      // Net gain = 962_000 wei.
      const multiplier = calculateMultiplier(32768);
      const expectedPayout = BigInt(Math.floor(Number(wagerWei) * multiplier));
      const expectedNetGain = expectedPayout - wagerWei;

      expect(newPlayerBal).toBe(playerInitial + expectedNetGain);
      expect(newBotBal).toBe(botInitial - expectedNetGain);

      // Strict balance conservation across channel
      expect(newPlayerBal + newBotBal).toBe(playerInitial + botInitial);

      // Check stats updated
      const stats = JSON.parse(mockState.get("stats:global")!);
      expect(stats.totalWins).toBe(1);
      expect(stats.totalRolls).toBe(1);
      expect(stats.totalWageredWei).toBe(wagerWei.toString());
      expect(stats.totalPaidOutWei).toBe(expectedPayout.toString());
    });

    test("allocates correct balances on player loss (conserving total balance)", async () => {
      // Force lucky roll = 50000 (>= 32768, guaranteed loss)
      bot.setLuckyNumberOverride(50000);

      const wagerWei = 2_000_000n;
      const playerInitial = 10_000_000n;
      const botInitial = 50_000_000n;

      const dicePayload: DiceGamePayload = {
        round: 1n,
        action: "roll",
        seedCommitment: fromHex("bb".repeat(32)),
        targetRoll: 50,
        wager: wagerWei,
      };
      const encodedDice = encodeDiceGamePayload(dicePayload);

      const allocations = [
        {
          networkTag: "mont",
          token: "",
          balances: [
            {
              participant: { keyType: 1, pubKey: playerPubHex },
              balance: playerInitial.toString(),
            },
            {
              participant: { keyType: 1, pubKey: botPubHex },
              balance: botInitial.toString(),
            },
          ],
        },
      ];

      const digest = channelStateDigest({
        channelId,
        appId: "dice-v1",
        sequenceNumber: 1,
        allocations,
        appState: encodedDice,
      });

      const item: CanonicalChannelUpdateItem = {
        type: "channel-update",
        channelId,
        appId: "dice-v1",
        sequenceNumber: 1,
        allocations,
        appState: encodedDice,
        signatures: [
          {
            algorithm: 1,
            signer: { keyType: 1, pubKey: playerPubHex },
            signature: toHex(signDer(digest, playerPriv)),
          },
        ],
      };

      const replies: any[] = [];
      await bot.onMessage(
        {
          conversationId: "c-loss",
          peerAddress: "0x1111111111111111111111111111111111111111",
          peerSubject: "0x1111111111111111111111111111111111111111",
          timestampMs: Date.now(),
          payloadDigest: "0x99",
          items: [item as any],
          reply: jest.fn(async (items) => {
            replies.push(items);
          }),
        },
        mockContext
      );

      const respItem = replies[0].find(
        (i: any) => i.type === "channel-update"
      ) as CanonicalChannelUpdateItem;
      expect(respItem).toBeDefined();

      const newBalances = respItem.allocations[0].balances;
      const newPlayerBal = BigInt(newBalances[0].balance.toString());
      const newBotBal = BigInt(newBalances[1].balance.toString());

      expect(newPlayerBal).toBe(playerInitial - wagerWei);
      expect(newBotBal).toBe(botInitial + wagerWei);

      // Strict balance conservation
      expect(newPlayerBal + newBotBal).toBe(playerInitial + botInitial);

      // Check stats updated
      const stats = JSON.parse(mockState.get("stats:global")!);
      expect(stats.totalWins).toBe(0);
      expect(stats.totalRolls).toBe(1);
      expect(stats.totalWageredWei).toBe(wagerWei.toString());
      expect(stats.totalPaidOutWei).toBe("0");
    });

    test("rejects roll when player channel balance is insufficient for wager", async () => {
      const dicePayload: DiceGamePayload = {
        round: 1n,
        action: "roll",
        seedCommitment: fromHex("aa".repeat(32)),
        targetRoll: 50,
        wager: 50_000_000n, // greater than player balance of 10_000_000
      };
      const encodedDice = encodeDiceGamePayload(dicePayload);

      const allocations = [
        {
          networkTag: "mont",
          token: "",
          balances: [
            {
              participant: { keyType: 1, pubKey: playerPubHex },
              balance: "10000000",
            },
            {
              participant: { keyType: 1, pubKey: botPubHex },
              balance: "50000000",
            },
          ],
        },
      ];

      const digest = channelStateDigest({
        channelId,
        appId: "dice-v1",
        sequenceNumber: 1,
        allocations,
        appState: encodedDice,
      });

      const item: CanonicalChannelUpdateItem = {
        type: "channel-update",
        channelId,
        appId: "dice-v1",
        sequenceNumber: 1,
        allocations,
        appState: encodedDice,
        signatures: [
          {
            algorithm: 1,
            signer: { keyType: 1, pubKey: playerPubHex },
            signature: toHex(signDer(digest, playerPriv)),
          },
        ],
      };

      const replies: any[] = [];
      await bot.onMessage(
        {
          conversationId: "c-insufficient",
          peerAddress: "0x1111111111111111111111111111111111111111",
          peerSubject: "0x1111111111111111111111111111111111111111",
          timestampMs: Date.now(),
          payloadDigest: "0x99",
          items: [item as any],
          reply: jest.fn(async (items) => {
            replies.push(items);
          }),
        },
        mockContext
      );

      expect(replies[0].find((i: any) => i.type === "text")?.text).toContain(
        "Insufficient channel balance"
      );
    });

    test("handles commit and reveal actions in DiceGamePayload", async () => {
      // 1. Action: commit
      const commitPayload: DiceGamePayload = {
        round: 5n,
        action: "commit",
        seedCommitment: fromHex("cc".repeat(32)),
        targetRoll: 25,
        wager: 500_000n,
      };
      const encodedCommit = encodeDiceGamePayload(commitPayload);

      const allocations = [
        {
          networkTag: "mont",
          token: "",
          balances: [
            {
              participant: { keyType: 1, pubKey: playerPubHex },
              balance: "10000000",
            },
            {
              participant: { keyType: 1, pubKey: botPubHex },
              balance: "50000000",
            },
          ],
        },
      ];

      const digestCommit = channelStateDigest({
        channelId,
        appId: "satoshi-dice-v1",
        sequenceNumber: 10,
        allocations,
        appState: encodedCommit,
      });

      const commitItem: CanonicalChannelUpdateItem = {
        type: "channel-update",
        channelId,
        appId: "satoshi-dice-v1",
        sequenceNumber: 10,
        allocations,
        appState: encodedCommit,
        signatures: [
          {
            algorithm: 1,
            signer: { keyType: 1, pubKey: playerPubHex },
            signature: toHex(signDer(digestCommit, playerPriv)),
          },
        ],
      };

      const replies: any[] = [];
      await bot.onMessage(
        {
          conversationId: "c-commit",
          peerAddress: "0x1111111111111111111111111111111111111111",
          peerSubject: "0x1111111111111111111111111111111111111111",
          timestampMs: Date.now(),
          payloadDigest: "0x99",
          items: [commitItem as any],
          reply: jest.fn(async (items) => {
            replies.push(items);
          }),
        },
        mockContext
      );

      const respCommit = replies[0].find(
        (i: any) => i.type === "channel-update"
      );
      expect(respCommit).toBeDefined();
      expect(respCommit.sequenceNumber).toBe(11);
      const decodedCommitResp = decodeDiceGamePayload(
        typeof respCommit.appState === "string"
          ? fromHex(respCommit.appState)
          : respCommit.appState
      );
      expect(decodedCommitResp.action).toBe("reveal");
      expect(decodedCommitResp.revealSeed).toBeDefined();

      // 2. Action: reveal
      const revealPayload: DiceGamePayload = {
        round: 6n,
        action: "reveal",
        seedCommitment: fromHex("dd".repeat(32)),
        revealSeed: fromHex("ee".repeat(32)),
        targetRoll: 50,
        wager: 100_000n,
      };
      const encodedReveal = encodeDiceGamePayload(revealPayload);

      const digestReveal = channelStateDigest({
        channelId,
        appId: "satoshi-dice-v1",
        sequenceNumber: 12,
        allocations,
        appState: encodedReveal,
      });

      const revealItem: CanonicalChannelUpdateItem = {
        type: "channel-update",
        channelId,
        appId: "satoshi-dice-v1",
        sequenceNumber: 12,
        allocations,
        appState: encodedReveal,
        signatures: [
          {
            algorithm: 1,
            signer: { keyType: 1, pubKey: playerPubHex },
            signature: toHex(signDer(digestReveal, playerPriv)),
          },
        ],
      };

      replies.length = 0;
      await bot.onMessage(
        {
          conversationId: "c-reveal",
          peerAddress: "0x1111111111111111111111111111111111111111",
          peerSubject: "0x1111111111111111111111111111111111111111",
          timestampMs: Date.now(),
          payloadDigest: "0x99",
          items: [revealItem as any],
          reply: jest.fn(async (items) => {
            replies.push(items);
          }),
        },
        mockContext
      );

      const respReveal = replies[0].find(
        (i: any) => i.type === "channel-update"
      );
      expect(respReveal).toBeDefined();
      expect(respReveal.sequenceNumber).toBe(13);
    });
  });
});
