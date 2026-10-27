/** @jest-environment jsdom */
import { mount } from '@vue/test-utils'
import Contacts from './Contacts.vue'

jest.mock('src/components/panels/ContactsPanel.vue', () => ({
  props: ['showTitle'],
  template:
    '<div data-testid="contacts-panel" :data-show-title="String(showTitle)" />',
}))

const slot = { template: '<div><slot /></div>' }
function mountAt(width: number) {
  return mount(Contacts, {
    global: {
      mocks: { $t: (key: string) => key, $q: { screen: { width } } },
      stubs: {
        QHeader: { template: '<header><slot /></header>' },
        QToolbar: slot,
        QToolbarTitle: slot,
        QPageContainer: slot,
        QPage: slot,
        QBtn: { template: '<button />' },
        QIcon: { template: '<i />' },
      },
    },
  })
}

describe('Contacts page', () => {
  it('on a phone is the contact list under the app header, titled once', () => {
    const wrapper = mountAt(390)
    expect(wrapper.find('header').text()).toContain(
      'contactBookDialog.contacts',
    )
    const panel = wrapper.get('[data-testid="contacts-panel"]')
    expect(panel.attributes('data-show-title')).toBe('false')
  })

  it('on a wide screen does not show the list a second time beside the sidebar', () => {
    const wrapper = mountAt(1280)
    expect(wrapper.find('[data-testid="contacts-panel"]').exists()).toBe(false)
    expect(wrapper.find('header').exists()).toBe(false)
    expect(
      wrapper.get('[data-testid="contacts-placeholder"]').text(),
    ).toContain('contactBookDialog.pickContact')
  })
})
