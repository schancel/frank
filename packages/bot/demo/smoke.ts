/**
 * Smoke test for the one-command demo, on Monad testnet with the real relay binary:
 *
 *   yarn demo:smoke
 *
 * Starts exactly what `yarn demo` starts (same `.env`, same state directory unless
 * FRANK_DEMO_STATE_DIR says otherwise, so bots funded by an earlier run are not funded again),
 * then a new user with a real wallet messages each bot and every reply is checked for its
 * content; the faucet's payment and the relay's proxied chain RPC are checked on chain. It spends
 * real testnet funds: whatever the start draws for the bots (refused above
 * FRANK_DEMO_MAX_START_DRAW_WEI, as for `yarn demo`; `--allow-draw` allows it) and, from
 * FRANK_TEST_WALLET_JSON, what tops the one persistent test user up to 0.012 MON per prompt
 * (0.072 MON for the six prompts; most of it is spent by a run).
 * Stop a running demo first (one launcher per state directory).
 *
 * Exit code 0 only if every check passes, every bot started funded, and the supervised processes
 * stayed up until shutdown.
 */
import { dirname, join, resolve } from 'path'

import { createMonadJsonRpcProvider } from '@frank/wallet/monad-provider'

import { resolveDemoConfig } from './demo-config'
import { DemoHandle, redact, startDemo } from './demo'
import { readEnvFile } from './env-file'
import type { RealWallet } from './real-stack'
import { runSmokeChecks, SmokeCheck } from './smoke-checks'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')

/** The relay's authenticated chain proxy, as the app uses it: a registered account obtains a
 * capability and reads a balance from the real chain through the relay. */
export async function checkProtectedRelayRpc(handle: DemoHandle, user: RealWallet): Promise<SmokeCheck> {
  const name = 'protected-relay-rpc'
  const identity = user.handle.identity
  const provider = createMonadJsonRpcProvider({
    rpcUrl: `${handle.relayUrl}/chain-rpc/monad-testnet/rpc`,
    chainId: 10143,
    relayAuth: {
      chain: 'monad-testnet',
      customer: identity.address.raw,
      subject: Buffer.from(identity.compressedPubKey).toString('hex'),
      networkTag: 'MONT',
      signDigest: digest => identity.signHash(Buffer.from(digest)),
    },
  })
  try {
    const viaRelay = await provider.getBalance(handle.fundingAddress)
    return { name, ok: true, detail: `the funding wallet's balance (${viaRelay} wei) was read from the chain through the relay proxy` }
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) }
  } finally {
    provider.destroy()
  }
}

export async function runSmoke(env: Record<string, string | undefined>): Promise<boolean> {
  let handle: DemoHandle | undefined
  let ok = false
  const reportError = (phase: string, err: unknown) =>
    console.error(`FAIL  smoke ${phase}: ${redact(err instanceof Error ? err.message : 'unknown error', [])}`)
  try {
    const envFilePath = env.FRANK_DEMO_ENV_FILE
      ? resolve(env.INIT_CWD ?? process.cwd(), env.FRANK_DEMO_ENV_FILE)
      : join(REPO_ROOT, '.env')
    const config = resolveDemoConfig({
      env,
      envFile: readEnvFile(envFilePath),
      envFileDir: dirname(envFilePath),
      cwd: env.INIT_CWD ?? process.cwd(),
      allowDrawFlag: process.argv.includes('--allow-draw'),
    })
    handle = await startDemo(config, { env, print: l => console.log(l) })
    // The proxy check runs as the same test user, while that user's wallet is open.
    const started = handle
    let proxy: SmokeCheck = { name: 'protected-relay-rpc', ok: false, detail: 'not reached: the test user could not be opened' }
    const results: SmokeCheck[] = await runSmokeChecks(handle, {
      timeoutMs: 180_000,
      env,
      onUser: async user => {
        proxy = await checkProtectedRelayRpc(started, user)
      },
    })
    results.push(proxy)
    for (const r of results) {
      // Only the configured secrets are removed: the general scrubber reads a long plain sentence
      // as a recovery phrase and would blank the detail.
      const detail = config.secrets.reduce((text, secret) => text.split(secret).join('<redacted>'), r.detail)
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}: ${detail}`)
    }
    ok = results.length > 0 && results.every(r => r.ok)
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
      console.log(`FAIL  supervised children exited unexpectedly: ${unhealthy.join(', ')}`)
    }
    if (handle) console.log(`\nstate and logs: ${handle.config.stateDir}`)
  }
  console.log(ok ? '\nSMOKE OK' : '\nSMOKE FAILED')
  return ok
}

if (require.main === module) {
  runSmoke(process.env).then(
    ok => process.exit(ok ? 0 : 1),
    err => {
      console.error('smoke test error:', err instanceof Error ? err.message : err)
      process.exit(1)
    },
  )
}
