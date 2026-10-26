/**
 * A received `stealth-asset` item (what the app's stealth send writes) becomes coins in the
 * recipient's coin list at the mailbox boundary (`recordEvmReceivedCoins`, which every mailbox
 * read and the mailbox stream go through), is counted in the balance once the chain shows it,
 * survives a reopen, is not doubled by a repeated read, and can be spent. Only the node is
 * stubbed (the provider's JSON-RPC methods); the wallet, its stores and the item codec are real.
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
import { createEvmChain } from "./evm-chain";
import type { EvmChainConfig } from "./evm-chain-config";
import type { EvmChainWalletHandle } from "../evm-wallet-handle";
import { InMemoryNativeTransactionAttemptStore } from "./chain-wallet";
import { fixedStampDefault } from "../oracle/stamp-policy.testutil";
import { deriveEvmStealthAddress } from "../evm-stealth";
import { recordEvmReceivedCoins } from "../evm-received-coin-manager";
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
  root = await mkdtemp(join(tmpdir(), "frank-stealth-asset-rx-"));
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

// Every received payment here is above the payment floor (ten moves of 21,000 gas at the node's
// price of 1, 210,000): a smaller one would be held as too small to move, not counted.
const receivedPart = async () => (await wallet.getBalanceParts!()).received;

test("a received multi-transfer stealth payment is counted, survives a reload, and a repeated read does not double it", async () => {
  const payment = await stealthSend([500_000n, 500_000n, 500_000n, 500_000n]);
  for (const raw of payment.raws) state.mine(raw);
  const message = received(
    [{ type: "text", text: "for you" } as MessageItem, payment.item()],
    "a1".repeat(32)
  );

  await recordEvmReceivedCoins(wallet, [message]);
  expect(await receivedPart()).toBe(2_000_000n);
  const coin = () =>
    wallet.getReceivedPayments!().find((p) => p.address === payment.address);
  expect(coin()).toMatchObject({ status: "received", origin: "stealth" });
  expect(wallet.getMessagePayment!("a1".repeat(32))).toMatchObject({
    status: "received",
  });

  // The same message read again (a repeated mailbox read, the stream and the poll both): no-op.
  await recordEvmReceivedCoins(wallet, [message, message]);
  wallet.invalidateBalanceCache?.();
  expect(await receivedPart()).toBe(2_000_000n);
  expect(
    wallet.getReceivedPayments!().filter((p) => p.address === payment.address)
  ).toHaveLength(1);

  await reopenWallet();
  expect(coin()).toMatchObject({ status: "received" });
  expect(await receivedPart()).toBe(2_000_000n);
  await recordEvmReceivedCoins(wallet, [message]);
  wallet.invalidateBalanceCache?.();
  expect(await receivedPart()).toBe(2_000_000n);
});

test("the coin is recorded before the chain shows it, counted only once it lands, and its transfers are rebroadcast", async () => {
  const payment = await stealthSend([700_000n, 300_000n]);
  await recordEvmReceivedCoins(wallet, [
    received([payment.item()], "b2".repeat(32)),
  ]);
  // Claimed is not received: the coin is known, nothing is counted from the message's word.
  expect(
    wallet.getReceivedPayments!().find((p) => p.address === payment.address)
  ).toMatchObject({ status: "pending" });
  // The wallet's own read puts the carried transfers on the chain; nothing is counted until a
  // read shows them landed.
  wallet.invalidateBalanceCache?.();
  expect(await receivedPart()).toBe(0n);
  expect(state.broadcast.mock.calls.map((call) => call[0]).sort()).toEqual(
    [...payment.raws].sort()
  );
  wallet.invalidateBalanceCache?.();
  expect(await receivedPart()).toBe(1_000_000n);
});

test("a received stealth payment can be spent", async () => {
  const payment = await stealthSend([30_000_000n, 30_000_000n]);
  for (const raw of payment.raws) state.mine(raw);
  await recordEvmReceivedCoins(wallet, [
    received([payment.item()], "c3".repeat(32)),
  ]);
  expect(await receivedPart()).toBe(60_000_000n);

  const prepared = await wallet.stealthPayments!.prepare({
    operationId: "spend-received",
    chainIdentifier: "monad-testnet",
    asset: { kind: "native" },
    recipientSpendPublicKey: getBytes(contact.signingKey.compressedPublicKey),
    amountAtomic: 5_000_000n,
    // The payment and up to four change outputs (`maxChangeOutputs`), 21,000 gas each at 1.
    maxNativeFeeAtomic: 105_000n,
  });
  expect(
    prepared.members.map((member) =>
      Transaction.from(member.rawTransaction).from!.toLowerCase()
    )
  ).toEqual([payment.address]);
});

test("transfers this wallet cannot use are ignored and the rest of the item is kept", async () => {
  const payment = await stealthSend([400_000n, 600_000n]);
  for (const raw of payment.raws) state.mine(raw);
  // A transfer to someone else's one-time account, and one on another chain.
  const other = deriveEvmStealthAddress({
    recipientSpendPubKey: getBytes(stranger.signingKey.compressedPublicKey),
  });
  const toStranger = await senders[2]!.signTransaction({
    type: 2,
    chainId: 10143n,
    nonce: 0,
    to: other.stealthAddress,
    value: 900n,
    gasLimit: 21000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
  });
  state.mine(toStranger);
  const ownKey = Buffer.from(wallet.identity.compressedPubKey).toString("hex");
  const item = payment.item([
    transfer(
      toStranger,
      other.ephemeralPubKey,
      stranger.signingKey.compressedPublicKey
    ),
    transfer(
      payment.raws[0]!,
      deriveEvmStealthAddress({
        recipientSpendPubKey: wallet.identity.compressedPubKey,
      }).ephemeralPubKey,
      ownKey,
      "monad-mainnet"
    ),
  ]);
  await recordEvmReceivedCoins(wallet, [received([item], "d4".repeat(32))]);
  expect(await receivedPart()).toBe(1_000_000n);
  expect(wallet.getReceivedPayments!().map((p) => p.address)).toEqual([
    payment.address,
  ]);

  // A later message naming the same one-time account with other transfers: the first claim
  // stays; the read does not fail.
  const again = await senders[3]!.signTransaction({
    type: 2,
    chainId: 10143n,
    nonce: 0,
    to: payment.address,
    value: 50n,
    gasLimit: 21000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
  });
  const conflicting = overTheWire({
    type: "stealth-asset",
    transfers: [
      transfer(
        again,
        getBytes("0x" + item.transfers[0]!.stealthMetadata.ephemeralPubKey),
        ownKey
      ),
    ],
  });
  await expect(
    recordEvmReceivedCoins(wallet, [received([conflicting], "e5".repeat(32))])
  ).resolves.toBeUndefined();
  wallet.invalidateBalanceCache?.();
  expect(await receivedPart()).toBe(1_000_000n);
});

test("a device that has not read the gas price yet still holds back a payment below the floor", async () => {
  // A wallet just opened: no fee has been read. Its first balance read reads the gas price
  // before it classifies, so it agrees with a device that read it long ago.
  const payment = await stealthSend([400n, 600n]);
  for (const raw of payment.raws) state.mine(raw);
  await recordEvmReceivedCoins(wallet, [
    received([payment.item()], "f1".repeat(32)),
  ]);
  const parts = await wallet.getBalanceParts!();
  expect(parts).toMatchObject({
    received: 0n,
    receivedCount: 0,
    tooSmall: 1000n,
    tooSmallCount: 1,
  });
  // The payment itself says the same (what its chat card shows).
  expect(
    wallet.getReceivedPayments!().find((p) => p.address === payment.address)
  ).toMatchObject({ status: "received", spendable: true, tooSmall: true });
});
