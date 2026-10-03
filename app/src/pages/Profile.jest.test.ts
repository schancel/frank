/** @jest-environment jsdom */
import { shallowMount } from '@vue/test-utils'
import ProfilePage from './Profile.vue'
import { readFileSync } from 'fs'
import { join } from 'path'

it('explains unavailable typed profile publication without a legacy submit path', () => {
  const wrapper = shallowMount(ProfilePage, {
    global: {
      mocks: { $t: (key: string) => key, $router: { push: jest.fn() } },
    },
  })
  expect(wrapper.find('[role="status"]').text()).toBe(
    'accountRecovery.profile_unavailable',
  )
  const source = readFileSync(join(__dirname, 'Profile.vue'), 'utf8')
  expect(source).not.toMatch(
    /registerMonadIdentity|useActiveWallet|setRelayData/,
  )
})
