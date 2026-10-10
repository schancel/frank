import { Wallet } from "ethers";
import {
  MAX_TEXT_STRING_BYTES,
  MAX_DIRECT_MESSAGE_FRAME_BYTES,
} from "@frank/codec";
import type {
  BotContext,
  BotMessageContext,
  BotStateStore,
  PreparedReply,
} from "@frank/bot-framework";
import type { QwenChatMessage } from "../../qwen-client";
import { MODEL_FAILED_TEXT, QwenBot } from "./qwen-bot";

const local = new Wallet("0x" + "11".repeat(32));
const peer = new Wallet("0x" + "12".repeat(32));
const other = new Wallet("0x" + "13".repeat(32));
const subject = (wallet: Wallet) =>
  wallet.signingKey.compressedPublicKey.slice(2);
const thread = "01010101-0101-0101-0101-010101010101";
const threadB = "02020202-0202-0202-0202-020202020202";
const receipt = {
  payloadDigest: "aa".repeat(32),
  stampValueWei: 1n,
  stampPayments: [],
  preparationTxHashes: [],
};
const scope = (ctx: BotContext, msg: BotMessageContext) => [
  ctx.networkTag === "MONT" ? "monad-testnet" : "monad-mainnet",
  ctx.subject,
  msg.peerSubject,
  msg.conversationId,
];
const key = (ctx: BotContext, msg: BotMessageContext) =>
  "qwen-history:v1:" + JSON.stringify(scope(ctx, msg));
const pair = (text = "prior") => [
  { role: "user", content: text },
  { role: "assistant", content: "answer" },
];
let rows: Map<string, string>;
let ctx: BotContext;
let bot: QwenBot;
let generator: jest.Mock;
let msg: BotMessageContext;
const record = (messages = pair()) => ({
  version: 1,
  scope: scope(ctx, msg),
  messages,
});
beforeEach(() => {
  rows = new Map();
  const state: BotStateStore = {
    get: jest.fn(async (k: string) => rows.get(k)),
    put: jest.fn(async (k: string, v: string) => {
      rows.set(k, v);
    }),
    del: jest.fn(async () => {}),
    batch: jest.fn(async () => {}),
    sublevel: () => state,
  };
  ctx = {
    botId: "qwen",
    address: local.address,
    subject: subject(local),
    networkTag: "MONT",
    relayBaseUrl: "http://localhost.invalid",
    provider: {} as BotContext["provider"],
    state,
    subscriptions: {
      subscribe: jest.fn(async () => true),
      unsubscribe: jest.fn(async () => true),
      isSubscribed: jest.fn(async () => false),
      listSubscribers: jest.fn(async () => [peer.address]),
      broadcast: jest.fn(async () => ({ sent: 1, failed: 0 })),
      handleSubscriptionCommand: jest.fn(async () => null),
    },
    lookupPeer: jest.fn(),
    sendMessage: jest.fn(async () => receipt),
    sendDirectMessage: jest.fn(async () => receipt),
    onNewUserRegistered: jest.fn(),
    sendTransfer: jest.fn(),
    sendTransaction: jest.fn(),
    buildAndSignTransfer: jest.fn(),
    waitForReceipt: jest.fn(),
    getBalance: jest.fn(),
    stopping: new AbortController().signal,
  };
  msg = {
    conversationId: thread,
    peerAddress: peer.address,
    peerSubject: subject(peer),
    timestampMs: 1,
    payloadDigest: "bb".repeat(32),
    items: [{ type: "text", text: "hello" }],
    reply: jest.fn(async () => receipt),
  };
  generator = jest.fn(async (_prompt: QwenChatMessage[]) => ({
    content: "answer",
    reasoning: "not stored",
  }));
  bot = new QwenBot({
    generator: { mode: "stub", describe: () => "fixture", reply: generator },
    retryDelayMs: 1,
  });
});
afterEach(() => jest.restoreAllMocks());

const text = (value: string): PreparedReply => ({
  kind: "prepared-reply",
  text: value,
});
const stored = (context = ctx, message = msg) => {
  const raw = rows.get(key(context, message));
  return raw === undefined ? undefined : JSON.parse(raw);
};

it("keeps its profile and newsletter, and answers a subscription command or an empty message with a stored reply, not a send of its own", async () => {
  expect(bot.getProfile().name).toBe("Qwen");
  expect(bot.schedules).toHaveLength(1);
  // No reply budget of its own: a person chatting is never cut off.
  expect((bot as { maxRepliesPerPeer?: number }).maxRepliesPerPeer).toBeUndefined();
  (ctx.subscriptions.handleSubscriptionCommand as jest.Mock).mockResolvedValueOnce(
    [{ type: "text", text: "subscribed" }]
  );
  expect(await bot.onMessage(msg, ctx)).toEqual(text("subscribed"));
  expect(
    await bot.onMessage({ ...msg, items: [{ type: "stamp" } as never] }, ctx)
  ).toEqual(text("Hello! I am Qwen. How can I help you today?"));
  expect(msg.reply).not.toHaveBeenCalled();
  expect(generator).not.toHaveBeenCalled();
  expect(ctx.state.put).not.toHaveBeenCalled();
  expect(await bot.sendDailyNewsletter(ctx)).toEqual({ sent: 1, failed: 0 });
});

it("returns the model's answer and remembers the turn, keeping the latest ten pairs", async () => {
  expect(await bot.onMessage(msg, ctx)).toEqual(text("answer"));
  expect(generator).toHaveBeenCalledWith(
    [{ role: "user", content: "hello" }],
    expect.objectContaining({ signal: ctx.stopping })
  );
  expect(stored()).toEqual(
    record([
      { role: "user", content: "hello" },
      { role: "assistant", content: "answer" },
    ])
  );
  rows.set(
    key(ctx, msg),
    JSON.stringify(
      record(Array.from({ length: 10 }, (_, i) => pair("old" + i)).flat())
    )
  );
  await bot.onMessage(msg, ctx);
  expect(generator.mock.calls[1][0]).toHaveLength(21);
  const kept = stored().messages;
  expect(kept).toHaveLength(20);
  expect(kept[0].content).toBe("old1");
  expect(kept.slice(-2).map((m: { content: string }) => m.content)).toEqual([
    "hello",
    "answer",
  ]);
  expect(msg.reply).not.toHaveBeenCalled();
});

it.each([
  ["thread", () => ({ message: { ...msg, conversationId: threadB } })],
  [
    "peer",
    () => ({
      message: {
        ...msg,
        peerAddress: other.address,
        peerSubject: subject(other),
      },
    }),
  ],
  [
    "local",
    () => ({
      context: { ...ctx, address: other.address, subject: subject(other) },
    }),
  ],
  ["network", () => ({ context: { ...ctx, networkTag: "MON1" as const } })],
])("keeps history apart by %s in the same store", async (_label, change) => {
  await bot.onMessage(msg, ctx);
  const { message = msg, context = ctx } = change() as {
    message?: BotMessageContext;
    context?: BotContext;
  };
  await bot.onMessage(message, context);
  expect(generator.mock.calls[1][0]).toEqual([
    { role: "user", content: "hello" },
  ]);
  expect(key(context, message)).not.toBe(key(ctx, msg));
  expect(stored(context, message).messages).toHaveLength(2);
  expect(stored().messages).toHaveLength(2);
});

// The default thread carries no conversation ID on the wire. On 05c93db0 such a message was
// refused outright ("history admission held") and never answered.
it("keys the history of a message with no conversation ID by the peer, and remembers it across messages", async () => {
  const bare = { ...msg, conversationId: undefined };
  const defaultKey =
    "qwen-history:v1:" +
    JSON.stringify(["monad-testnet", ctx.subject, msg.peerSubject, "default"]);
  expect(await bot.onMessage(bare, ctx)).toEqual(text("answer"));
  await bot.onMessage(
    { ...bare, items: [{ type: "text", text: "and then?" }] },
    ctx
  );
  expect(generator.mock.calls[1][0]).toEqual([
    { role: "user", content: "hello" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "and then?" },
  ]);
  expect(JSON.parse(rows.get(defaultKey)!).messages).toHaveLength(4);
  // An explicit conversation with the same peer, and another peer's default thread, are apart.
  await bot.onMessage(msg, ctx);
  await bot.onMessage(
    { ...bare, peerAddress: other.address, peerSubject: subject(other) },
    ctx
  );
  for (const call of generator.mock.calls.slice(2))
    expect(call[0]).toEqual([{ role: "user", content: "hello" }]);
  expect([...rows.keys()]).toHaveLength(3);
});

it("asks the model again after a failure, with a short wait, and answers once", async () => {
  generator
    .mockRejectedValueOnce(new Error("Request failed with status code 500"))
    .mockResolvedValueOnce({ content: "   " })
    .mockResolvedValue({ content: "third time" });
  jest.spyOn(console, "warn").mockImplementation(() => {});
  expect(await bot.onMessage(msg, ctx)).toEqual(text("third time"));
  expect(generator).toHaveBeenCalledTimes(3);
  expect(stored().messages[1].content).toBe("third time");
});

it.each([
  ["rejects", () => Promise.reject(new Error("socket hang up"))],
  ["answers nothing", async () => ({ content: "" })],
  ["answers a non-string", async () => ({ content: 7 })],
  ["answers malformed text", async () => ({ content: "\ud800" })],
  [
    "answers more than a message can carry",
    async () => ({ content: "x".repeat(MAX_TEXT_STRING_BYTES + 1) }),
  ],
])(
  "returns the plain failure reply when the model %s on every try, and remembers nothing",
  async (_label, result) => {
    generator.mockImplementation(result as never);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(await bot.onMessage(msg, ctx)).toEqual(text(MODEL_FAILED_TEXT));
    expect(generator).toHaveBeenCalledTimes(3);
    expect(ctx.state.put).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(3);
  }
);

it("makes as many model calls as configured, and none once the host is stopping", async () => {
  generator.mockRejectedValue(new Error("down"));
  jest.spyOn(console, "warn").mockImplementation(() => {});
  const once = new QwenBot({
    generator: { mode: "stub", describe: () => "fixture", reply: generator },
    modelTries: 1,
  });
  expect(await once.onMessage(msg, ctx)).toEqual(text(MODEL_FAILED_TEXT));
  expect(generator).toHaveBeenCalledTimes(1);
  const stopped = new AbortController();
  generator.mockImplementation(async () => {
    stopped.abort();
    throw new Error("aborted");
  });
  await bot.onMessage(msg, { ...ctx, stopping: stopped.signal });
  expect(generator).toHaveBeenCalledTimes(2);
});

it("does not log what the provider answered, only the error's message", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  generator.mockRejectedValue(
    Object.assign(new Error("Request failed with status code 401"), {
      response: { data: "SECRET-BODY", config: { headers: "Bearer KEY" } },
    })
  );
  await bot.onMessage(msg, ctx);
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(/SECRET-BODY|KEY/);
});

it("gives the generator its own copy of the prompt", async () => {
  generator.mockImplementation(async (prompt: QwenChatMessage[]) => {
    prompt[0].content = "rewritten";
    return { content: "answer" };
  });
  await bot.onMessage(msg, ctx);
  expect(stored().messages[0].content).toBe("hello");
});

it.each([
  ["a malformed conversation ID", () => ({ ...msg, conversationId: "conv-1" })],
  ["a peer key that is not the peer's", () => ({ ...msg, peerSubject: subject(other) })],
  ["its own key as the peer", () => ({ ...msg, peerAddress: local.address, peerSubject: subject(local) })],
])("refuses %s before any model call or write", async (_label, change) => {
  await expect(bot.onMessage(change() as BotMessageContext, ctx)).rejects.toThrow(
    /held/
  );
  expect(generator).not.toHaveBeenCalled();
  expect(ctx.state.put).not.toHaveBeenCalled();
});

it.each([
  ["not JSON", () => "{"],
  ["another conversation's record", () => JSON.stringify({ ...record(), scope: ["x", "y", "z", "w"] })],
  ["an odd number of turns", () => JSON.stringify(record(pair().slice(0, 1)))],
  ["larger than a history record may be", () => "x".repeat(MAX_DIRECT_MESSAGE_FRAME_BYTES + 1)],
])(
  "refuses stored history that is %s, leaving it as it is",
  async (_label, raw) => {
    const bytes = raw();
    rows.set(key(ctx, msg), bytes);
    await expect(bot.onMessage(msg, ctx)).rejects.toThrow(/held/);
    expect(generator).not.toHaveBeenCalled();
    expect(rows.get(key(ctx, msg))).toBe(bytes);
  }
);

it("accepts multibyte input and output at the text limit", async () => {
  const big = "é".repeat(MAX_TEXT_STRING_BYTES / 2);
  generator.mockResolvedValue({ content: big });
  expect(
    await bot.onMessage({ ...msg, items: [{ type: "text", text: big }] }, ctx)
  ).toEqual(text(big));
});

// On 05c93db0 the class fell back to stub echo replies when the model variables were missing.
describe("model configuration", () => {
  let environment: NodeJS.ProcessEnv;
  beforeEach(() => {
    environment = process.env;
    process.env = { PATH: environment.PATH };
    jest.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    process.env = environment;
  });

  it("is a startup error naming the missing variables, never a silent stub", () => {
    expect(() => new QwenBot()).toThrow(
      /QWEN_API_KEY and QWEN_OPENAI_COMPATIBLE_ENDPOINT/
    );
    process.env.QWEN_API_KEY = "k";
    expect(() => new QwenBot()).toThrow(/QWEN_OPENAI_COMPATIBLE_ENDPOINT/);
    expect(() => new QwenBot()).not.toThrow(/QWEN_API_KEY and/);
  });

  it("is the offline stub only when asked for, and says so", async () => {
    process.env.QWEN_BOT_MODE = "stub";
    const stub = new QwenBot();
    expect((await stub.onMessage(msg, ctx)).text).toMatch(/^\[STUB/);
    expect(
      (await new QwenBot({ config: { mode: "stub" } }).onMessage(msg, ctx)).text
    ).toMatch(/^\[STUB/);
  });

  it("is live with both variables set", () => {
    process.env.QWEN_API_KEY = "k";
    process.env.QWEN_OPENAI_COMPATIBLE_ENDPOINT = "http://model.invalid/v1";
    const log = console.log as jest.Mock;
    new QwenBot();
    expect(String(log.mock.calls[0][0])).toMatch(
      /LIVE mode.*timeout 45000 ms, thinking off/
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('"k"');
  });
});
