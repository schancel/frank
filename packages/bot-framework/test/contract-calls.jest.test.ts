/**
 * `botContractCallsOf` is an adapter: what a bot passes to `send` reaches the wallet's
 * `sendContractCall` as the wallet names it. The wallet here records its arguments only; the
 * wallet's own handling (the main-account wait, the journal) is exercised on a real node in
 * `packages/bot/src/bots/table-htlc.anvil.jest.test.ts`.
 */
import { botContractCallsOf } from "../src/contract-calls";

const HTLC = "0x" + "12".repeat(20);
const MAIN = "0x" + "34".repeat(20);

function recordingWallet() {
  const calls: unknown[] = [];
  const wallet = {
    chainIdentifier: "monad-testnet",
    sendContractCall: async (params: unknown) => {
      calls.push(params);
      return { operationId: "op-1", txHash: "0x" + "ab".repeat(32) };
    },
    getContractCallFunds: async () => ({ mainAddress: MAIN, mainBalance: 0n, otherBalance: 0n, mainBusy: false }),
    resumeNativeOperation: async () => undefined,
  };
  return { wallet, calls };
}

const call = {
  to: HTLC,
  data: "0x1234",
  value: 0n,
  record: { kind: "table-htlc", action: "distribute", game: "poker", tableId: "00".repeat(16), lockIds: [] },
} as const;

describe("botContractCallsOf", () => {
  it("hands the wallet the bot's main-account wait, so a busy account gives up instead of holding the bot", async () => {
    const { wallet, calls } = recordingWallet();
    const contractCalls = botContractCallsOf(wallet as never, () => HTLC)!;
    await contractCalls.send({ ...call, record: { ...call.record, lockIds: [] }, deadline: 99, mainAccountWaitMs: 10_000 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ to: { raw: HTLC }, data: "0x1234", deadline: 99, mainAccountWaitMs: 10_000 });
  });

  it("names no wait when the bot names none: the wallet's own default applies", async () => {
    const { wallet, calls } = recordingWallet();
    await botContractCallsOf(wallet as never, () => HTLC)!.send({ ...call, record: { ...call.record, lockIds: [] } });
    expect(calls[0]).not.toHaveProperty("mainAccountWaitMs");
  });
});
