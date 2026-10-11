/** @jest-environment jsdom */
import { enableAutoUnmount, mount } from '@vue/test-utils'
import ContactBookDialog from './ContactBookDialog.vue'
import { readFileSync } from 'fs'
import { join } from 'path'

enableAutoUnmount(afterEach)
jest.mock('src/stores/contacts', () => ({
  useContactStore: () => ({ getContacts: {} }),
}))
jest.mock('pinia', () => ({ storeToRefs: () => ({ getContacts: {} }) }))
jest.mock('../contacts/ContactList.vue', () => ({ template: '<div />' }))
it('removes the inert add button and keeps Close outside the scrollable contact list', () => {
  const pass = { template: '<div><slot /></div>' }
  const wrapper = mount(ContactBookDialog, {
    props: { contactClick: jest.fn() },
    global: {
      mocks: { $t: (key: string) => key },
      directives: { 'close-popup': {} },
      stubs: {
        QCard: pass,
        QCardSection: pass,
        QCardActions: pass,
        QSpace: pass,
        QInput: { template: '<input />' },
        QBtn: {
          props: ['label', 'icon'],
          template: '<button :data-icon="icon">{{ label }}</button>',
        },
      },
    },
  })
  expect(wrapper.find('button[data-icon="add"]').exists()).toBe(false)
  expect(wrapper.get('.contact-book-actions').text()).toBe('close')
  expect(
    wrapper.get('.contact-book-list').find('.contact-book-actions').exists(),
  ).toBe(false)
  const source = readFileSync(join(__dirname, 'ContactBookDialog.vue'), 'utf8')
  expect(source).toContain('min-height: 0')
  expect(source).toContain('overflow-y: auto')
  expect(source).not.toContain('newContactOpen')
})
