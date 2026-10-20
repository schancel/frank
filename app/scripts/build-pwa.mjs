import { execSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import brandConfig from '../config/brand.cjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(__dirname, '..')
const { BUILTIN_BRANDS, resolveAppBrand } = brandConfig

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

const rawArgs = process.argv.slice(2)
const passthroughArgs = []
let cliBrand = undefined
let allBrands = false

let skipExtensions = false

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i]
  if (arg === '--all-brands') {
    allBrands = true
  } else if (arg === '--skip-extensions') {
    skipExtensions = true
  } else if (arg === '--brand' && rawArgs[i + 1]) {
    cliBrand = rawArgs[++i]
  } else if (arg.startsWith('--brand=')) {
    cliBrand = arg.slice('--brand='.length)
  } else {
    passthroughArgs.push(arg)
  }
}

function buildBrandTarget(brandSlug, customDistDir) {
  const env = {
    ...process.env,
    ...(brandSlug ? { APP_BRAND: brandSlug } : {}),
    ...(customDistDir ? { APP_DIST_DIR: customDistDir } : {}),
  }
  const resolved = resolveAppBrand(env)
  console.log(
    `[build:pwa] Building brand "${resolved.productName}" (${resolved.id})${
      customDistDir ? ` -> ${customDistDir}` : ''
    }`,
  )
  const res = spawnSync(
    'yarn',
    ['quasar', 'build', '-m', 'pwa', ...passthroughArgs],
    {
      cwd: appDir,
      stdio: 'inherit',
      env,
    },
  )
  if ((res.status ?? 0) !== 0) {
    process.exit(res.status ?? 1)
  }
  if (!skipExtensions) {
    const extRes = spawnSync(
      process.execPath,
      [path.join(__dirname, 'build-extension.mjs'), '--skip-pwa-build'],
      {
        cwd: appDir,
        stdio: 'inherit',
        env,
      },
    )
    if ((extRes.status ?? 0) !== 0) {
      process.exit(extRes.status ?? 1)
    }
  }
}

if (allBrands) {
  for (const brandId of Object.keys(BUILTIN_BRANDS)) {
    buildBrandTarget(brandId, `dist/pwa-${brandId}`)
  }
} else {
  buildBrandTarget(cliBrand, process.env.APP_DIST_DIR)
}
