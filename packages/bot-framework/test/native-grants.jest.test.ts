import { mkdir, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Wallet, Transaction, keccak256, type Provider } from "ethers";
import { NativeGrants } from "../src/native-grants";
import { LevelBotStateStore } from "../src/state-store";
import { EvmNativeOperationJournal } from "@frank/wallet/storage/evm-native-operation-journal";
import { EvmLegacyConsolidator } from "@frank/wallet/chain/evm-legacy-consolidator";
import { NativeEvmTransactionBuilder } from "@frank/wallet/chain/evm-transaction-builder";
import type { NativeWalletHandle } from "@frank/wallet/chain/chain-wallet";

const signer = new Wallet("0x" + "11".repeat(32));
const recipient = new Wallet("0x" + "22".repeat(32)).address.toLowerCase();
const other = new Wallet("0x" + "33".repeat(32)).address.toLowerCase();
const binding = {
  chainIdentifier: "monad-testnet",
  nativeChainId: "10143",
  publicTuple: "synthetic-faucet-test",
};
const request = { to: recipient, valueWei: 100_000n, minReserveWei: 20_000n };

/** Real durable wallet owner and bot LevelDB. Only the external chain is simulated; transactions
 * are actually built, signed, journalled and replayed by the production native executor. */
describe("durable faucet grant / native wallet boundary", () => {
  let directory: string;
  let state: LevelBotStateStore;
  let journal: EvmNativeOperationJournal;
  let owner: EvmLegacyConsolidator;
  let wallet: NativeWalletHandle;
  let grants: NativeGrants;
  let raws: string[];
  let recipientBalance: bigint;
  let nonce: number;
  let mine: boolean;
  let loseResponse: boolean;
  let receipts: Map<string, object>;
  let transactions: Map<string, object>;
  let signCount: number;
  let blockHash = "0x" + "aa".repeat(32);
  const provider = {
    getBlock: async () => ({ hash: blockHash, number: 1 }),
    getBalance: async (address: string) =>
      address.toLowerCase() === signer.address.toLowerCase()
        ? 10_000_000n
        : recipientBalance,
    getTransactionCount: async () => nonce,
    getFeeData: async () => ({
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      gasPrice: 1n,
    }),
    estimateGas: async () => 21_000n,
    call: async () => "0x",
    getTransaction: async (hash: string) => transactions.get(hash) ?? null,
    getTransactionReceipt: async (hash: string) => receipts.get(hash) ?? null,
    broadcastTransaction: async (raw: string) => {
      raws.push(raw);
      const tx = Transaction.from(raw);
      if (mine && !receipts.has(tx.hash!)) {
        nonce = tx.nonce + 1;
        recipientBalance += tx.value;
        transactions.set(
          tx.hash!,
          Object.assign(tx, { blockHash, blockNumber: 1, index: 0 })
        );
        receipts.set(tx.hash!, {
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          status: 1,
          blockHash,
          blockNumber: 1,
          index: 0,
          gasUsed: 21_000n,
          gasPrice: 1n,
        });
      }
      if (loseResponse) throw new Error("RPC response lost after handoff");
      return { hash: keccak256(raw) };
    },
  };

  async function open() {
    state = await LevelBotStateStore.open(join(directory, "bot"));
    await mkdir(join(directory, "wallet"), { recursive: true });
    journal = new EvmNativeOperationJournal({
      location: join(directory, "wallet"),
      binding,
    });
    await journal.Open();
    owner = new EvmLegacyConsolidator({
      journal,
      provider: provider as unknown as Provider,
      transactionBuilder: new NativeEvmTransactionBuilder(),
      getSources: async () => [
        {
          kind: "identity",
          address: signer.address.toLowerCase(),
          identityPublicKey: signer.signingKey.publicKey,
        },
      ],
      sign: async (_source, raw) => {
        signCount++;
        return signer.signTransaction(Transaction.from(raw));
      },
    });
    wallet = {
      family: "evm",
      chainIdentifier: binding.chainIdentifier,
      networkId: "testnet",
      identity: {
        address: { raw: signer.address },
        displayAddress: signer.address,
      },
      getReceiveAddress: async () => ({ raw: signer.address }),
      getBalance: async () => provider.getBalance(signer.address),
      getNativeOperations: () => owner.listOperations(),
      resumeNativeOperation: (id) => owner.resumeOperation(id),
      sendNative: (params) => owner.sendNative(params),
    };
    grants = new NativeGrants(state, wallet);
  }
  async function restart() {
    await state.close();
    await journal.Close();
    await open();
  }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "frank-faucet-recovery-"));
    blockHash = "0x" + "aa".repeat(32);
    raws = [];
    recipientBalance = 0n;
    nonce = 0;
    mine = true;
    loseResponse = false;
    receipts = new Map();
    transactions = new Map();
    signCount = 0;
    await open();
  });
  afterEach(async () => {
    await state.close();
    await journal.Close();
    await rm(directory, { recursive: true, force: true });
  });

  test("landed grant spent before restart never pays twice, even when response was lost", async () => {
    loseResponse = true;
    expect((await grants.grant(request)).state).toBe("pending");
    expect(recipientBalance).toBe(request.valueWei);
    recipientBalance = 0n; // The customer's current balance is NOT completion evidence.
    await restart();
    loseResponse = false;
    expect(await grants.grant(request)).toMatchObject({
      state: "confirmed",
      already: true,
    });
    expect(signCount).toBe(1);
    expect(raws).toHaveLength(1);
    expect(journal.list()).toHaveLength(1);
  });

  test("unknown transaction after lost handoff replays the original signed bytes after restart", async () => {
    mine = false;
    loseResponse = true;
    await grants.grant(request);
    const original = raws[0];
    await restart();
    loseResponse = false;
    await grants.resume();
    expect(raws).toEqual([original, original]);
    expect(signCount).toBe(1);
    expect(journal.list()).toHaveLength(1);
  });

  test("crash after signing before business binding adopts the wallet's original operation", async () => {
    const real = state.durableBatch.bind(state);
    jest.spyOn(state, "durableBatch").mockImplementation(async (ops) => {
      const value =
        ops[0]?.type === "put" ? JSON.parse(ops[0].value) : undefined;
      if (value?.operationId !== null)
        throw new Error("crash before binding durable write");
      await real(ops);
    });
    await expect(grants.grant(request)).rejects.toThrow("crash before binding");
    expect(raws).toHaveLength(0);
    expect(signCount).toBe(1);
    expect(journal.list()[0]!.members[0]!.signed).not.toBeNull();
    await restart();
    await grants.grant(request);
    expect(raws).toHaveLength(1);
    expect(signCount).toBe(1);
    expect(journal.list()).toHaveLength(1);
  });

  test("crash after durable binding but before exposure resumes exactly that operation", async () => {
    const send = wallet.sendNative;
    wallet.sendNative = (params) =>
      send({
        ...params,
        onSigned: async (signed) => {
          await params.onSigned!(signed);
          throw new Error("crash after binding before exposure");
        },
      });
    expect((await grants.grant(request)).state).toBe("pending");
    expect(raws).toHaveLength(0);
    expect(signCount).toBe(1);
    await restart();
    await grants.grant(request);
    expect(raws).toHaveLength(1);
    expect(signCount).toBe(1);
    expect(journal.list()).toHaveLength(1);
  });

  test("a reverted original grant remains failed and never authorizes a replacement", async () => {
    await grants.grant(request);
    const hash = keccak256(raws[0]!);
    receipts.set(hash, { ...receipts.get(hash), status: 0 });
    await restart();
    expect((await grants.grant(request)).state).toBe("failed");
    expect(signCount).toBe(1);
    expect(raws).toHaveLength(1);
  });

  test("failure to persist intent prevents even signing", async () => {
    jest
      .spyOn(state, "durableBatch")
      .mockRejectedValue(new Error("disk unavailable"));
    await expect(grants.grant(request)).rejects.toThrow("disk unavailable");
    expect(signCount).toBe(0);
    expect(raws).toHaveLength(0);
    expect(journal.list()).toHaveLength(0);
  });

  test("crash with intent but no wallet operation retries only its original authorization", async () => {
    const originalSend = wallet.sendNative;
    wallet.sendNative = async () => {
      throw new Error("crash before wallet planning");
    };
    await expect(grants.grant(request)).rejects.toThrow("crash before wallet");
    wallet.sendNative = originalSend;
    await restart();
    await grants.grant(request);
    expect(signCount).toBe(1);
    expect(raws).toHaveLength(1);
  });

  test("concurrent duplicate requests have one operation and distinct recipients remain independent", async () => {
    await Promise.all([
      grants.grant(request),
      grants.grant(request),
      grants.grant({ ...request, to: other }),
    ]);
    expect(journal.list()).toHaveLength(2);
    expect(signCount).toBe(2);
    expect(new Set(raws).size).toBe(2);
  });

  test("changed authorization and foreign chain fail before another payment", async () => {
    await grants.grant(request);
    await expect(
      grants.grant({ ...request, valueWei: request.valueWei + 1n })
    ).rejects.toThrow("authorization changed");
    wallet = { ...wallet, chainIdentifier: "monad-mainnet" };
    await expect(
      new NativeGrants(state, wallet).grant(request)
    ).rejects.toThrow("foreign faucet");
    expect(signCount).toBe(1);
    expect(raws).toHaveLength(1);
  });

  test.each([1, 0])(
    "rechecks an orphaned cached receipt (status %s) and replays only original bytes",
    async (status) => {
      await grants.grant(request);
      const original = raws[0]!;
      const hash = keccak256(original);
      receipts.set(hash, { ...receipts.get(hash), status });
      expect((await grants.grant(request)).state).toBe(
        status === 1 ? "confirmed" : "failed"
      );
      expect(journal.list()[0]!.members[0]!.observation.state).toBe(
        status === 1 ? "included-success" : "included-revert"
      );
      // The old block is orphaned. Neither the receipt nor transaction remains canonical.
      receipts.clear();
      transactions.clear();
      nonce = 0;
      recipientBalance = 0n;
      blockHash = "0x" + "bb".repeat(32);
      mine = false;
      await restart();
      const result = await grants.grant(request);
      expect(["confirmed", "failed"]).not.toContain(result.state);
      expect(raws).toEqual([original, original]);
      expect(signCount).toBe(1);
      expect(journal.list()).toHaveLength(1);
    }
  );

  test("caller mutation cannot change an already authorized grant", async () => {
    const mutable = { ...request };
    const pending = grants.grant(mutable);
    mutable.valueWei *= 2n;
    mutable.to = other;
    await pending;
    expect(Transaction.from(raws[0]!).value).toBe(request.valueWei);
    expect(Transaction.from(raws[0]!).to!.toLowerCase()).toBe(recipient);
  });

  test("corrupt business state fails visibly, not as an empty grant", async () => {
    await state.put(`grant:${recipient}`, "pending");
    await expect(grants.grant(request)).rejects.toThrow("Invalid faucet grant");
    expect(signCount).toBe(0);
    expect(raws).toHaveLength(0);
  });
});
