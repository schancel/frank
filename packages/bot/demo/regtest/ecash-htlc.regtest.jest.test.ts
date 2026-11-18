/**
 * INTEGRATION: the eCash HTLC on a real Bitcoin ABC regtest node with Chronik. Runs
 * `ecash-htlc.livecheck.ts` in a subprocess (Jest cannot load the eCash SDK's WASM ESM glue);
 * that file holds every check and its own description.
 *
 * Needs a Chronik-enabled `bitcoind`: FRANK_BITCOIN_ABC_BIN_DIR, or the verified release fetched
 * by `yarn --cwd packages/bot regtest:fetch`. Without one the suite reports itself as NOT RUN.
 */
import { execFile } from 'child_process'
import { resolve } from 'path'

import { availableBitcoinAbc } from './bitcoin-abc'

const bitcoind = availableBitcoinAbc()
if (!bitcoind)
  // eslint-disable-next-line no-console
  console.warn(
    'NOT RUN: ecash-htlc.regtest needs a Chronik-enabled bitcoind (set FRANK_BITCOIN_ABC_BIN_DIR or run `yarn --cwd packages/bot regtest:fetch`).',
  )
const suite = bitcoind ? describe : describe.skip

suite('eCash HTLC on a real xec-regtest node', () => {
  it('funds through the native-operation path, claims, refuses bad preimages, refunds after T_A, and reveals via Chronik', async () => {
    const output = await new Promise<string>((done, fail) =>
      execFile(
        process.execPath,
        ['--import', 'tsx', 'demo/regtest/ecash-htlc.livecheck.ts'],
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
      /funded ecregtest:p\S+ with 11000 sats via native operation swap:[0-9a-f]{64}:xec-lock/,
      /claim with a wrong 32-byte preimage: rejected by the node/,
      /claim with the matching 31-byte preimage \(OP_SIZE check\): rejected by the node/,
      /claim with the matching 33-byte preimage \(OP_SIZE check\): rejected by the node/,
      /claim [0-9a-f]{64} with the right preimage mined: exactly 10000 sats/,
      /preimage read back through Chronik/,
      /refund while MTP < T_A: rejected by the node \(bad-txns-nonfinal\)/,
      /refund at MTP = T_A: rejected by the node \(bad-txns-nonfinal\)/,
      /refund [0-9a-f]{64} accepted once MTP > T_A and mined/,
      /second wallet instance of the same seed derives the same HTLC keys/,
      /second wallet instance of the same seed signs the identical refund/,
    ])
      expect(checks.some(line => expected.test(line))).toBe(true)
    expect(output).toMatch(/eCash HTLC regtest: OK \(13 checks\)/)
  }, 300_000)
})
