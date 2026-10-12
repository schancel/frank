import { execFileSync } from "node:child_process";
import { deriveEcashStealthDestination } from "./ecash-stealth";
import { stealthEphemeralPublicKey } from "@frank/cashweb/relay/stealth-ephemeral-pubkey";
import { stealthParentSecret } from "@frank/cashweb/relay/stealth-parent";

it("matches Frank's established recipient derivation, including a leading-zero ECDH coordinate", () => {
  const identity = new Uint8Array(32).fill(0x11);
  const identityPublicKey = Buffer.from(
    stealthEphemeralPublicKey(identity, true)
  ).toString("hex");
  for (const ephemeralSecret of [
    new Uint8Array(32).fill(0x22),
    Uint8Array.from([...new Uint8Array(31), 0x6d]),
  ]) {
    const ephemeral = stealthEphemeralPublicKey(ephemeralSecret, true);
    const derived = stealthParentSecret(identity, ephemeral);
    try {
      const expected = Buffer.from(
        stealthEphemeralPublicKey(derived.secret, true)
      ).toString("hex");
      for (const [chainIdentifier, addressPrefix] of [
        ["xec-mainnet", "ecash"],
        ["xec-testnet", "ectest"],
        ["xec-regtest", "ecregtest"],
      ] as const) {
        const destination = deriveEcashStealthDestination({
          chainIdentifier,
          addressPrefix,
          identityPublicKey,
          ephemeralSecret,
        });
        expect(destination.publicKey).toBe(expected);
        expect(destination.ephemeralPubKey).toBe(
          Buffer.from(ephemeral).toString("hex")
        );
        expect(destination.address.startsWith(addressPrefix + ":")).toBe(true);
      }
    } finally {
      derived.secret.fill(0);
      derived.digest.fill(0);
    }
  }
});

// Actual SDK/WASM with synthetic custody/indexer only. No network, owner key or browser storage.
const fixture = `
const assert = require('node:assert/strict');
const { Wallet } = require('ecash-wallet');
const { HdNode, Ecc, Address, Script, shaRmd160, sha256d, Tx, UnsignedTx, ALL_BIP143 } = require('ecash-lib');
const { EcashWallet, ECASH_MAINNET_CHECKPOINT_HASH } = require('./ecash-wallet.ts');
const { EcashSdkBackend } = require('./ecash-sdk-backend.ts');
const { createEcashStealthSeedBackend } = require('./ecash-seed-boundary.ts');
const { deriveEcashStealthDestination } = require('./ecash-stealth.ts');
const { secp256k1 } = require('@noble/curves/secp256k1');
const { sha256 } = require('@noble/hashes/sha256');
function stealthParentSecret(secret, ephemeral) {
  const digest = sha256(secp256k1.getSharedSecret(secret, ephemeral, true));
  const scalar = (BigInt('0x' + Buffer.from(secret).toString('hex')) + BigInt('0x' + Buffer.from(digest).toString('hex'))) % secp256k1.CURVE.n;
  return { secret: Uint8Array.from(Buffer.from(scalar.toString(16).padStart(64, '0'), 'hex')), digest };
}
const { InMemoryEcashOperationStore } = require('./ecash-operation-store.ts');
const { InMemoryNativeTransactionAttemptStore, nativeTransactionAttemptKey } = require('./chain/chain-wallet.ts');
const root = { registry: 'frank-domain-roots-v1', purpose: 'ecash-bch-wallet', bytes: new Uint8Array(32).fill(9) };
const identitySecret = new Uint8Array(32).fill(55), ephemeralSecret = new Uint8Array(32).fill(17);
const identityPublicKey = Buffer.from(new Ecc().derivePubkey(identitySecret)).toString('hex');
const destination = deriveEcashStealthDestination({ chainIdentifier: 'xec-mainnet', addressPrefix: 'ecash', identityPublicKey, ephemeralSecret });
const destinationScript = Address.fromCashAddress(destination.address).toScript();
const destinationPkh = destinationScript.toHex().slice(6, 46);
const recipient = { raw: Address.p2pkh(new Uint8Array(20).fill(31), 'ecash').toString() };
const tempSecrets = [];
function custody(options = {}) {
  return {
    identityPublicKey: options.identityPublicKey ?? identityPublicKey,
    assertActive: () => { if (options.expired) throw new Error('custody expired'); },
    withDerivedStealthSecret: async (derivation, callback) => {
      assert.equal(derivation.chainIdentifier, 'xec-mainnet');
      const { secret, digest } = stealthParentSecret(options.secret ?? identitySecret, Buffer.from(derivation.ephemeralPubKey, 'hex'));
      digest.fill(0); tempSecrets.push(secret); callback(secret);
      assert(secret.every(byte => byte === 0), 'backend must wipe callback secret');
    },
  };
}
function chronikFor() {
  const state = { coins: [], queries: 0, wrongScript: false };
  return Object.assign(state, {
    proxyInterface: () => ({ getEndpointArray: () => [{ url: 'http://127.0.0.1:1' }] }),
    blockchainInfo: async () => ({ tipHeight: 900000 }),
    batchSummary: async scripts => scripts.map(() => ({ numTxs: 0, numUtxos: 0 })),
    batchUtxos: async scripts => scripts.map(s => ({ utxos: { outputScript: '76a914' + s.payload + '88ac', utxos: [] } })),
    script: (type, payload) => ({ utxos: async () => {
      state.queries++; assert.equal(type, 'p2pkh');
      return { outputScript: state.wrongScript ? '00' : '76a914' + payload + '88ac', utxos: payload === destinationPkh ? state.coins : [] };
    }}),
    broadcastTx: async () => { throw new Error('network forbidden'); },
  });
}
async function make(options = {}) {
  const store = options.store ?? new InMemoryEcashOperationStore();
  const chronik = options.chronik ?? chronikFor();
  const sent = []; let backend, sdk;
  const injected = options.missing ? undefined : (options.custody ?? custody());
  const wallet = await EcashWallet.fromDomainRoot({
    domainRoot: root, networkId: 'xec-mainnet', chronik, operationStore: store,
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
    checkpointClientFactory: () => ({ block: async () => ({ blockInfo: { hash: ECASH_MAINNET_CHECKPOINT_HASH } }) }),
    rebroadcast: async raws => { sent.push([...raws]); },
    walletFactory: options.productionFactory ? createEcashStealthSeedBackend(injected) : ({ domainRoot, chronik, addressPrefix }) => {
      const account = HdNode.fromSeed(domainRoot.bytes).derivePath("m/44'/1899'/0'");
      sdk = new Wallet(account.seckey(), chronik, account, 0, addressPrefix);
      backend = new EcashSdkBackend(sdk, chronik, addressPrefix, injected); return backend;
    },
  });
  return { wallet, backend, sdk, store, chronik, sent, key: nativeTransactionAttemptKey({ family: 'bitcoin', chainIdentifier: 'xec-mainnet', address: wallet.identity.address.raw }) };
}
async function payment(value = 7000n, seedByte = 88) {
  const account = HdNode.fromSeed(new Uint8Array(32).fill(seedByte)).derivePath("m/44'/1899'/0'");
  const sdk = new Wallet(account.seckey(), chronikFor(), account, 0, 'ecash');
  sdk.utxos = [{ outpoint: { txid: seedByte.toString(16).repeat(32), outIdx: 0 }, sats: 100000n, blockHeight: 800000, isCoinbase: false, isFinal: true, address: sdk.getReceiveAddress(0) }];
  const built = new EcashSdkBackend(sdk, chronikFor(), 'ecash').buildNativeConstruction({ recipient: destination.address, value, excludedInputs: [] });
  return built.transactions[0];
}
function claim(tx, overrides = {}) {
  return { chainIdentifier: 'xec-mainnet', ephemeralPubKey: destination.ephemeralPubKey, claimedAmount: 7000n, transactions: [tx.rawTransaction], payloadDigest: 'ab'.repeat(32), timestamp: 100, ...overrides };
}
function coin(tx, sats = 7000n) {
  return { outpoint: { txid: tx.txid, outIdx: 0 }, sats, blockHeight: 800000, isCoinbase: false, isFinal: true };
}
`;
function run(body: string): void {
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--eval",
      `${fixture}\n(async () => {\n${body}\nconsole.log('PASS');\n})().catch(error => { console.error(error); process.exitCode = 1; });`,
    ],
    { cwd: __dirname, encoding: "utf8", timeout: 30_000 }
  );
  expect(output.trim()).toBe("PASS");
}

it(
  "validates recipient outputs, restores custody before discovery and signs a newly claimed respend",
  () =>
    run(`
  const tx = await payment(); const first = await make();
  assert.equal(first.store.get(first.key), undefined);
  const receipt = await first.wallet.recordStealthPayment(claim(tx));
  assert.equal(receipt.address, destination.address); assert.equal(receipt.publicKey, destination.publicKey);
  assert.equal(await first.wallet.getBalance(), 0n); // claims do not credit inventory
  assert.equal(first.wallet.getStealthReceipts().length, 1);
  assert.equal(first.sdk.utxos.length, 0);
  const publicBytes = JSON.stringify(first.store.get(first.key));
  assert(!publicBytes.includes(Buffer.from(identitySecret).toString('hex')));
  const derived = stealthParentSecret(identitySecret, Buffer.from(destination.ephemeralPubKey, 'hex')).secret;
  assert(!publicBytes.includes(Buffer.from(derived).toString('hex'))); derived.fill(0);
  first.chronik.coins = [coin(tx)];
  const before = JSON.stringify(first.store.get(first.key));
  const reopened = await make({ store: first.store, chronik: first.chronik });
  assert.equal(JSON.stringify(first.store.get(first.key)), before); assert.equal(reopened.sent.length, 0);
  assert.equal(await reopened.wallet.getBalance(), 7000n);
  assert.equal(await reopened.wallet.getBalance(), 7000n); assert.equal(reopened.sdk.utxos.length, 1);
  assert.equal(typeof reopened.wallet.withDerivedStealthSecret, 'undefined');
  const spend = await reopened.wallet.prepareNativeOperation({ operationId: 'respend', recipient, value: 1000n, maxFee: 1000n });
  assert.deepEqual(spend.inputs, [{ txid: tx.txid, vout: 0, satoshis: '7000' }]);
  assert(spend.nextChangeIndex > 0); assert.equal(spend.state, 'prepared');
  assert.equal(await reopened.wallet.getBalance(), 0n);
  await assert.rejects(reopened.wallet.prepareNativeOperation({ operationId: 'competing', recipient, value: 1000n }));
  const signed = Tx.fromHex(spend.transactions[0].rawTransaction);
  signed.inputs[0].signData = { sats: 7000n, outputScript: destinationScript };
  const signature = signed.inputs[0].script.bytecode.slice(1,65);
  const digest = sha256d(UnsignedTx.fromTx(signed).inputAt(0).sigHashPreimage(ALL_BIP143).bytes);
  new Ecc().schnorrVerify(signature, digest, Buffer.from(destination.publicKey, 'hex'));
  assert.throws(() => new Ecc().schnorrVerify(signature, digest, new Ecc().derivePubkey(ephemeralSecret)));
  await reopened.wallet.submitNativeOperation('respend');
  assert.deepEqual(reopened.sent, [[spend.transactions[0].rawTransaction]]);
  const again = await make({ store: first.store, chronik: first.chronik });
  assert.equal(await again.wallet.getBalance(), 0n); assert(tempSecrets.every(key => key.every(byte => byte === 0)));
`),
  35_000
);

it(
  "replays complete self notes idempotently and rejects conflicting, partial and malformed claims",
  () =>
    run(`
  const tx = await payment(), second = await payment(5000n, 89); const host = await make();
  const note = { type: 'received-coin', origin: 'stealth', chainIdentifier: 'xec-mainnet', address: destination.address,
    ephemeralPubKey: destination.ephemeralPubKey, claimedAmountWei: '7000', transactions: [tx.rawTransaction], payloadDigest: 'ab'.repeat(32), timestamp: 100 };
  assert.equal(await host.wallet.recordReceivedCoin(note), true);
  const saved = JSON.stringify(host.store.get(host.key));
  assert.equal(await host.wallet.recordReceivedCoin(note), true);
  await host.wallet.recordStealthPayment(claim(tx, { payloadDigest: 'cd'.repeat(32) }));
  assert.equal(JSON.stringify(host.store.get(host.key)), saved);
  const invalid = [
    { chainIdentifier: 'xec-testnet' }, { ephemeralPubKey: '00'.repeat(33) },
    { claimedAmount: 6999n }, { claimedAmount: 0n }, { claimedAmount: 1n << 64n },
    { payloadDigest: 'bad' }, { timestamp: -1 }, { transactions: ['00'] },
    { transactions: [tx.rawTransaction, tx.rawTransaction], claimedAmount: 14000n },
    { transactions: [second.rawTransaction], claimedAmount: 7000n },
    { transactions: [tx.rawTransaction, second.rawTransaction], claimedAmount: 12000n, payloadDigest: 'ef'.repeat(32) },
  ];
  for (const change of invalid) await assert.rejects(host.wallet.recordStealthPayment(claim(tx, change)));
  for (const change of [{ address: recipient.raw }, { transactions: undefined }, { payloadDigest: undefined }, { origin: 'stamp' }])
    await assert.rejects(host.wallet.recordReceivedCoin({ ...note, ...change }));
  assert.equal(JSON.stringify(host.store.get(host.key)), saved);
  await host.wallet.recordStealthPayment(claim(second, { claimedAmount: 5000n, payloadDigest: 'ef'.repeat(32) }));
  assert.equal(host.wallet.getStealthReceipts().length, 2);
  host.chronik.coins = [coin(tx), coin(second, 5000n)];
  assert.equal(await host.wallet.getBalance(), 12000n); assert.equal(host.sdk.utxos.length, 2);
`),
  35_000
);

it(
  "fails visibly on missing, mismatched and expired custody and keeps durable restoration read-only",
  () =>
    run(`
  const tx = await payment(), first = await make(); await first.wallet.recordStealthPayment(claim(tx));
  first.chronik.coins = [coin(tx)]; const saved = JSON.stringify(first.store.get(first.key));
  for (const options of [ { missing: true }, { custody: custody({ identityPublicKey: destination.publicKey }) },
    { custody: custody({ secret: new Uint8Array(32).fill(56) }) }, { custody: custody({ expired: true }) } ]) {
    const queries = first.chronik.queries;
    await assert.rejects(make({ ...options, store: first.store, chronik: first.chronik }), /custody|identity|derivation/);
    assert.equal(first.chronik.queries, queries); assert.equal(JSON.stringify(first.store.get(first.key)), saved);
  }
  const options = {}; const active = await make({ store: first.store, chronik: first.chronik, custody: custody(options) });
  options.expired = true; const queries = first.chronik.queries;
  await assert.rejects(active.wallet.getBalance(), /expired/);
  await assert.rejects(active.wallet.getReceiveAddress(), /expired/);
  assert.throws(() => active.backend.buildNativeConstruction({ recipient: recipient.raw, value: 1000n, excludedInputs: [] }), /expired/);
  assert.equal(first.chronik.queries, queries);
  assert.equal(JSON.stringify(first.store.get(first.key)), saved);
  for (const mutate of [receipt => { receipt.claimedAmount = '7001'; }, receipt => { receipt.derivation.chainIdentifier = 'xec-testnet'; }]) {
    const corrupt = new InMemoryEcashOperationStore(), ledger = JSON.parse(saved);
    mutate(ledger.stealthReceipts[0]); corrupt.put(first.key, ledger);
    const original = JSON.stringify(corrupt.get(first.key));
    await assert.rejects(make({ store: corrupt, chronik: first.chronik }), /receipt|amount/);
    assert.equal(first.chronik.queries, queries); assert.equal(JSON.stringify(corrupt.get(first.key)), original);
  }
`),
  35_000
);

it(
  "does not import keys before durable receipt persistence and rejects wrong indexer scripts",
  () =>
    run(`
  const tx = await payment(), host = await make(); const initialKeys = host.sdk.keypairs.size;
  const put = host.store.put.bind(host.store);
  host.store.put = () => { throw new Error('receipt write failed'); };
  await assert.rejects(host.wallet.recordStealthPayment(claim(tx)), /write failed/);
  assert.equal(host.sdk.keypairs.size, initialKeys); assert.equal(host.store.get(host.key), undefined);
  host.store.put = put; await host.wallet.recordStealthPayment(claim(tx));
  host.chronik.coins = [coin(tx)]; host.chronik.wrongScript = true;
  await assert.rejects(host.wallet.getBalance(), /wrong imported eCash script/);
  host.chronik.wrongScript = false; assert.equal(await host.wallet.getBalance(), 7000n);
  assert.throws(() => deriveEcashStealthDestination({ chainIdentifier: 'xec-testnet', addressPrefix: 'ecash', identityPublicKey, ephemeralSecret }), /chain binding/);
  assert.throws(() => deriveEcashStealthDestination({ chainIdentifier: 'made-up', addressPrefix: 'ecash', identityPublicKey, ephemeralSecret }), /chain binding/);
`),
  35_000
);

it(
  "injects published identity custody through the seed factory without changing the SDK HD root",
  () =>
    run(`
  const host = await make({ productionFactory: true });
  const account = HdNode.fromSeed(root.bytes).derivePath("m/44'/1899'/0'");
  const hdPublic = account.derivePath('0/0').pubkey();
  assert.notEqual(Buffer.from(hdPublic).toString('hex'), identityPublicKey);
  assert.equal(host.wallet.identity.address.raw, Address.p2pkh(shaRmd160(hdPublic), 'ecash').toString());
  const tx = await payment(); await host.wallet.recordStealthPayment(claim(tx));
  host.chronik.coins = [coin(tx)];
  const reopened = await make({ productionFactory: true, store: host.store, chronik: host.chronik });
  assert.deepEqual(reopened.wallet.identity, host.wallet.identity);
  assert.equal(await reopened.wallet.getBalance(), 7000n);
  const operation = await reopened.wallet.prepareNativeOperation({ operationId: 'factory-respend', recipient, value: 1000n });
  assert.equal(operation.inputs[0].txid, tx.txid); assert.equal(operation.state, 'prepared');
`),
  35_000
);
