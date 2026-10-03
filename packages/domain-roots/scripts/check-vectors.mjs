import { hkdfSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const vectors = JSON.parse(
  await readFile(new URL('../vectors/domain-roots-v1.json', import.meta.url)),
)
const registryId = Buffer.from(vectors.registry, 'ascii')
const salt = Buffer.from('frank/domain-root-registry/v1', 'ascii')
const purposes = [
  [1, 'ecash-bch-wallet'],
  [2, 'evm-wallet'],
  [3, 'solana-wallet'],
  [4, 'messaging-encryption'],
  [5, 'identity-authentication'],
]

function u16be(value) {
  const result = Buffer.alloc(2)
  result.writeUInt16BE(value)
  return result
}

for (const vector of vectors.vectors) {
  const root = Buffer.from(vector.accountRoot, 'hex')
  for (const [code, purpose] of purposes) {
    const label = Buffer.from(`frank/domain-root/v1/${purpose}`, 'ascii')
    const info = Buffer.concat([
      u16be(registryId.length),
      registryId,
      u16be(code),
      u16be(label.length),
      label,
      u16be(32),
    ])
    const actual = Buffer.from(
      hkdfSync('sha256', root, salt, info, 32),
    ).toString('hex')
    if (actual !== vector.outputs[purpose]) {
      throw new Error(`vector mismatch for ${vector.accountRoot}/${purpose}`)
    }
  }
}

console.log(`verified ${vectors.vectors.length * purposes.length} vectors`)
