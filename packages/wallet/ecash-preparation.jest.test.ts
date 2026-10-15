import { execFileSync } from "node:child_process";

// Production SDK/WASM runs in Node outside Jest's CJS transform. Every indexer and transport
// response is synthetic; no socket, browser profile, funded key or owner storage is opened.
const fixture = `
const assert = require('node:assert/strict');
const { EcashWallet, ECASH_MAINNET_CHECKPOINT_HASH, ECASH_TESTNET_CHECKPOINT_HASH } = require('./ecash-wallet.ts');
const { createEcashSeedBackend } = require('./ecash-seed-boundary.ts');
const { InMemoryEcashOperationStore } = require('./ecash-operation-store.ts');
const { InMemoryNativeTransactionAttemptStore, nativeTransactionAttemptKey, runNativeTransactionExclusive } = require('./chain/chain-wallet.ts');
const { HdNode, Address, shaRmd160, Tx, mnemonicToSeed } = require('ecash-lib');
const root = { registry: 'frank-domain-roots-v1', purpose: 'ecash-bch-wallet', bytes: new Uint8Array(32).fill(9) };
const recipient = { raw: Address.p2pkh(new Uint8Array(20).fill(31), 'ecash').toString() };
const params = operationId => ({ operationId, recipient, value: 1000n, maxFee: 1000n });
function chronikFor(seed, chain = 'xec-mainnet') {
  const account = HdNode.fromSeed(seed).derivePath("m/44'/1899'/0'");
  const firstPkh = Buffer.from(shaRmd160(account.derivePath('0/0').pubkey())).toString('hex');
  const coins = Array.from({ length: 8 }, (_, i) => ({ outpoint: { txid: (i + 1).toString(16).padStart(64, '0'), outIdx: i }, sats: 10000n, blockHeight: 800000, isCoinbase: false, isFinal: true }));
  return {
    coins,
    checkpoint: chain === 'xec-testnet' ? ECASH_TESTNET_CHECKPOINT_HASH : ECASH_MAINNET_CHECKPOINT_HASH,
    proxyInterface: () => ({ getEndpointArray: () => [{ url: 'http://127.0.0.1:1' }] }),
    blockchainInfo: async () => ({ tipHeight: 900000 }),
    batchSummary: async scripts => scripts.map(s => ({ numTxs: s.payload === firstPkh ? 1 : 0, numUtxos: s.payload === firstPkh ? coins.length : 0 })),
    batchUtxos: async scripts => scripts.map(s => ({ utxos: { outputScript: '76a914' + s.payload + '88ac', utxos: s.payload === firstPkh ? coins : [] } })),
    broadcastTx: async () => { throw new Error('use the injected signed-byte transport'); },
  };
}
async function make(options = {}) {
  const store = options.store ?? new InMemoryEcashOperationStore();
  const old = options.old ?? new InMemoryNativeTransactionAttemptStore();
  const chain = options.chain ?? 'xec-mainnet';
  const chronik = options.chronik ?? chronikFor(root.bytes, chain);
  const sent = [];
  const common = {
    networkId: chain, chronik, operationStore: store, nativeAttemptStore: old,
    checkpointClientFactory: () => ({ block: async () => ({ blockInfo: { hash: chronik.checkpoint } }) }),
    rebroadcast: async raws => { sent.push([...raws]); if (options.transport) await options.transport(raws); },
    getTransactionStatus: options.status ?? (async () => 'unknown'),
  };
  const wallet = options.legacyMnemonic
    ? await EcashWallet.fromLegacyMnemonic({ ...common, mnemonic: options.legacyMnemonic })
    : await EcashWallet.fromDomainRoot({ ...common, domainRoot: root, walletFactory: options.walletFactory ?? createEcashSeedBackend });
  return { wallet, store, old, chronik, sent, key: nativeTransactionAttemptKey({ family: 'bitcoin', chainIdentifier: chain, address: wallet.identity.address.raw }) };
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const turn = () => new Promise(resolve => setImmediate(resolve));
const binding = (wallet, operation) => ({ chainIdentifier: wallet.chainIdentifier, walletAddress: wallet.identity.address.raw, transactionHashes: operation.transactions.map(tx => tx.txid), externalPayloadDigest: 'ab'.repeat(32) });
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
  "publishes immutable local observations during coalesced refresh and preserves them on failure",
  () =>
    run(`
  const first = await make();
  const initial = (await first.wallet.getBalanceObservation());
  assert.equal(initial.balance, 80000n);
  assert.equal((await first.store.get(first.key)), undefined);
  let reads = 0;
  const original = first.chronik.batchUtxos;
  first.chronik.batchUtxos = async scripts => { reads++; return original(scripts); };
  await first.wallet.getBalance();
  const singleRefreshReads = reads;
  assert(singleRefreshReads > 0);
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { started = resolve; });
  first.chronik.batchUtxos = async scripts => { reads++; started(); await gate; return original(scripts); };
  const before = reads;
  const left = first.wallet.getBalance(), right = first.wallet.getBalance();
  assert.equal(left, right);
  await began;
  const observed = (await first.wallet.getBalanceObservation());
  first.chronik.coins[0].sats = 20000n;
  assert.deepEqual((await first.wallet.getBalanceObservation()), observed);
  release();
  assert.equal(await left, 90000n);
  assert.equal(reads - before, singleRefreshReads);
  const complete = (await first.wallet.getBalanceObservation());
  first.chronik.coins[0].sats = 30000n;
  first.chronik.batchUtxos = async () => { throw new Error('offline'); };
  first.chronik.script = () => ({ utxos: async () => { throw new Error('offline'); } });
  await assert.rejects(first.wallet.getBalance(), /offline/);
  assert.deepEqual((await first.wallet.getBalanceObservation()), complete);
  assert.equal((await first.store.get(first.key)), undefined);
`),
  35000
);

it(
  "filters cross-instance reservations, ambiguous attempts and canonical chain isolation from cached observations",
  () =>
    run(`
  const store = new InMemoryEcashOperationStore();
  const first = await make({ store });
  const other = await make({ store });
  const test = await make({ store, chain: 'xec-testnet' });
  assert.equal((await first.wallet.getBalanceObservation()).balance, 80000n);
  const prepared = await other.wallet.prepareNativeOperation(params('observe-held'));
  assert.equal((await first.wallet.getBalanceObservation()).balance, 70000n);
  assert.equal((await test.wallet.getBalanceObservation()).balance, 80000n);
  await other.wallet.releaseNativeOperation(prepared.operationId);
  assert.equal((await first.wallet.getBalanceObservation()).balance, 80000n);
  const exposed = await other.wallet.prepareNativeOperation(params('observe-exposed'));
  await other.wallet.recordNativeOperationExposure({ operationId: exposed.operationId, binding: binding(other.wallet, exposed) });
  assert.equal((await first.wallet.getBalanceObservation()).balance, 70000n);
  const reopened = await make({ store, transport: async () => { throw new Error('ambiguous'); } });
  assert.equal((await reopened.wallet.getBalanceObservation()).balance, 70000n);
  assert.equal((await test.wallet.getBalanceObservation()).balance, 80000n);
`),
  35000
);

it(
  "does not publish a competing SDK refresh's partial inventory when its final tip read fails",
  () =>
    run(`
  let backend;
  const first = await make({ walletFactory: async params => { backend = await createEcashSeedBackend(params); return backend; } });
  let unlock, locked, complete, tipStarted, rejectTip;
  const lockGate = new Promise(resolve => { unlock = resolve; });
  const lockBegan = new Promise(resolve => { locked = resolve; });
  const synced = new Promise(resolve => { complete = resolve; });
  const tipBegan = new Promise(resolve => { tipStarted = resolve; });
  const tipGate = new Promise((_, reject) => { rejectTip = reject; });
  const holding = runNativeTransactionExclusive(first.key, 'single-realm', async () => { locked(); await lockGate; });
  await lockBegan;
  const sync = backend.sync.bind(backend);
  backend.sync = async () => { await sync(); complete(); };
  first.chronik.coins.forEach(coin => { coin.sats = 20000n; });
  const balance = first.wallet.getBalance();
  await synced;
  first.chronik.coins.forEach(coin => { coin.sats = 30000n; });
  first.chronik.blockchainInfo = async () => { tipStarted(); return tipGate; };
  const estimate = first.wallet.estimateFee({ recipient, value: 1000n });
  const failedEstimate = assert.rejects(estimate, /tip offline/);
  await tipBegan;
  // The SDK has already replaced its live inventory, but this refresh has not completed.
  assert.equal(backend.balanceSats, 240000n);
  unlock(); await holding;
  assert.equal(await balance, 160000n);
  assert.equal((await first.wallet.getBalanceObservation()).balance, 160000n);
  rejectTip(new Error('tip offline')); await failedEstimate;
  assert.equal((await first.wallet.getBalanceObservation()).balance, 160000n);
`),
  35000
);

it(
  "claims disjoint inputs and change across shared-store instances while other broadcasts wait",
  () =>
    run(`
  const store = new InMemoryEcashOperationStore();
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { started = resolve; });
  const first = await make({ store, transport: async () => { started(); await gate; } });
  const second = await make({ store });
  const send = first.wallet.sendNative({ recipient, value: 1000n, maxFee: 1000n });
  await began;
  const prepared = await Promise.race([second.wallet.prepareNativeOperation(params('unrelated')), new Promise((_, reject) => setTimeout(() => reject(new Error('wallet-wide network lock')), 1500))]);
  const exposed = (await first.wallet.getEcashOperations()).find(o => o.state === 'exposed');
  assert.notEqual(exposed.inputs[0].txid, prepared.inputs[0].txid);
  assert.notEqual(Tx.fromHex(exposed.transactions[0].rawTransaction).outputs[1].script.toHex(), Tx.fromHex(prepared.transactions[0].rawTransaction).outputs[1].script.toHex());
  assert.equal((await store.get(first.key)).nextChangeIndex, 2);
  assert.equal(await second.wallet.getBalance(), 60000n);
  release(); await send;
  const pair = await Promise.all([first.wallet.prepareNativeOperation(params('parallel-a')), second.wallet.prepareNativeOperation(params('parallel-b'))]);
  assert.notEqual(pair[0].inputs[0].txid, pair[1].inputs[0].txid);
  assert.equal((await store.get(first.key)).nextChangeIndex, 4);
`),
  35_000
);

it(
  "reopens prepared operations without writes or broadcasts and releases only unexposed claims",
  () =>
    run(`
  const first = await make();
  assert.equal((await first.store.get(first.key)), undefined);
  const operation = await first.wallet.prepareNativeOperation(params('held'));
  assert.equal(first.sent.length, 0);
  const saved = JSON.stringify((await first.store.get(first.key)));
  let writes = 0;
  const put = first.store.put.bind(first.store);
  first.store.put = (...args) => { writes++; return put(...args); };
  const restored = await make({ store: first.store });
  assert.equal(writes, 0); assert.equal(restored.sent.length, 0);
  assert.equal(JSON.stringify((await first.store.get(first.key))), saved);
  assert.deepEqual(await restored.wallet.prepareNativeOperation(params('held')), operation);
  await assert.rejects(restored.wallet.prepareNativeOperation({ ...params('held'), value: 1001n }), /another intent/);
  await restored.wallet.releaseNativeOperation('held');
  assert.equal(await restored.wallet.getBalance(), 80000n);
  await assert.rejects(restored.wallet.submitNativeOperation('held'), /cannot be submitted/);
  await assert.rejects(restored.wallet.prepareNativeOperation(params('held')), /cannot be reused/);
  const next = await restored.wallet.prepareNativeOperation(params('next'));
  assert.equal((await first.store.get(first.key)).nextChangeIndex, 2);
  assert.notEqual(Tx.fromHex(next.transactions[0].rawTransaction).outputs[1].script.toHex(), Tx.fromHex(operation.transactions[0].rawTransaction).outputs[1].script.toHex());
`),
  35_000
);

it(
  "binds external exposure and retains claims through rejection, restart and repeated replay",
  () =>
    run(`
  const first = await make({ transport: async () => { throw new Error('Failed getting /broadcast-txs: txn-mempool-conflict'); } });
  const operation = await first.wallet.prepareNativeOperation(params('external'));
  const bound = binding(first.wallet, operation);
  for (const bad of [{ ...bound, chainIdentifier: 'xec-testnet' }, { ...bound, walletAddress: recipient.raw }, { ...bound, transactionHashes: ['00'.repeat(32)] }, { ...bound, externalPayloadDigest: 'not-a-digest' }])
    await assert.rejects(first.wallet.recordNativeOperationExposure({ operationId: 'external', binding: bad }), /does not match/);
  assert.equal((await first.wallet.getEcashOperations())[0].state, 'prepared');
  await first.wallet.recordNativeOperationExposure({ operationId: 'external', binding: bound });
  await first.wallet.recordNativeOperationExposure({ operationId: 'external', binding: bound });
  await assert.rejects(first.wallet.recordNativeOperationExposure({ operationId: 'external', binding: { ...bound, externalPayloadDigest: 'cd'.repeat(32) } }), /already bound/);
  await assert.rejects(first.wallet.releaseNativeOperation('external'), /cannot be released/);
  await assert.rejects(first.wallet.submitNativeOperation('external'));
  assert.equal((await first.wallet.getEcashOperations())[0].state, 'exposed');
  const restored = await make({ store: first.store });
  assert.equal(restored.sent.length, 0); // External delivery/replay remains the host's job.
  await restored.wallet.submitNativeOperation('external');
  await restored.wallet.submitNativeOperation('external');
  assert.deepEqual(restored.sent, [[operation.transactions[0].rawTransaction], [operation.transactions[0].rawTransaction]]);
  assert.equal((await restored.wallet.getEcashOperations())[0].state, 'submitted');
  await assert.rejects(restored.wallet.releaseNativeOperation('external'), /cannot be released/);
  assert.equal(await restored.wallet.getBalance(), 70000n);
`),
  35_000
);

it(
  "persists before exposure, survives native RPC interruption and never substitutes another payment",
  () =>
    run(`
  const first = await make({ transport: async () => { throw new Error('timeout'); } });
  await assert.rejects(first.wallet.sendNative({ recipient, value: 1000n, maxFee: 1000n, onSigned: async tx => {
    const op = (await first.wallet.getEcashOperations())[0];
    assert.equal(op.state, 'exposed'); assert.equal(op.transactions[0].txid, tx.txHash);
    assert.equal(first.sent.length, 0);
  } }));
  const operation = (await first.wallet.getEcashOperations())[0];
  const restored = await make({ store: first.store });
  assert.deepEqual(restored.sent, [[operation.transactions[0].rawTransaction]]);
  assert.equal((await restored.wallet.getEcashOperations()).length, 1);
  assert.equal((await restored.wallet.getEcashOperations())[0].state, 'submitted');
  const later = await restored.wallet.prepareNativeOperation(params('later'));
  assert.notEqual(later.inputs[0].txid, operation.inputs[0].txid);
  const callback = await make();
  await assert.rejects(callback.wallet.sendNative({ recipient, value: 1000n, onSigned: async () => { throw new Error('host write interrupted'); } }));
  assert.equal(callback.sent.length, 0);
  assert.equal((await callback.wallet.getEcashOperations())[0].state, 'exposed');
`),
  35_000
);

it(
  "fails closed on durable-write failure, fee rises and intent mutation across indexer awaits",
  () =>
    run(`
  const first = await make();
  const put = first.store.put.bind(first.store);
  first.store.put = () => { throw new Error('disk full'); };
  await assert.rejects(first.wallet.sendNative({ recipient, value: 1000n }), /disk full/);
  assert.equal(first.sent.length, 0); assert.equal((await first.store.get(first.key)), undefined);
  first.store.put = put;
  await assert.rejects(first.wallet.prepareNativeOperation({ ...params('fee'), maxFee: 0n }));
  assert.equal((await first.store.get(first.key)), undefined);
  const originalBatch = first.chronik.batchUtxos;
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { started = resolve; });
  first.chronik.batchUtxos = async scripts => { started(); await gate; return originalBatch(scripts); };
  const mutable = params('immutable');
  const preparing = first.wallet.prepareNativeOperation(mutable);
  await began; mutable.value = 5000n; mutable.operationId = 'changed'; mutable.recipient = { raw: 'bad' }; mutable.maxFee = 0n; release();
  const op = await preparing;
  assert.equal(op.operationId, 'immutable'); assert.equal(op.intent.value, '1000'); assert.equal(op.intent.recipient, recipient.raw); assert.equal(op.intent.maxFee, '1000');
  first.store.put = () => { throw new Error('exposure disk full'); };
  await assert.rejects(first.wallet.submitNativeOperation(op.operationId), /exposure disk full/);
  assert.equal(first.sent.length, 0); assert.equal((await first.wallet.getEcashOperations())[0].state, 'prepared');
  let accepted = false;
  const late = await make({ transport: async () => { accepted = true; } });
  const latePut = late.store.put.bind(late.store);
  late.store.put = (...args) => { if (accepted) throw new Error('post-broadcast journal failure'); return latePut(...args); };
  await assert.rejects(late.wallet.sendNative({ recipient, value: 1000n }), error => error.transaction !== undefined && error.reason.message === 'post-broadcast journal failure');
  assert.equal(late.sent.length, 1); assert.equal((await late.wallet.getEcashOperations())[0].state, 'exposed');
  late.store.put = latePut;
  const replayed = await make({ store: late.store });
  assert.deepEqual(replayed.sent[0], late.sent[0]);
`),
  35_000
);

it(
  "keeps old signed obligations in their original owner while deriving exclusions",
  () =>
    run(`
  const source = await make();
  const oldOperation = await source.wallet.prepareNativeOperation(params('old-source'));
  const old = new InMemoryNativeTransactionAttemptStore();
  const transaction = { txHash: oldOperation.transactions[0].txid, rawTransactions: [oldOperation.transactions[0].rawTransaction] };
  old.put(source.key, transaction);
  const restored = await make({ old });
  assert.deepEqual(old.get(source.key), transaction);
  assert.deepEqual(restored.sent, [transaction.rawTransactions]);
  assert.equal((await restored.store.get(source.key)), undefined);
  const fresh = await restored.wallet.prepareNativeOperation(params('fresh'));
  assert.notEqual(fresh.inputs[0].txid, oldOperation.inputs[0].txid);
  assert.equal((await restored.wallet.getEcashOperations()).length, 1);
  await assert.rejects(restored.wallet.resolveUnresolvedNativeTransaction({ transaction, outcome: 'not-submitted' }), /caller assertion/);
  assert.deepEqual(old.get(source.key), transaction);
  const settled = await make({ old, status: async () => 'confirmed' });
  assert.equal(old.get(source.key), undefined); assert.equal(settled.sent.length, 0);
  old.put(source.key, { txHash: transaction.txHash });
  const blocked = await make({ old });
  await assert.rejects(blocked.wallet.prepareNativeOperation(params('blocked')), error => error.reason.message.includes('lacks signed input evidence'));
  assert.equal(old.get(source.key).txHash, transaction.txHash);
  old.put(source.key, { ...transaction, txHash: 'ff'.repeat(32) });
  await assert.rejects(make({ old }), /bytes do not match/);
`),
  35_000
);

it(
  "isolates canonical networks and preserves claims until actual confirmation",
  () =>
    run(`
  const store = new InMemoryEcashOperationStore();
  let status = 'unknown';
  const main = await make({ store, status: async () => status });
  const test = await make({ store, chain: 'xec-testnet' });
  const a = await main.wallet.prepareNativeOperation(params('same-id'));
  const testRecipient = { raw: Address.p2pkh(new Uint8Array(20).fill(31), 'ectest').toString() };
  const b = await test.wallet.prepareNativeOperation({ ...params('same-id'), recipient: testRecipient });
  assert.notEqual(main.key, test.key); assert.equal(a.inputs[0].txid, b.inputs[0].txid);
  await assert.rejects(make({ chain: 'made-up-network' }), /Unknown eCash network/);
  await main.wallet.recordNativeOperationExposure({ operationId: a.operationId, binding: binding(main.wallet, a) });
  status = 'failed'; await main.wallet.reconcileNativeOperation(a.operationId);
  assert.equal((await main.wallet.getEcashOperations())[0].state, 'exposed');
  status = 'pending'; await main.wallet.reconcileNativeOperation(a.operationId);
  assert.equal((await main.wallet.getEcashOperations())[0].state, 'submitted');
  status = 'confirmed'; await main.wallet.reconcileNativeOperation(a.operationId);
  assert.equal((await main.wallet.getEcashOperations())[0].state, 'confirmed');
  // A stale indexer must not resurrect a confirmed spend as a selectable coin.
  const next = await main.wallet.prepareNativeOperation(params('after-confirmation'));
  assert.notEqual(next.inputs[0].txid, a.inputs[0].txid);
`),
  35_000
);

it(
  "retains consumed prior inputs across both confirmation paths, restart and write failure",
  () =>
    run(`
  const source = await make();
  const operation = await source.wallet.prepareNativeOperation(params('source'));
  const transaction = { txHash: operation.transactions[0].txid, rawTransactions: operation.transactions.map(tx => tx.rawTransaction) };
  for (const explicit of [false, true]) {
    const old = new InMemoryNativeTransactionAttemptStore();
    const store = new InMemoryEcashOperationStore();
    let status = 'unknown'; let fail = false;
    const durablePut = store.put.bind(store);
    store.put = async (key, ledger) => { if (fail) throw new Error('durability unavailable'); await durablePut(key, ledger); };
    const host = await make({ old, store, status: async () => status });
    old.put(source.key, transaction); status = 'confirmed'; fail = true;
    const settle = () => explicit
      ? host.wallet.resolveUnresolvedNativeTransaction({ transaction, outcome: 'submitted' })
      : host.wallet.finishInterruptedSend();
    await assert.rejects(settle());
    assert.deepEqual(old.get(source.key), transaction);
    assert.equal((await store.get(source.key)), undefined);
    fail = false; await settle();
    assert.equal(old.get(source.key), undefined);
    assert.deepEqual((await store.get(source.key)).consumedInputs, operation.inputs.map(({txid,vout}) => ({txid,vout})));
    assert.equal((await store.get(source.key)).operations.length, 0);
    const reopened = await make({ old, store });
    const next = await reopened.wallet.prepareNativeOperation(params('after-prior'));
    assert.ok(next.inputs.every(input => !operation.inputs.some(prior => prior.txid === input.txid && prior.vout === input.vout)));
    assert.equal((await reopened.wallet.getBalance()), 60000n);
  }
`),
  35_000
);

it(
  "uses the same SDK derivation and durable preparation through the legacy mnemonic entry point",
  () =>
    run(`
  const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const chronik = chronikFor(mnemonicToSeed(mnemonic));
  const legacy = await make({ legacyMnemonic: mnemonic, chronik });
  const expected = Address.p2pkh(shaRmd160(HdNode.fromSeed(mnemonicToSeed(mnemonic)).derivePath("m/44'/1899'/0'/0/0").pubkey()), 'ecash').toString();
  assert.equal(legacy.wallet.identity.address.raw, expected);
  const op = await legacy.wallet.prepareNativeOperation(params('legacy'));
  assert.equal(op.state, 'prepared'); assert.equal(legacy.sent.length, 0);
  await legacy.wallet.submitNativeOperation(op.operationId);
  assert.deepEqual(legacy.sent, [[op.transactions[0].rawTransaction]]);
`),
  35_000
);

it(
  "awaits initialization reads and rejects failed or foreign ledgers without writes",
  () =>
    run(`
  const store = new InMemoryEcashOperationStore();
  const get = store.get.bind(store), put = store.put.bind(store);
  const gate = deferred(), started = deferred();
  let pause = true, writes = 0, published = false;
  store.get = async key => { if (pause) { pause = false; started.resolve(); await gate.promise; } return get(key); };
  store.put = async (...args) => { writes++; return put(...args); };
  const opening = make({ store }).then(value => { published = true; return value; });
  await started.promise; await turn();
  assert.equal(published, false); assert.equal(writes, 0);
  gate.resolve(); const host = await opening;
  assert.equal(writes, 0); assert.equal(await get(host.key), undefined);
  store.get = async () => { await turn(); throw new Error('read failed'); };
  await assert.rejects(make({ store }), /read failed/);
  store.get = async () => ({ version: 1, chainIdentifier: 'xec-testnet', walletAddress: host.wallet.identity.address.raw, nextChangeIndex: 0, operations: [] });
  await assert.rejects(make({ store }), /another wallet or chain/);
  store.get = async () => ({ version: 99 });
  await assert.rejects(make({ store }), /Invalid eCash operation ledger/);
  assert.equal(writes, 0);
`),
  35_000
);

it(
  "awaits selection commits and serializes separate instances against fresh state",
  () =>
    run(`
  const store = new InMemoryEcashOperationStore();
  const first = await make({ store }), second = await make({ store });
  const put = store.put.bind(store), gate = deferred(), started = deferred();
  let pause = true, firstDone = false, secondDone = false;
  store.put = async (key, ledger) => { if (pause) { pause = false; started.resolve(); await gate.promise; } await put(key, ledger); };
  const a = first.wallet.prepareNativeOperation(params('delayed-a')).then(value => { firstDone = true; return value; });
  await started.promise;
  const b = second.wallet.prepareNativeOperation(params('delayed-b')).then(value => { secondDone = true; return value; });
  await turn();
  assert.equal(firstDone, false); assert.equal(secondDone, false);
  assert.equal(await store.get(first.key), undefined); assert.equal(first.sent.length + second.sent.length, 0);
  gate.resolve(); const [left, right] = await Promise.all([a, b]);
  assert.ok(left.inputs.every(input => !right.inputs.some(other => other.txid === input.txid && other.vout === input.vout)));
  assert.equal((await store.get(first.key)).nextChangeIndex, 2);
  assert.notEqual(Tx.fromHex(left.transactions[0].rawTransaction).outputs[1].script.toHex(), Tx.fromHex(right.transactions[0].rawTransaction).outputs[1].script.toHex());
`),
  35_000
);

it(
  "does not call onSigned or broadcast until the native exposure commit completes",
  () =>
    run(`
  const first = await make(), put = first.store.put.bind(first.store);
  const gate = deferred(), started = deferred();
  let pause = true, callbacks = 0, finished = false;
  first.store.put = async (key, ledger) => { if (pause && ledger.operations.some(op => op.state === 'exposed')) { pause = false; started.resolve(); await gate.promise; } await put(key, ledger); };
  const send = first.wallet.sendNative({ recipient, value: 1000n, maxFee: 1000n, onSigned: async () => { callbacks++; } }).then(value => { finished = true; return value; });
  await started.promise; await turn();
  assert.equal(finished, false); assert.equal(callbacks, 0); assert.equal(first.sent.length, 0);
  assert.equal((await first.wallet.getEcashOperations())[0].state, 'prepared');
  gate.resolve(); const transaction = await send;
  assert.equal(callbacks, 1); assert.equal(first.sent.length, 1);
  assert.equal(first.sent[0][0], transaction.rawTransactions[0]);
  assert.equal((await first.wallet.getEcashOperations())[0].state, 'submitted');
`),
  35_000
);

it(
  "waits for external exposure and retains original claims after a lost commit acknowledgment",
  () =>
    run(`
  const first = await make(), put = first.store.put.bind(first.store);
  const op = await first.wallet.prepareNativeOperation(params('external-delayed'));
  const gate = deferred(), started = deferred(); let finished = false;
  first.store.put = async (key, ledger) => { started.resolve(); await gate.promise; await put(key, ledger); throw new Error('commit acknowledgment lost'); };
  const exposure = first.wallet.recordNativeOperationExposure({ operationId: op.operationId, binding: binding(first.wallet, op) });
  const rejected = assert.rejects(exposure, /acknowledgment lost/).then(() => { finished = true; });
  await started.promise; await turn();
  assert.equal(finished, false); assert.equal(first.sent.length, 0);
  assert.equal((await first.wallet.getEcashOperations())[0].state, 'prepared');
  gate.resolve(); await rejected;
  assert.equal((await first.wallet.getEcashOperations())[0].state, 'exposed');
  first.store.put = put;
  await assert.rejects(first.wallet.releaseNativeOperation(op.operationId), /cannot be released/);
  const reopened = await make({ store: first.store }); assert.equal(reopened.sent.length, 0);
  assert.deepEqual(await reopened.wallet.prepareNativeOperation(params(op.operationId)), (await reopened.wallet.getEcashOperations())[0]);
  await reopened.wallet.recordNativeOperationExposure({ operationId: op.operationId, binding: binding(reopened.wallet, op) });
  assert.equal((await reopened.wallet.getEcashOperations()).length, 1);
  assert.deepEqual((await reopened.wallet.getEcashOperations())[0].transactions, op.transactions);
`),
  35_000
);

it(
  "recovers original preparation and native exposure after failed asynchronous acknowledgments",
  () =>
    run(`
  const first = await make(), put = first.store.put.bind(first.store);
  let failPreparation = true;
  first.store.put = async (key, ledger) => { await put(key, ledger); if (failPreparation) { failPreparation = false; throw new Error('prepared acknowledgment lost'); } };
  await assert.rejects(first.wallet.prepareNativeOperation(params('ack-lost')), /acknowledgment lost/);
  const committed = (await first.wallet.getEcashOperations())[0];
  assert.deepEqual(await first.wallet.prepareNativeOperation(params('ack-lost')), committed);
  assert.equal((await first.wallet.getEcashOperations()).length, 1);
  let failExposure = true, callbacks = 0;
  first.store.put = async (key, ledger) => { await put(key, ledger); if (failExposure && ledger.operations.some(op => op.state === 'exposed')) { failExposure = false; throw new Error('exposure acknowledgment lost'); } };
  await assert.rejects(first.wallet.sendNative({ recipient, value: 1000n, maxFee: 1000n, onSigned: async () => { callbacks++; } }), /acknowledgment lost/);
  assert.equal(callbacks, 0); assert.equal(first.sent.length, 0);
  const exposed = (await first.wallet.getEcashOperations()).find(op => op.state === 'exposed');
  await assert.rejects(first.wallet.releaseNativeOperation(exposed.operationId), /cannot be released/);
  first.store.put = put;
  const reopened = await make({ store: first.store });
  assert.equal(reopened.sent.length, 1);
  assert.deepEqual(reopened.sent[0], exposed.transactions.map(tx => tx.rawTransaction));
  assert.equal((await reopened.wallet.getEcashOperations()).length, 2);
  const other = await reopened.wallet.prepareNativeOperation(params('after-ack-loss'));
  assert.ok(other.inputs.every(input => !exposed.inputs.concat(committed.inputs).some(prior => prior.txid === input.txid && prior.vout === input.vout)));
  assert.equal((await first.store.get(first.key)).nextChangeIndex, 3);
`),
  35_000
);

it(
  "commits prior-obligation tombstones before deletion through delayed, failed and ambiguous storage",
  () =>
    run(`
  const source = await make(), operation = await source.wallet.prepareNativeOperation(params('prior-source'));
  const transaction = { txHash: operation.transactions[0].txid, rawTransactions: operation.transactions.map(tx => tx.rawTransaction) };
  const old = new InMemoryNativeTransactionAttemptStore(), store = new InMemoryEcashOperationStore();
  let status = 'unknown'; const host = await make({ old, store, status: async () => status });
  old.put(source.key, transaction); status = 'confirmed';
  const put = store.put.bind(store), gate = deferred(), started = deferred(); let fail = true;
  store.put = async (key, ledger) => { started.resolve(); await gate.promise; if (fail) throw new Error('tombstone failed'); await put(key, ledger); throw new Error('tombstone acknowledgment lost'); };
  const retirement = assert.rejects(host.wallet.finishInterruptedSend());
  await started.promise; await turn();
  assert.deepEqual(old.get(source.key), transaction); assert.equal(await store.get(source.key), undefined);
  gate.resolve(); await retirement;
  assert.deepEqual(old.get(source.key), transaction); assert.equal(await store.get(source.key), undefined);
  fail = false; await assert.rejects(host.wallet.finishInterruptedSend());
  assert.deepEqual(old.get(source.key), transaction);
  assert.deepEqual((await store.get(source.key)).consumedInputs, operation.inputs.map(({ txid, vout }) => ({ txid, vout })));
  store.put = put;
  const remove = old.delete.bind(old); old.delete = () => { throw new Error('delete failed'); };
  await assert.rejects(host.wallet.finishInterruptedSend()); assert.deepEqual(old.get(source.key), transaction);
  old.delete = remove;
  const reopened = await make({ store, old, status: async () => 'confirmed' });
  assert.equal(old.get(source.key), undefined); assert.equal(reopened.sent.length, 0);
  assert.equal((await store.get(source.key)).consumedInputs.length, operation.inputs.length);
  const next = await reopened.wallet.prepareNativeOperation(params('after-retirement'));
  assert.ok(next.inputs.every(input => !operation.inputs.some(prior => prior.txid === input.txid && prior.vout === input.vout)));
`),
  35_000
);

it(
  "keeps same-ID preparation behind a visible write with a pending acknowledgment without querying the indexer",
  () =>
    run(`
  const store = new InMemoryEcashOperationStore();
  const first = await make({ store }), second = await make({ store });
  const put = store.put.bind(store), visible = deferred(), acknowledged = deferred();
  let firstDone = false, retryDone = false, writes = 0;
  store.put = async (key, ledger) => { writes++; await put(key, ledger); visible.resolve(); await acknowledged.promise; };
  const preparation = first.wallet.prepareNativeOperation(params('same-id-pending')).then(value => { firstDone = true; return value; });
  await visible.promise;
  assert.equal((await store.get(first.key)).operations.length, 1);
  second.chronik.batchUtxos = async () => { throw new Error('retry must not query offline indexer'); };
  second.chronik.blockchainInfo = async () => { throw new Error('retry must not query offline indexer'); };
  const retry = second.wallet.prepareNativeOperation(params('same-id-pending')).then(value => { retryDone = true; return value; });
  await turn();
  assert.equal(firstDone, false); assert.equal(retryDone, false);
  assert.equal(first.sent.length + second.sent.length, 0);
  acknowledged.resolve(); const [original, repeated] = await Promise.all([preparation, retry]);
  assert.deepEqual(repeated, original);
  assert.deepEqual(await second.wallet.prepareNativeOperation(params('same-id-pending')), original);
  assert.equal(writes, 1);
  const ledger = await store.get(first.key);
  assert.equal(ledger.operations.length, 1); assert.equal(ledger.nextChangeIndex, 1);
  assert.equal(first.sent.length + second.sent.length, 0);
`),
  35_000
);
