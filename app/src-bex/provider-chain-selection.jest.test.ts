/** @jest-environment jsdom */
import {
  createBackgroundBridgeState,
  handleBackgroundMessage,
  installBackgroundBridge,
  restoreStoredBridgeState,
} from './background'
import { FRANK_DAPP_BRIDGE_CHANNEL } from './runtime-adapter'

const ADDRESS = '0x' + '11'.repeat(20)
const ORIGIN = 'https://dapp.example'
const REGTEST = '0x' + (20143).toString(16)
const sender = { url: 'chrome-extension://provider-test/index.html' }
function fixture() {
  const set = jest.fn(async (_values: Record<string, unknown>) => undefined)
  const scope = {
    chrome: {
      runtime: {
        id: 'provider-test',
        getURL: (path: string) => 'chrome-extension://provider-test/' + path,
      },
      storage: { local: { set } },
    },
  }
  const state = createBackgroundBridgeState(
    { activePersonaAddress: ADDRESS, chainIdHex: '0x1' },
    scope,
  )
  const message = (type: string, fields: Record<string, unknown> = {}) =>
    handleBackgroundMessage(
      { channel: FRANK_DAPP_BRIDGE_CHANNEL, type, ...fields },
      sender,
      state,
      scope,
    )
  const rpc = (method: string, params: unknown[] = []) =>
    message('dapp-rpc-request', { origin: ORIGIN, payload: { method, params } })
  return { state, scope, set, message, rpc }
}

describe('global provider selection and network-tagged observations', () => {
  it('starts from configured canonical regtest and blocks unknown/non-EVM configuration', async () => {
    const previous = process.env.MONAD_RPC_CHAIN
    try {
      process.env.MONAD_RPC_CHAIN = 'monad-regtest'
      expect(createBackgroundBridgeState().chainIdHex).toBe(REGTEST)
      process.env.MONAD_RPC_CHAIN = 'unknown-network'
      expect(
        (
          await handleBackgroundMessage(
            {
              channel: FRANK_DAPP_BRIDGE_CHANNEL,
              type: 'dapp-rpc-request',
              payload: { method: 'eth_chainId' },
            },
            {},
            createBackgroundBridgeState(),
          )
        ).error.code,
      ).toBe(4901)
      process.env.MONAD_RPC_CHAIN = 'solana-devnet'
      expect(
        (
          await handleBackgroundMessage(
            {
              channel: FRANK_DAPP_BRIDGE_CHANNEL,
              type: 'dapp-rpc-request',
              payload: { method: 'eth_chainId' },
            },
            {},
            createBackgroundBridgeState(),
          )
        ).error.code,
      ).toBe(4901)
    } finally {
      if (previous === undefined) delete process.env.MONAD_RPC_CHAIN
      else process.env.MONAD_RPC_CHAIN = previous
    }
  })

  it('preserves restored Ethereum through primary-wallet unlock/persona/balance observations', async () => {
    const f = fixture()
    await restoreStoredBridgeState(f.state, {
      storage: {
        local: {
          get: async () => ({
            frankChainIdHex: '0x01',
            frankPoolBalanceWeiHex: '0x123',
          }),
        },
      },
    })
    expect(f.state.chainIdHex).toBe('0x1')
    expect(f.state.poolBalanceWeiHex).toBe('0x0')
    for (const type of ['update-persona-state', 'set-active-persona']) {
      await f.message(type, {
        address: ADDRESS,
        chainIdentifier: 'monad-regtest',
        chainIdHex: REGTEST,
        poolBalanceWeiHex: '0x50',
      })
      expect((await f.rpc('eth_chainId')).result).toBe('0x1')
      expect((await f.rpc('net_version')).result).toBe('1')
      expect(f.state.poolBalanceWeiHex).toBe('0x0')
    }
    expect(
      f.set.mock.calls.flatMap(call => Object.keys(call[0] ?? {})),
    ).not.toContain('frankChainIdHex')
  })

  it('does not answer a default after unsupported stored selection; explicit selection repairs only the preference', async () => {
    const f = fixture()
    await restoreStoredBridgeState(f.state, {
      storage: {
        local: { get: async () => ({ frankChainIdHex: '0xdeadbeef' }) },
      },
    })
    expect((await f.rpc('eth_chainId')).error.code).toBe(4901)
    expect(
      (await f.rpc('eth_getBalance', [ADDRESS, 'latest'])).error.code,
    ).toBe(4901)
    expect(f.set).not.toHaveBeenCalled()
    f.state.solanaConnectedOrigins.add(ORIGIN)
    expect((await f.rpc('solana_disconnect')).ok).toBe(true)
    expect(f.state.solanaConnectedOrigins.has(ORIGIN)).toBe(false)
    expect(f.state.providerChainError?.code).toBe(4901)
    await f.rpc('wallet_switchEthereumChain', [{ chainId: '0x1' }])
    expect((await f.rpc('eth_chainId')).result).toBe('0x1')
    expect(f.state.providerChainError).toBeUndefined()
    expect(f.set).toHaveBeenCalledWith({
      frankChainIdHex: '0x1',
      frankPoolBalanceWeiHex: '0x0',
    })
  })

  it('keeps failed preference restore visible through the installed runtime listener', async () => {
    const f = fixture()
    let listener: (
      message: unknown,
      sender: unknown,
      reply: (value: unknown) => void,
    ) => unknown = () => undefined
    const scope = {
      chrome: {
        ...f.scope.chrome,
        runtime: {
          ...f.scope.chrome.runtime,
          onMessage: {
            addListener: (value: typeof listener) => {
              listener = value
            },
            removeListener: () => undefined,
          },
        },
        storage: {
          local: {
            set: f.set,
            get: async () => ({ frankChainIdHex: '0xdeadbeef' }),
          },
        },
      },
    }
    const bridge = installBackgroundBridge(scope, f.state)
    try {
      const response = await new Promise(resolve =>
        listener(
          {
            channel: FRANK_DAPP_BRIDGE_CHANNEL,
            type: 'dapp-rpc-request',
            payload: { method: 'eth_chainId' },
          },
          sender,
          resolve,
        ),
      )
      expect(response).toMatchObject({ ok: false, error: { code: 4901 } })
      expect(f.set).not.toHaveBeenCalled()
    } finally {
      bridge.dispose()
    }
  })

  it('requires canonical matching network identity for balance observations', async () => {
    const f = fixture()
    for (const fields of [
      { chainIdHex: '0x1' },
      { chainIdentifier: 'solana-devnet' },
      { chainIdentifier: 'unknown-network' },
      { chainIdentifier: 'ethereum-mainnet', chainIdHex: REGTEST },
    ])
      await f.message('update-persona-state', {
        ...fields,
        poolBalanceWeiHex: '0x99',
      })
    expect(f.state.poolBalanceWeiHex).toBe('0x0')
    await f.message('update-persona-state', {
      chainIdentifier: 'ethereum-mainnet',
      chainIdHex: '0x01',
      poolBalanceWeiHex: '0x99',
    })
    expect(f.state.poolBalanceWeiHex).toBe('0x99')
    expect(f.state.chainIdHex).toBe('0x1')
    await f.rpc('wallet_switchEthereumChain', [{ chainId: REGTEST }])
    expect(f.state.chainIdHex).toBe(REGTEST)
    expect(f.state.poolBalanceWeiHex).toBe('0x0')
  })

  it('rejects unsupported explicit selections without changing selection or balance', async () => {
    const f = fixture()
    for (const type of [
      'set-dapp-chain',
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
    ]) {
      const result =
        type === 'set-dapp-chain'
          ? await f.message(type, { chainIdHex: '0xdeadbeef' })
          : await f.rpc(type, [{ chainId: '0xdeadbeef' }])
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe(4902)
      expect(f.state.chainIdHex).toBe('0x1')
    }
    expect(f.set).not.toHaveBeenCalled()
  })

  it('retains the original pending request chain and persona across later switch and snapshots', async () => {
    const f = fixture()
    f.state.connectedOrigins.add(ORIGIN)
    f.state.approvalWindow = {
      show: async () => undefined,
      close: async () => undefined,
    }
    const decision = f.rpc('eth_sendTransaction', [
      { from: ADDRESS, to: '0x' + '22'.repeat(20), value: '0x1' },
    ])
    await Promise.resolve()
    const pending = [...f.state.pendingApprovals.values()][0]
    expect(pending).toMatchObject({
      chainIdHex: '0x1',
      chainIdentifier: 'ethereum-mainnet',
      personaAddress: ADDRESS,
    })
    await f.rpc('wallet_switchEthereumChain', [{ chainId: REGTEST }])
    await f.message('update-persona-state', {
      address: '0x' + '33'.repeat(20),
      chainIdentifier: 'monad-regtest',
      chainIdHex: REGTEST,
      poolBalanceWeiHex: '0x50',
    })
    expect(f.state.pendingApprovals.get(pending.id)).toBe(pending)
    expect(pending).toMatchObject({
      chainIdHex: '0x1',
      chainIdentifier: 'ethereum-mainnet',
      personaAddress: ADDRESS,
    })
    await f.message('companion-resolve-approval', {
      requestId: pending.id,
      approved: false,
    })
    expect((await decision).error.code).toBe(4001)
  })
})
