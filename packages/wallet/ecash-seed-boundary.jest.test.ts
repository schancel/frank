import { execFileSync } from "child_process";
import path from "path";

// Run the unmocked published SDK in Node: Jest's CJS wrapper cannot load the SDK's browser
// WASM ESM glue. The subprocess uses the exact production adapter and never opens a socket.
it("constructs and rediscovers frozen roots with ecash-wallet 6.2.1 and independent BIP32 public vectors", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--eval",
      `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function(id, ...args) {
      assert(!/^bip39(?:\\/|$)/.test(id), 'new path loaded npm bip39');
      return load.call(this, id, ...args);
    };
    const { EcashWallet, ECASH_MAINNET_CHECKPOINT_HASH } = require('./ecash-wallet.ts');
    const { InMemoryNativeTransactionAttemptStore } = require('./chain/chain-wallet.ts');
    const { Wallet } = require('ecash-wallet');
    assert.equal(require('ecash-wallet/package.json').version, '6.2.1');
    const { HdNode, Address } = require('ecash-lib');
    const mnemonic = require('ecash-lib/dist/mnemonic.js');
    const pbkdf2 = require('ecash-lib/dist/pbkdf2.js');
    const forbidden = () => { throw new Error('mnemonic/PBKDF2 conversion invoked'); };
    Wallet.fromMnemonic = forbidden;
    for (const name of Object.keys(mnemonic)) mnemonic[name] = forbidden;
    for (const name of Object.keys(pbkdf2)) pbkdf2[name] = forbidden;
    const seenSeeds = [];
    const fromSeed = HdNode.fromSeed;
    HdNode.fromSeed = function(seed) { seenSeeds.push(Buffer.from(seed)); return fromSeed.call(this, seed); };
    const vectors = require('../domain-roots/vectors/domain-roots-v1.json').vectors;
    const { HDNodeWallet, getBytes } = require('ethers');
    const { createHash } = require('node:crypto');
    const pkh = (node) => createHash('ripemd160').update(createHash('sha256').update(getBytes(node.publicKey)).digest()).digest();
    (async () => {
      const publicResults = [];
      for (const vector of vectors) {
        const bytes = Buffer.from(vector.outputs['ecash-bch-wallet'], 'hex');
        const independent = HDNodeWallet.fromSeed(bytes).derivePath("m/44'/1899'/0'");
        const first = Address.p2pkh(pkh(independent.derivePath('0/0')), 'ecash').toString();
        const next = Address.p2pkh(pkh(independent.derivePath('0/2')), 'ecash').toString();
        const used = new Set([pkh(independent.derivePath('0/1')).toString('hex'), pkh(independent.derivePath('1/0')).toString('hex')]);
        let discoveries = 0;
        let syncs = 0;
        const chronik = {
          blockchainInfo: async () => ({ tipHeight: 900000 }),
          proxyInterface: () => ({ getEndpointArray: () => [{ url: 'http://127.0.0.1:1' }] }),
          batchSummary: async (scripts) => { discoveries++; return scripts.map(s => ({ numTxs: used.has(s.payload) ? 1 : 0, numUtxos: 0 })); },
          batchUtxos: async (scripts) => { syncs++; return scripts.map(s => ({ utxos: { outputScript: '76a914' + s.payload + '88ac', utxos: [] } })); },
        };
        const checkpoints = [];
        const options = {
          domainRoot: { registry: 'frank-domain-roots-v1', purpose: 'ecash-bch-wallet', bytes },
          networkId: 'ecash-mainnet', chronik,
          checkpointClientFactory: url => ({ block: async height => { checkpoints.push([url, height]); return { blockInfo: { hash: ECASH_MAINNET_CHECKPOINT_HASH } }; } }),
          nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
        };
        const wallet = await EcashWallet.fromDomainRoot(options);
        const restored = await EcashWallet.fromDomainRoot(options);
        assert.equal(wallet.identity.address.raw, first);
        assert.deepEqual(restored.identity, wallet.identity);
        assert.equal((await wallet.getReceiveAddress()).raw, next);
        assert.equal((await restored.getReceiveAddress()).raw, next);
        assert.equal(await wallet.getBalance(), 0n);
        assert.equal(discoveries, 8);
        assert.equal(syncs, 5);
        assert.deepEqual(checkpoints, [['http://127.0.0.1:1', 661648], ['http://127.0.0.1:1', 661648]]);
        assert.equal(bytes.toString('hex'), vector.outputs['ecash-bch-wallet']);
        publicResults.push({ first, next });
      }
      assert.deepEqual(seenSeeds.map(b => b.toString('hex')), vectors.flatMap(v => [v.outputs['ecash-bch-wallet'], v.outputs['ecash-bch-wallet']]));
      assert(!Object.keys(require.cache).some(p => /[\\/]bip39[\\/]/.test(p)));
      console.log(JSON.stringify(publicResults));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `,
    ],
    { cwd: __dirname, encoding: "utf8", timeout: 30_000 }
  );
  expect(JSON.parse(output)).toEqual([
    {
      first: "ecash:qp4zvdp29me699shcrw2046z9v9j9cmugcjmzffajc",
      next: "ecash:qr3txcyl8xyt5x9pjq5p9pqlxscyn6j5yvqa4ltl4f",
    },
    {
      first: "ecash:qq88jsysz9k2ckyer5k9kfpc3yj2x9msnqugz8n9vt",
      next: "ecash:qqeypkdr4gu30744r0rmhdjk5haq3x558v43cnaau4",
    },
  ]);
}, 35_000);

it("keeps npm BIP39 and the legacy adapter outside the new chain's eager browser bundle", async () => {
  const { build } = require("esbuild") as typeof import("esbuild");
  const result = await build({
    entryPoints: [path.join(__dirname, "chain/ecash-chain.ts")],
    bundle: true,
    platform: "browser",
    format: "esm",
    splitting: true,
    outdir: "/unused-ecash-bundle",
    write: false,
    metafile: true,
  });
  const outputs = result.metafile!.outputs;
  const entry = Object.keys(outputs).find((name) =>
    outputs[name].entryPoint?.endsWith("chain/ecash-chain.ts")
  )!;
  const visited = new Set<string>();
  const walk = (name: string): void => {
    if (visited.has(name)) return;
    visited.add(name);
    for (const dependency of outputs[name].imports) {
      if (dependency.kind !== "dynamic-import" && !dependency.external)
        walk(dependency.path);
    }
  };
  walk(entry);
  const eagerInputs = [...visited].flatMap((name) =>
    Object.keys(outputs[name].inputs)
  );
  expect(
    eagerInputs.some((name) => name.endsWith("ecash-seed-boundary.ts"))
  ).toBe(true);
  expect(eagerInputs.some((name) => /bip39|ecash-legacy-seed/.test(name))).toBe(
    false
  );
  // SDK CJS packaging retains its own mnemonic utility. This is enabling proof, not #692's
  // application-wide removal claim: the actual-SDK test forbids executing that utility.
  expect(
    Object.keys(result.metafile!.inputs).some((name) =>
      /ecash-lib\/dist\/mnemonic.js/.test(name)
    )
  ).toBe(true);
});
