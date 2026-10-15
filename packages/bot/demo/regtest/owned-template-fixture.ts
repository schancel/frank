/** Import-safe, unfunded Bitcoin ABC regtest getblocktemplate fixture. */
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { Supervisor, SupervisedChild } from '../supervisor'
import { freePort, isListening, sleep } from './regtest-chain'

const PIN = '08dbe296274c7940d47e9db15d2c6aa99aa6eb749d84f7888a1d5ce19cfb6233'
export interface BlockTemplate {
  height: number
  previousblockhash: string
  transactions: unknown[]
}
export interface ReadyTemplateFixture {
  readonly chainIdentifier: 'xec-regtest'
  readonly disconnectedError: { code: number; message: string }
  readonly template: BlockTemplate
  rpc<T = unknown>(method: string, params?: unknown[]): Promise<T>
  stop(): Promise<void>
}
class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message) }
}
/** Requires the previously verified Darwin 0.34.0 archive; never downloads. */
export async function startOwnedTemplateFixture(options: {
  archive: string
  binaryDir: string
  timeoutMs?: number
}): Promise<ReadyTemplateFixture> {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error('timeoutMs must be positive and finite')
  const archive = resolve(options.archive)
  const binary = resolve(options.binaryDir, 'bitcoind')
  const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex')
  if (digest(readFileSync(archive)) !== PIN) throw new Error('pinned ABC archive identity mismatch')
  const archived = execFileSync('tar', ['-xOf', archive, 'bitcoin-abc-0.34.0/bin/bitcoind'], { maxBuffer: 128 * 1024 * 1024 })
  if (digest(archived) !== digest(readFileSync(binary))) throw new Error('ABC binary differs from pinned archive')
  const version = execFileSync(binary, ['-version'], { encoding: 'utf8' }).split('\n')[0]!
  if (!version.startsWith('Bitcoin ABC version v0.34.0-')) throw new Error('ABC version mismatch')
  const root = mkdtempSync(join(tmpdir(), 'frank-owned-template-'))
  const supervisor = new Supervisor(process.env, () => {})
  const ports: number[] = []
  const nodes: Array<{ rpc: ReadyTemplateFixture['rpc']; child: SupervisedChild }> = []
  let stopping: Promise<void> | undefined
  let interrupted = false
  const kill = () => { supervisor.killAllNow(); rmSync(root, { recursive: true, force: true }) }
  const stop = () => stopping ??= (async () => {
    await supervisor.stopAll(3000)
    rmSync(root, { recursive: true, force: true })
    process.off('exit', kill)
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
    for (const port of ports) if (await isListening(port)) throw new Error('owned fixture port remained open')
  })()
  const interrupt = () => { interrupted = true; void stop().catch(() => { process.exitCode = 1 }) }
  process.once('exit', kill)
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  const deadline = Date.now() + (options.timeoutMs ?? 30000)
  const wait = async (ready: () => Promise<boolean>) => {
    for (;;) {
      if (interrupted) throw new Error('owned fixture interrupted')
      if (nodes.some(node => node.child.hasExited())) throw new Error('owned ABC exited before readiness')
      if (Date.now() >= deadline) throw new Error('owned ABC readiness timeout')
      if (await ready()) return
      await sleep(100)
    }
  }
  try {
    for (let i = 0; i < 2; i++) {
      const dataDir = join(root, `node-${i}`)
      mkdirSync(dataDir, { mode: 0o700 })
      const rpcPort = await freePort()
      ports.push(rpcPort)
      const p2pPort = await freePort()
      ports.push(p2pPort)
      const cookie = join(dataDir, 'regtest', '.cookie')
      const child = supervisor.start({ name: `template-${i}`, command: binary,
        args: ['-regtest', `-datadir=${dataDir}`, '-server', '-disablewallet', '-dnsseed=0', '-discover=0', '-connect=0', '-listen=1', `-bind=127.0.0.1:${p2pPort}`, `-port=${p2pPort}`, `-rpcport=${rpcPort}`, '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1', '-dbcache=16', '-maxmempool=8', '-par=1'],
        cwd: dataDir, logPath: join(root, `node-${i}.log`), env: {} })
      const rpc: ReadyTemplateFixture['rpc'] = async <T>(method: string, params: unknown[] = []) => {
        const response = await fetch(`http://127.0.0.1:${rpcPort}`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(readFileSync(cookie, 'utf8').trim()).toString('base64')}` },
          body: JSON.stringify({ jsonrpc: '1.0', id: 'owned-template', method, params }), signal: AbortSignal.timeout(2000),
        })
        const body = await response.json() as { result: T; error: { code: number; message: string } | null }
        if (body.error) throw new RpcError(body.error.code, body.error.message)
        return body.result
      }
      nodes.push({ rpc, child })
      await wait(async () => {
        if (!existsSync(cookie)) return false
        try { await rpc('getblockcount'); return true } catch { return false }
      })
      const info = await rpc<{ chain: string; blocks: number; initialblockdownload: boolean }>('getblockchaininfo')
      const network = await rpc<{ subversion: string }>('getnetworkinfo')
      if (info.chain !== 'regtest' || info.blocks !== 0 || !info.initialblockdownload || !network.subversion.includes('Bitcoin ABC:0.34.0')) throw new Error('RPC identity mismatch')
    }
    const first = nodes[0]!
    let disconnectedError: { code: number; message: string } | undefined
    try { await first.rpc('getblocktemplate') } catch (error) {
      if (!(error instanceof RpcError) || error.code !== -9 || error.message !== 'Bitcoin is not connected!') throw error
      disconnectedError = { code: error.code, message: error.message }
    }
    if (!disconnectedError) throw new Error('disconnected getblocktemplate unexpectedly succeeded')
    await first.rpc('addnode', [`127.0.0.1:${ports[3]!}`, 'onetry'])
    // A fresh genesis tip is too old to leave IBD; ordinary RPC mining keeps validation intact.
    const bootstrap = await first.rpc<string[]>('generatetodescriptor', [1, 'raw(6a)'])
    if (bootstrap.length !== 1) throw new Error('ordinary bootstrap block was not mined')
    await wait(async () => {
      for (const node of nodes) {
        const peers = await node.rpc<Array<{ version: number; pingtime?: number }>>('getpeerinfo')
        const chain = await node.rpc<{ initialblockdownload: boolean; blocks: number; bestblockhash: string }>('getblockchaininfo')
        if (chain.initialblockdownload || chain.blocks !== 1 || chain.bestblockhash !== bootstrap[0] || !peers.some(p => p.version > 0 && p.pingtime !== undefined)) return false
      }
      return true
    })
    const template = await first.rpc<BlockTemplate>('getblocktemplate')
    if (template.height !== 2 || !/^[0-9a-f]{64}$/.test(template.previousblockhash) || !Array.isArray(template.transactions)) throw new Error('invalid ready template')
    return { chainIdentifier: 'xec-regtest', disconnectedError, template, rpc: first.rpc, stop }
  } catch (error) { await stop(); throw error }
}
if (require.main === module) {
  ;(async () => {
    const archive = process.env.ADAPTOR_ABC_ARCHIVE
    const binaryDir = process.env.FRANK_BITCOIN_ABC_BIN_DIR
    if (!archive || !binaryDir) throw new Error('verified archive and binary directory required')
    const fixture = await startOwnedTemplateFixture({ archive, binaryDir })
    try { console.log(JSON.stringify({ chainIdentifier: fixture.chainIdentifier, disconnectedError: fixture.disconnectedError, templateHeight: fixture.template.height, transactions: fixture.template.transactions.length })) }
    finally { await fixture.stop() }
  })().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
