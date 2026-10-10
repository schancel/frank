/**
 * The hosted CI job names the wallet's payment suites one by one. Jest treats each name as a
 * filter, so a name that matches no file runs nothing and the job stays green with the coverage
 * gone (it happened when the send rewrite renamed four suites). Every `.jest.test.ts` name the
 * workflow gives to this package must be a file here, and the suites of the send path must be
 * among them.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const workflow = readFileSync(
  join(__dirname, '..', '..', '.github', 'workflows', 'app-lint-and-test.yml'),
  'utf8',
)
const named = workflow
  .split('\n')
  .filter(line => line.includes('yarn workspace @frank/wallet test'))
  .flatMap(line => line.match(/[\w./-]+\.jest\.test\.ts/g) ?? [])

describe('the wallet suites hosted CI names', () => {
  it('names some', () => {
    expect(named.length).toBeGreaterThan(5)
  })
  it.each(named)('%s exists', name => {
    expect(existsSync(join(__dirname, name))).toBe(true)
  })
  it.each([
    'chain/monad-parallel-send.jest.test.ts',
    'chain/monad-parallel-send.anvil.jest.test.ts',
    'chain/monad-outgoing-message-store.jest.test.ts',
    'chain/monad-fund-ahead.jest.test.ts',
    'chain/monad-canonical-dm-message-id.jest.test.ts',
    'chain/monad-chain.jest.test.ts',
    'evm-spend-spacing.jest.test.ts',
  ])('the send path suite %s is run', name => {
    expect(named).toContain(name)
  })
})
