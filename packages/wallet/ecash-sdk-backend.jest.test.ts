import { execFileSync } from "node:child_process";

// The actual published SDK loads WASM ESM glue that cannot run inside Jest's CJS wrapper.
// This child uses production custody code, synthetic Chronik responses and no network sockets.
it("discovers imported coins and signs an immutable excluded-input construction with the actual SDK", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--eval",
      `
const assert = require('node:assert/strict');
const { Wallet } = require('ecash-wallet');
const { HdNode, Ecc, Address, Script, shaRmd160, Tx, UnsignedTx, ALL_BIP143, sha256d } = require('ecash-lib');
const { EcashSdkBackend } = require('./ecash-sdk-backend.ts');
assert.equal(require('ecash-wallet/package.json').version, '6.2.1');
const account = HdNode.fromSeed(new Uint8Array(32).fill(77)).derivePath("m/44'/1899'/0'");
const secret = new Uint8Array(32).fill(19);
const pk = new Ecc().derivePubkey(secret), pkh = shaRmd160(pk), script = Script.p2pkh(pkh);
const importedAddress = Address.p2pkh(pkh, 'ectest').toString();
let importedCoins = [1, 2].map(n => ({
  outpoint: { txid: n.toString().repeat(64), outIdx: n },
  sats: 10000n, blockHeight: 800000, isCoinbase: false, isFinal: true,
}));
let wrongScript = false, broadcasts = 0, queries = 0;
const summaryCalls = [], usedPkhs = new Set();
const hdPkh = path => Buffer.from(shaRmd160(new Ecc().derivePubkey(account.derivePath(path).seckey()))).toString('hex');
const chronik = {
  blockchainInfo: async () => ({ tipHeight: 900000 }),
  batchSummary: async scripts => { summaryCalls.push(scripts.length); return scripts.map(s => ({ numTxs: usedPkhs.has(s.payload) ? 1 : 0, numUtxos: 0 })); },
  batchUtxos: async scripts => scripts.map(s => ({ utxos: { outputScript: '76a914' + s.payload + '88ac', utxos: [] } })),
  script: (type, payload) => ({ utxos: async () => {
    assert.equal(type, 'p2pkh'); assert.equal(payload, Buffer.from(pkh).toString('hex')); queries++;
    return { outputScript: wrongScript ? '00' : script.toHex(), utxos: importedCoins };
  } }),
  broadcastTx: async () => { broadcasts++; throw new Error('broadcast forbidden'); },
  broadcastTxs: async () => { broadcasts++; throw new Error('broadcast forbidden'); },
};
(async () => {
  const sdk = new Wallet(account.seckey(), chronik, account, 0, 'ectest');
  const backend = new EcashSdkBackend(sdk, chronik, 'ectest');
  assert.equal(backend.importSigningKey(secret), importedAddress);
  assert.equal(backend.importSigningKey(secret), importedAddress);
  assert.throws(() => backend.importSigningKey(new Uint8Array(32)));
  assert.throws(() => backend.importSigningKey(new Uint8Array(31)));
  assert.throws(() => backend.importSigningKey(account.derivePath('0/0').seckey()), /already belongs to the HD keyring/);
  secret.fill(0);
  await backend.syncAndDiscoverAddresses();
  assert.equal(backend.balanceSats, 20000n);
  assert.deepEqual(backend.getCompleteBalanceObservation().coins, [1, 2].map(n => ({
    txid: n.toString().repeat(64), vout: n, satoshis: 10000n,
  })));
  assert.equal(sdk.utxos.length, 2);
  const original = { coins: structuredClone(sdk.utxos), change: sdk.changeIndex, receive: sdk.receiveIndex, keys: [...sdk.keypairs.keys()] };
  const recipient = Address.p2pkh(new Uint8Array(20).fill(31), 'ectest').toString();
  const params = { recipient, value: 1000n, excludedInputs: [{ txid: '1'.repeat(64), vout: 1 }] };
  const result = backend.buildNativeConstruction(params);
  assert.deepEqual(result.selectedInputs, [{ txid: '2'.repeat(64), vout: 2, satoshis: 10000n }]);
  assert.equal(result.transactions.length, 1);
  assert.equal(result.nextChangeIndex, original.change + 1);
  assert.deepEqual(sdk.utxos, original.coins);
  assert.equal(sdk.changeIndex, original.change);
  assert.equal(sdk.receiveIndex, original.receive);
  assert.deepEqual([...sdk.keypairs.keys()], original.keys);
  assert.deepEqual(backend.buildNativeConstruction(params), result);
  const tx = Tx.fromHex(result.transactions[0].rawTransaction);
  assert.equal(Buffer.from(tx.inputs[0].prevOut.txid).reverse().toString('hex'), '2'.repeat(64));
  assert.equal(tx.inputs[0].prevOut.outIdx, 2);
  assert.equal(tx.outputs[0].sats, 1000n);
  assert.equal(tx.outputs[0].script.toHex(), Address.fromCashAddress(recipient).toScript().toHex());
  assert.equal(result.fee, 10000n - tx.outputs.reduce((sum, o) => sum + o.sats, 0n));
  assert(result.fee > 0n);
  assert.equal(Buffer.from(sha256d(tx.ser())).reverse().toString('hex'), result.transactions[0].txid);
  tx.inputs[0].signData = { sats: 10000n, outputScript: script };
  const unlocking = tx.inputs[0].script.bytecode;
  assert.equal(unlocking[0], 65); assert.equal(unlocking[65], 0x41);
  const preimage = UnsignedTx.fromTx(tx).inputAt(0).sigHashPreimage(ALL_BIP143);
  new Ecc().schnorrVerify(unlocking.slice(1, 65), sha256d(preimage.bytes), pk);
  assert(Object.isFrozen(result) && Object.isFrozen(result.transactions) && Object.isFrozen(result.transactions[0]));
  assert(Object.isFrozen(result.selectedInputs) && Object.isFrozen(result.selectedInputs[0]));
  assert.throws(() => result.transactions.push({}));
  assert.throws(() => backend.buildNativeConstruction({ ...params, recipient: Address.p2pkh(pkh, 'ecash').toString() }));
  assert.throws(() => backend.buildNativeConstruction({ ...params, value: 0n }));
  assert.throws(() => backend.buildNativeConstruction({ ...params, excludedInputs: [{ txid: 'bad', vout: 0 }] }));
  assert.throws(() => backend.buildNativeConstruction({ ...params, excludedInputs: importedCoins.map(c => ({ txid: c.outpoint.txid, vout: c.outpoint.outIdx })) }));
  await backend.sync(); assert.equal(backend.balanceSats, 20000n); assert.equal(sdk.utxos.length, 2);
  // An ordinary refresh with nothing new probes only the gap window: 20 scripts per chain.
  summaryCalls.length = 0; await backend.sync(); assert.deepEqual(summaryCalls, [40]);
  // Another device used change 1/(changeIndex + 5): the probe sees it and resumes discovery.
  const change = sdk.changeIndex; usedPkhs.add(hdPkh('1/' + (change + 5)));
  summaryCalls.length = 0; await backend.sync();
  assert.equal(summaryCalls[0], 40); assert(summaryCalls.length > 1);
  assert.equal(sdk.changeIndex, change + 6);
  summaryCalls.length = 0; await backend.sync(); assert.deepEqual(summaryCalls, [40]);
  // Window edges: the probe covers [index, index + 20) on each chain.
  const probeFinds = async (path, expectedReceive, expectedChange) => {
    usedPkhs.add(hdPkh(path));
    summaryCalls.length = 0; await backend.sync();
    assert.equal(summaryCalls[0], 40, path); assert(summaryCalls.length > 1, path);
    assert.equal(sdk.receiveIndex, expectedReceive, path); assert.equal(sdk.changeIndex, expectedChange, path);
  };
  let c = sdk.changeIndex, r = sdk.receiveIndex;
  await probeFinds('1/' + c, r, c + 1);                 // exactly at the start index
  c = sdk.changeIndex; await probeFinds('1/' + (c + 19), r, c + 20); // last address in the window
  c = sdk.changeIndex;
  await probeFinds('0/' + (r + 3), r + 4, c);            // the receive chain
  r = sdk.receiveIndex;
  // +20 lies outside the window: the probe alone neither sees nor discovers it.
  const outside = hdPkh('1/' + (c + 20)); usedPkhs.add(outside);
  summaryCalls.length = 0; await backend.sync(); assert.deepEqual(summaryCalls, [40]);
  assert.equal(sdk.changeIndex, c); assert.equal(sdk.receiveIndex, r);
  usedPkhs.delete(outside);
  // A failed or malformed probe fails the refresh: no discovery, no sync, observation kept.
  const { EcashGapProbeError } = require('./ecash-sdk-backend.ts');
  const { describeWalletFailure } = require('./wallet-failure.ts');
  const before = backend.getCompleteBalanceObservation();
  const methods = ['batchSummary', 'batchUtxos', 'script', 'address', 'blockchainInfo', 'tx'];
  const saved = Object.fromEntries(methods.map(m => [m, chronik[m]]));
  for (const [reply, reason] of [[null, 'unavailable'], [39, 'protocol'], [41, 'protocol']]) {
    let probeScripts = 0, otherRequests = 0;
    for (const m of methods) chronik[m] = (...args) => { otherRequests++; throw new Error('unexpected chronik ' + m); };
    chronik.batchSummary = async scripts => {
      probeScripts += scripts.length;
      if (reply === null) throw new Error('rpc_hourly_quota');
      return Array.from({ length: reply }, () => ({ numTxs: 0, numUtxos: 0 }));
    };
    await assert.rejects(backend.sync(), error => {
      assert(error instanceof EcashGapProbeError); assert.equal(error.reason, reason);
      assert.equal(describeWalletFailure(error).observationUnavailable, true);
      return true;
    });
    assert.equal(probeScripts, 40, reason); assert.equal(otherRequests, 0, reason);
    assert.deepEqual(backend.getCompleteBalanceObservation(), before);
    assert.equal(sdk.changeIndex, c); assert.equal(sdk.receiveIndex, r);
  }
  Object.assign(chronik, saved);
  summaryCalls.length = 0; await backend.sync(); assert.deepEqual(summaryCalls, [40]);
  wrongScript = true; await assert.rejects(backend.sync(), /wrong imported eCash script/); wrongScript = false;
  importedCoins = []; await backend.sync(); assert.equal(backend.balanceSats, 0n);
  importedCoins = [{ outpoint: { txid: '3'.repeat(64), outIdx: 0 }, sats: 10000n, blockHeight: 800000, isCoinbase: false, isFinal: true }];
  const restoredSdk = new Wallet(account.seckey(), chronik, account, 0, 'ectest');
  const restored = new EcashSdkBackend(restoredSdk, chronik, 'ectest');
  assert.equal(restored.importSigningKey(new Uint8Array(32).fill(19)), importedAddress);
  await restored.syncAndDiscoverAddresses();
  assert.equal(restored.balanceSats, 10000n);
  assert.equal(restored.buildNativeConstruction({ ...params, excludedInputs: [] }).selectedInputs[0].txid, '3'.repeat(64));
  assert.equal(broadcasts, 0);
  const { createEcashSeedBackend } = require('./ecash-seed-boundary.ts');
  const seedBackend = await createEcashSeedBackend({
    domainRoot: { registry: 'frank-domain-roots-v1', purpose: 'ecash-bch-wallet', bytes: new Uint8Array(32).fill(77) },
    chronik, addressPrefix: 'ectest',
  });
  assert(seedBackend instanceof EcashSdkBackend);
  assert.equal(seedBackend.importSigningKey(new Uint8Array(32).fill(19)), importedAddress);
  await seedBackend.syncAndDiscoverAddresses();
  assert.equal(seedBackend.buildNativeConstruction({ ...params, excludedInputs: [] }).selectedInputs[0].txid, '3'.repeat(64));
  assert.equal(broadcasts, 0);
  console.log(JSON.stringify({ selectedInputs: result.selectedInputs.map(i => i.txid + ':' + i.vout), fee: result.fee.toString(), nextChangeIndex: result.nextChangeIndex, importedDiscoveryQueries: queries, broadcasts }));
})().catch(error => { console.error(error); process.exitCode = 1; });
`,
    ],
    { cwd: __dirname, encoding: "utf8", timeout: 30_000 }
  );
  expect(JSON.parse(output)).toMatchObject({
    selectedInputs: [`${"2".repeat(64)}:2`],
    nextChangeIndex: 1,
    broadcasts: 0,
  });
}, 35_000);
