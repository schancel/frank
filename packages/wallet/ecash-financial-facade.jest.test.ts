import { execFileSync } from "node:child_process";

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
    rebroadcast: async raws => { sent.push([...raws]); if (options.transport) await options.transport(raws); },
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
      `${fixture}\n${financialFixture}\n(async () => {\n${body}\nconsole.log('PASS');\n})().catch(error => { console.error(error); process.exitCode = 1; });`,
    ],
    { cwd: __dirname, encoding: "utf8", timeout: 30_000 }
  );
  expect(output.trim()).toBe("PASS");
}
const financialFixture = `
const intent = id => ({ operationId: id, chainIdentifier: 'xec-mainnet', asset: { kind: 'native' }, recipientSpendPublicKey: Buffer.from(identityPublicKey, 'hex'), amountAtomic: 1000n, maxNativeFeeAtomic: 1000n });
async function sender(options = {}) {
  const chronik = options.chronik ?? chronikFor();
  const account = HdNode.fromSeed(root.bytes).derivePath("m/44'/1899'/0'");
  const pkh = Buffer.from(shaRmd160(account.derivePath('0/0').pubkey())).toString('hex');
  const coins = Array.from({ length: 8 }, (_, i) => ({ outpoint: { txid: (i + 1).toString().repeat(64), outIdx: i }, sats: 10000n, blockHeight: 800000, isCoinbase: false, isFinal: true }));
  chronik.batchSummary = async scripts => scripts.map(script => ({ numTxs: script.payload === pkh ? 1 : 0, numUtxos: script.payload === pkh ? 8 : 0 }));
  chronik.batchUtxos = async scripts => scripts.map(script => ({ utxos: { outputScript: '76a914' + script.payload + '88ac', utxos: script.payload === pkh ? coins : [] } }));
  return make({ ...options, chronik });
}
function receiptClaim(tx, overrides = {}) {
  return { chainIdentifier: 'xec-mainnet', asset: { kind: 'native' }, recipientDestination: Uint8Array.from(destinationScript.bytecode), ephemeralPublicKey: Buffer.from(destination.ephemeralPubKey, 'hex'), amountAtomic: 7000n, rawTransactions: [tx.rawTransaction], payloadDigest: 'ab'.repeat(32), ...overrides };
}
function chainEvidence(chronik, txs) {
  let tip = 'fa'.repeat(32), canonical = 'bc'.repeat(32), mined = true, spent = false, unavailable = false;
  let rawMismatch = false, txMismatch = false, tipChanges = false, unmined = [];
  let queries = 0;
  chronik.blockchainInfo = async () => ({ tipHeight: 900000, tipHash: tipChanges && ++queries % 2 === 0 ? 'fe'.repeat(32) : tip });
  chronik.tx = async hash => {
    if (unavailable) throw new Error('indexer unavailable');
    const raw = txs.find(tx => tx.txid === hash)?.rawTransaction;
    if (!raw) throw new Error('indexer has no transaction');
    const parsed = Tx.fromHex(raw);
    return { txid: txMismatch ? 'ff'.repeat(32) : hash, outputs: parsed.outputs.map(output => ({ sats: output.sats, outputScript: output.script.toHex(), ...(spent ? { spentBy: { txid: 'dd'.repeat(32), outIdx: 0 } } : {}) })), ...(mined && !unmined.includes(hash) ? { block: { height: 800000, hash: 'bc'.repeat(32) } } : {}) };
  };
  chronik.rawTx = async hash => ({ rawTx: rawMismatch ? '00' : txs.find(tx => tx.txid === hash).rawTransaction });
  chronik.block = async height => ({ blockInfo: { hash: canonical, height } });
  return { set: change => { ({ tip = tip, canonical = canonical, mined = mined, spent = spent, unavailable = unavailable, rawMismatch = rawMismatch, txMismatch = txMismatch, tipChanges = tipChanges, unmined = unmined } = change); } };
}
`;

it(
  "checks unsigned fees before any real signer and quotes without signing",
  () =>
    run(`
  const host = await sender();
  let signs = 0; const original = Ecc.prototype.schnorrSign;
  Ecc.prototype.schnorrSign = function(...args) { signs++; return original.apply(this, args); };
  const before = host.store.get(host.key);
  await assert.rejects(host.wallet.stealthPayments.prepare({ ...intent('over-fee'), maxNativeFeeAtomic: 0n }));
  assert.equal(signs, 0); assert.deepEqual(host.store.get(host.key), before);
  const quote = await host.wallet.estimateFee({ recipient, value: 1000n });
  assert(quote > 0n); assert.equal(signs, 0); assert.equal(host.store.get(host.key), undefined);
  const prepared = await host.wallet.stealthPayments.prepare(intent('accepted'));
  assert(signs > 0); const signed = signs;
  const stored = host.wallet.getEcashOperations()[0];
  assert(BigInt(stored.fee) <= 1000n);
  assert.equal(prepared.members[0].recipientAmountAtomic, 1000n);
  assert.equal(prepared.recipientSpendPublicKey.toString('hex'), identityPublicKey);
  assert.equal(Buffer.from(prepared.recipientDestination).toString('hex'), Address.fromCashAddress(prepared.recipientAddress).toScript().toHex());
  assert.deepEqual(await host.wallet.stealthPayments.prepare(intent('accepted')), prepared); assert.equal(signs, signed);
  await assert.rejects(host.wallet.stealthPayments.prepare({ ...intent('accepted'), amountAtomic: 2000n }));
  await assert.rejects(host.wallet.stealthPayments.prepare({ ...intent('bad-asset'), asset: { kind: 'erc20', contractAddress: '00' } }));
  await assert.rejects(host.wallet.stealthPayments.prepare({ ...intent('missing-ceiling'), maxNativeFeeAtomic: undefined }));
  await assert.rejects(host.wallet.stealthPayments.prepare({ ...intent('source'), sourceAddress: host.wallet.identity.address.raw }));
`),
  35_000
);

it(
  "persists immutable metadata and bytes, resumes by original digest and keeps network waits outside claims",
  () =>
    run(`
  const host = await sender(); const prepared = await host.wallet.stealthPayments.prepare(intent('durable'));
  const snapshot = JSON.stringify(host.store.get(host.key));
  const reopened = await sender({ store: host.store, chronik: host.chronik });
  assert.equal(JSON.stringify(host.store.get(host.key)), snapshot); assert.equal(reopened.sent.length, 0);
  assert.deepEqual(await reopened.wallet.stealthPayments.get('durable'), prepared);
  assert.deepEqual(await reopened.wallet.stealthPayments.list(), [{ operationId: 'durable' }]);
  await reopened.wallet.stealthPayments.expose({ operationId: 'durable', payloadDigest: 'ac'.repeat(32) });
  assert.deepEqual(await reopened.wallet.stealthPayments.list(), [{ operationId: 'durable', payloadDigest: 'ac'.repeat(32) }]);
  await assert.rejects(reopened.wallet.stealthPayments.expose({ operationId: 'durable', payloadDigest: 'ad'.repeat(32) }));
  assert.equal(await reopened.wallet.stealthPayments.release('durable'), false);
  let release, began; const gate = new Promise(resolve => { release = resolve; }); const begun = new Promise(resolve => { began = resolve; });
  const external = await sender({ store: host.store, chronik: host.chronik, transport: async () => { began(); await gate; } }); assert.equal(external.sent.length, 0);
  const pending = external.wallet.stealthPayments.submit('durable');
  await begun;
  const other = await Promise.race([external.wallet.stealthPayments.prepare(intent('unrelated')), new Promise((_,reject) => setTimeout(() => reject(new Error('global network lock')), 1000))]);
  assert.notEqual(other.members[0].txHash, prepared.members[0].txHash);
  release(); assert.equal((await pending).status, 'pending');
  assert.deepEqual(external.sent, [prepared.members.map(member => member.rawTransaction)]);
  assert.equal(await external.wallet.stealthPayments.release('unrelated'), true);
  assert.equal(await external.wallet.stealthPayments.get('unrelated'), undefined);
  const evidence = chainEvidence(external.chronik, prepared.members.map(member => ({ txid: member.txHash, rawTransaction: member.rawTransaction })));
  assert.equal((await external.wallet.stealthPayments.reconcile('durable')).status, 'succeeded');
  evidence.set({ mined: false });
  assert.equal((await external.wallet.stealthPayments.reconcile('durable')).status, 'pending');
  assert.equal(external.wallet.getEcashOperations()[0].state, 'submitted');
`),
  35_000
);

it(
  "separates durable receipt, exact-byte submission and fresh canonical observation",
  () =>
    run(`
  const tx = await payment(); const host = await make(); const claim = receiptClaim(tx);
  await assert.rejects(host.wallet.stealthReceipts.submit(claim), /durable receipt/);
  await host.wallet.stealthReceipts.record(claim); assert.equal(host.sent.length, 0);
  assert.equal(await host.wallet.getBalance(), 0n);
  const evidence = chainEvidence(host.chronik, [tx]);
  const saved = JSON.stringify(host.store.get(host.key));
  let observed = await host.wallet.stealthReceipts.observe(claim);
  assert.equal(observed.status, 'succeeded'); assert.equal(observed.verifiedReceivedAmountAtomic, 7000n); assert.equal(observed.spendability, 'pending'); assert.equal(host.sent.length, 0);
  await host.wallet.stealthReceipts.submit(claim); assert.deepEqual(host.sent, [[tx.rawTransaction]]);
  assert.equal(JSON.stringify(host.store.get(host.key)), saved);
  host.chronik.coins = [coin(tx)];
  assert.equal((await host.wallet.stealthReceipts.observe(claim)).spendability, 'spendable');
  const spend = await host.wallet.prepareNativeOperation({ operationId: 'claim-coin', recipient, value: 1000n });
  assert.equal((await host.wallet.stealthReceipts.observe(claim)).spendability, 'reserved');
  evidence.set({ spent: true }); // a stale UTXO snapshot cannot override the spent transaction fact
  assert.equal((await host.wallet.stealthReceipts.observe(claim)).spendability, 'empty');
  evidence.set({ mined: false, spent: false });
  observed = await host.wallet.stealthReceipts.observe(claim);
  assert.equal(observed.status, 'pending'); assert.equal(observed.verifiedReceivedAmountAtomic, undefined);
  for (const change of [{ unavailable: true }, { canonical: 'ff'.repeat(32) }, { rawMismatch: true }, { txMismatch: true }, { tipChanges: true }]) {
    evidence.set({ unavailable: false, canonical: 'bc'.repeat(32), rawMismatch: false, txMismatch: false, tipChanges: false, mined: true, ...change });
    await assert.rejects(host.wallet.stealthReceipts.observe(claim));
  }
  await assert.rejects(host.wallet.stealthReceipts.submit({ ...claim, recipientDestination: Buffer.from(recipient.raw) }));
  assert.equal(host.sent.length, 1);
  assert.equal(host.wallet.getStealthReceipts().length, 1);
`),
  35_000
);

it(
  "groups exact transaction sets and supports distinct derived accounts in one payload",
  () =>
    run(`
  const first = await payment(), other = await payment(3000n, 89), host = await make();
  const grouped = receiptClaim(first, { amountAtomic: 10000n, rawTransactions: [first.rawTransaction, other.rawTransaction] });
  await host.wallet.stealthReceipts.record(grouped);
  const secondDestination = deriveEcashStealthDestination({ chainIdentifier: 'xec-mainnet', addressPrefix: 'ecash', identityPublicKey, ephemeralSecret: new Uint8Array(32).fill(18) });
  const account = HdNode.fromSeed(new Uint8Array(32).fill(90)).derivePath("m/44'/1899'/0'");
  const sdk = new Wallet(account.seckey(), chronikFor(), account, 0, 'ecash');
  sdk.utxos = [{ outpoint: { txid: 'af'.repeat(32), outIdx: 0 }, sats: 10000n, blockHeight: 800000, isCoinbase: false, isFinal: true, address: sdk.getReceiveAddress(0) }];
  const second = new EcashSdkBackend(sdk, chronikFor(), 'ecash').buildNativeConstruction({ recipient: secondDestination.address, value: 4000n, excludedInputs: [] }).transactions[0];
  const secondClaim = receiptClaim(second, { amountAtomic: 4000n, recipientDestination: Address.fromCashAddress(secondDestination.address).toScript().bytecode, ephemeralPublicKey: Buffer.from(secondDestination.ephemeralPubKey, 'hex') });
  await host.wallet.stealthReceipts.record(secondClaim);
  await host.wallet.stealthReceipts.record(grouped); await host.wallet.stealthReceipts.record(secondClaim);
  assert.equal(host.wallet.getStealthReceipts().length, 2);
  const evidence = chainEvidence(host.chronik, [first, other, second]); evidence.set({ unmined: [other.txid] });
  let result = await host.wallet.stealthReceipts.observe(grouped);
  assert.equal(result.status, 'partial'); assert.equal(result.verifiedReceivedAmountAtomic, 7000n);
  assert.equal((await host.wallet.stealthReceipts.observe(secondClaim)).verifiedReceivedAmountAtomic, 4000n);
  evidence.set({ unmined: [] }); assert.equal((await host.wallet.stealthReceipts.observe(grouped)).status, 'succeeded');
  const saved = JSON.stringify(host.store.get(host.key));
  const reopened = await make({ store: host.store, chronik: host.chronik });
  assert.equal(JSON.stringify(host.store.get(host.key)), saved); assert.equal(reopened.wallet.getStealthReceipts().length, 2);
  await assert.rejects(reopened.wallet.stealthReceipts.record(receiptClaim(first)), /Conflicting/);
`),
  35_000
);

it(
  "rejects expired custody across every facade method and retains failed durable preparations",
  () =>
    run(`
  const options = {}, host = await sender({ custody: custody(options) });
  const prepared = await host.wallet.stealthPayments.prepare(intent('lifetime'));
  await host.wallet.stealthPayments.expose({ operationId: 'lifetime', payloadDigest: 'cd'.repeat(32) });
  const saved = JSON.stringify(host.store.get(host.key)); options.expired = true;
  for (const invoke of [() => host.wallet.stealthPayments.get('lifetime'), () => host.wallet.stealthPayments.list(),
    () => host.wallet.stealthPayments.prepare(intent('expired')), () => host.wallet.stealthPayments.expose({ operationId: 'lifetime', payloadDigest: 'cd'.repeat(32) }),
    () => host.wallet.stealthPayments.submit('lifetime'), () => host.wallet.stealthPayments.reconcile('lifetime'), () => host.wallet.stealthPayments.release('lifetime')]) await assert.rejects(invoke(), /expired/);
  assert.equal(JSON.stringify(host.store.get(host.key)), saved); assert.equal(host.sent.length, 0);
  const fresh = await sender(); const original = fresh.store.put.bind(fresh.store);
  fresh.store.put = () => { throw new Error('durable preparation failed'); };
  const floor = fresh.sdk.changeIndex;
  await assert.rejects(fresh.wallet.stealthPayments.prepare(intent('persist-failure')), /durable preparation failed/);
  assert.equal(fresh.store.get(fresh.key), undefined); assert.equal(fresh.sdk.changeIndex, floor); assert.equal(fresh.sent.length, 0);
  fresh.store.put = original; assert.equal((await fresh.wallet.stealthPayments.prepare(intent('persist-failure'))).members.length, 1);
  const closing = {}, interrupted = await sender({ custody: custody(closing) });
  const immutable = await interrupted.wallet.stealthPayments.prepare(intent('close-before-rpc'));
  const persist = interrupted.store.put.bind(interrupted.store);
  interrupted.store.put = (key, ledger) => {
    persist(key, ledger);
    if (ledger.operations.some(operation => operation.state === 'exposed')) closing.expired = true;
  };
  await assert.rejects(interrupted.wallet.stealthPayments.submit('close-before-rpc'));
  assert.equal(interrupted.sent.length, 0);
  assert.equal(interrupted.wallet.getEcashOperations()[0].state, 'exposed');
  const recovered = await make({ store: interrupted.store });
  await recovered.wallet.stealthPayments.submit('close-before-rpc');
  assert.deepEqual(recovered.sent, [[immutable.members[0].rawTransaction]]);
`),
  35_000
);
