import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { BundleRef, TrustBundle } from './provision'
import { endpoint, paths, reopenBundle } from './provision'
import { checkNode, proofMarker } from './https-fixture'

export interface BrowserProof {
  kind: 'synthetic-chromium-spki-transport-proof'
  chromium: string
  node: string
  limitation: 'SPKI bypass is not general PKI or enforce-only pinning; Node owns exact-certificate validation'
}

/** Internal transport probe shared by real-browser negative tests; not exported by index. */
export async function probeChromium(
  bundle: TrustBundle,
  executable: string,
  leafSpki: string | null,
  signal?: AbortSignal,
): Promise<{ chromium: string; profile: string; args: string[]; pid: number }> {
  endpoint(bundle.trustInputs.endpoint)
  if (!isAbsolute(executable))
    throw new Error(
      'Explicit absolute Chromium executable required; browser not verified',
    )
  if (leafSpki !== null && !/^[A-Za-z0-9+/]{43}=$/.test(leafSpki))
    throw new Error('Invalid leaf SPKI hash')
  const version = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 4096,
    env: { PATH: process.env.PATH },
  })
  if (
    version.error ||
    version.status !== 0 ||
    !/Chrom(e|ium)/.test(version.stdout)
  )
    throw new Error('Chromium unavailable; browser not verified')
  if (signal?.aborted) throw new Error('Browser proof aborted')
  const profile = mkdtempSync(join(tmpdir(), 'directory-trust-browser-'))
  const args = [
    '--headless=new',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--use-mock-keychain',
    '--password-store=basic',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-breakpad',
    '--disable-domain-reliability',
    '--enable-logging=stderr',
    '--log-level=0',
    '--no-proxy-server',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--dump-dom',
    '--virtual-time-budget=5000',
    ...(leafSpki === null
      ? []
      : [`--ignore-certificate-errors-spki-list=${leafSpki}`]),
    bundle.trustInputs.endpoint + paths.proof,
  ]
  let pid: number | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, TMPDIR: tmpdir() },
      })
      pid = child.pid
      let output = ''
      let failure: Error | undefined
      let rendered = false
      let diagnosticTail = ''
      // Only this spawned process group, including Chrome's owned helper processes.
      const kill = (sig: NodeJS.Signals) => {
        if (child.pid) {
          try {
            process.kill(-child.pid, sig)
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e
          }
        }
      }
      let force: NodeJS.Timeout | undefined
      const terminate = () => {
        kill('SIGTERM')
        force ??= setTimeout(() => kill('SIGKILL'), 1000)
      }
      const abort = () => {
        failure = new Error('Browser proof aborted or timed out')
        terminate()
      }
      const timer = setTimeout(abort, 20000)
      signal?.addEventListener('abort', abort, { once: true })
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString()
        if (output.length > 1000000) abort()
        // Some macOS Chrome versions keep running after --dump-dom. Own shutdown
        // after the complete document, rather than treating process exit as proof.
        else if (!rendered && output.includes('</html>')) {
          rendered = true
          terminate()
        }
      })
      child.once('error', () => {
        failure = new Error('Chromium failed to start; browser not verified')
      })
      child.stderr.on('data', (chunk: Buffer) => {
        // Retain only a bounded parse window, never publish Chrome's raw logs.
        // Chromium's -200..-209 network errors are certificate validation errors.
        diagnosticTail = (diagnosticTail + chunk.toString()).slice(-4096)
        const certificateError = diagnosticTail.match(/net_error (-20[0-9])\b/)
        if (certificateError && !failure) {
          failure = new Error(
            `Chromium rejected certificate (net_error ${certificateError[1]}); browser not verified`,
          )
          terminate()
        }
      })
      child.once('close', code => {
        clearTimeout(timer)
        if (force) clearTimeout(force)
        signal?.removeEventListener('abort', abort)
        kill('SIGKILL')
        if (failure) reject(failure)
        else if (
          (!rendered && code !== 0) ||
          !output.includes(`<pre id="result">${proofMarker(bundle)}</pre>`)
        )
          reject(
            new Error(
              'Chromium did not prove the exact synthetic endpoint/tuple',
            ),
          )
        else resolve()
      })
    })
    return { chromium: version.stdout.trim(), profile, args, pid: pid! }
  } finally {
    if (pid) {
      let remaining = true
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          process.kill(-pid, 0)
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
            remaining = false
            break
          }
          throw e
        }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      if (remaining)
        throw new Error(
          'Owned Chromium process group did not finish; profile retained for diagnosis',
        )
    }
    rmSync(profile, { recursive: true, force: true })
  }
}

export async function checkBrowser(
  ref: BundleRef,
  nowNs: bigint,
  executable: string,
  signal?: AbortSignal,
): Promise<BrowserProof> {
  const node = await checkNode(ref, nowNs)
  const bundle = reopenBundle(ref, nowNs)
  const result = await probeChromium(
    bundle,
    executable,
    bundle.tls.leafSpkiSha256,
    signal,
  )
  return {
    kind: 'synthetic-chromium-spki-transport-proof',
    chromium: result.chromium,
    node: node.node,
    limitation:
      'SPKI bypass is not general PKI or enforce-only pinning; Node owns exact-certificate validation',
  }
}
