import { spawnSync } from 'child_process'
import { existsSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { Supervisor } from './supervisor'

export interface NgrokTunnelInfo {
  name: string
  public_url: string
  proto: string
  config?: {
    addr: string
    inspect?: boolean
  }
}

export interface NgrokApiResponse {
  tunnels: NgrokTunnelInfo[]
  uri: string
}

export interface RenderNgrokConfigParams {
  relayPort: number
  appPort: number
  relayDomain?: string
  appDomain?: string
  authtoken?: string
}

export interface StartNgrokOptions {
  stateDir: string
  logDir: string
  relayPort: number
  appPort: number
  ngrokBin?: string
  ngrokConfig?: string
  ngrokRelayDomain?: string
  ngrokAppDomain?: string
  ngrokAuthtoken?: string
  argsOverride?: string[]
  timeoutMs?: number
  pollMs?: number
  supervisor: Supervisor
  fetchFn?: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>
}

export interface NgrokResult {
  publicRelayUrl?: string
  publicAppUrl?: string
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * Searches for an existing user ngrok configuration file (e.g. from `ngrok config check`
 * or OS-standard locations) so that user-saved credentials (authtoken) are preserved
 * when merging the demo's ephemeral tunnel definitions.
 */
export function locateUserNgrokConfig(ngrokBin = 'ngrok'): string | undefined {
  try {
    const res = spawnSync(ngrokBin, ['config', 'check'], { encoding: 'utf8' })
    if (res.status === 0 && res.stdout) {
      const match = res.stdout.match(/Valid configuration file at (.*)/)
      if (match && match[1] && existsSync(match[1].trim())) {
        return match[1].trim()
      }
    }
  } catch {
    // ignore
  }

  const candidates = [
    join(homedir(), 'Library', 'Application Support', 'ngrok', 'ngrok.yml'),
    join(homedir(), '.config', 'ngrok', 'ngrok.yml'),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'ngrok', 'ngrok.yml') : '',
  ].filter(Boolean)

  for (const path of candidates) {
    if (existsSync(path)) return path
  }

  return undefined
}

/**
 * Renders YAML configuration for the ngrok agent (version 3 format) declaring
 * endpoints/tunnels for both the local relay port and the frontend app dev server port.
 */
export function renderDemoNgrokYaml(params: RenderNgrokConfigParams): string {
  const lines: string[] = ['version: "3"']
  if (params.authtoken) {
    lines.push('agent:')
    lines.push(`  authtoken: ${params.authtoken}`)
  }
  lines.push('tunnels:')
  lines.push('  relay:')
  lines.push('    proto: http')
  lines.push(`    addr: ${params.relayPort}`)
  if (params.relayDomain) {
    lines.push(`    domain: ${params.relayDomain}`)
  }
  lines.push('  app:')
  lines.push('    proto: http')
  lines.push(`    addr: ${params.appPort}`)
  if (params.appDomain) {
    lines.push(`    domain: ${params.appDomain}`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * Starts the ngrok agent via Supervisor, waits until the local API at 127.0.0.1:4040
 * reports active tunnels, and extracts the public URLs for both the relay and the app.
 */
export async function startNgrok(options: StartNgrokOptions): Promise<NgrokResult> {
  const ngrokBin = options.ngrokBin || 'ngrok'
  const demoConfigPath = join(options.stateDir, 'ngrok.yml')
  const demoYaml = renderDemoNgrokYaml({
    relayPort: options.relayPort,
    appPort: options.appPort,
    relayDomain: options.ngrokRelayDomain,
    appDomain: options.ngrokAppDomain,
    authtoken: options.ngrokAuthtoken,
  })
  writeFileSync(demoConfigPath, demoYaml, 'utf8')

  const userConfig = options.ngrokConfig ?? locateUserNgrokConfig(ngrokBin)
  const args = options.argsOverride ?? [
    'start',
    '--all',
    ...(userConfig && existsSync(userConfig) ? ['--config', userConfig] : []),
    '--config',
    demoConfigPath,
    '--log=stdout',
  ]

  options.supervisor.start({
    name: 'ngrok',
    command: ngrokBin,
    args,
    cwd: options.stateDir,
    env: {},
    logPath: join(options.logDir, 'ngrok.log'),
  })

  const timeoutMs = options.timeoutMs ?? 15000
  const deadline = Date.now() + timeoutMs
  const pollInterval = options.pollMs ?? 250
  const fetcher =
    options.fetchFn ??
    (globalThis.fetch as unknown as (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>)

  while (Date.now() < deadline) {
    const child = options.supervisor.get('ngrok')
    if (child?.hasExited()) {
      const tail = child.tail().slice(-10)
      throw new Error(`ngrok exited unexpectedly. Last output:\n${tail.join('\n')}`)
    }

    try {
      const res = await fetcher('http://127.0.0.1:4040/api/tunnels')
      if (res.ok) {
        const body = (await res.json()) as NgrokApiResponse
        if (body.tunnels && body.tunnels.length > 0) {
          const relayTunnel = body.tunnels.find(t => t.name === 'relay')
          const appTunnel = body.tunnels.find(t => t.name === 'app')
          const fallback = body.tunnels[0]
          return {
            publicRelayUrl: relayTunnel?.public_url ?? fallback?.public_url,
            publicAppUrl: appTunnel?.public_url ?? fallback?.public_url,
          }
        }
      }
    } catch {
      // not yet responding
    }

    await sleep(pollInterval)
  }

  throw new Error(`ngrok tunnels failed to become ready within ${timeoutMs / 1000}s`)
}
