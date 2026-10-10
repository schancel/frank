/**
 * Smoke test for the one-command demo, on Monad testnet with the real relay binary:
 *
 *   yarn demo:smoke
 *
 * Starts exactly what `yarn demo` starts (same `.env`, same state directory unless
 * FRANK_DEMO_STATE_DIR says otherwise, so bots funded by an earlier run are not funded again),
 * then a new user with a real wallet messages each bot and every reply is checked for its
 * content; the faucet's payment and the relay's proxied chain RPC are checked on chain. It spends
 * real testnet funds: the bots' funding on a first run, and 0.05 MON lent to the test user, of
 * which what is left is returned. Stop a running demo first (one launcher per state directory).
 *
 * Exit code 0 only if every check passes, every bot started funded, and the supervised processes
 * stayed up until shutdown.
 */
import { join, resolve } from 'path'

import { createMonadJsonRpcProvider } from '@frank/wallet/monad-provider'

import { resolveDemoConfig } from './demo-config'
import { DemoHandle, redact, startDemo } from './demo'
import { readEnvFile } from './env-file'
import { openRealWallet } from './real-stack'
import { runSmokeChecks, SmokeCheck } from './smoke-checks'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')

/** The relay's authenticated chain proxy, as the app uses it: a registered account obtains a
 * capability and reads a balance from the real chain through the relay. */
export async function checkProtectedRelayRpc(handle: DemoHandle): Promise<SmokeCheck> {
  const name = 'protected-relay-rpc'
  const wallet = await openRealWallet({
    label: 'proxy-smoke',
    relayUrl: handle.relayUrl,
    stateDir: join(handle.config.stateDir, `smoke-proxy-${Date.now()}`),
  })
  const identity = wallet.handle.identity
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
    await wallet.close()
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
      cwd: env.INIT_CWD ?? process.cwd(),
    })
    handle = await startDemo(config, { env, print: l => console.log(l) })
    const results: SmokeCheck[] = await runSmokeChecks(handle, { timeoutMs: 180_000, env })
    results.push(await checkProtectedRelayRpc(handle).catch(err => ({ name: 'protected-relay-rpc', ok: false, detail: String(err) })))
    for (const r of results) {
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}: ${redact(r.detail, config.secrets)}`)
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
