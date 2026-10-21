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

const CONNECT_KINDS = new Set(['connect', 'permissions'])

const METHOD_LABELS: Record<string, string> = {
  eth_requestAccounts: 'Connect to this site',
  wallet_requestPermissions: 'Connect to this site',
  btc_requestAccounts: 'Connect your Bitcoin address',
  xec_cashtabRequest: 'eCash request',
  personal_sign: 'Sign a message',
  eth_sign: 'Sign a message',
  eth_signTypedData: 'Sign typed data',
  eth_signTypedData_v3: 'Sign typed data',
  eth_signTypedData_v4: 'Sign typed data',
  eth_sendTransaction: 'Send a transaction',
  btc_signMessage: 'Sign a message',
  btc_signPsbt: 'Sign a Bitcoin transaction',
  btc_signPsbts: 'Sign Bitcoin transactions',
}

export function isConnectRequest(request: PendingDappApproval): boolean {
  return CONNECT_KINDS.has(request.kind ?? '')
}

export function describeApprovalMethod(request: PendingDappApproval): string {
  if (request.method === 'xec_cashtabRequest') {
    return isConnectRequest(request)
      ? 'Connect your eCash address'
      : 'Send an eCash transaction'
  }
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

function requestDetails(request: PendingDappApproval): string {
  try {
    const text = JSON.stringify(request.params ?? null, null, 2)
    return text.length > 2000 ? `${text.slice(0, 2000)}…` : text
  } catch {
    return String(request.params)
  }
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
  let shownId: string | null = null
  let busy = false

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
      await sendRuntimeMessage(
        {
          channel: FRANK_DAPP_BRIDGE_CHANNEL,
          type: 'resolve-approval',
          approvalId: request.id,
          approved,
          ...(approved && isConnectRequest(request)
            ? { useBurnerPersona: useBurner }
            : {}),
        },
        globalScope,
      )
    } finally {
      busy = false
    }
    await refresh()
  }

  function render(request: PendingDappApproval, queueLength: number) {
    if (shownId !== request.id) {
      shownId = request.id
      useBurner = true
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

    if (isConnectRequest(request)) {
      root.append(
        el(
          doc,
          'p',
          'approval-text',
          'The site will see the address you choose and can ask you to sign or send from it.',
        ),
      )
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
        approve.disabled = !options.find(option => option.burner === useBurner)
          ?.address
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
      syncApprove()
      actions.append(approve)
    } else {
      // Frank has no safe signer for websites yet; the request can only be
      // declined. The site receives a user-rejected (4001) answer.
      root.append(
        el(
          doc,
          'p',
          'approval-text approval-unsupported',
          'Frank cannot sign or send for websites yet. Reject this request to let the site know.',
        ),
      )
      const details = el(doc, 'details', 'approval-details')
      details.append(el(doc, 'summary', undefined, 'Request details'))
      details.append(el(doc, 'pre', undefined, requestDetails(request)))
      root.append(details)
    }

    root.append(actions)
  }

  async function refresh(): Promise<void> {
    let queue: PendingDappApproval[]
    try {
      queue = await fetchQueue()
    } catch {
      queue = []
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
