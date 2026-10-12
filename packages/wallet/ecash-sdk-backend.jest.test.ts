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
const chronik = {
  blockchainInfo: async () => ({ tipHeight: 900000 }),
  batchSummary: async scripts => scripts.map(() => ({ numTxs: 0, numUtxos: 0 })),
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
