/** @jest-environment jsdom */
import { reactive } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import Panel from './DirectoryProvisioningPanel.vue'
import en from '../../i18n/en-us'
import fr from '../../i18n/fr-fr'

const mockState = reactive({
  status: 'pending' as 'pending' | 'checking' | 'ready',
  reason: null as string | null,
  participants: {
    'relay-a': 'unchecked',
    'relay-b': 'unchecked',
    'bot': 'unchecked',
  } as Record<string, string>,
  peerAddress: null as string | null,
})
const mockExport = jest.fn()
const mockRefresh = jest.fn()
jest.mock('../../utils/monad-identity-session', () => ({
  get messagingState() {
    return mockState
  },
  exportPublicIdentity: () => mockExport(),
  refreshMessaging: (explicit: boolean) => mockRefresh(explicit),
}))
const translate = (key: string) =>
  key.split('.').reduce((value: any, part) => value[part], en)
const mountPanel = () =>
  mount(Panel, {
    global: {
      mocks: { $t: translate },
      stubs: {
        QBtn: {
          props: ['label', 'disable'],
          emits: ['click'],
          template:
            '<button :disabled="disable" @click="$emit(\'click\')">{{label}}</button>',
        },
      },
    },
  })
beforeEach(() => {
  jest.clearAllMocks()
  mockState.status = 'pending'
  mockState.reason = null
  mockState.peerAddress = null
})

test('mount stays pending and performs no export, check or network request', () => {
  const request = jest.fn()
  const previous = global.fetch
  global.fetch = request
  try {
    const panel = mountPanel()
    expect(panel.get('[role="status"]').text()).toBe(
      'Pending operator installation',
    )
    expect(panel.get('[role="status"]').attributes('aria-live')).toBe('polite')
    expect(
      panel.find('[aria-labelledby="directory-provisioning-title"]').exists(),
    ).toBe(true)
    expect(panel.text()).toContain('Relay A: not checked')
    expect(panel.text()).toContain('Bot: not checked')
    expect(request).not.toHaveBeenCalled()
    expect(mockExport).not.toHaveBeenCalled()
    expect(mockRefresh).not.toHaveBeenCalled()
    panel.unmount()
  } finally {
    global.fetch = previous
  }
})

test('export is an explicit action showing public JSON, or the precise reason it is unavailable', async () => {
  const panel = mountPanel()
  mockExport.mockResolvedValue({ ok: false, reason: 'policy-missing' })
  await panel.get('[data-test="directory-export"]').trigger('click')
  await flushPromises()
  expect(panel.get('[role="alert"]').text()).toContain(
    'The operator has not installed a network policy',
  )
  expect(panel.find('[data-test="directory-export-text"]').exists()).toBe(false)
  mockExport.mockResolvedValue({
    ok: true,
    file: { kind: 'public-revision-zero-export', subjectP: '02ab' },
  })
  await panel.get('[data-test="directory-export"]').trigger('click')
  await flushPromises()
  const text = panel.get('[data-test="directory-export-text"]')
    .element as HTMLTextAreaElement
  expect(JSON.parse(text.value).subjectP).toBe('02ab')
  expect(
    panel.get('[data-test="directory-export-download"]').attributes('download'),
  ).toBe('frank-ui-public-export.json')
  expect(mockRefresh).not.toHaveBeenCalled()
})

test('check is explicit, and partial installation is shown per participant without a ready label', async () => {
  const panel = mountPanel()
  mockRefresh.mockImplementation(async () => {
    mockState.reason = 'participant-unavailable'
    mockState.participants = {
      'relay-a': 'matched',
      'relay-b': 'unavailable',
      'bot': 'mismatch',
    }
  })
  await panel.get('[data-test="directory-check"]').trigger('click')
  await flushPromises()
  expect(mockRefresh).toHaveBeenCalledWith(true)
  expect(panel.get('[role="status"]').text()).toBe(
    'Pending operator installation',
  )
  expect(panel.text()).toContain('Relay A: approved bundle installed')
  expect(panel.text()).toContain('Relay B: no installation status available')
  expect(panel.text()).toContain('Bot: different or incomplete installation')
  expect(
    panel.get('[data-test="directory-provisioning-reason"]').text(),
  ).toContain('did not report its installation')
  mockState.status = 'ready'
  mockState.reason = null
  mockState.peerAddress = '0x00000000000000000000000000000000000000b0'
  await flushPromises()
  expect(panel.get('[role="status"]').text()).toContain(
    'local demo installation',
  )
  expect(panel.get('[data-test="directory-peer-address"]').text()).toContain(
    '0x00000000000000000000000000000000000000b0',
  )
})

test('every pending reason and participant state has English and French copy', () => {
  const keys = (value: any): string[] =>
    Object.entries(value).flatMap(([key, child]) =>
      typeof child === 'string' ? [key] : keys(child).map(k => `${key}.${k}`),
    )
  expect(keys(fr.directoryProvisioning).sort()).toEqual(
    keys(en.directoryProvisioning).sort(),
  )
})
