import { execFileSync } from "child_process";
import path from "path";

it("matches the actual SDK historical writer without network access or seed conversion", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--eval",
      `
    const assert = require('node:assert/strict');
    const { mnemonicToSeedSync } = require('bip39');
    const { ChronikClient } = require('chronik-client');
    const { Wallet } = require('ecash-wallet');
    const { createEcashBip39SeedBackend } = require('./ecash-seed-boundary.ts');
    const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const seed = new Uint8Array(mnemonicToSeedSync(phrase));
    const chronik = new ChronikClient(['http://127.0.0.1:1']);
    globalThis.fetch = () => { throw new Error('Local address derivation attempted network access'); };
    (async () => {
      for (const prefix of ['ecash', 'ectest', 'ecregtest']) {
        const former = Wallet.fromMnemonic(phrase, chronik, { hd: true, prefix });
        const restored = await createEcashBip39SeedBackend({ derivation: 'frank-bip39-bip32-v1', seed }, chronik, prefix);
        for (const index of [0, 1, 7]) assert.equal(restored.getReceiveAddress(index), former.getReceiveAddress(index));
      }
      assert.equal(seed.length, 64);
      console.log('Historical eCash SDK identity and address branches match');
    })().finally(() => seed.fill(0)).catch(error => { console.error(error); process.exitCode = 1; });
  `,
    ],
    { cwd: path.resolve(__dirname), encoding: "utf8" }
  );
  expect(output).toContain(
    "Historical eCash SDK identity and address branches match"
  );
});
