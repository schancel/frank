/**
 * The one decision a suite on a real node makes when its binary is missing: skip with NOT RUN
 * locally, fail under FRANK_REQUIRE_NODES=1.
 */
import { anvilBinary, findAnvil, nodeSuiteReady } from './node-binaries.testutil'

const missingAnvil = anvilBinary(undefined)

describe('nodeSuiteReady', () => {
  let warn: jest.SpyInstance
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => warn.mockRestore())

  it('runs a suite whose binaries are all found', () => {
    expect(nodeSuiteReady('x.anvil', [anvilBinary('/bin/anvil')], { FRANK_REQUIRE_NODES: '1' })).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  it('skips with NOT RUN when a binary is missing and nodes are not required', () => {
    expect(nodeSuiteReady('x.anvil', [missingAnvil], {})).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^NOT RUN: x\.anvil needs anvil \(set ANVIL_BIN/))
  })

  it('fails, naming the binary and FRANK_REQUIRE_NODES, when nodes are required', () => {
    const bitcoind = { name: 'a Chronik-enabled bitcoind', found: false, hint: 'set FRANK_BITCOIN_ABC_BIN_DIR' }
    expect(() =>
      nodeSuiteReady('x.regtest', [bitcoind, anvilBinary('/bin/anvil'), missingAnvil], { FRANK_REQUIRE_NODES: '1' }),
    ).toThrow(
      'x.regtest needs a Chronik-enabled bitcoind (set FRANK_BITCOIN_ABC_BIN_DIR) and anvil (set ANVIL_BIN, install ' +
        'the @foundry-rs/anvil package (yarn install), or put anvil on PATH), and FRANK_REQUIRE_NODES=1 requires it to run.',
    )
    expect(warn).not.toHaveBeenCalled()
  })

  it('takes only FRANK_REQUIRE_NODES=1 as required', () => {
    expect(nodeSuiteReady('x.anvil', [missingAnvil], { FRANK_REQUIRE_NODES: 'true' })).toBe(false)
  })
})

describe('findAnvil', () => {
  it('takes ANVIL_BIN, when set, as the only candidate: a missing path is missing', () => {
    expect(findAnvil({ ANVIL_BIN: '/nonexistent/anvil' })).toBeUndefined()
  })

  it('returns an ANVIL_BIN that exists', () => {
    expect(findAnvil({ ANVIL_BIN: process.execPath })).toBe(process.execPath)
  })
})
