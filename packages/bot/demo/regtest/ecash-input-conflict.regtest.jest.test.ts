/**
 * INTEGRATION: two devices of one eCash account spend the same coin, on a real Bitcoin ABC regtest
 * node with Chronik (issue 2089). Runs `ecash-input-conflict.livecheck.ts` in a subprocess (Jest
 * cannot load the eCash SDK's WASM ESM glue); that file holds every check and its own description.
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
const suite = nodeSuiteReady('ecash-input-conflict.regtest', [bitcoinAbcBinary(bitcoind)]) ? describe : describe.skip

suite('two devices of one eCash seed spend the same coin on a real xec-regtest node', () => {
  it('reconciles the losing operation as conflicted once the winner is final, releases its other coin, keeps that across restart and retries the intent once', async () => {
    const output = await new Promise<string>((done, fail) =>
      execFile(
        process.execPath,
        ['--import', 'tsx', 'demo/regtest/ecash-input-conflict.livecheck.ts'],
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
      /two devices of one seed each signed a payment from the same coin/,
      /device 2 broadcast was refused; while device 1 spend is only in the mempool its operation stays unresolved/,
      /device 2 reconciled its operation as conflicted by \w+/,
      /device 2 restarted keeps the conflicted state and never rebroadcasts it/,
      /device 2 retried the same intent from fresh inputs; the payee got each payment exactly once/,
      /a plain send that lost the race is found conflicted by the balance refresh; its txid reads failed/,
      /two Retry clicks sent the plain send once more, the same intent; the payee got it exactly once/,
    ])
      expect(checks.some(line => expected.test(line))).toBe(true)
    expect(output).toMatch(/eCash input-conflict regtest: OK \(7 checks\)/)
  }, 300_000)
})
