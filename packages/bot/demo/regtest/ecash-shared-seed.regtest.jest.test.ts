/**
 * INTEGRATION: two devices of one eCash account on a real Bitcoin ABC regtest node with Chronik
 * (issue 2084). Runs `ecash-shared-seed.livecheck.ts` in a subprocess (Jest cannot load the eCash
 * SDK's WASM ESM glue); that file holds every check and its own description.
 *
 * Needs a Chronik-enabled `bitcoind`: FRANK_BITCOIN_ABC_BIN_DIR, or the verified release fetched
 * by `yarn --cwd packages/bot regtest:fetch`. Without one the suite reports itself as NOT RUN,
 * or fails under FRANK_REQUIRE_NODES=1.
 */
import { execFile } from 'child_process'
import { resolve } from 'path'

import { nodeSuiteReady } from '@frank/wallet/node-binaries.testutil'

import { availableBitcoinAbc, bitcoinAbcBinary } from './bitcoin-abc'

const bitcoind = availableBitcoinAbc()
const suite = nodeSuiteReady('ecash-shared-seed.regtest', [bitcoinAbcBinary(bitcoind)]) ? describe : describe.skip

suite('two devices of one eCash seed on a real xec-regtest node', () => {
  it("discovers the other device's change, unconfirmed too, and spends it, also after a wiped operation store", async () => {
    const output = await new Promise<string>((done, fail) =>
      execFile(
        process.execPath,
        ['--import', 'tsx', 'demo/regtest/ecash-shared-seed.livecheck.ts'],
        {
          cwd: resolve(__dirname, '..', '..'),
          env: process.env,
          maxBuffer: 16 * 1024 * 1024,
          timeout: 280_000,
        },
        (error, stdout, stderr) => (error ? fail(new Error(`${error.message}\n${stdout}${stderr}`)) : done(stdout)),
      ),
    )
    const checks = output.split('\n').filter(line => line.startsWith('ok - '))
    for (const expected of [
      /device 1 paid three times/,
      /device 2 of the same seed \(separate operation store\) sees the full \d+ sats from unconfirmed change/,
      /device 2 spent device 1's change, then its own/,
      /device 1 sees device 2's unconfirmed change beyond its own change index/,
      /device 1 restarted with a wiped operation store sees \d+ sats and spends from them/,
    ])
      expect(checks.some(line => expected.test(line))).toBe(true)
    expect(output).toMatch(/eCash shared-seed regtest: OK \(5 checks\)/)
  }, 300_000)
})
