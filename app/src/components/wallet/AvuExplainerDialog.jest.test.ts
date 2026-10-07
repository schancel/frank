/** @jest-environment jsdom */
import { mount } from '@vue/test-utils'
import AvuExplainerDialog from './AvuExplainerDialog.vue'
import en from '../../i18n/en-us'

const t = (key: string) =>
  key.split('.').reduce((value: any, part) => value?.[part], en) ?? key

function mountDialog(props = {}) {
  return mount(AvuExplainerDialog, {
    props: {
      modelValue: true,
      ...props,
    },
    global: {
      mocks: { $t: t },
      stubs: {
        QDialog: {
          props: ['modelValue'],
          template:
            '<div v-if="modelValue" data-test="dialog-stub"><slot /></div>',
        },
        QCard: { template: '<div><slot /></div>' },
        QCardSection: { template: '<div><slot /></div>' },
        QCardActions: { template: '<div><slot /></div>' },
        QAvatar: { template: '<div class="avatar-stub"><slot /></div>' },
        QIcon: { template: '<i class="icon-stub" />' },
        QSpace: { template: '<span />' },
        QBtn: {
          props: ['label', 'disable'],
          template:
            '<button :disabled="disable" @click="$emit(\'click\')">{{ label }}<slot /></button>',
        },
      },
    },
  })
}

describe('AvuExplainerDialog component', () => {
  test('renders dialog when modelValue is true and displays core concepts', () => {
    const wrapper = mountDialog()
    expect(wrapper.find('[data-test="avu-explainer-card"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Arbitrary Value Unit (AVU)')
    expect(wrapper.text()).toContain('1 AVU ≡ 1 Kilowatt-Hour (kWh)')
    expect(wrapper.text()).toContain('Refusing the USD Meme')
    expect(wrapper.text()).toContain('The Root of Every Supply Chain')
    expect(wrapper.text()).toContain('Bypassing the CPI')
    expect(wrapper.text()).toContain('Truly "Oracle-Less"')
  })

  test('does not render when modelValue is false', () => {
    const wrapper = mountDialog({ modelValue: false })
    expect(wrapper.find('[data-test="avu-explainer-card"]').exists()).toBe(
      false,
    )
  })

  test('emits update:modelValue with false when close button is clicked', async () => {
    const wrapper = mountDialog()
    const closeBtn = wrapper.find('[data-test="avu-dialog-close-btn"]')
    expect(closeBtn.exists()).toBe(true)
    await closeBtn.trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false])
  })
})
