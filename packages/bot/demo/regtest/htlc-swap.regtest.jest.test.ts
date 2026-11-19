/**
 * INTEGRATION: the HTLC swap runner between two accounts on a real Bitcoin ABC regtest node with
 * Chronik and anvil running GenericHTLC v2. Runs `htlc-swap.livecheck.ts` in a subprocess (Jest
 * cannot load the eCash SDK's WASM ESM glue); that file holds every check and its description.
 *
 * Needs a Chronik-enabled `bitcoind` (FRANK_BITCOIN_ABC_BIN_DIR, or `yarn --cwd packages/bot
 * regtest:fetch`) and an `anvil` (ANVIL_BIN, the `@foundry-rs/anvil` package, or PATH). Without
 * them the suite reports itself as NOT RUN.
 */
import { execFile, spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join, resolve } from 'path'

import { availableBitcoinAbc } from './bitcoin-abc'

function anvilAvailable(): boolean {
  if (process.env.ANVIL_BIN) return existsSync(process.env.ANVIL_BIN)
  try {
    const root = dirname(dirname(require.resolve('@foundry-rs/anvil/package.json')))
    const arch = process.arch === 'x64' ? 'amd64' : process.arch
    if (existsSync(join(root, `anvil-${process.platform}-${arch}`, 'bin', 'anvil'))) return true
  } catch {
    // Not installed as a package.
  }
  return spawnSync('anvil', ['--version']).status === 0
}

const ready = Boolean(availableBitcoinAbc()) && anvilAvailable()
if (!ready)
  // eslint-disable-next-line no-console
  console.warn(
    'NOT RUN: htlc-swap.regtest needs a Chronik-enabled bitcoind (FRANK_BITCOIN_ABC_BIN_DIR or `yarn --cwd packages/bot regtest:fetch`) and anvil (ANVIL_BIN).',
  )
const suite = ready ? describe : describe.skip

suite('HTLC swap runner on xec-regtest and anvil', () => {
  it('swaps, refunds, survives restarts without a duplicate spend, and hands over between devices', async () => {
    const output = await new Promise<string>((done, fail) =>
      execFile(
        process.execPath,
        ['--import', 'tsx', 'demo/regtest/htlc-swap.livecheck.ts'],
        {
          cwd: resolve(__dirname, '..', '..'),
          env: process.env,
          maxBuffer: 16 * 1024 * 1024,
          timeout: 560_000,
        },
        (error, stdout, stderr) => (error ? fail(new Error(`${error.message}\n${stdout}${stderr}`)) : done(stdout)),
      ),
    )
    const checks = output.split('\n').filter(line => line.startsWith('ok - '))
    for (const expected of [
      /A funds the XEC HTLC automatically once the accept arrives; a stop after the authorization resumes the same operation/,
      /B locks MON once the XEC output is final; a restart does not lock again/,
      /A withdraws MON with its derived preimage/,
      /B claims exactly 20000 sats .* re-broadcast as the same txid [0-9a-f]{64}/,
      /happy path: one funding, one lock, one withdraw, one claim/,
      /B never locks: B abandons at its cutoff, A refunds exactly the principal once MTP > T_A/,
      /A never claims: B refunds MON .* A refunds XEC once MTP > T_A/,
      /A’s runner never refunds after its MON withdraw landed/,
      /lostToRefund/,
      /two devices of A: only the active device funds/,
      /two devices of A: the device taking over withdraws from the chain state alone, once/,
      /a double-funded script: B claims exactly one output/,
      /the extra output: A refunds it after T_A/,
      /withdrawn A refunds only the extra output/,
      /B back online: claims the output A left for it/,
    ])
      expect(checks.some(line => expected.test(line))).toBe(true)
    expect(output).toMatch(/HTLC swap runner regtest: OK \(17 checks\)/)
  }, 600_000)
})
