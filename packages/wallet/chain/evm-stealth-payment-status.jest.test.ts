/**
 * What the paying wallet's journal says of a stealth payment it sent (`stealthPayments.status`),
 * which the sender's card shows: not sent yet until it is handed to the chain, pending until the
 * chain shows it, partly landed while only some of its transfers are in, paid once all are, and
 * failed with the reason when a transfer reverted. Each answer survives a reload (a reopen of the
 * wallet from its storage). Only the node is stubbed (the provider's JSON-RPC methods); the
 * wallet, its journal and stores are real.
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
  function mine(raw: string, status = 1) {
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
      status,
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
  /** Broadcasts are taken but not mined until the test says so. */
  const hold = () =>
    broadcast.mockImplementation(async (raw) => ({ hash: keccak256(raw) } as never));
  return { balances, nonces, txs, receipts, mine, broadcast, hold };
}

let root: string,
  wallet: EvmChainWalletHandle,
  state: ReturnType<typeof node>,
  cfg: EvmChainConfig;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "frank-stealth-sent-status-"));
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


/** Two received stealth coins of 100000 wei each, landed, recorded and verified on chain by the
 * wallet: what the payment draws on. (A received coin the wallet has not verified is never an
 * input.) */
async function twoCoins() {
  for (const digest of ["a1", "b2"]) {
    // Each one-time account is fresh, so the two coins are separate accounts.
    const payment = await stealthSend([100000n]);
    for (const raw of payment.raws) state.mine(raw);
    await recordEvmReceivedCoins(wallet, [
      received([payment.item()], digest.repeat(32)),
    ]);
  }
  const coins = await wallet.refreshReceivedPayments!();
  expect(coins.filter((coin) => coin.spendable)).toHaveLength(2);
}

const OPERATION = "sent-stealth-1";
const DIGEST = "f6".repeat(32);

async function prepareSend(amountAtomic: bigint) {
  const intent = {
    operationId: OPERATION,
    chainIdentifier: "monad-testnet",
    asset: { kind: "native" as const },
    recipientSpendPublicKey: getBytes(contact.signingKey.compressedPublicKey),
    amountAtomic,
  };
  const quote = await wallet.stealthPayments!.quote!(intent);
  return wallet.stealthPayments!.prepare({
    ...intent,
    maxNativeFeeAtomic: quote.estimatedNativeFeeAtomic,
  });
}

const status = () => wallet.stealthPayments!.status!(OPERATION);

test("a sent stealth payment reads not sent, then pending, then partly landed, then paid, through reloads", async () => {
  await twoCoins();
  const prepared = await prepareSend(150000n);
  expect(prepared.members.length).toBe(2);
  const hashes = prepared.members.map((member) => member.txHash);

  // Signed and saved, not handed to anyone: not sent.
  expect(await status()).toMatchObject({
    status: "pending",
    submitted: false,
    intendedAmountAtomic: 150000n,
    members: hashes.map((txHash) => ({ txHash, state: "unsent" })),
  });
  await wallet.stealthPayments!.expose({
    operationId: OPERATION,
    payloadDigest: DIGEST,
  });
  expect((await status())!.submitted).toBe(false);

  // Handed to the chain, not in a block yet: pending, and still pending after a reload.
  state.hold();
  await wallet.stealthPayments!.submit(OPERATION);
  expect(await status()).toMatchObject({
    status: "pending",
    submitted: true,
    members: hashes.map((txHash) => ({ txHash, state: "pending" })),
  });
  expect((await status())!.verifiedReceivedAmountAtomic).toBeUndefined();
  await reopenWallet();
  state.hold();
  expect(await status()).toMatchObject({ status: "pending", submitted: true });

  // One transfer lands: partly landed, with exactly what landed; kept across a reload.
  const first = prepared.members[0]!;
  state.mine(first.rawTransaction);
  await wallet.stealthPayments!.reconcile(OPERATION);
  const partial = (await status())!;
  expect(partial).toMatchObject({
    status: "partial",
    verifiedReceivedAmountAtomic: first.recipientAmountAtomic,
  });
  expect(partial.members.map((member) => member.state)).toEqual([
    "landed",
    "pending",
  ]);
  // The fee is said once every transaction of the payment is final, never as a running figure.
  expect(partial.nativeFeeAtomic).toBeUndefined();
  await reopenWallet();
  state.hold();
  expect(await status()).toMatchObject({
    status: "partial",
    verifiedReceivedAmountAtomic: first.recipientAmountAtomic,
  });

  // The rest lands: paid, the whole amount, and the network fee apart from it.
  state.mine(prepared.members[1]!.rawTransaction);
  await wallet.stealthPayments!.reconcile(OPERATION);
  const paid = (await status())!;
  expect(paid).toMatchObject({
    status: "succeeded",
    verifiedReceivedAmountAtomic: 150000n,
    members: hashes.map((txHash) => ({ txHash, state: "landed" })),
  });
  expect(paid.nativeFeeAtomic).toBeGreaterThan(0n);
  await reopenWallet();
  expect(await status()).toMatchObject({
    status: "succeeded",
    verifiedReceivedAmountAtomic: 150000n,
  });
});

test("a transfer that reverts reads failed with its reason, and the rest still counts", async () => {
  await twoCoins();
  const prepared = await prepareSend(150000n);
  await wallet.stealthPayments!.expose({
    operationId: OPERATION,
    payloadDigest: DIGEST,
  });
  state.hold();
  await wallet.stealthPayments!.submit(OPERATION);
  state.mine(prepared.members[0]!.rawTransaction);
  state.mine(prepared.members[1]!.rawTransaction, 0);
  // A revert is believed once it is deep enough that it will not be reorganised away.
  jest.spyOn(wallet.provider, "getBlockNumber").mockResolvedValue(100);
  await wallet.stealthPayments!.reconcile(OPERATION);
  const read = (await status())!;
  expect(read.status).toBe("partial");
  expect(read.verifiedReceivedAmountAtomic).toBe(
    prepared.members[0]!.recipientAmountAtomic
  );
  expect(read.members[1]).toMatchObject({
    state: "failed",
    failure: "reverted",
  });
  await reopenWallet();
  expect((await status())!.members[1]).toMatchObject({
    state: "failed",
    failure: "reverted",
  });
});

test("a payment this wallet does not hold has no status", async () => {
  expect(await wallet.stealthPayments!.status!("not-a-payment")).toBeUndefined();
});
