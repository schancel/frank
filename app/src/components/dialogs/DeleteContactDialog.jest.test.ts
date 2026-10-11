/** @jest-environment jsdom */
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import en from 'src/i18n/en-us'

enableAutoUnmount(afterEach)
const mockSessionState = { revision: 0, account: null }
jest.mock('src/accounts/session', () => ({
  accountSession: { state: mockSessionState },
}))
const mockDeleteContact = jest.fn()
jest.mock('src/stores/contacts', () => ({
  useContactStore: () => ({
    deleteContact: (...args: unknown[]) => mockDeleteContact(...args),
  }),
}))
// eslint-disable-next-line @typescript-eslint/no-var-requires
const DeleteContactDialog = require('./DeleteContactDialog.vue').default
function render() {
  return mount(DeleteContactDialog, {
    attachTo: document.body,
    props: { address: 'peer-a', name: 'Alice' },
    global: {
      mocks: {
        $t: (key: string, params: Record<string, string> = {}) => {
          const text = key
            .split('.')
            .reduce<unknown>(
              (value, part) => (value as Record<string, unknown>)?.[part],
              en,
            )
          return String(text).replace('{name}', params.name ?? '')
        },
      },
      stubs: {
        QCard: { template: '<div><slot /></div>' },
        QCardSection: { template: '<div><slot /></div>' },
        QCardActions: { template: '<div><slot /></div>' },
        QBtn: {
          props: ['label', 'disable'],
          template: '<button :disabled="disable">{{ label }}</button>',
        },
      },
    },
  })
}
beforeEach(() => mockDeleteContact.mockReset().mockResolvedValue(undefined))
it('states the complete scope and cancels without deleting anything', async () => {
  const wrapper = render()
  expect(wrapper.text()).toContain('Delete Contact and Conversations')
  expect(wrapper.text()).toContain(
    'Delete Alice and all conversations with this contact?',
  )
  await wrapper.get('[data-test="delete-contact-cancel"]').trigger('click')
  expect(wrapper.emitted('cancel')).toHaveLength(1)
  expect(mockDeleteContact).not.toHaveBeenCalled()
})
it('captures the original peer and prevents duplicate confirmation until deletion finishes', async () => {
  let finish!: () => void
  mockDeleteContact.mockImplementation(
    () =>
      new Promise<void>(resolve => {
        finish = resolve
      }),
  )
  const wrapper = render()
  await wrapper.setProps({ address: 'peer-b', name: 'Bob' })
  expect(wrapper.text()).toContain('Alice')
  await wrapper.get('[data-test="delete-contact-confirm"]').trigger('click')
  await wrapper.get('[data-test="delete-contact-confirm"]').trigger('click')
  expect(mockDeleteContact).toHaveBeenCalledTimes(1)
  expect(mockDeleteContact).toHaveBeenCalledWith('peer-a')
  expect(wrapper.emitted('deleted')).toBeUndefined()
  expect(
    wrapper.get('[data-test="delete-contact-cancel"]').attributes('disabled'),
  ).toBeDefined()
  finish()
  await flushPromises()
  expect(wrapper.emitted('deleted')).toHaveLength(1)
})
it('keeps failures visible and permits retry of the same peer', async () => {
  mockDeleteContact
    .mockRejectedValueOnce(new Error('disk unavailable'))
    .mockResolvedValueOnce(undefined)
  const wrapper = render()
  await wrapper.get('[data-test="delete-contact-confirm"]').trigger('click')
  await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain(
    'Could not finish deleting this contact',
  )
  expect(wrapper.emitted('deleted')).toBeUndefined()
  await wrapper.get('[data-test="delete-contact-confirm"]').trigger('click')
  await flushPromises()
  expect(mockDeleteContact.mock.calls).toEqual([['peer-a'], ['peer-a']])
  expect(wrapper.emitted('deleted')).toHaveLength(1)
})

it('refuses an old confirmation after the account changes', async () => {
  const wrapper = render()
  mockSessionState.revision++
  try {
    await wrapper.get('[data-test="delete-contact-confirm"]').trigger('click')
    await flushPromises()
    expect(mockDeleteContact).not.toHaveBeenCalled()
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
  } finally {
    mockSessionState.revision--
  }
})

it('keeps confirmation keyboard events out of the contact list navigation listener', async () => {
  const navigate = jest.fn()
  document.addEventListener('keydown', navigate)
  try {
    const wrapper = render()
    await wrapper
      .get('[data-test="delete-contact-confirm"]')
      .trigger('keydown', { key: 'Enter' })
    expect(navigate).not.toHaveBeenCalled()
    expect(mockDeleteContact).not.toHaveBeenCalled()
  } finally {
    document.removeEventListener('keydown', navigate)
  }
})
