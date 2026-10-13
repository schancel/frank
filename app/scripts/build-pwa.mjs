import { execSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(__dirname, '..')

function resolveCommitHash() {
  if (process.env.QCLI_GIT_COMMIT_HASH) return process.env.QCLI_GIT_COMMIT_HASH
  for (const p of [
    path.join(appDir, 'private-build/source.json'),
    path.join(appDir, '../private-build/source.json'),
  ]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
      const hash =
        parsed.public_source_sha || parsed.commitSha || parsed.resolvedOrigin
      if (hash) return hash
    } catch (err) {}
  }
  try {
    return execSync('git rev-parse HEAD', { cwd: appDir }).toString().trim()
  } catch (err) {
    return 'unknown'
  }
}

const hash = resolveCommitHash()
process.env.QCLI_GIT_COMMIT_HASH = hash

const res = spawnSync(
  'yarn',
  ['quasar', 'build', '-m', 'pwa', ...process.argv.slice(2)],
  {
    cwd: appDir,
    stdio: 'inherit',
    env: process.env,
  },
)
process.exit(res.status ?? 0)
