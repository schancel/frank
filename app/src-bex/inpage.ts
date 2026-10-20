export const FRANK_DAPP_BRIDGE_CHANNEL = 'frank-dapp-bridge-v1'

export interface Eip1193RequestArguments {
  readonly method: string
  readonly params?: readonly unknown[] | object
}

export interface Eip6963ProviderInfo {
  uuid: string
  name: string
  icon: string
  rdns: string
}

export interface Eip6963ProviderDetail {
  info: Eip6963ProviderInfo
  provider: FrankInpageProvider
}

export type ProviderEventListener = (...args: any[]) => void

export const FRANK_EIP6963_INFO: Eip6963ProviderInfo = {
  uuid: 'b7e3c9c0-1709-4f7a-9b4a-5369676e6574',
  name: 'Frank',
  icon: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="%23111827"/><text x="32" y="43" text-anchor="middle" font-family="sans-serif" font-size="32" font-weight="bold" fill="%2310b981">F</text></svg>',
  rdns: 'mx.signet.frank',
}

export class FrankInpageProvider {
  public readonly isFrank = true
  public readonly isMetaMask = false
  public selectedAddress: string | null = null
  public chainId: string | null = '0x279f'
  public networkVersion: string | null = '10143'
  private listeners = new Map<string, Set<ProviderEventListener>>()
  private pending = new Map<
    string,
    { resolve: (value: any) => void; reject: (reason?: any) => void }
  >()
  private requestCounter = 0
  private win: Window

  constructor(win: Window) {
    this.win = win
    this.win.addEventListener('message', this.handleWindowMessage)
  }

  public isConnected(): boolean {
    return true
  }

  private handleWindowMessage = (event: MessageEvent) => {
    if (event.source !== null && event.source !== this.win) return
    const data = event.data
    if (
      !data ||
      typeof data !== 'object' ||
      data.channel !== FRANK_DAPP_BRIDGE_CHANNEL ||
      data.direction !== 'to-inpage'
    ) {
      return
    }

    if (data.type === 'rpc-response' && typeof data.id === 'string') {
      const entry = this.pending.get(data.id)
      if (!entry) return
      this.pending.delete(data.id)
      if (data.error) {
        const err = new Error(
          data.error.message || 'Frank dApp provider error',
        ) as Error & { code?: number; data?: unknown }
        err.code =
          typeof data.error.code === 'number' ? data.error.code : -32603
        err.data = data.error.data
        entry.reject(err)
      } else {
        entry.resolve(data.result)
      }
      return
    }

    if (data.type === 'provider-event' && typeof data.event === 'string') {
      if (data.event === 'accountsChanged' && Array.isArray(data.payload)) {
        this.selectedAddress =
          typeof data.payload[0] === 'string' ? data.payload[0] : null
      } else if (
        data.event === 'chainChanged' &&
        typeof data.payload === 'string'
      ) {
        this.chainId = data.payload
        this.networkVersion = String(parseInt(data.payload, 16))
      }
      this.emit(data.event, data.payload)
    }
  }

  public async request<T = unknown>(args: Eip1193RequestArguments): Promise<T> {
    if (!args || typeof args.method !== 'string' || !args.method.trim()) {
      const err = new Error('Invalid EIP-1193 request method') as Error & {
        code: number
      }
      err.code = -32600
      throw err
    }

    const id = `frank-rpc-${++this.requestCounter}-${Date.now()}`
    const result = await new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.win.postMessage(
        {
          channel: FRANK_DAPP_BRIDGE_CHANNEL,
          direction: 'to-content',
          type: 'rpc-request',
          id,
          payload: {
            method: args.method,
            params: args.params,
          },
        },
        '*',
      )
    })

    if (
      (args.method === 'eth_requestAccounts' ||
        args.method === 'eth_accounts') &&
      Array.isArray(result)
    ) {
      const prevAddress = this.selectedAddress
      this.selectedAddress = typeof result[0] === 'string' ? result[0] : null
      if (args.method === 'eth_requestAccounts' && this.selectedAddress) {
        this.emit('connect', { chainId: this.chainId ?? '0x279f' })
        if (prevAddress !== this.selectedAddress) {
          this.emit('accountsChanged', result)
        }
      }
    } else if (args.method === 'eth_chainId' && typeof result === 'string') {
      this.chainId = result
      this.networkVersion = String(parseInt(result, 16))
    } else if (
      args.method === 'wallet_switchEthereumChain' ||
      args.method === 'wallet_addEthereumChain'
    ) {
      const rawChainId = Array.isArray(args.params)
        ? (args.params[0] as any)?.chainId
        : (args.params as any)?.chainId
      if (
        typeof rawChainId === 'string' &&
        /^0x[0-9a-fA-F]+$/.test(rawChainId.trim())
      ) {
        const normalized = '0x' + parseInt(rawChainId.trim(), 16).toString(16)
        this.chainId = normalized
        this.networkVersion = String(parseInt(normalized, 16))
        this.emit('chainChanged', normalized)
      }
    }

    return result
  }

  public on(event: string, listener: ProviderEventListener): this {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return this
  }

  public removeListener(event: string, listener: ProviderEventListener): this {
    const set = this.listeners.get(event)
    if (set) {
      set.delete(listener)
    }
    return this
  }

  public off(event: string, listener: ProviderEventListener): this {
    return this.removeListener(event, listener)
  }

  public emit(event: string, ...args: any[]): boolean {
    const set = this.listeners.get(event)
    if (!set || set.size === 0) return false
    for (const fn of Array.from(set)) {
      fn(...args)
    }
    return true
  }

  public destroy(): void {
    this.win.removeEventListener('message', this.handleWindowMessage)
    this.pending.clear()
    this.listeners.clear()
  }
}

export interface FrankSolanaStandardWallet {
  readonly version: '1.0.0'
  readonly name: 'Frank'
  readonly icon: string
  readonly chains: readonly ['solana:mainnet', 'solana:devnet']
  readonly features: Record<string, unknown>
  readonly accounts: readonly unknown[]
}

export function createFrankSolanaStandardWallet(
  provider: FrankInpageProvider,
): FrankSolanaStandardWallet {
  return {
    version: '1.0.0',
    name: 'Frank',
    icon: FRANK_EIP6963_INFO.icon,
    chains: ['solana:mainnet', 'solana:devnet'],
    accounts: [],
    features: {
      'standard:connect': {
        version: '1.0.0',
        connect: async () =>
          await provider.request({
            method: 'solana_connect',
          }),
      },
      'standard:disconnect': {
        version: '1.0.0',
        disconnect: async () =>
          await provider.request({
            method: 'solana_disconnect',
          }),
      },
      'solana:signMessage': {
        version: '1.0.0',
        signMessage: async (input: unknown) =>
          await provider.request({
            method: 'solana_signMessage',
            params: [input],
          }),
      },
      'solana:signTransaction': {
        version: '1.0.0',
        signTransaction: async (input: unknown) =>
          await provider.request({
            method: 'solana_signTransaction',
            params: [input],
          }),
      },
    },
  }
}

export function announceEip6963Provider(
  win: Window,
  provider: FrankInpageProvider,
): Eip6963ProviderDetail {
  const detail: Eip6963ProviderDetail = Object.freeze({
    info: Object.freeze({ ...FRANK_EIP6963_INFO }),
    provider,
  })
  win.dispatchEvent(
    new CustomEvent('eip6963:announceProvider', {
      detail,
    }),
  )
  return detail
}

export function announceSolanaWalletStandard(
  win: Window,
  wallet: FrankSolanaStandardWallet,
): void {
  const registerPayload = {
    register: (...callbacks: Array<(w: FrankSolanaStandardWallet) => void>) => {
      for (const cb of callbacks) {
        if (typeof cb === 'function') cb(wallet)
      }
    },
  }

  try {
    win.dispatchEvent(
      new CustomEvent('wallet-standard:app-ready', {
        detail: registerPayload,
      }),
    )
  } catch {
    // Ignore environments restricting custom event dispatch
  }

  win.addEventListener('wallet-standard:register-wallet', (event: Event) => {
    const customEvent = event as CustomEvent
    if (typeof customEvent.detail === 'function') {
      customEvent.detail({
        register: () => wallet,
      })
    }
  })
}

export function installInpageProvider(
  win: Window & Record<string, any> = typeof window !== 'undefined'
    ? (window as Window & Record<string, any>)
    : ({} as any),
): FrankInpageProvider | null {
  if (!win || typeof win.addEventListener !== 'function') {
    return null
  }

  if (win.__FRANK_INPAGE_PROVIDER_INSTALLED__ && win.frankEthereum) {
    return win.frankEthereum as FrankInpageProvider
  }

  const provider = new FrankInpageProvider(win)
  const solanaWallet = createFrankSolanaStandardWallet(provider)

  win.__FRANK_INPAGE_PROVIDER_INSTALLED__ = true
  win.frankEthereum = provider
  win.frankSolana = solanaWallet
  if (!win.ethereum) {
    win.ethereum = provider
  }

  announceEip6963Provider(win, provider)
  win.addEventListener('eip6963:requestProvider', () => {
    announceEip6963Provider(win, provider)
  })

  announceSolanaWalletStandard(win, solanaWallet)
  return provider
}

if (typeof window !== 'undefined') {
  installInpageProvider(window as Window & Record<string, any>)
}
