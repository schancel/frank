/** @jest-environment jsdom */

import { mount, flushPromises } from '@vue/test-utils'
import BackupAccount from './BackupAccount.vue'
import { webcrypto } from 'crypto'
import {
  beginCodex32Signup,
  encodeRecoveryDescriptor,
  recoverCodex32Shares,
  type RecoveredCodex32Account,
} from '@frank/account-recovery'
import { DOMAIN_PURPOSES } from '@frank/domain-roots'
import { MonadIdentity } from '@frank/wallet/monad-identity'
import type { AccountCustody, PublicAccount } from '../accounts/custody'
import { createAccountSession, type RuntimeWallet } from '../accounts/session'

const mockRouterBack = jest.fn()
const mockRouterPush = jest.fn()
jest.mock('vue-router', () => ({
  useRouter: () => ({
    back: mockRouterBack,
    push: mockRouterPush,
  }),
}))

/**
 * The page, its composable, the session's backup path and the recovery package are real. jsdom has
 * neither IndexedDB nor WebCrypto, so storage is stood in for by `device()`: a custody that hands
 * back the material of an account made by the real signup ceremony. The same flow on real custody
 * and vault storage is in accounts/backup-roundtrip.jest.test.ts and the Chrome custody suite.
 */
let mockSession: ReturnType<typeof createAccountSession> | undefined
/** How many times anything asked custody for the account root. */
let mockRootReads = 0
jest.mock('../accounts/session', () => ({
  ...jest.requireActual('../accounts/session'),
  get accountSession() {
    return mockSession
  },
}))

beforeAll(() => {
  if (typeof globalThis.crypto?.getRandomValues !== 'function')
    Object.defineProperty(globalThis, 'crypto', {
      value: webcrypto,
      configurable: true,
    })
})
afterEach(async () => {
  await mockSession?.close()
  mockSession = undefined
})

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
/** What makes two recoveries the same account. */
const identityOf = (account: RecoveredCodex32Account) => ({
  accountRoot: hex(account.accountRoot),
  roots: DOMAIN_PURPOSES.map(purpose => hex(account.roots[purpose].bytes)),
  identityAddress: MonadIdentity.fromDomainRoot(
    account.roots['identity-authentication'],
  ).displayAddress,
  descriptor: encodeRecoveryDescriptor(account.metadata.descriptor),
})

/** Sign up for real, then open the session on a custody holding that account. */
async function device(options: { keepsAccountRoot?: boolean } = {}) {
  const signup = beginCodex32Signup({
    threshold: 2,
    identifier: 'test',
    indices: ['q', 'p', 'z'],
    randomBytes: length => crypto.getRandomValues(new Uint8Array(length)),
  })
  const signupShares = [...signup.shares]
  const created = signup.confirmWithMetadata(signupShares.slice(0, 2))
  const account = {
    displayName: 'Fixture',
    descriptor: encodeRecoveryDescriptor(created.metadata.descriptor),
    receipt: { operationId: 'attempt', context: { accountId: 'account' } },
  } as PublicAccount
  const snapshot = { schema: 1, revision: 1, active: account, pending: null }
  const custody = {
    snapshot: async () => snapshot,
    openActive: async () => ({
      account,
      takeRoots: () =>
        DOMAIN_PURPOSES.map(purpose => ({
          ...created.roots[purpose],
          bytes: created.roots[purpose].bytes.slice(),
        })),
      close: () => undefined,
    }),
    exportAccountRoot: async () => (
      mockRootReads++,
      {
        account,
        accountRoot:
          options.keepsAccountRoot === false
            ? null
            : created.accountRoot.slice(),
      }
    ),
    close: () => undefined,
  } as unknown as AccountCustody
  mockSession = createAccountSession({
    open: async () => custody,
    createWallet: async () =>
      ({ close: async () => undefined } as unknown as RuntimeWallet),
  })
  await mockSession.initialize()
  mockRootReads = 0
  return { signupShares, original: identityOf(created) }
}

type Mounted = ReturnType<typeof mountPage>
/** Wait for the page to finish issuing a set, then read the shares it shows. */
async function shownShares(wrapper: Mounted, count: number) {
  await wrapper.find('[data-test="show-recovery-shares"]').trigger('click')
  for (let i = 0; i < 200; i++) {
    await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 5))
    if (
      !wrapper.find('[data-test="backup-loading"]').exists() &&
      wrapper.findAll('[data-test="codex32-share"]').length === count
    )
      break
  }
  const shares = wrapper
    .findAll('[data-test="codex32-share"]')
    .map(node => node.text())
  expect(shares).toHaveLength(count)
  return shares
}
async function settled(wrapper: Mounted) {
  for (let i = 0; i < 200; i++) {
    await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 5))
    if (!wrapper.find('[data-test="backup-loading"]').exists()) return
  }
}

function mountPage() {
  return mount(BackupAccount, {
    global: {
      mocks: {
        $t: (key: string, values?: Record<string, unknown>) => {
          if (values) {
            return `${key}:${JSON.stringify(values)}`
          }
          return key
        },
      },
      stubs: {
        QHeader: { template: '<header><slot /></header>' },
        QToolbar: { template: '<div><slot /></div>' },
        QToolbarTitle: { template: '<h1><slot /></h1>' },
        QPageContainer: { template: '<main><slot /></main>' },
        QPage: { template: '<section><slot /></section>' },
        QCard: { template: '<div><slot /></div>' },
        QCardSection: { template: '<div><slot /></div>' },
        QCardActions: { template: '<div><slot /></div>' },
        QBtn: {
          props: ['label', 'disable'],
          template: '<button :disabled="disable">{{ label }}<slot /></button>',
        },
        QInput: {
          props: ['modelValue', 'label'],
          template:
            '<input :value="modelValue" @input="$emit(\'update:modelValue\', Number($event.target.value))" />',
        },
        QSpinner: { template: '<span data-test="spinner" />' },
        QTooltip: { template: '<span />' },
      },
    },
  })
}

describe('BackupAccount page', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    Object.assign(navigator, {
      clipboard: {
        writeText: jest.fn().mockResolvedValue(undefined),
      },
    })
  })

  it('reads nothing secret until the user asks, and drops it when they leave', async () => {
    await device()
    const wrapper = mountPage()
    await settled(wrapper)
    expect(mockRootReads).toBe(0)
    expect(wrapper.findAll('[data-test="codex32-share"]')).toHaveLength(0)
    expect(wrapper.text()).not.toMatch(/ms1[0-9]/)
    expect(wrapper.find('[data-test="backup-reveal-warning"]').text()).toBe(
      'accountRecovery.show_recovery_shares_warning',
    )
    // No note about shares from "before this update": there is no earlier version in use.
    expect(wrapper.text()).not.toContain('earlier_settings_shares')

    // Choosing a scheme is not asking for shares.
    await wrapper.find('[data-test="codex32-scheme-btn"]').trigger('click')
    await settled(wrapper)
    expect(mockRootReads).toBe(0)

    await shownShares(wrapper, 5)
    expect(mockRootReads).toBe(1)

    // Another scheme hides the set that was shown and waits to be asked again.
    await wrapper.find('[data-test="codex32-scheme-btn"]').trigger('click')
    await settled(wrapper)
    expect(wrapper.findAll('[data-test="codex32-share"]')).toHaveLength(0)
    expect(mockRootReads).toBe(1)

    await shownShares(wrapper, 10)
    const state = wrapper.vm.$.setupState as { backupShares: string[] }
    expect(state.backupShares).toHaveLength(10)
    wrapper.unmount()
    expect(state.backupShares).toHaveLength(0)
  })

  it('shows shares that restore the same account', async () => {
    const { signupShares, original } = await device()

    const wrapper = mountPage()
    expect(wrapper.find('[data-test="backup-back"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="backup-menu"]').exists()).toBe(true)
    const shares = await shownShares(wrapper, 3)
    expect(new Set(shares).size).toBe(3)
    expect(shares.some(share => signupShares.includes(share))).toBe(false)
    expect(wrapper.find('[data-test="backup-explainer"]').text()).toContain(
      'accountRecovery.codex32_threshold_explainer:{"threshold":2,"count":3}',
    )
    expect(wrapper.find('[data-test="backup-explainer"]').text()).toContain(
      'accountRecovery.codex32_backup_sets_do_not_mix',
    )

    for (const subset of [shares.slice(0, 2), shares.slice(1, 3)])
      expect(identityOf(recoverCodex32Shares(subset))).toEqual(original)
    expect(identityOf(recoverCodex32Shares(signupShares.slice(1)))).toEqual(
      original,
    )
    expect(() => recoverCodex32Shares([signupShares[0], shares[1]])).toThrow(
      /inconsistent-share/,
    )
  })

  it('issues a different, complete set for each scheme, each of which restores the account', async () => {
    const { original } = await device()

    const wrapper = mountPage()
    const twoOfThree = await shownShares(wrapper, 3)
    await wrapper.find('[data-test="codex32-scheme-btn"]').trigger('click')
    const threeOfFive = await shownShares(wrapper, 5)
    await wrapper.find('[data-test="codex32-scheme-btn"]').trigger('click')
    const sixOfTen = await shownShares(wrapper, 10)

    expect(wrapper.find('[data-test="custom-scheme-section"]').exists()).toBe(
      false,
    )
    await wrapper
      .find('[data-test="codex32-custom-scheme-btn"]')
      .trigger('click')
    await wrapper.find('[data-test="input-threshold"]').setValue(4)
    await wrapper.find('[data-test="input-count"]').setValue(7)
    await wrapper.find('[data-test="apply-custom-scheme"]').trigger('click')
    const fourOfSeven = await shownShares(wrapper, 7)
    expect(wrapper.find('[data-test="custom-scheme-section"]').exists()).toBe(
      false,
    )

    for (const [threshold, shares] of [
      [2, twoOfThree],
      [3, threeOfFive],
      [6, sixOfTen],
      [4, fourOfSeven],
    ] as const)
      expect(
        identityOf(recoverCodex32Shares(shares.slice(-threshold))),
      ).toEqual(original)
    expect(() =>
      recoverCodex32Shares([threeOfFive[0], twoOfThree[1], threeOfFive[2]]),
    ).toThrow(/inconsistent-share/)
  })

  it('tells an account stored before account roots were kept the truth and shows no shares', async () => {
    await device({ keepsAccountRoot: false })

    const wrapper = mountPage()
    await settled(wrapper)
    expect(wrapper.find('[data-test="backup-unavailable"]').exists()).toBe(
      false,
    )
    await wrapper.find('[data-test="show-recovery-shares"]').trigger('click')
    await settled(wrapper)
    expect(wrapper.find('[data-test="backup-unavailable"]').text()).toBe(
      'accountRecovery.codex32_backup_unavailable_for_account',
    )
    expect(wrapper.findAll('[data-test="codex32-share"]')).toHaveLength(0)
    expect(wrapper.text()).not.toMatch(/ms1[0-9]/)
    // Nothing on the page claims shares restore the account, or offers another scheme.
    expect(wrapper.find('[data-test="backup-explainer"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="codex32-scheme-btn"]').exists()).toBe(
      false,
    )
    // No note about shares from "before this update": there is no earlier version in use.
    expect(wrapper.text()).not.toContain('earlier_settings_shares')
  })

  it("shows an error and no shares when the stored root is not this account's", async () => {
    const { original } = await device()
    const other = await device()
    expect(other.original.descriptor).not.toBe(original.descriptor)
    // Custody now names the first account while holding the second one's root.
    const custody = await mockSession!.snapshot()
    ;(custody.active as { descriptor: string }).descriptor = original.descriptor

    const wrapper = mountPage()
    await wrapper.find('[data-test="show-recovery-shares"]').trigger('click')
    await settled(wrapper)
    expect(wrapper.find('[data-test="backup-error"]').text()).toMatch(
      /descriptor-mismatch/,
    )
    expect(wrapper.findAll('[data-test="codex32-share"]')).toHaveLength(0)
  })

  it('copies share to clipboard when copy button clicked', async () => {
    await device()
    const wrapper = mountPage()
    const shares = await shownShares(wrapper, 3)

    const copyBtns = wrapper.findAll('[data-test="copy-share"]')
    expect(copyBtns.length).toBe(3)

    await copyBtns[0].trigger('click')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(shares[0])

    await flushPromises()
    expect(wrapper.find('[data-test="copy-status"]').text()).toContain(
      'Share 1 copied.',
    )
  })

  it('navigates back when cancel/done is clicked', async () => {
    await device()
    const wrapper = mountPage()
    await settled(wrapper)

    const backBtn = wrapper.find('[data-test="backup-back"]')
    await backBtn.trigger('click')
    // navigateBack checks history.state.back; if unset, it pushes '/'
    expect(mockRouterPush).toHaveBeenCalledWith('/')
  })
})
