/**
 * Smoke test for the one-command demo (#312): starts the whole stack against the built-in fake
 * chain (no keys, no funds, no network), then plays a new user against every bot and checks that
 * each one answers:
 *
 *   yarn demo:smoke                       # builds the relay with Cargo (slow the first time)
 *   CASHWEBD_BIN=/path/to/cashwebd-exe yarn demo:smoke
 *
 * It uses a throwaway state directory and a dummy env file, so it never reads a real `.env`
 * (FRANK_DEMO_ENV_FILE is always pointed at the dummy). Exit code 0 only if every check passes
 * and the supervised run stays healthy through shutdown.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'

import { runSmokeChecks, SmokeCheck } from './smoke-checks'
import { resolveDemoConfig } from './demo-config'
import { DemoHandle, redact, startDemo } from './demo'

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => resolve(port))
    })
  })
}

export async function runSmoke(
  env: Record<string, string | undefined>,
): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), 'frank-demo-smoke-'))
  let handle: DemoHandle | undefined
  let ok = false
  const reportError = (phase: string, err: unknown) =>
    console.error(
      `FAIL  smoke ${phase}: ${redact(
        err instanceof Error ? err.message : 'unknown error',
        [],
      )}`,
    )
  try {
    const dummyEnvFile = join(dir, 'dummy.env')
    writeFileSync(dummyEnvFile, 'FRANK_NETWORK_TAG=MONT\n')
    const smokeEnv: Record<string, string | undefined> = {
      PATH: env.PATH,
      HOME: env.HOME,
      TMPDIR: env.TMPDIR,
      CASHWEBD_BIN: env.CASHWEBD_BIN,
      PROTOC: env.PROTOC,
      CARGO_TARGET_DIR: env.CARGO_TARGET_DIR,
      CARGO_HOME: env.CARGO_HOME,
      RUSTUP_HOME: env.RUSTUP_HOME,
      FRANK_DEMO_ENV_FILE: dummyEnvFile,
      FRANK_DEMO_STATE_DIR: join(dir, 'state'),
      FRANK_DEMO_FAKE_CHAIN: '1',
      FRANK_DEMO_RELAY_PORT: String(await freePort()),
      FRANK_DEMO_FAKE_RPC_PORT: String(await freePort()),
    }
    const config = resolveDemoConfig({
      env: smokeEnv,
      envFile: {}, // never a real .env
      fakeChainFlag: true,
      cwd: dir,
    })
    handle = await startDemo(config, {
      env: smokeEnv,
      print: l => console.log(l),
    })
    const results: SmokeCheck[] = await runSmokeChecks(handle, {
      timeoutMs: 120_000,
    })
    for (const r of results) {
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}: ${r.detail}`)
    }
    ok = results.every(r => r.ok)
  } catch (err) {
    reportError('setup or checks', err)
  } finally {
    try {
      await handle?.stop()
    } catch (err) {
      ok = false
      reportError('shutdown', err)
    }
    // The supervisor retains unexpected exits, and excludes intentional stopAll exits.
    // Read health after stop settles so late failures cannot trigger successful cleanup.
    const unhealthy = handle?.unhealthy() ?? []
    if (unhealthy.length) {
      ok = false
      console.log(
        `FAIL  supervised children exited unexpectedly: ${unhealthy.join(
          ', ',
        )}`,
      )
    }
    // Keep the logs when something failed: they are the evidence.
    if (ok) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (err) {
        ok = false
        reportError('cleanup', err)
      }
    }
    if (!ok) console.log(`\nstate and logs kept in ${dir}`)
  }
  console.log(ok ? '\nSMOKE OK' : '\nSMOKE FAILED')
  return ok
}

if (require.main === module) {
  runSmoke(process.env).then(
    ok => process.exit(ok ? 0 : 1),
    err => {
      console.error(
        'smoke test error:',
        err instanceof Error ? err.message : err,
      )
      process.exit(1)
    },
  )
}
