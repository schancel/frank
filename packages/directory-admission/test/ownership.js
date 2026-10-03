import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openNodeDirectoryStore } from '../src/node'
import { runOwnership } from './ownership-cases'

async function main() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), 'frank-admission-ownership-')),
  )
  try {
    const factory = (name, anchor, mode) =>
      openNodeDirectoryStore({ location: path.join(root, name), anchor, mode })
    const selected = process.argv.slice(2)
    const result = await runOwnership(
      factory,
      selected.length ? selected : undefined,
    )
    console.log(JSON.stringify({ backend: 'native-level-7', ...result }))
    if (!result.ok) process.exitCode = 1
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
