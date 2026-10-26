/**
 * The user's reconcile pass (`reconcileEvmWallet`): it reads the whole mailbox again and finds a
 * stealth-asset payment the wallet's earlier reads missed, walks the seed, reads journal
 * operations, and reports what it found. It is idempotent, signs and broadcasts nothing, and
 * concurrent calls share one run. Only the node (the provider's JSON-RPC methods) and the
 * relay's mailbox answer are stubbed; the wallet, its stores and the item codec are real.
 */
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { getBytes, keccak256, Transaction, Wallet } from "ethers";
import vectors from "../../domain-roots/vectors/domain-roots-v1.json";
import type { DomainPurpose, DomainRoot } from "../../domain-roots/src";
import { validateFrame, standaloneItemBudget } from "@frank/codec";
import type {
  MessageItem,
  RecipientAssetPaymentItem,
} from "@frank/cashweb/types/messages";
import type { DirectMessageReceived, MonadRootBundle } from "./active-chain";
import { createEvmChain, reconcileEvmWallet } from "./evm-chain";
import { evmWalletInternals } from "../evm-wallet";
import type { EvmChainConfig } from "./evm-chain-config";
import type { EvmChainWalletHandle } from "../evm-wallet-handle";
import { InMemoryNativeTransactionAttemptStore } from "./chain-wallet";
import { fixedStampDefault } from "../oracle/stamp-policy.testutil";
import { deriveEvmStealthAddress } from "../evm-stealth";
import {
  decodeRecipientAssetPaymentItem,
  encodeRecipientAssetPaymentItem,
} from "../message-item-plugins/stealth-asset/codec";

jest.setTimeout(30_000);

const MAIN = "0x4669eff913a3c595cea5fa92a600201e8e9e75d8";
const senders = [1, 2, 3, 4].map((i) => new Wallet("0x" + `4${i}`.repeat(32)));
const contact = new Wallet("0x" + "32".repeat(32));
const stranger = new Wallet("0x" + "33".repeat(32));

function roots(): MonadRootBundle {
  const root = <P extends DomainPurpose>(purpose: P): DomainRoot<P> => ({
    registry: "frank-domain-roots-v1",
    purpose,
    bytes: getBytes("0x" + vectors.vectors[0].outputs[purpose]),
  });
  return {
    evm: root("evm-wallet"),
    authentication: root("identity-authentication"),
    messaging: root("messaging-encryption"),
  };
}

/** The node: balances, nonces and receipts of the transactions it was handed. */
function node(wallet: EvmChainWalletHandle) {
  const balances = new Map<string, bigint>([[MAIN, 0n]]);
  const nonces = new Map<string, number>();
  const txs = new Map<string, ReturnType<typeof Transaction.from>>();
  const receipts = new Map<string, object>();
  const blockHash = "0x" + "ab".repeat(32);
  const provider = wallet.provider;
  jest
    .spyOn(provider, "getBlock")
    .mockImplementation(async () => ({ hash: blockHash, number: 1 } as never));
  jest.spyOn(provider, "getBlockNumber").mockResolvedValue(1);
  jest
    .spyOn(provider, "getBalance")
    .mockImplementation(
      async (address) => balances.get(String(address).toLowerCase()) ?? 0n
    );
  jest
    .spyOn(provider, "getTransactionCount")
    .mockImplementation(
      async (address) => nonces.get(String(address).toLowerCase()) ?? 0
    );
  jest.spyOn(provider, "getFeeData").mockResolvedValue({
    gasPrice: 1n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
  } as never);
  jest.spyOn(provider, "estimateGas").mockResolvedValue(21000n);
  jest
    .spyOn(provider, "getTransaction")
    .mockImplementation(async (hash) => (txs.get(hash) as never) ?? null);
  jest
    .spyOn(provider, "getTransactionReceipt")
    .mockImplementation(async (hash) => (receipts.get(hash) as never) ?? null);
  function mine(raw: string) {
    const tx = Transaction.from(raw),
      from = tx.from!.toLowerCase(),
      to = tx.to!.toLowerCase();
    if (receipts.has(tx.hash!)) return;
    nonces.set(from, tx.nonce + 1);
    balances.set(from, (balances.get(from) ?? 0n) - tx.gasLimit - tx.value);
    balances.set(to, (balances.get(to) ?? 0n) + tx.value);
    txs.set(
      tx.hash!,
      Object.assign(tx, { blockHash, blockNumber: 1, index: 0 })
    );
    receipts.set(tx.hash!, {
      hash: tx.hash,
      from,
      to,
      status: 1,
      blockHash,
      blockNumber: 1,
      index: 0,
      gasUsed: tx.gasLimit,
      gasPrice: 1n,
      logs: [],
    });
  }
  const broadcast = jest
    .spyOn(provider, "broadcastTransaction")
    .mockImplementation(async (raw) => {
      mine(raw);
      return { hash: keccak256(raw) } as never;
    });
  return { balances, nonces, txs, receipts, mine, broadcast };
}

let root: string,
  wallet: EvmChainWalletHandle,
  state: ReturnType<typeof node>,
  cfg: EvmChainConfig;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "frank-reconcile-"));
  cfg = {
    networkId: "monad-testnet",
    chainId: 10143,
    rpcChain: "monad-testnet",
    relayBaseUrl: "http://127.0.0.1:1",
    networkTag: "MONT",
    stampBurnAddress: "0x000000000000000000000000000000000000dEaD",
    resolveDefaultStamp: fixedStampDefault(1n),
    defaultTopicVoteValueWei: 1n,
    subAccountPoolSize: 2,
    walletStorageLocation: join(root, "wallet"),
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
  };
  wallet = (await createEvmChain(cfg).createWallet(
    roots()
  )) as EvmChainWalletHandle;
  state = node(wallet);
});

afterEach(async () => {
  await wallet.close();
  jest.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

/** A reload: the wallet is closed and opened again from its storage; the chain is kept. */
async function reopenWallet() {
  const old = state;
  await wallet.close();
  jest.restoreAllMocks();
  wallet = (await createEvmChain(cfg).createWallet(
    roots()
  )) as EvmChainWalletHandle;
  state = node(wallet);
  for (const field of ["balances", "nonces", "txs", "receipts"] as const)
    for (const [key, value] of old[field])
      (state[field] as Map<string, unknown>).set(key, value);
}

const transfer = (
  raw: string,
  ephemeralPubKey: Uint8Array,
  spendKey: string,
  chainIdentifier = "monad-testnet"
): RecipientAssetPaymentItem["transfers"][number] => {
  const tx = Transaction.from(raw);
  return {
    chainIdentifier,
    asset: { kind: "native" },
    txId: tx.hash!.slice(2),
    rawTx: raw.slice(2),
    destination: tx.to!.slice(2).toLowerCase(),
    amountAtomic: tx.value.toString(),
    derivationScheme: 1,
    recipientSpendKey: { keyType: 1, publicKey: spendKey.replace(/^0x/, "") },
    stealthMetadata: {
      keyType: 1,
      ephemeralPubKey: Buffer.from(ephemeralPubKey).toString("hex"),
    },
  };
};

/** The item as a recipient reads it: encoded and decoded with the canonical codec. */
function overTheWire(
  item: RecipientAssetPaymentItem
): RecipientAssetPaymentItem {
  const encoded = encodeRecipientAssetPaymentItem(item);
  const frame = validateFrame(encoded);
  if (frame.kind !== "parsed") throw new Error("Expected a canonical frame");
  return decodeRecipientAssetPaymentItem(encoded, {
    frame,
    budget: standaloneItemBudget(),
  });
}

function received(
  items: MessageItem[],
  payloadDigest: string
): DirectMessageReceived {
  return {
    senderAddress: { raw: contact.address },
    recipientAddress: { raw: wallet.identity.address.raw },
    items,
    payloadDigest,
    stampValueWei: 0n,
    stampPayments: [],
    receivedTime: Date.now(),
  };
}

/** A stealth send of `values` to this wallet, one signed transfer from each sender. */
async function stealthSend(values: readonly bigint[]) {
  const ownKey = wallet.identity.compressedPubKey;
  const derived = deriveEvmStealthAddress({ recipientSpendPubKey: ownKey });
  const raws = await Promise.all(
    values.map((value, i) =>
      senders[i]!.signTransaction({
        type: 2,
        chainId: 10143n,
        nonce: state.nonces.get(senders[i]!.address.toLowerCase()) ?? 0,
        to: derived.stealthAddress,
        value,
        gasLimit: 21000n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
      })
    )
  );
  const spendKey = Buffer.from(ownKey).toString("hex");
  return {
    address: derived.stealthAddress.toLowerCase(),
    raws,
    item: (extra: RecipientAssetPaymentItem["transfers"] = []) =>
      overTheWire({
        type: "stealth-asset",
        transfers: [
          ...raws.map((raw) =>
            transfer(raw, derived.ephemeralPubKey, spendKey)
          ),
          ...extra,
        ],
        memo: "for you",
      }),
  };
}


/** The relay's mailbox, as the wallet's canonical messaging reads it: every read from the start
 * returns what was delivered, which the wallet's own earlier reads may have passed by. */
function mailbox(messages: DirectMessageReceived[]) {
  const reads: number[] = [];
  evmWalletInternals(wallet).canonicalMessaging = {
    fetchSince: async ({ sinceMs }: { sinceMs: number }) => {
      reads.push(sinceMs);
      return messages.filter((m) => (m.receivedTime ?? 0) >= sinceMs);
    },
  } as never;
  return reads;
}

test("finds a stealth-asset payment the wallet missed, signs and sends nothing, and a second run finds nothing new", async () => {
  const payment = await stealthSend([600n, 400n]);
  for (const raw of payment.raws) state.mine(raw);
  const message = received([payment.item()], "f6".repeat(32));
  const reads = mailbox([
    received([{ type: "text", text: "hello" } as MessageItem], "f7".repeat(32)),
    message,
  ]);
  const signed = jest.spyOn(wallet.mainAccount, "signTransaction");
  const operationsBefore = wallet.getNativeOperations!().length;
  expect(wallet.getReceivedPayments!()).toEqual([]);

  const steps: string[] = [];
  const summary = await reconcileEvmWallet(wallet, (progress) =>
    steps.push(progress.step)
  );

  expect(reads[0]).toBe(0);
  expect(summary).toMatchObject({
    chainIdentifier: "monad-testnet",
    messagesRead: 2,
    mailboxComplete: true,
    failures: [],
  });
  expect(summary.receivedCoinsAdded).toEqual([
    expect.objectContaining({ address: payment.address, claimedAmountWei: "1000" }),
  ]);
  expect(new Set(steps)).toEqual(new Set(["mailbox", "seed", "operations"]));
  expect(
    wallet.getReceivedPayments!().find((p) => p.address === payment.address)
  ).toBeDefined();
  // Read and record only: nothing signed, nothing handed to the node, no operation started.
  expect(state.broadcast).not.toHaveBeenCalled();
  expect(signed).not.toHaveBeenCalled();
  expect(wallet.getNativeOperations!().length).toBe(operationsBefore);

  const again = await reconcileEvmWallet(wallet);
  expect(again).toMatchObject({
    messagesRead: 2,
    receivedCoinsAdded: [],
    receivedCoinsChanged: 0,
    accountsAdded: [],
    operationsChanged: [],
    failures: [],
  });
  expect(
    wallet.getReceivedPayments!().filter((p) => p.address === payment.address)
  ).toHaveLength(1);
  expect(state.broadcast).not.toHaveBeenCalled();

  // The ordinary wallet then counts it once the chain shows it, as for any received payment.
  expect((await wallet.getBalanceParts!()).received).toBe(1000n);
});

test("concurrent calls share one run, and a failing mailbox read is reported while the other steps still run", async () => {
  const reads = mailbox([]);
  const [first, second] = [reconcileEvmWallet(wallet), reconcileEvmWallet(wallet)];
  expect(await first).toBe(await second);
  expect(reads).toEqual([0]);

  evmWalletInternals(wallet).canonicalMessaging = {
    fetchSince: async () => {
      throw new Error("relay unreachable");
    },
  } as never;
  const summary = await reconcileEvmWallet(wallet);
  expect(summary.mailboxComplete).toBe(false);
  expect(summary.failures).toEqual([
    { step: "mailbox", message: "relay unreachable" },
  ]);
  // The seed walk still read the chain.
  expect(jest.mocked(wallet.provider.getTransactionCount)).toHaveBeenCalled();
});

test("reads a signed operation from the chain and records it, without broadcasting it", async () => {
  const payment = await stealthSend([30000n, 30000n]);
  for (const raw of payment.raws) state.mine(raw);
  mailbox([received([payment.item()], "c3".repeat(32))]);
  await reconcileEvmWallet(wallet);
  // The ordinary balance read verifies the found coins on chain before they can be spent.
  expect((await wallet.getBalanceParts!()).received).toBe(60000n);
  // Signed here and never handed to anyone: the pass must not broadcast it.
  await wallet.stealthPayments!.prepare({
    operationId: "spend-received",
    chainIdentifier: "monad-testnet",
    asset: { kind: "native" },
    recipientSpendPublicKey: getBytes(contact.signingKey.compressedPublicKey),
    amountAtomic: 5000n,
    maxNativeFeeAtomic: 42000n,
  });
  const signedOperations = () =>
    wallet.getNativeOperations!().filter(
      (row) => row.kind === "transaction-set" && row.members.every((m) => m.signed)
    );
  expect(signedOperations()).toHaveLength(1);
  const broadcasts = state.broadcast.mock.calls.length;

  const summary = await reconcileEvmWallet(wallet);
  expect(summary.failures).toEqual([]);
  expect(summary.operationsObserved).toBe(1);
  // Read, not sent: a member that never left the wallet is "not yet sent", so nothing changes
  // and it is not exposed.
  expect(summary.operationsChanged).toEqual([]);
  expect(
    signedOperations()[0]!.members.map((member) => [member.observation.state, member.exposed ?? false])
  ).toEqual([["unknown", false]]);
  expect(state.broadcast.mock.calls.length).toBe(broadcasts);
  // Its reservation stands: the pass released nothing.
  expect(signedOperations()).toHaveLength(1);
  expect(wallet.getNativeOperations!()[0]!.cancelled).toBe(false);
});

test("a closed wallet refuses", async () => {
  await wallet.close();
  await expect(reconcileEvmWallet(wallet)).rejects.toThrow(/closed/);
  wallet = (await createEvmChain(cfg).createWallet(roots())) as EvmChainWalletHandle;
});
