// The generated type identifiers agree with docs/protocol/message-types/v1.json, the one source.
// Regenerate with `yarn message-types:generate`; `yarn message-types:check` is the full gate.
import * as fs from 'fs'
import * as path from 'path'
import * as generated from '../src/message-types.generated'

interface RegistryEntry {
  id: number
  key: string
  open_item_field: boolean
}

const REGISTRY = path.resolve(
  __dirname,
  '../../../docs/protocol/message-types/v1.json',
)
const entries: RegistryEntry[] = JSON.parse(
  fs.readFileSync(REGISTRY, 'utf8'),
).types
const constName = (key: string) =>
  'TYPE_' + key.toUpperCase().replace(/-/g, '_')

describe('message type registry', () => {
  it('allocates every id and key once', () => {
    const ids = entries.map(e => e.id)
    const keys = entries.map(e => e.key)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('generates exactly one constant per registered type, with its id', () => {
    const exported = Object.fromEntries(
      Object.entries(generated).filter(([name]) => name.startsWith('TYPE_')),
    )
    expect(exported).toEqual(
      Object.fromEntries(entries.map(e => [constName(e.key), e.id])),
    )
  })

  it('derives the S8 open-field exclusion from the registry', () => {
    expect([...generated.OPEN_ITEM_FIELD_FORBIDDEN_TYPES].sort()).toEqual(
      entries
        .filter(e => !e.open_item_field)
        .map(e => e.id)
        .sort(),
    )
  })
})
