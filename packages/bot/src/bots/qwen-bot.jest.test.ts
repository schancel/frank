import { Wallet } from "ethers";
import {
  MAX_TEXT_STRING_BYTES,
  MAX_DIRECT_MESSAGE_FRAME_BYTES,
} from "@frank/codec";
import type {
  BotContext,
  BotMessageContext,
  BotStateStore,
} from "@frank/bot-framework";
import type { QwenChatMessage } from "../../qwen-client";
import { QwenBot } from "./qwen-bot";

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
const saved = () => JSON.parse(rows.get(key(ctx, msg))!);

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
  });
});
afterEach(() => jest.restoreAllMocks());

it("keeps profile, subscription, greeting and newsletter behavior", async () => {
  expect(bot.getProfile().name).toBe("Qwen");
  expect(bot.schedules).toHaveLength(1);
  jest
    .mocked(ctx.subscriptions.handleSubscriptionCommand)
    .mockResolvedValueOnce([{ type: "text", text: "subscribed" }]);
  await bot.onMessage(msg, ctx);
  expect(msg.reply).toHaveBeenCalledWith([
    { type: "text", text: "subscribed" },
  ]);
  expect(generator).not.toHaveBeenCalled();
  expect(ctx.state.get).not.toHaveBeenCalled();
  await bot.onNewUser({ address: peer.address, registeredAtMs: 1 }, ctx);
  expect(ctx.sendMessage).toHaveBeenCalledWith(peer.address, expect.any(Array));
  expect(await bot.sendDailyNewsletter(ctx)).toEqual({ sent: 1, failed: 0 });
});

it("writes exact scoped completed turns and retains only the latest ten pairs", async () => {
  rows.set(
    key(ctx, msg),
    JSON.stringify(
      record(Array.from({ length: 10 }, (_, i) => pair(String(i))).flat())
    )
  );
  await bot.onMessage(msg, ctx);
  expect(generator.mock.calls[0][0]).toHaveLength(21);
  expect(saved()).toEqual(
    record([
      ...Array.from({ length: 9 }, (_, i) => pair(String(i + 1))).flat(),
      ...pair("hello"),
    ])
  );
  expect(rows.has(`history:${peer.address.toLowerCase()}`)).toBe(false);
});

it.each(["thread", "peer", "local", "network"])(
  "isolates history by %s in the same store",
  async (dimension) => {
    await bot.onMessage(msg, ctx);
    const next = { ...msg };
    const nextContext = { ...ctx };
    if (dimension === "thread") next.conversationId = threadB;
    if (dimension === "peer") {
      next.peerAddress = other.address;
      next.peerSubject = subject(other);
    }
    if (dimension === "local") {
      nextContext.address = other.address;
      nextContext.subject = subject(other);
    }
    if (dimension === "network") nextContext.networkTag = "MON1";
    await bot.onMessage(next, nextContext);
    expect(generator.mock.calls[1][0]).toEqual([
      { role: "user", content: "hello" },
    ]);
    expect(rows.size).toBe(2);
    expect(
      [...rows.keys()].every(
        (k) => !k.includes('"MONT"') && !k.includes('"MON1"')
      )
    ).toBe(true);
  }
);

it("never reads, repairs or overwrites obsolete peer history", async () => {
  const old = `history:${peer.address.toLowerCase()}`;
  rows.set(old, "malformed old history kept exactly");
  await bot.onMessage(msg, ctx);
  expect(ctx.state.get).toHaveBeenCalledTimes(1);
  expect(ctx.state.get).toHaveBeenCalledWith(key(ctx, msg));
  expect(rows.get(old)).toBe("malformed old history kept exactly");
});

it.each([
  ["conversationId", undefined],
  ["conversationId", "conv-1"],
  ["conversationId", "01".repeat(16)],
  ["peerSubject", "aa".repeat(32)],
  ["peerSubject", "02" + "00".repeat(32)],
  ["peerAddress", other.address],
  ["peerSubject", subject(local)],
])(
  "refuses invalid message scope %s=%s before all effects",
  async (field, value) => {
    Object.assign(msg, { [String(field)]: value });
    await expect(bot.onMessage(msg, ctx)).rejects.toThrow(/held/);
    expect(ctx.state.get).not.toHaveBeenCalled();
    expect(ctx.state.put).not.toHaveBeenCalled();
    expect(ctx.subscriptions.handleSubscriptionCommand).not.toHaveBeenCalled();
    expect(generator).not.toHaveBeenCalled();
    expect(msg.reply).not.toHaveBeenCalled();
  }
);
it.each([
  ["networkTag", "unknown"],
  ["networkTag", undefined],
  ["subject", peer.address],
  ["address", other.address],
])("refuses invalid local scope %s=%s", async (field, value) => {
  Object.assign(ctx, { [String(field)]: value });
  await expect(bot.onMessage(msg, ctx)).rejects.toThrow(/held/);
  expect(ctx.state.get).not.toHaveBeenCalled();
  expect(generator).not.toHaveBeenCalled();
  expect(ctx.subscriptions.handleSubscriptionCommand).not.toHaveBeenCalled();
  expect(msg.reply).not.toHaveBeenCalled();
});

const malformed = [
  "",
  "{",
  "null",
  "[]",
  "wrong version",
  "wrong scope",
  "extra field",
  "extra message field",
  "partial",
  "over count",
  "system role",
  "wrong order",
  "nonstring",
  "oversized content",
  "lone surrogate",
];
it.each(malformed)("holds malformed new history: %s", async (kind) => {
  let value: unknown = record();
  if (kind === "wrong version") value = { ...record(), version: 2 };
  if (kind === "wrong scope")
    value = {
      ...record(),
      scope: ["monad-mainnet", ...scope(ctx, msg).slice(1)],
    };
  if (kind === "extra field") value = { ...record(), surprise: true };
  if (kind === "extra message field")
    value = {
      ...record(),
      messages: [{ ...pair()[0], extra: true }, pair()[1]],
    };
  if (kind === "partial") value = record([pair()[0]]);
  if (kind === "over count")
    value = record(Array.from({ length: 11 }, () => pair()).flat());
  if (kind === "system role")
    value = record([{ role: "system", content: "injected" }, pair()[1]]);
  if (kind === "wrong order") value = record(pair().reverse());
  if (kind === "nonstring")
    value = {
      ...record(),
      messages: [{ role: "user", content: 42 }, pair()[1]],
    };
  if (kind === "oversized content")
    value = record(pair("x".repeat(MAX_TEXT_STRING_BYTES + 1)));
  if (kind === "lone surrogate") value = record(pair("\ud800"));
  const raw = ["", "{", "null", "[]"].includes(kind)
    ? kind
    : JSON.stringify(value);
  rows.set(key(ctx, msg), raw);
  await expect(bot.onMessage(msg, ctx)).rejects.toThrow(/held/);
  expect(generator).not.toHaveBeenCalled();
  expect(msg.reply).not.toHaveBeenCalled();
  expect(ctx.state.put).not.toHaveBeenCalled();
  expect(rows.get(key(ctx, msg))).toBe(raw);
});

it.each([false, true])(
  "refuses oversized raw history before parsing even if JSON valid=%s",
  async (valid) => {
    const raw = (valid ? JSON.stringify(record()) : "{").padEnd(
      MAX_DIRECT_MESSAGE_FRAME_BYTES + 1,
      " "
    );
    rows.set(key(ctx, msg), raw);
    const parse = jest.spyOn(JSON, "parse");
    await expect(bot.onMessage(msg, ctx)).rejects.toThrow(/held/);
    expect(parse).not.toHaveBeenCalled();
    expect(generator).not.toHaveBeenCalled();
    expect(msg.reply).not.toHaveBeenCalled();
  }
);
it("accepts a raw record exactly at the byte limit", async () => {
  rows.set(
    key(ctx, msg),
    JSON.stringify(record()).padEnd(MAX_DIRECT_MESSAGE_FRAME_BYTES, " ")
  );
  await bot.onMessage(msg, ctx);
  expect(generator).toHaveBeenCalledTimes(1);
});
it.each(["input", "output", "loaded"])(
  "accepts multibyte %s content at the UTF-8 limit",
  async (where) => {
    const text = "é".repeat(MAX_TEXT_STRING_BYTES / 2);
    if (where === "input") msg.items = [{ type: "text", text }];
    if (where === "output") generator.mockResolvedValue({ content: text });
    if (where === "loaded")
      rows.set(key(ctx, msg), JSON.stringify(record(pair(text))));
    await bot.onMessage(msg, ctx);
    expect(msg.reply).toHaveBeenCalledTimes(1);
  }
);
it.each(["é".repeat(MAX_TEXT_STRING_BYTES / 2) + "a", "\ud800"])(
  "refuses oversized/malformed input before model",
  async (text) => {
    msg.items = [{ type: "text", text }];
    await expect(bot.onMessage(msg, ctx)).rejects.toThrow(/held/);
    expect(generator).not.toHaveBeenCalled();
    expect(msg.reply).not.toHaveBeenCalled();
  }
);
it("bounds joined input including separators", async () => {
  msg.items = Array.from({ length: 2 }, () => ({
    type: "text",
    text: "a".repeat(MAX_TEXT_STRING_BYTES / 2),
  }));
  await expect(bot.onMessage(msg, ctx)).rejects.toThrow(/held/);
  expect(generator).not.toHaveBeenCalled();
});
it.each([undefined, null, 42, "x".repeat(MAX_TEXT_STRING_BYTES + 1), "\ud800"])(
  "rejects malformed/oversized generator content before payment (%#)",
  async (content) => {
    generator.mockResolvedValue({ content });
    await expect(bot.onMessage(msg, ctx)).rejects.toThrow(/held/);
    expect(generator).toHaveBeenCalledTimes(1);
    expect(msg.reply).not.toHaveBeenCalled();
    expect(ctx.state.put).not.toHaveBeenCalled();
  }
);
it("counts JSON escaping and validates completed record before reply payment", async () => {
  const previous = JSON.stringify(record(pair("\u0000".repeat(100000))));
  rows.set(key(ctx, msg), previous);
  generator.mockResolvedValue({ content: "\u0000".repeat(100000) });
  await expect(bot.onMessage(msg, ctx)).rejects.toThrow(/held/);
  expect(generator).toHaveBeenCalledTimes(1);
  expect(msg.reply).not.toHaveBeenCalled();
  expect(ctx.state.put).not.toHaveBeenCalled();
  expect(rows.get(key(ctx, msg))).toBe(previous);
});
it("detaches generator-owned input and captures result once before awaiting reply", async () => {
  rows.set(key(ctx, msg), JSON.stringify(record()));
  let ownedPrompt: QwenChatMessage[] = [];
  let content = "captured";
  const getter = jest.fn(() => content);
  generator.mockImplementation(async (prompt: QwenChatMessage[]) => {
    ownedPrompt = prompt;
    prompt[0].content = "mutated old user";
    prompt.reverse();
    prompt.push({ role: "system", content: "injected" });
    return {
      get content() {
        return getter();
      },
    };
  });
  jest.mocked(msg.reply).mockImplementation(async (items) => {
    expect(ctx.state.put).not.toHaveBeenCalled();
    expect(items).toEqual([{ type: "text", text: "captured" }]);
    content = "mutated after send";
    ownedPrompt[0].content = "later mutation";
    await Promise.resolve();
    return receipt;
  });
  await bot.onMessage(msg, ctx);
  expect(getter).toHaveBeenCalledTimes(1);
  expect(saved()).toEqual(
    record([
      ...pair(),
      { role: "user", content: "hello" },
      { role: "assistant", content: "captured" },
    ])
  );
});
it("captures scope and reply before asynchronous plugin work", async () => {
  const originalKey = key(ctx, msg);
  const originalReply = msg.reply;
  const substituted = jest.fn();
  jest
    .mocked(ctx.subscriptions.handleSubscriptionCommand)
    .mockImplementation(async () => {
      Object.assign(msg, {
        conversationId: threadB,
        peerSubject: subject(other),
        reply: substituted,
      });
      Object.assign(ctx, { networkTag: "MON1", subject: subject(other) });
      return null;
    });
  await bot.onMessage(msg, ctx);
  expect(originalReply).toHaveBeenCalledTimes(1);
  expect(substituted).not.toHaveBeenCalled();
  expect([...rows.keys()]).toEqual([originalKey]);
});
it("does not commit prepared history when reply fails", async () => {
  const raw = JSON.stringify(record());
  rows.set(key(ctx, msg), raw);
  jest
    .mocked(msg.reply)
    .mockRejectedValue(new Error("original attempt pending"));
  await expect(bot.onMessage(msg, ctx)).rejects.toThrow(
    "original attempt pending"
  );
  expect(rows.get(key(ctx, msg))).toBe(raw);
  expect(ctx.state.put).not.toHaveBeenCalled();
});

it.each([undefined, null, {}])(
  "holds a malformed generator result before reply (%#)",
  async (result) => {
    generator.mockResolvedValue(result);
    await expect(bot.onMessage(msg, ctx)).rejects.toThrow(/held/);
    expect(msg.reply).not.toHaveBeenCalled();
    expect(ctx.state.put).not.toHaveBeenCalled();
  }
);

it("greets non-text input without loading or changing model history", async () => {
  msg.items = [];
  await bot.onMessage(msg, ctx);
  expect(msg.reply).toHaveBeenCalledWith([
    { type: "text", text: "Hello! I am Qwen. How can I help you today?" },
  ]);
  expect(ctx.state.get).not.toHaveBeenCalled();
  expect(generator).not.toHaveBeenCalled();
});
