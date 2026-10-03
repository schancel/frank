/** @jest-environment jsdom */
import { shallowMount } from '@vue/test-utils'
import BackupReminder from './BackupReminder.vue'
import en from '../../i18n/en-us'
const mockAccount = { account: null as object | null }
jest.mock('../../accounts/session', () => ({
  get accountStatus() {
    return mockAccount
  },
}))
const t = (key: string) =>
  key.split('.').reduce((value: any, part) => value[part], en)
test('fresh accounts have no false backup-complete reminder', () => {
  const view = shallowMount(BackupReminder, { global: { mocks: { $t: t } } })
  expect(view.find('[data-test="backup-reminder"]').exists()).toBe(false)
})
test('active custody metadata honestly describes backup limitations without a re-export action', () => {
  mockAccount.account = { descriptor: 'public' }
  const view = shallowMount(BackupReminder, { global: { mocks: { $t: t } } })
  expect(view.text()).toContain('cannot recreate')
  expect(view.find('button').exists()).toBe(false)
})
