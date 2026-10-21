/** @jest-environment jsdom */
import { shallowMount } from '@vue/test-utils'

jest.mock('@frank/wallet/chain', () => ({
  activeChain: { parseAddress: () => null, formatAddress: (a: string) => a },
}))

import ContactCard from './ContactCard.vue'

it('opening the profile only reports the tap; the owner decides where it goes', async () => {
  const push = jest.fn()
  const wrapper = shallowMount(ContactCard, {
    props: {
      name: 'Ada',
      address: '0x1111111111111111111111111111111111111111',
    },
    global: {
      mocks: { $t: (key: string) => key, $router: { push } },
      stubs: {
        QItem: {
          emits: ['click'],
          template:
            '<div v-bind="$attrs" @click="$emit(\'click\')"><slot /></div>',
        },
      },
    },
  })
  await wrapper.find('[data-test="contact-card-open-profile"]').trigger('click')
  expect(wrapper.emitted('open-profile')).toHaveLength(1)
  expect(push).not.toHaveBeenCalled()
})
