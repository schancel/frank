/** @jest-environment jsdom */
import { mount } from '@vue/test-utils'
import Panel from './DirectoryProvisioningPanel.vue'
import en from '../../i18n/en-us'
const translate = (key: string) => key.split('.').reduce((value: any, part) => value[part], en)
test('mount stays pending without operator authority and offers no signing or installation action', () => {
  const request = jest.fn()
  const previous = global.fetch
  global.fetch = request
  try {
    const panel = mount(Panel, { global: { mocks: { $t: translate }, stubs: { QBtn: { props: ['label', 'disable'], template: '<button :disabled="disable">{{label}}</button>' } } } })
    expect(panel.get('[role="status"]').text()).toBe('Pending operator installation')
    expect(panel.get('button').attributes('disabled')).toBeDefined()
    expect(panel.text()).toContain('Authenticated operator policy is not available')
    expect(request).not.toHaveBeenCalled()
    expect(panel.find('[aria-labelledby="directory-provisioning-title"]').exists()).toBe(true)
    panel.unmount()
  } finally { global.fetch = previous }
})
