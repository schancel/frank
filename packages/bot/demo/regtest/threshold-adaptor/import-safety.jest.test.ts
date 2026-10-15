import * as fs from 'node:fs'
import { JsonRpcProvider } from 'ethers'
import { startEcashRegtest } from '../ecash-regtest'

jest.mock('node:fs', () => ({
  ...jest.requireActual('node:fs'),
  mkdtempSync: jest.fn(() => '/tmp/native-import-must-not-create-state'),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  rmdirSync: jest.fn(),
}))
jest.mock('../ecash-regtest', () => ({
  startEcashRegtest: jest.fn(async () => {
    throw new Error('native node startup on import')
  }),
}))
jest.mock('ethers', () => ({
  ...jest.requireActual('ethers'),
  JsonRpcProvider: jest.fn(() => {
    throw new Error('native RPC construction on import')
  }),
}))

it.each(['xec', 'evm'])(
  '%s livecheck import has no runtime effects',
  async name => {
    const savedEnvironment = { ...process.env }
    const savedExitCode = process.exitCode
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('fetch on import'))
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    process.env.ADAPTOR_MONAD_RPC_URL = 'http://127.0.0.1:1'
    process.env.ADAPTOR_MONAD_CHECKPOINT_HEIGHT = '1'
    process.env.ADAPTOR_MONAD_CHECKPOINT_HASH = `0x${'11'.repeat(32)}`
    const expectedEnvironment = { ...process.env }
    jest.clearAllMocks()
    try {
      // Match the CommonJS boundary used by the repository's bot entry safety gate.
      require(`./${name}.livecheck`)
      await Promise.resolve()
      await Promise.resolve()
      expect(startEcashRegtest).not.toHaveBeenCalled()
      expect(JsonRpcProvider).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
      for (const operation of [
        fs.mkdtempSync,
        fs.mkdirSync,
        fs.writeFileSync,
        fs.rmdirSync,
      ])
        expect(operation).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(savedExitCode)
      expect(process.env).toEqual(expectedEnvironment)
      expect(consoleSpy).not.toHaveBeenCalled()
    } finally {
      process.env = savedEnvironment
      process.exitCode = savedExitCode
      fetchSpy.mockRestore()
      consoleSpy.mockRestore()
    }
  },
)
