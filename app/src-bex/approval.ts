/**
 * The approval window page (approval.html): shows the first waiting dApp
 * request with its site, the persona choice for a connection, and
 * Approve / Reject. The background owns the queue and closes this window when
 * it is empty; closing it by hand rejects what is still waiting.
 *
 * It is a plain page, not the Frank app: it needs no account custody, so it
 * opens instantly and never competes with an open Frank view for the account.
 */
import {
  FRANK_DAPP_APPROVALS_CHANGED,
  FRANK_DAPP_BRIDGE_CHANNEL,
  onRuntimeMessage,
  sendRuntimeMessage,
} from './runtime-adapter'
import type { PendingDappApproval } from './background'
import {
  formatUnits,
  getBytes,
  hexlify,
  Interface,
  keccak256,
  parseUnits,
} from 'ethers'
import {
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js'
import {
  getChainRegistryEntry,
  PROTOCOL_CHAINS,
} from '@frank/wallet/chain/chains-registry'

const CONNECT_KINDS = new Set(['connect', 'permissions'])

const METHOD_LABELS: Record<string, string> = {
  eth_requestAccounts: 'Connect to this site',
  wallet_requestPermissions: 'Connect to this site',
  personal_sign: 'Sign a message',
  eth_sign: 'Sign a message',
  eth_signTypedData: 'Sign typed data',
  eth_signTypedData_v3: 'Sign typed data',
  eth_signTypedData_v4: 'Sign typed data',
  eth_sendTransaction: 'Send a transaction',
  solana_connect: 'Connect a Solana account',
  solana_signMessage: 'Sign a Solana message',
  solana_signTransaction: 'Sign a Solana transaction',
  solana_signAndSendTransaction: 'Sign and send a Solana transaction',
}

export function isConnectRequest(request: PendingDappApproval): boolean {
  return CONNECT_KINDS.has(request.kind ?? '')
}

export function describeApprovalMethod(request: PendingDappApproval): string {
  return METHOD_LABELS[request.method] ?? request.method
}

function siteHost(origin: string): string {
  try {
    return new URL(origin).host || origin
  } catch {
    return origin
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag)
  if (className) node.className = className
  // textContent only: origins and params come from web pages.
  if (text !== undefined) node.textContent = text
  return node
}

function nativeChain(request: PendingDappApproval) {
  if (request.chainIdentifier)
    return getChainRegistryEntry(request.chainIdentifier)
  const id = request.chainIdHex
  if (!id) return undefined
  try {
    const nativeId = BigInt(id)
    return Object.values(PROTOCOL_CHAINS).find(
      chain =>
        chain.family === 'evm' &&
        chain.nativeChainId !== undefined &&
        BigInt(chain.nativeChainId) === nativeId,
    )
  } catch {
    return undefined
  }
}

function bytesForReview(value: unknown): Uint8Array {
  if (typeof value === 'string') {
    if (/^0x(?:[0-9a-f]{2})*$/i.test(value)) return getBytes(value)
    return new TextEncoder().encode(value)
  }
  if (
    Array.isArray(value) &&
    value.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
  )
    return Uint8Array.from(value)
  throw new Error('The request bytes cannot be safely displayed')
}

function decodedText(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

interface SolanaReviewAccount {
  readonly address: string
  readonly signer: boolean
  readonly writable: boolean
}

function describeSolanaInstruction(
  index: number,
  programId: string,
  accounts: readonly SolanaReviewAccount[],
  data: Uint8Array,
  approvedAccount: string | undefined,
): string {
  if (programId !== SystemProgram.programId.toBase58())
    throw new Error(
      `Unsupported Solana program ${programId}; instruction ${index} data is ${hexlify(
        data,
      )}. Frank cannot explain its effects, so approval is disabled.`,
    )
  if (data.length !== 12)
    throw new Error(
      `Unsupported Solana System Program instruction ${index} (program ${programId}); data is ${hexlify(
        data,
      )}. Only a standard native SOL transfer can be reviewed, so approval is disabled.`,
    )
  const instructionType =
    data[0]! | (data[1]! << 8) | (data[2]! << 16) | (data[3]! << 24)
  if (instructionType !== 2)
    throw new Error(
      `Unsupported Solana System Program instruction type ${instructionType}; data is ${hexlify(
        data,
      )}. Approval is disabled.`,
    )
  if (
    accounts.length !== 2 ||
    !accounts[0]!.signer ||
    !accounts[0]!.writable ||
    !accounts[1]!.writable
  )
    throw new Error(
      `Malformed Solana native transfer instruction ${index}; approval is disabled.`,
    )
  if (!approvedAccount || accounts[0]!.address !== approvedAccount)
    throw new Error(
      `Solana transfer source ${
        accounts[0]!.address
      } does not match the approved Frank account; approval is disabled.`,
    )
  let lamports = 0n
  for (let byte = 0; byte < 8; byte += 1)
    lamports |= BigInt(data[4 + byte]!) << BigInt(byte * 8)
  return `Instruction ${index}\nProgram: ${programId} (System Program)\nEffect: Transfer ${formatUnits(
    lamports,
    9,
  )} SOL (${lamports} lamports)\nFrom: ${accounts[0]!.address}\nTo: ${
    accounts[1]!.address
  }`
}

function solanaTransactionReview(
  value: unknown,
  approvedAccount?: string,
): string {
  const bytes = bytesForReview(value)
  let versioned: VersionedTransaction | undefined
  try {
    versioned = VersionedTransaction.deserialize(bytes)
  } catch {
    versioned = undefined
  }
  let message: string
  if (versioned) {
    if (versioned.message.addressTableLookups.length > 0)
      throw new Error(
        'This Solana v0 transaction uses address lookup tables. Frank cannot resolve every account before approval, so approval is disabled.',
      )
    const keys = versioned.message.staticAccountKeys
    const instructions = versioned.message.compiledInstructions
    if (
      instructions.some(
        ix =>
          ix.programIdIndex >= keys.length ||
          ix.accountKeyIndexes.some(index => index >= keys.length),
      )
    )
      throw new Error(
        'This Solana v0 transaction contains unresolved account indexes, so approval is disabled.',
      )
    message = instructions
      .map((ix, index) => {
        const program = keys[ix.programIdIndex]
        const accounts = ix.accountKeyIndexes.map(accountIndex => ({
          address: keys[accountIndex]!.toBase58(),
          signer: versioned!.message.isAccountSigner(accountIndex),
          writable: versioned!.message.isAccountWritable(accountIndex),
        }))
        return describeSolanaInstruction(
          index + 1,
          program!.toBase58(),
          accounts,
          ix.data,
          approvedAccount,
        )
      })
      .join('\n\n')
  } else {
    const tx = Transaction.from(bytes)
    message = tx.instructions
      .map((ix, index) =>
        describeSolanaInstruction(
          index + 1,
          ix.programId.toBase58(),
          ix.keys.map(key => ({
            address: key.pubkey.toBase58(),
            signer: key.isSigner,
            writable: key.isWritable,
          })),
          ix.data,
          approvedAccount,
        ),
      )
      .join('\n\n')
  }
  if (!message) throw new Error('Empty Solana transactions cannot be approved.')
  return `Transaction bytes (hex): ${hexlify(bytes)}\n\n${message}`
}

function approvalReview(request: PendingDappApproval): string {
  const chain = nativeChain(request)
  if (request.chainFamily === 'evm') {
    if (!chain || chain.family !== 'evm')
      throw new Error('Unknown EVM chain identity')
    const lines = [
      `Chain: ${chain.name} (${chain.id}, chain ID ${
        request.chainIdHex ?? 'unknown'
      })`,
    ]
    if (
      request.method === 'eth_requestAccounts' ||
      request.method === 'wallet_requestPermissions'
    )
      throw new Error('Connection uses the account selection controls')
    const params = Array.isArray(request.params)
      ? request.params
      : [request.params]
    if (request.method === 'personal_sign' || request.method === 'eth_sign') {
      const message = request.method === 'eth_sign' ? params[1] : params[0]
      const bytes = bytesForReview(message)
      lines.push(`Account: ${request.personaAddress ?? 'unknown'}`)
      const text = decodedText(bytes)
      lines.push(
        `Message UTF-8: ${text === undefined ? '(not valid UTF-8)' : text}`,
      )
      lines.push(`Message bytes (hex): ${hexlify(bytes)}`)
      return lines.join('\n\n')
    }
    if (/^eth_signTypedData(?:_v[34])?$/.test(request.method)) {
      const raw = params[1]
      const data =
        typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, any>)
      if (
        !data ||
        typeof data !== 'object' ||
        !data.domain ||
        !data.types ||
        !data.message
      )
        throw new Error('Typed data cannot be safely summarized')
      const primaryType =
        data.primaryType ??
        Object.keys(data.types).find(k => k !== 'EIP712Domain')
      if (typeof primaryType !== 'string')
        throw new Error('Typed data primary type is missing')
      lines.push(
        `Account: ${request.personaAddress ?? String(params[0] ?? 'unknown')}`,
      )
      lines.push(`Domain:\n${JSON.stringify(data.domain, null, 2)}`)
      lines.push(`Primary type: ${primaryType}`)
      lines.push(`Message:\n${JSON.stringify(data.message, null, 2)}`)
      return lines.join('\n\n')
    }
    if (request.method === 'eth_sendTransaction') {
      const tx = params[0] as Record<string, unknown> | undefined
      if (!tx || typeof tx !== 'object')
        throw new Error('Transaction cannot be summarized')
      const value = BigInt(String(tx.value ?? '0x0'))
      const unit = chain.unit || 'native units'
      const decimals = chain.nativeDecimals ?? 0
      lines.push(
        `Account: ${request.personaAddress ?? String(tx.from ?? 'unknown')}`,
      )
      lines.push(`Recipient: ${String(tx.to ?? '(contract creation)')}`)
      lines.push(
        `Value: ${formatUnits(value, decimals)} ${unit} (${value} base units)`,
      )
      const gasLimitValue = tx.gas ?? tx.gasLimit
      const gasPriceValue = tx.maxFeePerGas ?? tx.gasPrice
      if (gasLimitValue === undefined || gasPriceValue === undefined)
        throw new Error(
          'Gas limit or fee cap is missing. Frank cannot show the maximum native fee and total transaction cost before approval, so approval is disabled.',
        )
      const gasLimit = BigInt(String(gasLimitValue))
      const maxFeePerGas = BigInt(String(gasPriceValue))
      const maxGasFee = gasLimit * maxFeePerGas
      lines.push(`Gas limit: ${gasLimit.toString()}`)
      lines.push(
        `Maximum fee per gas: ${formatUnits(
          maxFeePerGas,
          decimals,
        )} ${unit} (${maxFeePerGas} base units)`,
      )
      if (tx.maxPriorityFeePerGas !== undefined) {
        const priorityFee = BigInt(String(tx.maxPriorityFeePerGas))
        lines.push(
          `Priority fee cap: ${formatUnits(
            priorityFee,
            decimals,
          )} ${unit} (${priorityFee} base units)`,
        )
      }
      lines.push(
        `Maximum gas fee: ${formatUnits(
          maxGasFee,
          decimals,
        )} ${unit} (${maxGasFee} base units)`,
      )
      lines.push(
        `Maximum total cost: ${formatUnits(
          value + maxGasFee,
          decimals,
        )} ${unit} (${value + maxGasFee} base units)`,
      )
      const data = typeof tx.data === 'string' ? tx.data : '0x'
      lines.push(`Calldata: ${data}`)
      lines.push(`Calldata hash: ${keccak256(data)}`)
      if (
        data.startsWith('0xa9059cbb') &&
        typeof tx.to === 'string' &&
        /^0x[0-9a-f]{40}$/i.test(tx.to)
      ) {
        try {
          const iface = new Interface([
            'function transfer(address to,uint256 value)',
          ])
          const decoded = iface.decodeFunctionData('transfer', data)
          lines.push(
            `ERC-20 contract: ${String(tx.to ?? '(unknown contract)')}`,
            `ERC-20 recipient: ${String(decoded[0])}`,
            `ERC-20 transfer amount: ${String(
              decoded[1],
            )} base units (token decimals and symbol are not resolved)`,
          )
        } catch {
          lines.push(
            'Calldata interpretation: undecoded; complete calldata is shown above.',
          )
        }
      } else if (data !== '0x') {
        lines.push(
          'Calldata interpretation: undecoded; complete calldata is shown above.',
        )
      }
      return lines.join('\n\n')
    }
    throw new Error(`No safe review is available for ${request.method}`)
  }
  if (request.chainFamily === 'solana') {
    const lines = [
      `Chain: ${
        request.method === 'solana_connect'
          ? 'Solana mainnet-beta and devnet (Frank supports both networks)'
          : String(
              (request.params as any)?.chain ?? 'Solana network not specified',
            )
      }`,
    ]
    if (request.method === 'solana_connect') {
      if (!request.solanaAccountAddress)
        throw new Error('Unlock Frank to show the Solana account')
      lines.push(`Solana account: ${request.solanaAccountAddress}`)
      return lines.join('\n\n')
    }
    const p = request.params as Record<string, unknown>
    lines.push(
      `Solana account: ${
        request.solanaAccountAddress ?? String(p?.account ?? 'unknown')
      }`,
    )
    if (request.method === 'solana_signMessage') {
      const bytes = bytesForReview(p?.message)
      const text = decodedText(bytes)
      lines.push(
        `Message UTF-8: ${text === undefined ? '(not valid UTF-8)' : text}`,
      )
      lines.push(`Message bytes (hex): ${hexlify(bytes)}`)
      return lines.join('\n\n')
    }
    if (
      request.method === 'solana_signTransaction' ||
      request.method === 'solana_signAndSendTransaction'
    ) {
      lines.push(
        solanaTransactionReview(
          p?.transaction,
          request.solanaAccountAddress ?? String(p?.account ?? ''),
        ),
      )
      return lines.join('\n\n')
    }
    throw new Error(`No safe review is available for ${request.method}`)
  }
  throw new Error(`No safe review is available for ${request.method}`)
}

export interface ApprovalPage {
  /** Re-read the queue from the background and render its first request. */
  refresh(): Promise<void>
  dispose(): void
}

/**
 * Render the approval queue into `root`. `globalScope` carries the extension
 * API (tests pass a fake one); `closeWindow` closes this window.
 */
export function mountApprovalPage(
  root: HTMLElement,
  options: {
    globalScope?: Record<string, any>
    closeWindow?: () => void
  } = {},
): ApprovalPage {
  const doc = root.ownerDocument
  const { globalScope } = options
  const closeWindow = options.closeWindow ?? (() => window.close())
  let useBurner = true
  let fundingAmount = ''
  let shownId: string | null = null
  let busy = false
  let errorMessage = ''

  function showError(message: string) {
    errorMessage = message
    let alert = root.querySelector<HTMLElement>('[role="alert"]')
    if (!alert) {
      alert = el(doc, 'p', 'approval-text approval-unsupported')
      alert.setAttribute('role', 'alert')
      root.append(alert)
    }
    alert.textContent = message
  }

  function openFrankButton(): HTMLButtonElement {
    const button = el(doc, 'button', 'approval-approve', 'Open Frank')
    button.type = 'button'
    button.dataset.testid = 'approval-open-frank'
    button.addEventListener('click', () => {
      void sendRuntimeMessage<unknown, { ok?: boolean }>(
        {
          channel: FRANK_DAPP_BRIDGE_CHANNEL,
          type: 'open-extension-window',
        },
        globalScope,
      )
        .then(response => {
          if (!response?.ok)
            showError(
              'Frank could not open. Open it from the browser toolbar, then return here.',
            )
        })
        .catch(error =>
          showError(
            error instanceof Error ? error.message : 'Frank could not open.',
          ),
        )
    })
    return button
  }

  // A signed-out connection is rejected immediately. This notice explains how
  // to retry; it is not an approval and does not retain or authorize a request.
  if (
    new URLSearchParams(doc.defaultView?.location.search ?? '').get(
      'notice',
    ) === 'account-required'
  ) {
    root.replaceChildren()
    root.append(
      el(doc, 'div', 'approval-brand', 'Frank'),
      el(doc, 'h1', 'approval-title', 'Sync or unlock Frank first'),
      el(
        doc,
        'p',
        'approval-text',
        'Your PWA login does not unlock the extension. Open Frank and sync or unlock your extension account, then retry connecting from the website.',
      ),
      openFrankButton(),
    )
    return { refresh: async () => undefined, dispose: () => undefined }
  }

  async function fetchQueue(): Promise<PendingDappApproval[]> {
    const res = await sendRuntimeMessage<
      unknown,
      { result?: { pendingApprovals?: PendingDappApproval[] } }
    >(
      { channel: FRANK_DAPP_BRIDGE_CHANNEL, type: 'get-bridge-state' },
      globalScope,
    )
    const list = res?.result?.pendingApprovals
    return Array.isArray(list) ? list : []
  }

  async function decide(
    request: PendingDappApproval,
    approved: boolean,
  ): Promise<void> {
    if (busy) return
    busy = true
    try {
      const chain = nativeChain(request)
      const fundingAmountAtomic =
        approved &&
        isConnectRequest(request) &&
        request.chainFamily !== 'solana' &&
        fundingAmount.trim()
          ? parseUnits(
              fundingAmount.trim(),
              chain?.nativeDecimals ?? 18,
            ).toString()
          : undefined
      const response = await sendRuntimeMessage<
        unknown,
        { ok?: boolean; error?: { code?: number; message?: string } }
      >(
        {
          channel: FRANK_DAPP_BRIDGE_CHANNEL,
          type: 'resolve-approval',
          approvalId: request.id,
          approved,
          ...(approved && isConnectRequest(request)
            ? {
                useBurnerPersona: useBurner,
                ...(fundingAmountAtomic === undefined
                  ? {}
                  : { fundingAmountAtomic }),
              }
            : {}),
        },
        globalScope,
      )
      if (!response?.ok && (approved || response?.error?.code !== 4001)) {
        showError(
          response?.error?.message ||
            'Frank could not answer this request. Try again.',
        )
        return
      }
      errorMessage = ''
    } catch (error) {
      showError(
        error instanceof Error
          ? error.message
          : 'Frank could not answer this request. Try again.',
      )
      return
    } finally {
      busy = false
    }
    await refresh()
  }

  function render(request: PendingDappApproval, queueLength: number) {
    if (shownId !== request.id) {
      shownId = request.id
      useBurner = true
      fundingAmount = ''
      errorMessage = ''
    }
    root.replaceChildren()

    const header = el(doc, 'header', 'approval-header')
    header.append(el(doc, 'div', 'approval-brand', 'Frank'))
    if (queueLength > 1) {
      header.append(
        el(doc, 'div', 'approval-count', `1 of ${queueLength} requests`),
      )
    }
    root.append(header)

    const site = el(doc, 'section', 'approval-site')
    site.append(el(doc, 'div', 'approval-host', siteHost(request.origin)))
    site.append(el(doc, 'div', 'approval-origin', request.origin))
    root.append(site)

    root.append(
      el(doc, 'h1', 'approval-title', describeApprovalMethod(request)),
    )

    const actions = el(doc, 'footer', 'approval-actions')
    const reject = el(doc, 'button', 'approval-reject', 'Reject')
    reject.type = 'button'
    reject.dataset.testid = 'approval-reject'
    reject.addEventListener('click', () => void decide(request, false))
    actions.append(reject)

    if (request.method === 'solana_connect') {
      let summary = ''
      try {
        summary = approvalReview(request)
      } catch (error) {
        summary =
          error instanceof Error
            ? error.message
            : 'Unlock Frank to show the Solana account.'
      }
      root.append(
        el(
          doc,
          'p',
          'approval-text',
          'Frank will share this Solana account with this site.',
        ),
        el(doc, 'pre', 'approval-review-summary', summary),
      )
      const approve = el(doc, 'button', 'approval-approve', 'Connect')
      approve.type = 'button'
      approve.dataset.testid = 'approval-approve'
      approve.disabled = !request.solanaAccountAddress || !summary
      approve.addEventListener('click', () => void decide(request, true))
      actions.append(approve)
    } else if (isConnectRequest(request) && request.chainFamily !== 'solana') {
      const chain = nativeChain(request)
      const networkKnown = chain?.family === 'evm'
      root.append(
        el(
          doc,
          'pre',
          'approval-review-summary',
          networkKnown
            ? `Active EVM chain: ${chain.name} (${chain.id}, chain ID ${
                request.chainIdHex ?? 'unknown'
              })`
            : 'Active EVM chain is unknown; connection approval is disabled.',
        ),
      )
      root.append(
        el(
          doc,
          'p',
          'approval-text',
          'The site will see the address you choose and can ask you to sign or send from it.',
        ),
      )
      if (!request.suggestedBurnerAddress || !request.primaryPersonaAddress) {
        root.append(
          el(
            doc,
            'p',
            'approval-text',
            'Open Frank to sync or unlock your extension account. Then return here and choose Connect. Signing in to the PWA does not unlock the extension.',
          ),
        )
        root.append(openFrankButton())
      }
      const choices = el(doc, 'fieldset', 'approval-personas')
      choices.append(
        el(doc, 'legend', undefined, 'Address shared with this site'),
      )
      const options: Array<{
        burner: boolean
        label: string
        hint: string
        address?: string
      }> = [
        {
          burner: true,
          label: 'New address for this site',
          hint: 'Recommended: other sites cannot link it to you.',
          address: request.suggestedBurnerAddress,
        },
        {
          burner: false,
          label: 'Your shared dApp address',
          hint: 'The same address every site connected this way sees.',
          address: request.primaryPersonaAddress,
        },
      ]
      const approve = el(doc, 'button', 'approval-approve', 'Connect')
      approve.type = 'button'
      approve.dataset.testid = 'approval-approve'
      approve.addEventListener('click', () => void decide(request, true))
      // Persona addresses come from Frank's custody; without one there is nothing to connect.
      const syncApprove = () => {
        approve.disabled =
          !networkKnown ||
          !options.find(option => option.burner === useBurner)?.address
      }
      for (const option of options) {
        const label = el(doc, 'label', 'approval-persona')
        const input = el(doc, 'input')
        input.type = 'radio'
        input.name = 'persona'
        input.checked = option.burner === useBurner
        input.dataset.testid = option.burner
          ? 'approval-persona-burner'
          : 'approval-persona-primary'
        input.addEventListener('change', () => {
          useBurner = option.burner
          syncApprove()
        })
        const body = el(doc, 'span', 'approval-persona-body')
        body.append(el(doc, 'span', 'approval-persona-label', option.label))
        body.append(el(doc, 'span', 'approval-persona-hint', option.hint))
        if (option.address) {
          body.append(el(doc, 'code', 'approval-address', option.address))
        } else {
          body.append(
            el(
              doc,
              'span',
              'approval-persona-pending',
              'Open Frank and unlock it to create this address.',
            ),
          )
        }
        label.append(input, body)
        choices.append(label)
      }
      root.append(choices)
      const funding = el(doc, 'label', 'approval-funding')
      funding.append(
        el(
          doc,
          'span',
          'approval-funding-label',
          `Fund this address from Frank (${chain?.unit ?? 'native asset'})`,
        ),
      )
      const amount = el(doc, 'input', 'approval-funding-input')
      amount.type = 'text'
      amount.inputMode = 'decimal'
      amount.placeholder = 'Amount for a new address'
      amount.value = fundingAmount
      amount.dataset.testid = 'approval-funding-amount'
      amount.addEventListener('input', () => {
        fundingAmount = amount.value
      })
      funding.append(amount)
      funding.append(
        el(
          doc,
          'span',
          'approval-persona-hint',
          'A new address needs an initial amount before connecting. For an already funded address, leave this blank. Further top-ups belong in Wallet.',
        ),
      )
      root.append(funding)
      syncApprove()
      actions.append(approve)
    } else {
      let summary = ''
      let reviewError = ''
      try {
        summary = approvalReview(request)
      } catch (error) {
        reviewError =
          error instanceof Error
            ? error.message
            : 'Request details cannot be safely displayed.'
      }
      const failureContext = [
        request.chainFamily === 'solana'
          ? `Chain: ${String(
              (request.params as any)?.chain ?? 'Solana network not specified',
            )}`
          : `Chain: ${nativeChain(request)?.name ?? 'Unknown EVM chain'}`,
        request.chainFamily === 'solana'
          ? `Account: ${request.solanaAccountAddress ?? 'unknown'}`
          : `Account: ${request.personaAddress ?? 'unknown'}`,
        reviewError,
      ].join('\n\n')
      root.append(
        el(doc, 'pre', 'approval-review-summary', summary || failureContext),
      )
      const approve = el(doc, 'button', 'approval-approve', 'Approve')
      approve.type = 'button'
      approve.dataset.testid = 'approval-approve'
      approve.disabled =
        !summary || !root.querySelector('.approval-review-summary')
      approve.addEventListener('click', () => void decide(request, true))
      actions.append(approve)
    }

    root.append(actions)
    if (errorMessage) showError(errorMessage)
  }

  async function refresh(): Promise<void> {
    let queue: PendingDappApproval[]
    try {
      queue = await fetchQueue()
    } catch {
      showError(
        'Frank could not load the connection request. Open Frank and try connecting again.',
      )
      root.append(openFrankButton())
      return
    }
    if (queue.length === 0) {
      // Nothing waits here (answered, or the background restarted).
      root.replaceChildren()
      closeWindow()
      return
    }
    render(queue[0], queue.length)
  }

  const offMessage = onRuntimeMessage(message => {
    const m = message as { channel?: unknown; type?: unknown } | null
    if (
      m?.channel === FRANK_DAPP_BRIDGE_CHANNEL &&
      m?.type === FRANK_DAPP_APPROVALS_CHANGED
    ) {
      void refresh()
    }
    // Never answer: requests to the background are not ours.
    return undefined
  }, globalScope)

  void refresh()
  return { refresh, dispose: offMessage }
}

if (
  typeof document !== 'undefined' &&
  document.getElementById('frank-approval-root')
) {
  mountApprovalPage(document.getElementById('frank-approval-root')!)
}
