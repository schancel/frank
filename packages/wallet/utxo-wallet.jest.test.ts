import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { HDNodeWallet } from "ethers";
import { decodeCashAddress } from "ecashaddrjs";
import {
  parseTransaction,
  privateKeyFromBytes,
  publicFromPrivate,
  signEcdsa,
} from "@frank/nakamoto";
import { stealthParentSecret } from "@frank/cashweb/relay/stealth-parent";
import { deriveUtxoStealthDestination } from "./utxo-stealth";
import { createUtxoChain } from "./chain/utxo-chain";
import type { UtxoStealthCustody } from "./utxo-stealth";
import {
  NativeFeeExceededError,
  NativeTransactionRefusedError,
  NativeTransactionSubmissionError,
} from "./chain/chain-wallet";
import {
  IndexedOutput,
  memoryUtxoWalletStore,
  planUtxoSend,
  UTXO_NETWORKS,
  UtxoBroadcastRefused,
  UtxoCoin,
  UtxoIndexer,
  UtxoNetwork,
  UtxoWallet,
  UtxoWalletStore,
  parseUtxoAddress,
} from "./utxo-wallet";

const BTC = UTXO_NETWORKS["btc-testnet"];
const BCH = UTXO_NETWORKS["bch-testnet"];
// BIP39 seed of "abandon ... about" with no passphrase: the seed of the published BIP84 vectors.
const unhex = (text: string) => Uint8Array.from(Buffer.from(text, "hex"));
const ABANDON_SEED = unhex(
  "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4"
);
const ROOT = new Uint8Array(32).fill(7);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const sha256d = (bytes: Uint8Array) => sha256(sha256(bytes));

/** An in-memory unspent set: the narrow seam where an Electrum server would answer. */
function makeIndexer() {
  const unspent = new Map<string, IndexedOutput[]>();
  const known = new Set<string>();
  const broadcasts: string[] = [];
  let broadcastOutcome: "accept" | "refuse" | "lost" | "lost-but-sent" =
    "accept";
  const indexer: UtxoIndexer = {
    listUnspent: async (script) => unspent.get(hex(script)) ?? [],
    hasHistory: async (script) => unspent.has(hex(script)),
    hasTransaction: async (txid) => known.has(txid),
    feeRate: async () => 2n,
    broadcast: async (raw) => {
      broadcasts.push(raw);
      if (broadcastOutcome === "refuse")
        throw new UtxoBroadcastRefused("min relay fee not met");
      if (broadcastOutcome === "lost") throw new Error("socket closed");
      spend(raw);
      if (broadcastOutcome === "lost-but-sent")
        throw new Error("socket closed");
    },
  };
  /** Apply a transaction the way a node would: remove its inputs, add its outputs. */
  function spend(raw: string) {
    const network = raw.startsWith("0200000000010") ? BTC : BCH;
    const parsed = parseTransaction(unhex(raw), network.descriptor);
    if (!parsed.ok) throw new Error("test indexer could not parse");
    const tx = parsed.value;
    for (const input of tx.inputs) {
      const txid = hex(Uint8Array.from(input.prevout.txid).reverse());
      for (const [script, outputs] of unspent) {
        const rest = outputs.filter(
          (o) => !(o.txid === txid && o.vout === input.prevout.vout)
        );
        if (rest.length !== outputs.length) unspent.set(script, rest);
      }
    }
    const txid = txidOf(raw, network);
    tx.outputs.forEach((output, vout) => {
      const script = hex(output.scriptPubKey);
      unspent.set(script, [
        ...(unspent.get(script) ?? []),
        { txid, vout, amount: output.value, height: 0 },
      ]);
    });
    known.add(txid);
  }
  return {
    indexer,
    unspent,
    known,
    broadcasts,
    setOutcome: (outcome: typeof broadcastOutcome) => {
      broadcastOutcome = outcome;
    },
  };
}

function txidOf(raw: string, network: UtxoNetwork): string {
  const parsed = parseTransaction(unhex(raw), network.descriptor);
  if (!parsed.ok) throw new Error("unparseable");
  const tx = parsed.value;
  return hex(sha256d(serializeLegacy(tx)).reverse());
}

type Parsed = Extract<
  ReturnType<typeof parseTransaction>,
  { ok: true }
>["value"];

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}
function u64(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}
const cat = (...parts: Uint8Array[]) => Uint8Array.from(Buffer.concat(parts));
const withLength = (bytes: Uint8Array) =>
  cat(Uint8Array.of(bytes.length), bytes);
const outpoint = (input: Parsed["inputs"][number]) =>
  cat(Uint8Array.from(input.prevout.txid), u32(input.prevout.vout));
const output = (o: Parsed["outputs"][number]) =>
  cat(u64(o.value), withLength(o.scriptPubKey));

/** Serialization without witness data: what a txid commits to. Written here, not imported. */
function serializeLegacy(tx: Parsed): Uint8Array {
  return cat(
    u32(tx.version),
    Uint8Array.of(tx.inputs.length),
    ...tx.inputs.map((i) =>
      cat(outpoint(i), withLength(i.scriptSig), u32(i.sequence))
    ),
    Uint8Array.of(tx.outputs.length),
    ...tx.outputs.map(output),
    u32(tx.locktime)
  );
}

/**
 * The BIP143 digest, written from the BIP rather than taken from the signing library. Bitcoin Cash
 * uses the same preimage with the fork id in the hash type.
 */
function bip143Digest(
  tx: Parsed,
  index: number,
  scriptCode: Uint8Array,
  amount: bigint,
  hashType: number
): Uint8Array {
  const input = tx.inputs[index];
  return sha256d(
    cat(
      u32(tx.version),
      sha256d(cat(...tx.inputs.map(outpoint))),
      sha256d(cat(...tx.inputs.map((i) => u32(i.sequence)))),
      outpoint(input),
      withLength(scriptCode),
      u64(amount),
      u32(input.sequence),
      sha256d(cat(...tx.outputs.map(output))),
      u32(tx.locktime),
      u32(hashType)
    )
  );
}

const p2pkhScript = (pubkey: Uint8Array) =>
  cat(
    Uint8Array.of(0x76, 0xa9, 0x14),
    ripemd160(sha256(pubkey)),
    Uint8Array.of(0x88, 0xac)
  );

/** Check every input's signature against its coin with independent hashing and secp256k1. */
function expectValidSignatures(
  raw: string,
  network: UtxoNetwork,
  spent: readonly UtxoCoin[]
) {
  const parsed = parseTransaction(unhex(raw), network.descriptor);
  if (!parsed.ok) throw new Error("unparseable");
  const tx = parsed.value;
  expect(tx.inputs).toHaveLength(spent.length);
  tx.inputs.forEach((input, index) => {
    const coin = spent[index];
    let signature: Uint8Array;
    let pubkey: Uint8Array;
    if (network.ownOutput === "p2wpkh") {
      expect(input.scriptSig).toHaveLength(0);
      expect(input.witness).toHaveLength(2);
      [signature, pubkey] = input.witness as Uint8Array[];
      // The witness program must be the hash of the revealed key.
      expect(hex(coin.scriptPubKey)).toBe(
        `0014${hex(ripemd160(sha256(pubkey)))}`
      );
    } else {
      expect(input.witness ?? []).toHaveLength(0);
      const sigLength = input.scriptSig[0];
      signature = input.scriptSig.slice(1, 1 + sigLength);
      pubkey = input.scriptSig.slice(2 + sigLength);
      expect(input.scriptSig[1 + sigLength]).toBe(33);
      expect(hex(coin.scriptPubKey)).toBe(hex(p2pkhScript(pubkey)));
    }
    const hashType = signature[signature.length - 1];
    expect(hashType).toBe(network.ownOutput === "p2wpkh" ? 0x01 : 0x41);
    const digest = bip143Digest(
      tx,
      index,
      p2pkhScript(pubkey),
      coin.amount,
      hashType
    );
    const der = signature.slice(0, -1);
    const parsedSignature = secp256k1.Signature.fromDER(der);
    expect(parsedSignature.hasHighS()).toBe(false);
    expect(secp256k1.verify(parsedSignature, digest, pubkey)).toBe(true);
  });
}

async function open(
  network: UtxoNetwork,
  backend = makeIndexer(),
  store: UtxoWalletStore = memoryUtxoWalletStore(),
  seed: Uint8Array = ROOT,
  stealthCustody?: UtxoStealthCustody
) {
  const wallet = await UtxoWallet.create({
    network,
    seed,
    indexer: backend.indexer,
    storeFor: () => store,
    stealthCustody,
  });
  return { wallet, backend, store };
}

/** Synthetic identity custody deliberately unrelated to either wallet's HD root. The callback
 * holds no derived secret between calls and makes every signing closure obey session expiry. */
function syntheticStealthCustody(
  network: UtxoNetwork,
  identitySecret = new Uint8Array(32).fill(21)
) {
  let active = true;
  const identityPublicKey = secp256k1.getPublicKey(identitySecret, true);
  const custody: UtxoStealthCustody = {
    identityPublicKey,
    async deriveStealthSigner(derivation) {
      if (!active) throw new Error("custody closed");
      if (
        derivation.chainIdentifier !== network.chainIdentifier ||
        hex(derivation.identityPublicKey) !== hex(identityPublicKey)
      )
        throw new Error("wrong custody scope");
      const derive = () =>
        stealthParentSecret(identitySecret, derivation.ephemeralPubKey).secret;
      const secret = derive();
      const key = privateKeyFromBytes(secret, true);
      secret.fill(0);
      if (!key.ok) throw new Error("bad synthetic custody key");
      const point = publicFromPrivate(key.value);
      key.value.bytes.fill(0);
      if (!point.ok) throw new Error("bad synthetic custody point");
      return {
        publicKey: point.value.compressed,
        sign(digest) {
          if (!active) throw new Error("custody closed");
          const temporary = derive();
          const signer = privateKeyFromBytes(temporary, true);
          temporary.fill(0);
          if (!signer.ok) throw new Error("bad synthetic custody signer");
          try {
            const signature = signEcdsa(signer.value, digest);
            if (!signature.ok)
              throw new Error("bad synthetic custody signature");
            return signature.value;
          } finally {
            signer.value.bytes.fill(0);
          }
        },
      };
    },
  };
  return {
    custody,
    close: () => {
      active = false;
    },
  };
}

function scriptOf(network: UtxoNetwork, address: string): string {
  const destination = parseUtxoAddress(network, address);
  if (!destination) throw new Error("bad address");
  const hash = hex((destination as { hash: Uint8Array }).hash);
  return destination.kind === "p2wpkh" ? `0014${hash}` : `76a914${hash}88ac`;
}

function fund(
  backend: ReturnType<typeof makeIndexer>,
  network: UtxoNetwork,
  address: string,
  amount: bigint,
  txid: string,
  height = 100
) {
  const script = scriptOf(network, address);
  backend.unspent.set(script, [
    ...(backend.unspent.get(script) ?? []),
    { txid: txid.repeat(64).slice(0, 64), vout: 0, amount, height },
  ]);
}

const BTC_RECIPIENT = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
const BCH_RECIPIENT = "bchtest:qpm2qsznhks23z7629mms6s4cwef74vcwvqcw003ap";

describe("derivation", () => {
  it("derives the published BIP84 testnet address for the well-known seed", async () => {
    const { wallet } = await open(
      BTC,
      makeIndexer(),
      memoryUtxoWalletStore(),
      ABANDON_SEED
    );
    expect((await wallet.getReceiveAddress()).raw).toBe(
      "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl"
    );
  });

  it("derives the published BIP44 coin-145 key hash for the well-known seed", async () => {
    const { wallet } = await open(
      BCH,
      makeIndexer(),
      memoryUtxoWalletStore(),
      ABANDON_SEED
    );
    const address = (await wallet.getReceiveAddress()).raw;
    expect(address.startsWith("bchtest:q")).toBe(true);
    // The mainnet form of the same key, as wallets that implement BIP44 for BCH show it.
    const published = decodeCashAddress(
      "bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6"
    );
    expect(decodeCashAddress(address).hash).toEqual(published.hash);
  });

  it.each([
    [BTC, "m/84'/1'/0'/0/0"],
    [BCH, "m/44'/145'/0'/0/0"],
  ])(
    "uses the 32-byte root directly as the BIP32 seed (%#)",
    async (network, path) => {
      const { wallet } = await open(network);
      const expected = HDNodeWallet.fromSeed(ROOT).derivePath(path);
      const keyHash = hex(
        ripemd160(sha256(Buffer.from(expected.publicKey.slice(2), "hex")))
      );
      expect(scriptOf(network, wallet.identity.displayAddress)).toContain(
        keyHash
      );
    }
  );
});

describe("coin selection", () => {
  const coin = (amount: bigint, extra: Partial<UtxoCoin> = {}): UtxoCoin => ({
    privKey: new Uint8Array(32).fill(1),
    txid: amount.toString(16).padStart(64, "0"),
    vout: 0,
    amount,
    origin: "receive",
    state: "unspent",
    scriptPubKey: new Uint8Array(22),
    confirmed: true,
    ...extra,
  });
  const recipientScript = new Uint8Array(22);
  const plan = (coins: UtxoCoin[], value: bigint, feeRate = 1n) =>
    planUtxoSend({ coins, value, recipientScript, feeRate, network: BTC });

  it("uses the largest coins first and returns the remainder as change", () => {
    const result = plan([coin(1_000n), coin(50_000n), coin(20_000n)], 30_000n);
    expect(result.inputs.map((c) => c.amount)).toEqual([50_000n]);
    // 11 overhead + 68 input + 31 recipient + 31 change virtual bytes at 1 per byte.
    expect(result.fee).toBe(141n);
    expect(result.change).toBe(50_000n - 30_000n - 141n);
  });

  it("adds coins until the amount and fee are covered", () => {
    const result = plan([coin(10_000n), coin(9_000n), coin(8_000n)], 18_500n);
    expect(result.inputs.map((c) => c.amount)).toEqual([10_000n, 9_000n]);
    expect(result.fee + (result.change ?? 0n) + 18_500n).toBe(19_000n);
  });

  it("pays a remainder below dust as fee instead of making an unspendable output", () => {
    const result = plan([coin(10_500n)], 10_000n);
    expect(result.change).toBeUndefined();
    expect(result.fee).toBe(500n);
  });

  it("prefers confirmed coins and never selects a coin a pending send has claimed", () => {
    const result = plan(
      [
        coin(90_000n, { state: "pending" }),
        coin(60_000n, { confirmed: false }),
        coin(40_000n),
      ],
      10_000n
    );
    expect(result.inputs.map((c) => c.amount)).toEqual([40_000n]);
  });

  it("refuses when the coins cannot cover amount plus fee, and below-dust amounts", () => {
    expect(() => plan([coin(10_000n)], 10_000n)).toThrow("Insufficient funds");
    expect(() => plan([coin(90_000n, { state: "pending" })], 1_000n)).toThrow(
      "Insufficient funds"
    );
    expect(() => plan([coin(10_000n)], 100n)).toThrow(
      "below the network minimum"
    );
  });
});

describe.each([
  ["Bitcoin testnet (P2WPKH, BIP143)", BTC, BTC_RECIPIENT],
  ["Bitcoin Cash testnet (P2PKH, fork id)", BCH, BCH_RECIPIENT],
] as const)("%s", (_name, network, recipient) => {
  it("reads the balance across every address and rotates the receive address", async () => {
    const { wallet, backend } = await open(network);
    const first = (await wallet.getReceiveAddress()).raw;
    expect(await wallet.getBalance()).toBe(0n);
    // Showing the address again does not consume it.
    expect((await wallet.getReceiveAddress()).raw).toBe(first);
    fund(backend, network, first, 70_000n, "a");
    expect(await wallet.getBalance()).toBe(70_000n);
    const second = (await wallet.getReceiveAddress()).raw;
    expect(second).not.toBe(first);
    fund(backend, network, second, 30_000n, "b", 0);
    expect(await wallet.getBalance()).toBe(100_000n);
    expect(wallet.coins().map((c) => [c.origin, c.state, c.confirmed])).toEqual(
      [
        ["receive", "unspent", true],
        ["receive", "unspent", false],
      ]
    );
  });

  it("builds a transaction whose every signature is valid, with change to a fresh address", async () => {
    const { wallet, backend } = await open(network);
    const first = (await wallet.getReceiveAddress()).raw;
    fund(backend, network, first, 70_000n, "a");
    const second = (await wallet.getReceiveAddress()).raw;
    fund(backend, network, second, 30_000n, "b");
    await wallet.getBalance();
    const coins = [...wallet.coins()].sort((l, r) =>
      l.amount > r.amount ? -1 : 1
    );

    const signed = jest.fn();
    const sent = await wallet.sendNative({
      recipient: { raw: recipient },
      value: 80_000n,
      onSigned: signed,
    });
    expect(backend.broadcasts).toHaveLength(1);
    const raw = backend.broadcasts[0];
    expect(sent.txHash).toBe(txidOf(raw, network));
    expect(signed).toHaveBeenCalledWith({ txHash: sent.txHash });
    expectValidSignatures(raw, network, coins);

    const parsed = parseTransaction(unhex(raw), network.descriptor);
    if (!parsed.ok) throw new Error("unparseable");
    const [paid, change] = parsed.value.outputs;
    expect(hex(paid.scriptPubKey)).toBe(scriptOf(network, recipient));
    expect(paid.value).toBe(80_000n);
    // Change goes to a change-chain address, never back to a receive address.
    expect([first, second].map((a) => scriptOf(network, a))).not.toContain(
      hex(change.scriptPubKey)
    );
    const fee = 100_000n - 80_000n - change.value;
    const size = BigInt(Math.ceil(raw.length / 2));
    expect(fee).toBeGreaterThanOrEqual(
      network.ownOutput === "p2wpkh" ? size / 2n : size
    );
    expect(fee).toBeLessThan(2_000n);
    // The change is spendable at once and counted in the balance.
    expect(await wallet.getBalance()).toBe(change.value);
    expect(wallet.coins()).toEqual([
      expect.objectContaining({ origin: "change", amount: change.value }),
    ]);

    // A second send uses the change and a new change address.
    await wallet.sendNative({ recipient: { raw: recipient }, value: 5_000n });
    const next = parseTransaction(
      unhex(backend.broadcasts[1]),
      network.descriptor
    );
    if (!next.ok) throw new Error("unparseable");
    expect(hex(next.value.outputs[1].scriptPubKey)).not.toBe(
      hex(change.scriptPubKey)
    );
  });

  it("frees the coins when the network refuses the transaction outright", async () => {
    const { wallet, backend, store } = await open(network);
    fund(
      backend,
      network,
      (await wallet.getReceiveAddress()).raw,
      70_000n,
      "a"
    );
    backend.setOutcome("refuse");
    const refused = await wallet
      .sendNative({ recipient: { raw: recipient }, value: 10_000n })
      .catch((error) => error);
    // The caller learns it was refused, and why, in the node's words.
    expect(refused).toBeInstanceOf(NativeTransactionRefusedError);
    expect(refused.message).toBe(
      "The network refused the transaction: min relay fee not met"
    );
    expect(wallet.getUnresolvedNativeTransaction()).toBeUndefined();
    expect(await wallet.getBalance()).toBe(70_000n);
    expect(JSON.parse(store.load()!).consumedNativeInputs ?? []).toEqual([]);
  });

  it("does not report failure, or sign again, for a transaction that may have been broadcast", async () => {
    const { wallet, backend, store } = await open(network);
    fund(
      backend,
      network,
      (await wallet.getReceiveAddress()).raw,
      70_000n,
      "a"
    );
    fund(
      backend,
      network,
      (await wallet.getReceiveAddress()).raw,
      60_000n,
      "b"
    );
    backend.setOutcome("lost");
    const attempt = wallet.sendNative({
      recipient: { raw: recipient },
      value: 10_000n,
    });
    await expect(attempt).rejects.toBeInstanceOf(
      NativeTransactionSubmissionError
    );
    const raw = backend.broadcasts[0];
    expect(wallet.getUnresolvedNativeTransaction()).toEqual({
      txHash: txidOf(raw, network),
      rawTransactions: [raw],
    });
    // The claimed coin is not spendable while the outcome is unknown.
    expect(await wallet.getBalance()).toBe(60_000n);

    // Still unreachable: the old bytes are tried again and its coin stays claimed. A new send
    // may only use the other coin, never the claimed one.
    await expect(
      wallet.sendNative({ recipient: { raw: recipient }, value: 65_000n })
    ).rejects.toThrow("Insufficient funds");
    expect(new Set(backend.broadcasts)).toEqual(new Set([raw]));

    // After a restart the same bytes are sent again, not a new payment.
    backend.setOutcome("accept");
    const restarted = await open(network, backend, store);
    expect(backend.broadcasts[backend.broadcasts.length - 1]).toBe(raw);
    expect(restarted.wallet.getUnresolvedNativeTransaction()).toBeUndefined();
    expect(await restarted.wallet.getBalance()).toBe(
      130_000n - 10_000n - feeOf(raw, network, 70_000n)
    );
  });

  it("does not send again a transaction the node took before the answer was lost", async () => {
    const { wallet, backend, store } = await open(network);
    fund(
      backend,
      network,
      (await wallet.getReceiveAddress()).raw,
      70_000n,
      "a"
    );
    backend.setOutcome("lost-but-sent");
    await expect(
      wallet.sendNative({ recipient: { raw: recipient }, value: 10_000n })
    ).rejects.toBeInstanceOf(NativeTransactionSubmissionError);
    backend.setOutcome("accept");
    const restarted = await open(network, backend, store);
    expect(backend.broadcasts).toHaveLength(1);
    expect(restarted.wallet.getUnresolvedNativeTransaction()).toBeUndefined();
    await restarted.wallet.sendNative({
      recipient: { raw: recipient },
      value: 5_000n,
    });
    expect(backend.broadcasts).toHaveLength(2);
  });

  it("lets a second send use other coins while the first is still being broadcast", async () => {
    const { wallet, backend } = await open(network);
    fund(
      backend,
      network,
      (await wallet.getReceiveAddress()).raw,
      70_000n,
      "a"
    );
    fund(
      backend,
      network,
      (await wallet.getReceiveAddress()).raw,
      60_000n,
      "b"
    );
    await wallet.getBalance();
    // The first broadcast hangs at the node.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const accept = backend.indexer.broadcast;
    let first = true;
    backend.indexer.broadcast = async (raw) => {
      if (first) {
        first = false;
        await held;
      }
      return accept(raw);
    };
    const slow = wallet.sendNative({
      recipient: { raw: recipient },
      value: 10_000n,
    });
    const quick = await wallet.sendNative({
      recipient: { raw: recipient },
      value: 10_000n,
    });
    expect(quick.txHash).toMatch(/^[0-9a-f]{64}$/);
    release();
    const slowResult = await slow;
    expect(slowResult.txHash).not.toBe(quick.txHash);
    // Two different transactions, no input in common, and the hanging one sent only once.
    expect(backend.broadcasts).toHaveLength(2);
    const inputs = backend.broadcasts.map((raw) => {
      const parsed = parseTransaction(unhex(raw), network.descriptor);
      if (!parsed.ok) throw new Error("unparseable");
      return parsed.value.inputs.map(
        (i) => `${hex(i.prevout.txid)}:${i.prevout.vout}`
      );
    });
    expect(inputs[0]).toHaveLength(1);
    expect(inputs[1]).toHaveLength(1);
    expect(inputs[0][0]).not.toBe(inputs[1][0]);
  });

  it("refuses to pay more than the reviewed fee, before signing or recording anything", async () => {
    const { wallet, backend, store } = await open(network);
    fund(
      backend,
      network,
      (await wallet.getReceiveAddress()).raw,
      70_000n,
      "a"
    );
    const transfer = { recipient: { raw: recipient }, value: 10_000n };
    const { fee } = await wallet.estimateFee(transfer);
    const before = store.load();
    const error = await wallet
      .sendNative({ ...transfer, maxFee: fee - 1n })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(NativeFeeExceededError);
    expect(error.fee).toBe(fee);
    expect(backend.broadcasts).toHaveLength(0);
    expect(store.load()).toBe(before);
    await wallet.sendNative({ ...transfer, maxFee: fee });
    expect(feeOf(backend.broadcasts[0], network, 70_000n)).toBe(fee);
  });

  it("prepares valid signed bytes, retains claims on reopen, and broadcasts nothing", async () => {
    const { wallet, backend, store } = await open(network);
    fund(
      backend,
      network,
      (await wallet.getReceiveAddress()).raw,
      70_000n,
      "a"
    );
    await wallet.getBalance();
    const coins = [...wallet.coins()];
    const prepared = await wallet.prepareNativePayment({
      operationId: "first",
      recipient: { raw: recipient },
      value: 10_000n,
    });
    const raw = prepared.transaction.rawTransactions![0];
    expectValidSignatures(raw, network, coins);
    expect(prepared).toMatchObject({
      chainIdentifier: network.chainIdentifier,
      value: 10_000n,
      phase: "prepared",
    });
    expect(prepared.transaction.txHash).toBe(txidOf(raw, network));
    const tx = parseTransaction(unhex(raw), network.descriptor);
    if (!tx.ok) throw new Error("unparseable");
    expect(hex(tx.value.outputs[0].scriptPubKey)).toBe(
      scriptOf(network, recipient)
    );
    expect(tx.value.outputs[0].value).toBe(10_000n);
    expect(prepared.fee).toBe(feeOf(raw, network, 70_000n));
    const restarted = (await open(network, backend, store)).wallet;
    expect(await restarted.getBalance()).toBe(0n);
    expect(await restarted.getNativePayments()).toEqual([prepared]);
    expect(backend.broadcasts).toHaveLength(0);
    await expect(restarted.submitPreparedPayment("first")).rejects.toThrow(
      "must be exposed"
    );
  });

  it("reuses an operation exactly and refuses a changed intent or a released id", async () => {
    const { wallet, backend, store } = await open(network);
    fund(
      backend,
      network,
      (await wallet.getReceiveAddress()).raw,
      70_000n,
      "a"
    );
    const params = {
      operationId: "same",
      recipient: { raw: recipient },
      value: 10_000n,
    };
    const prepared = await wallet.prepareNativePayment(params);
    const before = store.load();
    expect(await wallet.prepareNativePayment(params)).toEqual(prepared);
    expect(store.load()).toBe(before);
    await expect(
      wallet.prepareNativePayment({ ...params, value: 11_000n })
    ).rejects.toThrow("another recipient or amount");
    await expect(
      wallet.prepareNativePayment({
        ...params,
        recipient: { raw: wallet.identity.address.raw },
      })
    ).rejects.toThrow("another recipient or amount");
    await expect(
      wallet.prepareNativePayment({ ...params, maxFee: prepared.fee - 1n })
    ).rejects.toBeInstanceOf(NativeFeeExceededError);
    expect(await wallet.releaseUnexposedPayment("same")).toBe(true);
    expect(await wallet.releaseUnexposedPayment("same")).toBe(false);
    expect(await wallet.getBalance()).toBe(70_000n);
    const released = JSON.parse(store.load()!);
    expect(released.changeIndex).toBe(JSON.parse(before!).changeIndex);
    await expect(wallet.prepareNativePayment(params)).rejects.toThrow(
      "was released"
    );
    expect(backend.broadcasts).toHaveLength(0);
  });

  it("coordinates distinct instances over shared durable storage and consumes distinct change indices", async () => {
    const backend = makeIndexer();
    const shared = memoryUtxoWalletStore();
    // Different store objects deliberately share the same durable bytes.
    const store = () => ({
      load: () => shared.load(),
      save: (value: string) => shared.save(value),
    });
    const first = (await open(network, backend, store())).wallet;
    const second = (await open(network, backend, store())).wallet;
    fund(backend, network, first.identity.address.raw, 70_000n, "a");
    fund(backend, network, first.identity.address.raw, 60_000n, "b");
    const prepare = (wallet: UtxoWallet, operationId: string) =>
      wallet.prepareNativePayment({
        operationId,
        recipient: { raw: recipient },
        value: 10_000n,
      });
    const payments = await Promise.all([
      prepare(first, "left"),
      prepare(second, "right"),
    ]);
    const parsed = payments.map((payment) => {
      const tx = parseTransaction(
        unhex(payment.transaction.rawTransactions![0]),
        network.descriptor
      );
      if (!tx.ok) throw new Error("unparseable");
      return tx.value;
    });
    expect(hex(parsed[0].inputs[0].prevout.txid)).not.toBe(
      hex(parsed[1].inputs[0].prevout.txid)
    );
    expect(hex(parsed[0].outputs[1].scriptPubKey)).not.toBe(
      hex(parsed[1].outputs[1].scriptPubKey)
    );
    expect(await first.getNativePayments()).toHaveLength(2);
    expect(await second.getBalance()).toBe(0n);
    expect(backend.broadcasts).toHaveLength(0);
  });

  it("makes concurrent retries of the same operation reserve and sign one payment", async () => {
    const { wallet, backend, store } = await open(network);
    fund(backend, network, wallet.identity.address.raw, 70_000n, "a");
    const other = (await open(network, backend, store)).wallet;
    const params = {
      operationId: "same",
      recipient: { raw: recipient },
      value: 10_000n,
    };
    const [left, right] = await Promise.all([
      wallet.prepareNativePayment(params),
      other.prepareNativePayment(params),
    ]);
    expect(left).toEqual(right);
    expect(await wallet.getNativePayments()).toHaveLength(1);
    expect(JSON.parse(store.load()!).changeIndex).toBe(1);
  });

  it("keeps exposed claims through reopen, refusal and repeated exposure without broadcasting on open", async () => {
    const { wallet, backend, store } = await open(network);
    fund(backend, network, wallet.identity.address.raw, 70_000n, "a");
    await wallet.prepareNativePayment({
      operationId: "exposed",
      recipient: { raw: recipient },
      value: 10_000n,
    });
    await wallet.recordPaymentExposure({
      operationId: "exposed",
      payloadDigest: "a".repeat(64),
    });
    await wallet.recordPaymentExposure({
      operationId: "exposed",
      payloadDigest: "a".repeat(64),
    });
    const other = (await open(network, backend, store)).wallet;
    expect(backend.broadcasts).toHaveLength(0);
    expect(await other.releaseUnexposedPayment("exposed")).toBe(false);
    backend.setOutcome("refuse");
    await expect(other.submitPreparedPayment("exposed")).rejects.toBeInstanceOf(
      NativeTransactionSubmissionError
    );
    expect(await wallet.releaseUnexposedPayment("exposed")).toBe(false);
    expect(await wallet.getBalance()).toBe(0n);
    expect((await wallet.getNativePayments())[0]).toMatchObject({
      phase: "submitted",
      payloadDigests: ["a".repeat(64)],
    });
  });

  it("recovers ambiguous submission using only the original signed bytes", async () => {
    const { wallet, backend, store } = await open(network);
    fund(backend, network, wallet.identity.address.raw, 70_000n, "a");
    const params = {
      operationId: "recover",
      recipient: { raw: recipient },
      value: 10_000n,
    };
    const prepared = await wallet.prepareNativePayment(params);
    await wallet.recordPaymentExposure({
      operationId: "recover",
      payloadDigest: "a".repeat(64),
    });
    backend.setOutcome("lost");
    await expect(
      wallet.submitPreparedPayment("recover")
    ).rejects.toBeInstanceOf(NativeTransactionSubmissionError);
    backend.setOutcome("accept");
    const other = (await open(network, backend, store)).wallet;
    expect(backend.broadcasts).toEqual([
      prepared.transaction.rawTransactions![0],
      prepared.transaction.rawTransactions![0],
    ]);
    expect((await other.prepareNativePayment(params)).transaction).toEqual(
      prepared.transaction
    );
    await other.submitPreparedPayment("recover");
    expect(backend.broadcasts).toHaveLength(2);
    expect((await other.getNativePayments())[0].phase).toBe("settled");
  });

  it("uses other coins while a prepared payment submission is waiting on the network", async () => {
    const { wallet, backend, store } = await open(network);
    fund(backend, network, wallet.identity.address.raw, 70_000n, "a");
    fund(backend, network, wallet.identity.address.raw, 60_000n, "b");
    const prepared = await wallet.prepareNativePayment({
      operationId: "slow",
      recipient: { raw: recipient },
      value: 10_000n,
    });
    await wallet.recordPaymentExposure({
      operationId: "slow",
      payloadDigest: "a".repeat(64),
    });
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const broadcasting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const broadcast = backend.indexer.broadcast;
    backend.indexer.broadcast = async (raw) => {
      if (raw === prepared.transaction.rawTransactions![0]) {
        started();
        await held;
      }
      await broadcast(raw);
    };
    const other = (await open(network, backend, store)).wallet;
    const slow = wallet.submitPreparedPayment("slow");
    await broadcasting;
    const quick = await other.prepareNativePayment({
      operationId: "quick",
      recipient: { raw: recipient },
      value: 10_000n,
    });
    expect(quick.transaction.txHash).not.toBe(prepared.transaction.txHash);
    release();
    await slow;
  });

  it("keeps spent inputs excluded when a settled payment's indexer coin view lags", async () => {
    const { wallet, backend } = await open(network);
    fund(backend, network, wallet.identity.address.raw, 70_000n, "a");
    const stale = new Map(backend.unspent);
    const params = {
      operationId: "settled",
      recipient: { raw: recipient },
      value: 10_000n,
    };
    await wallet.prepareNativePayment(params);
    await wallet.recordPaymentExposure({
      operationId: "settled",
      payloadDigest: "a".repeat(64),
    });
    await wallet.submitPreparedPayment("settled");
    await wallet.submitPreparedPayment("settled");
    backend.unspent.clear();
    for (const [script, coins] of stale) backend.unspent.set(script, coins);
    expect(await wallet.getBalance()).toBe(0n);
    await expect(
      wallet.prepareNativePayment({ ...params, operationId: "new" })
    ).rejects.toThrow("Insufficient funds");
    expect(backend.broadcasts).toHaveLength(1);
  });

  it("does not expose or broadcast when preparation or exposure persistence fails", async () => {
    const backend = makeIndexer();
    const durable = memoryUtxoWalletStore();
    let fail = false;
    const store = {
      load: () => durable.load(),
      save: (value: string) => {
        if (fail) throw new Error("storage full");
        durable.save(value);
      },
    };
    const wallet = (await open(network, backend, store)).wallet;
    fund(backend, network, wallet.identity.address.raw, 70_000n, "a");
    await wallet.getBalance();
    const before = durable.load();
    const params = {
      operationId: "durable",
      recipient: { raw: recipient },
      value: 10_000n,
    };
    fail = true;
    await expect(wallet.prepareNativePayment(params)).rejects.toThrow(
      "storage full"
    );
    expect(durable.load()).toBe(before);
    fail = false;
    await wallet.prepareNativePayment(params);
    fail = true;
    await expect(
      wallet.recordPaymentExposure({
        operationId: "durable",
        payloadDigest: "a".repeat(64),
      })
    ).rejects.toThrow("storage full");
    await expect(wallet.submitPreparedPayment("durable")).rejects.toThrow(
      "must be exposed"
    );
    fail = false;
    expect(await wallet.releaseUnexposedPayment("durable")).toBe(true);
    expect(backend.broadcasts).toHaveLength(0);
  });

  it("serializes exposure against release across instances so exposed bytes never lose their claim", async () => {
    const { wallet, backend, store } = await open(network);
    fund(backend, network, wallet.identity.address.raw, 70_000n, "a");
    await wallet.prepareNativePayment({
      operationId: "race",
      recipient: { raw: recipient },
      value: 10_000n,
    });
    const other = (await open(network, backend, store)).wallet;
    const results = await Promise.allSettled([
      wallet.recordPaymentExposure({
        operationId: "race",
        payloadDigest: "a".repeat(64),
      }),
      other.releaseUnexposedPayment("race"),
    ]);
    const payment = (await wallet.getNativePayments())[0];
    if (results[0].status === "fulfilled") {
      expect(results[1]).toEqual({ status: "fulfilled", value: false });
      expect(payment.phase).toBe("exposed");
      expect(await other.getBalance()).toBe(0n);
    } else {
      expect(results[1]).toEqual({ status: "fulfilled", value: true });
      expect(payment.phase).toBe("released");
      expect(payment.payloadDigests).toEqual([]);
      await expect(
        other.recordPaymentExposure({
          operationId: "race",
          payloadDigest: "a".repeat(64),
        })
      ).rejects.toThrow("was released");
    }
    expect(backend.broadcasts).toHaveLength(0);
  });

  it("keeps native sends from selecting another instance's prepared inputs", async () => {
    const { wallet, backend, store } = await open(network);
    fund(backend, network, wallet.identity.address.raw, 70_000n, "a");
    fund(backend, network, wallet.identity.address.raw, 60_000n, "b");
    const prepared = await wallet.prepareNativePayment({
      operationId: "held",
      recipient: { raw: recipient },
      value: 10_000n,
    });
    const other = (await open(network, backend, store)).wallet;
    await other.sendNative({ recipient: { raw: recipient }, value: 10_000n });
    const input = (raw: string) => {
      const parsed = parseTransaction(unhex(raw), network.descriptor);
      if (!parsed.ok) throw new Error("unparseable");
      return hex(parsed.value.inputs[0].prevout.txid);
    };
    expect(input(backend.broadcasts[0])).not.toBe(
      input(prepared.transaction.rawTransactions![0])
    );
    expect((await wallet.getNativePayments())[0].phase).toBe("prepared");
  });

  it("does not free a cached native input when another instance settles its pending record before selection", async () => {
    const { wallet: first, backend, store } = await open(network);
    const second = (await open(network, backend, store)).wallet;
    fund(backend, network, first.identity.address.raw, 70_000n, "a");
    fund(backend, network, first.identity.address.raw, 60_000n, "b");
    backend.setOutcome("lost");
    await expect(
      first.sendNative({ recipient: { raw: recipient }, value: 10_000n })
    ).rejects.toBeInstanceOf(NativeTransactionSubmissionError);
    const nativeRaw = backend.broadcasts[0];

    let readComplete!: () => void;
    let continueSelection!: () => void;
    const read = new Promise<void>((resolve) => {
      readComplete = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      continueSelection = resolve;
    });
    // Wrap the real sync solely to schedule the gap after its atomic apply and before selection.
    // Both wallet instances still read the test indexer and mutate through their real APIs.
    const boundary = second as unknown as { sync(): Promise<void> };
    const sync = boundary.sync.bind(second);
    const barrier = jest
      .spyOn(boundary, "sync")
      .mockImplementationOnce(async () => {
        await sync();
        readComplete();
        await resume;
      });
    const preparing = second.prepareNativePayment({
      operationId: "after-native",
      recipient: { raw: recipient },
      value: 10_000n,
    });
    try {
      await read;
      // Someone rebroadcasts the native bytes; the first instance now learns they were consumed
      // and retires its pending record while the second still has the earlier input snapshot.
      backend.setOutcome("accept");
      await backend.indexer.broadcast(nativeRaw);
      await expect(
        first.sendNative({ recipient: { raw: recipient }, value: 1_000_000n })
      ).rejects.toThrow("Insufficient funds");
      expect(JSON.parse(store.load()!).pending).toEqual([]);
    } finally {
      continueSelection();
      barrier.mockRestore();
    }
    const prepared = await preparing;
    const parsed = parseTransaction(
      unhex(prepared.transaction.rawTransactions[0]),
      network.descriptor
    );
    if (!parsed.ok) throw new Error("unparseable");
    expect(
      hex(Uint8Array.from(parsed.value.inputs[0].prevout.txid).reverse())
    ).toBe("b".repeat(64));
    // The exclusion survives a fresh wallet even when the indexer later returns the old input.
    fund(backend, network, first.identity.address.raw, 70_000n, "a");
    const reopened = (await open(network, backend, store)).wallet;
    expect((await reopened.getNativePayments())[0].transaction).toEqual(
      prepared.transaction
    );
    expect(await reopened.getBalance()).toBe(
      70_000n - 10_000n - feeOf(nativeRaw, network, 70_000n)
    );
  });

  it("fails reopening a foreign-chain operation before any broadcast", async () => {
    const { wallet, backend, store } = await open(network);
    fund(backend, network, wallet.identity.address.raw, 70_000n, "a");
    await wallet.prepareNativePayment({
      operationId: "chain",
      recipient: { raw: recipient },
      value: 10_000n,
    });
    const foreign = JSON.parse(store.load()!);
    foreign.operations[0].chainIdentifier =
      network === BTC ? "bch-testnet" : "btc-testnet";
    foreign.operations[0].phase = "submitted";
    foreign.operations[0].payloadDigests = ["a".repeat(64)];
    const badStore = memoryUtxoWalletStore();
    badStore.save(JSON.stringify(foreign));
    await expect(open(network, backend, badStore)).rejects.toThrow(
      "belongs to another chain"
    );
    expect(backend.broadcasts).toHaveLength(0);
  });

  async function preparedStealth() {
    const backend = makeIndexer();
    const sender = (await open(network, backend)).wallet;
    const custody = syntheticStealthCustody(network);
    const receiverRoot = new Uint8Array(32).fill(11);
    const store = memoryUtxoWalletStore();
    const receiver = await createUtxoChain({
      chainIdentifier: network.chainIdentifier,
      indexer: backend.indexer,
      storeFor: () => store,
      stealthCustody: custody.custody,
    }).createWallet(receiverRoot);
    fund(backend, network, sender.identity.address.raw, 70_000n, "a");
    const destination = deriveUtxoStealthDestination({
      network,
      identityPublicKey: custody.custody.identityPublicKey,
      ephemeralSecret: new Uint8Array(32).fill(17),
    });
    const prepared = await sender.prepareNativePayment({
      operationId: "stealth",
      recipient: { raw: destination.address },
      value: 10_000n,
    });
    const receipt = {
      chainIdentifier: network.chainIdentifier,
      ephemeralPubKey: hex(destination.derivation.ephemeralPubKey),
      transactions: prepared.transaction.rawTransactions,
      claimedAmount: 10_000n,
      payloadDigest: "5".repeat(64),
      timestampMs: 100,
    };
    return {
      backend,
      sender,
      receiver,
      receiverRoot,
      custody,
      store,
      destination,
      prepared,
      receipt,
    };
  }

  it("imports recipient-only stealth, reopens without private keys, restores from a self note, and respends with valid signatures", async () => {
    const f = await preparedStealth();
    expect(f.destination.address).not.toBe(f.receiver.identity.address.raw);
    await f.receiver.recordStealthPayment(f.receipt);
    // Signed-message claims alone never credit the receiver.
    expect(await f.receiver.getBalance()).toBe(0n);
    expect(f.backend.broadcasts).toHaveLength(0);
    await f.sender.recordPaymentExposure({
      operationId: "stealth",
      payloadDigest: f.receipt.payloadDigest,
    });
    await f.sender.submitPreparedPayment("stealth");
    expect(await f.receiver.getBalance()).toBe(10_000n);
    await f.receiver.recordStealthPayment(f.receipt);
    await f.receiver.recordStealthPayment({
      ...f.receipt,
      payloadDigest: "6".repeat(64),
    });
    expect(await f.receiver.getBalance()).toBe(10_000n);
    expect(f.receiver.coins()).toHaveLength(1);
    expect(f.receiver.coins()[0]).toMatchObject({
      origin: "stealth",
      amount: 10_000n,
    });
    expect(f.receiver.coins()[0].privKey).toBeUndefined();
    const stored = JSON.parse(f.store.load()!);
    expect(stored.stealthScripts[0]).not.toHaveProperty("privateKey");
    expect(stored.stealthScripts[0]).not.toHaveProperty("privKey");
    const reopened = (
      await open(network, f.backend, f.store, f.receiverRoot, f.custody.custody)
    ).wallet;
    expect(await reopened.getBalance()).toBe(10_000n);
    const receipts = await reopened.getStealthReceipts();
    expect(receipts).toHaveLength(2);
    expect(receipts[0].address).toBe(f.destination.address);
    // Seed plus a mailbox derivation note works with a genuinely empty local wallet store.
    const restored = (
      await open(
        network,
        f.backend,
        memoryUtxoWalletStore(),
        f.receiverRoot,
        f.custody.custody
      )
    ).wallet;
    expect(await restored.getBalance()).toBe(0n);
    const note = {
      type: "received-coin" as const,
      chainIdentifier: network.chainIdentifier,
      address: f.destination.address,
      origin: "stealth" as const,
      ephemeralPubKey: f.receipt.ephemeralPubKey,
      claimedAmountWei: "10000",
      transactions: f.receipt.transactions,
      payloadDigest: f.receipt.payloadDigest,
      timestamp: 100,
    };
    await expect(
      restored.recordReceivedCoin({
        ...note,
        address: restored.identity.address.raw,
      })
    ).rejects.toThrow("address does not match");
    expect(await restored.getStealthReceipts()).toEqual([]);
    expect(await restored.recordReceivedCoin(note)).toBe(true);
    expect(await restored.recordReceivedCoin(note)).toBe(true);
    expect(await restored.getBalance()).toBe(10_000n);
    expect(restored.coins()).toHaveLength(1);
    const spent = [...reopened.coins()];
    await reopened.sendNative({ recipient: { raw: recipient }, value: 2_000n });
    const raw = f.backend.broadcasts[f.backend.broadcasts.length - 1];
    expectValidSignatures(raw, network, spent);
    expect(await reopened.getBalance()).toBe(
      10_000n - 2_000n - feeOf(raw, network, 10_000n)
    );
  });

  it("rejects wrong-chain, invalid-point, malformed, duplicate and false-amount stealth claims before mutation", async () => {
    const f = await preparedStealth();
    const before = f.store.load();
    for (const receipt of [
      {
        ...f.receipt,
        chainIdentifier: network === BTC ? "bch-testnet" : "btc-testnet",
      },
      { ...f.receipt, ephemeralPubKey: "02" + "ff".repeat(32) },
      { ...f.receipt, ephemeralPubKey: "00".repeat(33) },
      { ...f.receipt, transactions: ["zz"] },
      {
        ...f.receipt,
        transactions: [...f.receipt.transactions, ...f.receipt.transactions],
      },
      { ...f.receipt, claimedAmount: 11_000n },
      { ...f.receipt, claimedAmount: 0n },
    ])
      await expect(f.receiver.recordStealthPayment(receipt)).rejects.toThrow();
    expect(f.store.load()).toBe(before);
    expect(f.backend.broadcasts).toHaveLength(0);
    expect(await f.receiver.getBalance()).toBe(0n);
  });

  it("keeps stealth import persistence failures observable and replayable", async () => {
    const f = await preparedStealth();
    const durable = memoryUtxoWalletStore();
    let fail = false;
    const store = {
      load: () => durable.load(),
      save: (value: string) => {
        if (fail) throw new Error("storage full");
        durable.save(value);
      },
    };
    const receiver = (
      await open(network, f.backend, store, f.receiverRoot, f.custody.custody)
    ).wallet;
    fail = true;
    await expect(receiver.recordStealthPayment(f.receipt)).rejects.toThrow(
      "storage full"
    );
    fail = false;
    expect(await receiver.getStealthReceipts()).toEqual([]);
    await receiver.recordStealthPayment(f.receipt);
    expect(await receiver.getStealthReceipts()).toHaveLength(1);
    expect(f.backend.broadcasts).toHaveLength(0);
  });

  it("fails restoration with missing, wrong identity or mismatched derived signing custody", async () => {
    const f = await preparedStealth();
    await f.receiver.recordStealthPayment(f.receipt);
    const before = f.store.load();
    await expect(
      open(network, f.backend, f.store, f.receiverRoot)
    ).rejects.toThrow("custody is unavailable");
    const wrong = syntheticStealthCustody(network, new Uint8Array(32).fill(22));
    await expect(
      open(network, f.backend, f.store, f.receiverRoot, wrong.custody)
    ).rejects.toThrow("another identity");
    const mismatch: UtxoStealthCustody = {
      identityPublicKey: f.custody.custody.identityPublicKey,
      deriveStealthSigner: async () => ({
        publicKey: wrong.custody.identityPublicKey,
        sign: () => {
          throw new Error("must not sign");
        },
      }),
    };
    await expect(
      open(network, f.backend, f.store, f.receiverRoot, mismatch)
    ).rejects.toThrow("does not match stored script");
    expect(f.store.load()).toBe(before);
    expect(f.backend.broadcasts).toHaveLength(0);
  });

  it("refuses spending through an expired custody capability without a new signed attempt", async () => {
    const f = await preparedStealth();
    await f.receiver.recordStealthPayment(f.receipt);
    await f.sender.recordPaymentExposure({
      operationId: "stealth",
      payloadDigest: f.receipt.payloadDigest,
    });
    await f.sender.submitPreparedPayment("stealth");
    // Expire after synchronization but before the atomic signing boundary.
    const boundary = f.receiver as unknown as { sync(): Promise<void> };
    const sync = boundary.sync.bind(f.receiver);
    jest.spyOn(boundary, "sync").mockImplementationOnce(async () => {
      await sync();
      f.custody.close();
    });
    const before = f.store.load();
    await expect(
      f.receiver.sendNative({ recipient: { raw: recipient }, value: 2_000n })
    ).rejects.toThrow("custody closed");
    expect(f.store.load()).toBe(before);
    expect(f.backend.broadcasts).toHaveLength(1);
    expect(JSON.parse(f.store.load()!).pending).toEqual([]);
  });

  it("rejects addresses of other networks", async () => {
    const { wallet, backend } = await open(network);
    fund(
      backend,
      network,
      (await wallet.getReceiveAddress()).raw,
      70_000n,
      "a"
    );
    for (const foreign of [
      "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
      "bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6",
      network === BTC ? BCH_RECIPIENT : BTC_RECIPIENT,
      "0x000000000000000000000000000000000000dEaD",
    ]) {
      await expect(
        wallet.sendNative({ recipient: { raw: foreign }, value: 10_000n })
      ).rejects.toThrow("Invalid recipient address");
    }
    expect(backend.broadcasts).toHaveLength(0);
  });
});

function feeOf(raw: string, network: UtxoNetwork, inputTotal: bigint): bigint {
  const parsed = parseTransaction(unhex(raw), network.descriptor);
  if (!parsed.ok) throw new Error("unparseable");
  return (
    inputTotal - parsed.value.outputs.reduce((sum, o) => sum + o.value, 0n)
  );
}

it("refuses stored state it does not understand instead of dropping a pending send", async () => {
  const store = memoryUtxoWalletStore();
  store.save(JSON.stringify({ version: 0, pending: "?" }));
  await expect(open(BTC, makeIndexer(), store)).rejects.toThrow(
    "not in the current format"
  );
});
