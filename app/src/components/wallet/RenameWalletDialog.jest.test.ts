/** @jest-environment jsdom */
import { mount } from '@vue/test-utils'
import RenameWalletDialog from './RenameWalletDialog.vue'
import en from '../../i18n/en-us'

const t = (key: string) =>
  key.split('.').reduce((value: any, part) => value?.[part], en) ?? key

function mountDialog(props = {}) {
  return mount(RenameWalletDialog, {
    props: {
      modelValue: true,
      chain: 'monad',
      currentName: '',
      defaultName: 'Main wallet',
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
        QInput: {
          props: ['modelValue', 'label', 'placeholder'],
          template: `
            <div>
              <input
                data-test="native-input"
                :value="modelValue"
                :placeholder="placeholder"
                @input="$emit('update:modelValue', $event.target.value)"
                @keyup.enter="$emit('keyup', $event)"
              />
            </div>
          `,
        },
        QBtn: {
          props: ['label', 'disable'],
          template: '<button :disabled="disable">{{ label }}<slot /></button>',
        },
      },
    },
  })
}

describe('RenameWalletDialog component', () => {
  test('renders dialog when modelValue is true and displays title and input placeholder', () => {
    const wrapper = mountDialog()
    expect(wrapper.find('[data-test="rename-wallet-card"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Rename wallet')
    const input = wrapper.find('[data-test="native-input"]')
    expect(input.attributes('placeholder')).toBe('Main wallet')
  })

  test('populates input with currentName when provided and shows reset button', () => {
    const wrapper = mountDialog({ currentName: 'Trading Bot' })
    const input = wrapper.find('[data-test="native-input"]')
    expect((input.element as HTMLInputElement).value).toBe('Trading Bot')
    expect(wrapper.find('[data-test="rename-wallet-reset-btn"]').exists()).toBe(
      true,
    )
    expect(
      wrapper.find('[data-test="rename-wallet-reset-btn"]').text(),
    ).toContain('Reset to default')
  })

  test('does not show reset button when currentName is empty', () => {
    const wrapper = mountDialog({ currentName: '' })
    expect(wrapper.find('[data-test="rename-wallet-reset-btn"]').exists()).toBe(
      false,
    )
  })

  test('emits save event with trimmed input and closes dialog', async () => {
    const wrapper = mountDialog({ currentName: 'Old' })
    const input = wrapper.find('[data-test="native-input"]')
    await input.setValue('  New Name  ')

    await wrapper.find('[data-test="rename-wallet-save-btn"]').trigger('click')

    expect(wrapper.emitted('save')).toEqual([['New Name']])
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
  })

  test('emits reset event and closes dialog on reset button click', async () => {
    const wrapper = mountDialog({ currentName: 'Custom Monad' })
    await wrapper.find('[data-test="rename-wallet-reset-btn"]').trigger('click')

    expect(wrapper.emitted('reset')).toBeTruthy()
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
  })

  test('emits update:modelValue false on cancel', async () => {
    const wrapper = mountDialog()
    await wrapper
      .find('[data-test="rename-wallet-cancel-btn"]')
      .trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
  })
})
