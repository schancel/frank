/** @jest-environment jsdom */
import { ref } from 'vue'
import {
  FRANK_DAPP_APPROVALS_CHANGED,
  FRANK_DAPP_BRIDGE_CHANNEL,
} from '../../src-bex/runtime-adapter'
import {
  DAPP_APPROVAL_ROUTE,
  installDappApprovalSurfacing,
} from './dapp-approval-surface'
import * as session from '../accounts/session'

const setAccountStatus = (
  session as unknown as {
    __setStatus: (s: string) => void
  }
).__setStatus

jest.mock('../accounts/session', () => {
  const { reactive } = jest.requireActual('vue')
  const accountStatus = reactive({ status: 'ready' })
  return {
    accountStatus,
    __setStatus: (s: string) => (accountStatus.status = s),
  }
})

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function extensionScope(pending: unknown[]) {
  const listeners: Array<(msg: any, sender: any, respond: any) => any> = []
  const respond = jest.fn()
  const scope = {
    chrome: {
      runtime: {
        id: 'frank-test-ext',
        sendMessage: jest.fn(async (msg: any) =>
          msg.type === 'get-bridge-state'
            ? { ok: true, result: { pendingApprovals: pending } }
            : undefined,
        ),
        onMessage: {
          addListener: (fn: any) => listeners.push(fn),
          removeListener: (fn: any) =>
            listeners.splice(listeners.indexOf(fn), 1),
        },
      },
    },
  }
  const deliver = (msg: unknown) => listeners.map(fn => fn(msg, {}, respond))
  return { scope, deliver, respond, listeners }
}

function fakeRouter(path: string) {
  const currentRoute = ref({ path })
  const push = jest.fn(async (to: string) => {
    currentRoute.value = { path: to }
  })
  return { currentRoute, push } as any
}

it('opens the approval screen when the open view is on another route and a dApp request arrives', async () => {
  const pending: unknown[] = []
  const { scope, deliver, respond, listeners } = extensionScope(pending)
  const router = fakeRouter('/wallet')

  const dispose = installDappApprovalSurfacing(router, scope)
  await flush()
  expect(router.push).not.toHaveBeenCalled()

  pending.push({ id: 'req-1', origin: 'https://app.uniswap.org' })
  const returned = deliver({
    channel: FRANK_DAPP_BRIDGE_CHANNEL,
    type: FRANK_DAPP_APPROVALS_CHANGED,
  })
  await flush()
  expect(router.push).toHaveBeenCalledWith(DAPP_APPROVAL_ROUTE)
  // The view never answers runtime messages meant for the background.
  expect(returned).toEqual([false])
  expect(respond).not.toHaveBeenCalled()

  deliver({ channel: FRANK_DAPP_BRIDGE_CHANNEL, type: 'get-bridge-state' })
  await flush()
  expect(router.push).toHaveBeenCalledTimes(1)

  dispose()
  expect(listeners).toHaveLength(0)
})

it('routes to a request that was already pending when the view opened', async () => {
  const { scope } = extensionScope([{ id: 'req-0' }])
  const router = fakeRouter('/chat')
  const dispose = installDappApprovalSurfacing(router, scope)
  await flush()
  expect(router.push).toHaveBeenCalledWith(DAPP_APPROVAL_ROUTE)
  dispose()
})

it('waits for account setup before leaving onboarding, then routes', async () => {
  setAccountStatus('fresh')
  const { scope } = extensionScope([{ id: 'req-1' }])
  const router = fakeRouter('/setup')
  const dispose = installDappApprovalSurfacing(router, scope)
  await flush()
  expect(router.push).not.toHaveBeenCalled()
  setAccountStatus('ready')
  await flush()
  await flush()
  expect(router.push).toHaveBeenCalledWith(DAPP_APPROVAL_ROUTE)
  dispose()
})

it('does nothing outside an extension', async () => {
  const router = fakeRouter('/wallet')
  const dispose = installDappApprovalSurfacing(router, {})
  await flush()
  expect(router.push).not.toHaveBeenCalled()
  dispose()
})
