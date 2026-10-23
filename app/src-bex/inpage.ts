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

export interface FrankSolanaWalletStandard {
  readonly version: '1.0.0'
  readonly name: 'Frank'
  readonly icon: string
  readonly chains: readonly string[]
  readonly features: Record<string, any>
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

    if (data.type === 'provider-privacy-config') {
      const w = this.win as Window & Record<string, any>
      if (
        data.announceMode === 'always' ||
        data.announceMode === 'connected-only' ||
        data.announceMode === 'stealth'
      ) {
        w.__FRANK_ANNOUNCE_MODE__ = data.announceMode
      }
      if (typeof data.isOriginApproved === 'boolean') {
        w.__FRANK_ORIGIN_APPROVED__ = data.isOriginApproved
      }
      if (data.triggerAnnounce && shouldAnnounceEip6963Provider(w)) {
        announceEip6963Provider(this.win, this)
      }
      return
    }

    if (data.type === 'provider-event' && typeof data.event === 'string') {
      if (data.event === 'accountsChanged' && Array.isArray(data.payload)) {
        this.selectedAddress =
          typeof data.payload[0] === 'string' ? data.payload[0] : null
        ;(this.win as Window & Record<string, any>).__FRANK_ORIGIN_APPROVED__ =
          Boolean(this.selectedAddress)
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
      ;(this.win as Window & Record<string, any>).__FRANK_ORIGIN_APPROVED__ =
        Boolean(this.selectedAddress)
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

export function isIsolatedExtensionWorld(
  scope: Record<string, any> = typeof globalThis !== 'undefined'
    ? (globalThis as Record<string, any>)
    : {},
): boolean {
  const browserId = scope?.browser?.runtime?.id
  if (typeof browserId === 'string' && browserId.length > 0) {
    return true
  }
  const chromeId = scope?.chrome?.runtime?.id
  if (typeof chromeId === 'string' && chromeId.length > 0) {
    return true
  }
  return false
}

export type DappProviderAnnounceMode = 'always' | 'connected-only' | 'stealth'

export function generateEphemeralUuidV4(win?: Record<string, any>): string {
  const randUuidFn =
    typeof win?.crypto?.randomUUID === 'function'
      ? win.crypto.randomUUID.bind(win.crypto)
      : typeof globalThis !== 'undefined' &&
        typeof (globalThis as any).crypto?.randomUUID === 'function'
      ? (globalThis as any).crypto.randomUUID.bind((globalThis as any).crypto)
      : null
  if (randUuidFn) {
    try {
      return randUuidFn()
    } catch {
      // Fall through to math random fallback
    }
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => {
    const r = (Math.random() * 16) | 0
    const v = ch === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export function shouldAnnounceEip6963Provider(
  winOrMode: (Window & Record<string, any>) | DappProviderAnnounceMode,
  explicitOriginApproved?: boolean,
): boolean {
  let mode: DappProviderAnnounceMode = 'always'
  let originApproved = Boolean(explicitOriginApproved)
  if (typeof winOrMode === 'string') {
    mode = winOrMode
  } else if (winOrMode && typeof winOrMode === 'object') {
    mode =
      winOrMode.__FRANK_ANNOUNCE_MODE__ ??
      winOrMode.__FRANK_PRIVACY_CONFIG__?.announceMode ??
      'always'
    originApproved = Boolean(
      winOrMode.__FRANK_ORIGIN_APPROVED__ ??
        winOrMode.__FRANK_PRIVACY_CONFIG__?.originApproved ??
        explicitOriginApproved,
    )
  }
  if (mode === 'always') return true
  if (mode === 'connected-only') {
    return originApproved
  }
  if (mode === 'stealth') {
    return false
  }
  return true
}

export function announceEip6963Provider(
  win: Window,
  provider: FrankInpageProvider,
  uuidOverride?: string,
): Eip6963ProviderDetail {
  const w = win as Window & Record<string, any>
  const resolvedUuid =
    uuidOverride ||
    (typeof w?.__FRANK_EIP6963_INSTANCE_UUID__ === 'string' &&
    w.__FRANK_EIP6963_INSTANCE_UUID__
      ? w.__FRANK_EIP6963_INSTANCE_UUID__
      : FRANK_EIP6963_INFO.uuid)
  const detail: Eip6963ProviderDetail = Object.freeze({
    info: Object.freeze({
      ...FRANK_EIP6963_INFO,
      uuid: resolvedUuid,
    }),
    provider,
  })
  if (isIsolatedExtensionWorld(w)) {
    return detail
  }
  if (!shouldAnnounceEip6963Provider(w)) {
    return detail
  }
  win.dispatchEvent(
    new CustomEvent('eip6963:announceProvider', {
      detail,
    }),
  )
  return detail
}

export function installInpageProvider(
  win: Window & Record<string, any> = typeof window !== 'undefined'
    ? (window as Window & Record<string, any>)
    : ({} as any),
): FrankInpageProvider | null {
  if (!win || typeof win.addEventListener !== 'function') {
    return null
  }

  // Never install the inpage provider or dispatch EIP-6963 CustomEvents inside
  // an isolated WebExtension content-script world: in Safari/WebKit, CustomEvent
  // detail objects containing isolated-world provider instances are sanitized to
  // null when crossing into the main page world, crashing EIP-6963 consumers
  // (e.g. Uniswap/wagmi evaluating event.detail.info).
  if (isIsolatedExtensionWorld(win)) {
    const api = win.browser?.runtime?.id ? win.browser : win.chrome
    const scriptUrl =
      typeof api?.runtime?.getURL === 'function'
        ? String(api.runtime.getURL('inpage.js'))
        : ''
    if (scriptUrl && win.document) {
      const existing = win.document.querySelector?.(
        'script[data-frank-safari-inpage="true"]',
      )
      if (!existing && typeof win.document.createElement === 'function') {
        const script = win.document.createElement('script')
        script.src = scriptUrl
        script.async = false
        script.setAttribute('data-frank-safari-inpage', 'true')
        const container = win.document.head || win.document.documentElement
        if (container) {
          container.appendChild(script)
        }
      }
    }
    return null
  }

  const instanceUuid =
    typeof win.__FRANK_EIP6963_INSTANCE_UUID__ === 'string' &&
    win.__FRANK_EIP6963_INSTANCE_UUID__
      ? win.__FRANK_EIP6963_INSTANCE_UUID__
      : generateEphemeralUuidV4(win)
  win.__FRANK_EIP6963_INSTANCE_UUID__ = instanceUuid

  if (win.__FRANK_INPAGE_PROVIDER_INSTALLED__ && win.frankEthereum) {
    try {
      Object.setPrototypeOf(win.frankEthereum, FrankInpageProvider.prototype)
      announceEip6963Provider(
        win,
        win.frankEthereum as FrankInpageProvider,
        instanceUuid,
      )
    } catch {
      // Ignore prototype upgrade errors
    }
    installSolanaWalletStandard(win, win.frankEthereum as FrankInpageProvider)
    return win.frankEthereum as FrankInpageProvider
  }

  const provider = new FrankInpageProvider(win)

  win.__FRANK_INPAGE_PROVIDER_INSTALLED__ = true
  win.frankEthereum = provider
  if (!win.ethereum) {
    win.ethereum = provider
  }
  announceEip6963Provider(win, provider, instanceUuid)
  installSolanaWalletStandard(win, provider)
  win.addEventListener('eip6963:requestProvider', () => {
    announceEip6963Provider(win, provider, instanceUuid)
  })
  return provider
}

/** Register a Wallet Standard provider backed by real Solana account requests. */
export function installSolanaWalletStandard(
  win: Window & Record<string, any>,
  provider: FrankInpageProvider,
): FrankSolanaWalletStandard {
  const existing = win.__FRANK_SOLANA_WALLET__ as
    | FrankSolanaWalletStandard
    | undefined
  if (existing) {
    registerSolanaWallet(win, existing)
    return existing
  }
  const account = (raw: any) => ({
    address: String(raw.address),
    publicKey: new Uint8Array(raw.publicKey),
    chains: ['solana:mainnet', 'solana:devnet'],
    features: [
      'solana:signMessage',
      'solana:signTransaction',
      'solana:signAndSendTransaction',
    ],
  })
  const features = {
    'standard:connect': {
      version: '1.0.0',
      connect: async () => {
        const result = await provider.request<any>({ method: 'solana_connect' })
        return { accounts: [account(result)] }
      },
    },
    'standard:disconnect': {
      version: '1.0.0',
      disconnect: async () => {
        await provider.request({ method: 'solana_disconnect' })
      },
    },
    'standard:events': { version: '1.0.0', on: () => () => undefined },
    'solana:signMessage': {
      version: '1.0.0',
      signMessage: async (...inputs: any[]) => {
        const results = []
        for (const input of inputs) {
          const signature = await provider.request<any>({
            method: 'solana_signMessage',
            params: {
              message: Array.from(input.message),
              account: input.account?.address,
            },
          })
          results.push({
            signedMessage: input.message,
            signature: new Uint8Array(signature.signature),
            account: input.account,
          })
        }
        return results
      },
    },
    'solana:signTransaction': {
      version: '1.0.0',
      supportedTransactionVersions: ['legacy', 0],
      signTransaction: async (...inputs: any[]) => {
        const results = []
        for (const input of inputs) {
          const transaction = await provider.request<any>({
            method: 'solana_signTransaction',
            params: {
              transaction: Array.from(input.transaction),
              account: input.account?.address,
              chain: input.chain,
            },
          })
          results.push({
            signedTransaction: new Uint8Array(transaction.transaction),
            account: input.account,
            chain: input.chain,
          })
        }
        return results
      },
    },
    'solana:signAndSendTransaction': {
      version: '1.0.0',
      supportedTransactionVersions: ['legacy', 0],
      signAndSendTransaction: async (...inputs: any[]) => {
        const results = []
        for (const input of inputs) {
          const signature = await provider.request<string>({
            method: 'solana_signAndSendTransaction',
            params: {
              transaction: Array.from(input.transaction),
              account: input.account?.address,
              chain: input.chain,
            },
          })
          const { default: bs58 } = await import('bs58')
          results.push({
            signature: bs58.decode(signature),
            account: input.account,
            chain: input.chain,
          })
        }
        return results
      },
    },
  }
  const wallet: FrankSolanaWalletStandard = Object.freeze({
    version: '1.0.0',
    name: 'Frank',
    icon: FRANK_EIP6963_INFO.icon,
    chains: Object.freeze(['solana:mainnet', 'solana:devnet']),
    features,
  })
  win.__FRANK_SOLANA_WALLET__ = wallet
  registerSolanaWallet(win, wallet)
  return wallet
}

function registerSolanaWallet(
  win: Window & Record<string, any>,
  wallet: FrankSolanaWalletStandard,
) {
  const register = () => {
    win.dispatchEvent(
      new CustomEvent('wallet-standard:register-wallet', {
        detail: (callback: (wallet: FrankSolanaWalletStandard) => void) =>
          callback(wallet),
      }),
    )
  }
  register()
  if (!win.__FRANK_SOLANA_WALLET_READY_LISTENER__) {
    win.__FRANK_SOLANA_WALLET_READY_LISTENER__ = true
    win.addEventListener('wallet-standard:app-ready', register)
  }
}

if (typeof window !== 'undefined') {
  installInpageProvider(window as Window & Record<string, any>)
}
