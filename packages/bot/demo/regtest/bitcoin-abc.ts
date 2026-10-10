/**
 * Fetches the Bitcoin ABC node (the eCash reference client, with the Chronik indexer built in)
 * that the eCash regtest runs. Nothing is committed: the release archive is downloaded once into a
 * git-ignored cache, checked against the SHA-256 pinned below, and unpacked there.
 *
 *   yarn --cwd packages/bot regtest:fetch       # download, verify, print the path of bitcoind
 *
 * The cache is `<repo>/.regtest-cache` (or FRANK_REGTEST_CACHE_DIR, to share one download between
 * worktrees). FRANK_BITCOIN_ABC_BIN_DIR names a directory that already holds `bitcoind` built with
 * Chronik and skips the download.
 *
 * To move to a newer release: change BITCOIN_ABC_VERSION and copy the three hashes from the signed
 * list at https://download.bitcoinabc.org/<version>/ (`*-sha256sums.<version>.asc`).
 *
 * macOS: Bitcoin ABC publishes an x86_64 build only. On Apple silicon it runs under Rosetta
 * (`softwareupdate --install-rosetta`).
 */
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'

export const BITCOIN_ABC_VERSION = '0.34.0'

/** Release archives by `${process.platform}-${process.arch}`, with the SHA-256 of each. */
const ARCHIVES: Record<string, { path: string; sha256: string }> = {
  'darwin-arm64': {
    path: `osx/bitcoin-abc-${BITCOIN_ABC_VERSION}-x86_64-apple-darwin.tar.gz`,
    sha256: '08dbe296274c7940d47e9db15d2c6aa99aa6eb749d84f7888a1d5ce19cfb6233',
  },
  'darwin-x64': {
    path: `osx/bitcoin-abc-${BITCOIN_ABC_VERSION}-x86_64-apple-darwin.tar.gz`,
    sha256: '08dbe296274c7940d47e9db15d2c6aa99aa6eb749d84f7888a1d5ce19cfb6233',
  },
  'linux-x64': {
    path: `linux/bitcoin-abc-${BITCOIN_ABC_VERSION}-x86_64-linux-gnu.tar.gz`,
    sha256: '2bd8d98fd67d9957fdc001e4426dccb4a6b37d3ee8aa0e01ae94fb0d26f9dafa',
  },
  'linux-arm64': {
    path: `linux/bitcoin-abc-${BITCOIN_ABC_VERSION}-aarch64-linux-gnu.tar.gz`,
    sha256: '1f6f2b8b83effe8cbaf0fad969ceae0754808a5be110921ccfb19aaa6e7ed75b',
  },
}

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..')

function checkRuns(bitcoind: string): void {
  try {
    execFileSync(bitcoind, ['-version'], { stdio: 'ignore' })
  } catch (err) {
    const rosetta =
      process.platform === 'darwin' && process.arch === 'arm64'
        ? ' On Apple silicon it needs Rosetta: softwareupdate --install-rosetta'
        : ''
    throw new Error(`${bitcoind} does not run (${err instanceof Error ? err.message : String(err)}).${rosetta}`)
  }
}

/** Returns the path of a runnable `bitcoind`, downloading and verifying the release if needed. */
export async function ensureBitcoinAbc(
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  if (env.FRANK_BITCOIN_ABC_BIN_DIR) {
    const own = join(resolve(env.FRANK_BITCOIN_ABC_BIN_DIR), 'bitcoind')
    if (!existsSync(own)) throw new Error(`FRANK_BITCOIN_ABC_BIN_DIR has no bitcoind: ${own}`)
    checkRuns(own)
    return own
  }
  const archive = ARCHIVES[`${process.platform}-${process.arch}`]
  if (!archive) {
    throw new Error(
      `Bitcoin ABC publishes no build for ${process.platform}-${process.arch}; set FRANK_BITCOIN_ABC_BIN_DIR to a directory holding a bitcoind built with Chronik`,
    )
  }
  const cache = resolve(env.FRANK_REGTEST_CACHE_DIR ?? join(REPO_ROOT, '.regtest-cache'))
  const home = join(cache, `bitcoin-abc-${BITCOIN_ABC_VERSION}`)
  const bitcoind = join(home, 'bin', 'bitcoind')
  // `home` appears only by the rename below, complete and verified, and is never removed here:
  // another run sharing the cache may be executing the node inside it.
  const marker = join(home, '.verified-sha256')
  if (existsSync(home) && readFileSync(marker, 'utf8').trim() !== archive.sha256) {
    throw new Error(`${home} does not hold the pinned release; remove it and run again`)
  }
  if (!existsSync(home)) {
    mkdirSync(cache, { recursive: true })
    const url = `https://download.bitcoinabc.org/${BITCOIN_ABC_VERSION}/${archive.path}`
    const response = await fetch(url)
    if (!response.ok) throw new Error(`downloading ${url} failed: HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (sha256 !== archive.sha256) {
      throw new Error(`${url} has SHA-256 ${sha256}, expected ${archive.sha256}: not unpacked`)
    }
    // Unpack into a directory of this process and rename it into place in one step, so two
    // runs starting together never see a half-written directory.
    const staging = join(cache, `unpack-${process.pid}`)
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging)
    const tarball = join(staging, 'bitcoin-abc.tar.gz')
    writeFileSync(tarball, bytes)
    execFileSync('tar', ['-xzf', tarball, '-C', staging])
    writeFileSync(join(staging, `bitcoin-abc-${BITCOIN_ABC_VERSION}`, '.verified-sha256'), archive.sha256)
    try {
      renameSync(join(staging, `bitcoin-abc-${BITCOIN_ABC_VERSION}`), home)
    } catch (err) {
      // Another run put its verified copy there first; use that one.
      if (!existsSync(marker)) throw err
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }
  checkRuns(bitcoind)
  return bitcoind
}

if (require.main === module) {
  ensureBitcoinAbc().then(
    path => console.log(path),
    err => {
      console.error(err instanceof Error ? err.message : err)
      process.exit(1)
    },
  )
}
