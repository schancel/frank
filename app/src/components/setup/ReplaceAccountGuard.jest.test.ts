/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'

jest.mock('../dialogs/SeedConfirmDialog.vue', () => ({
  template: '<div data-test="dialog" />',
}))

import ReplaceAccountGuard from './ReplaceAccountGuard.vue'

const messages: Record<string, string> = { 'replaceGuard.word': 'REPLACE' }
const QDialogStub = defineComponent({
  props: { modelValue: { type: Boolean, default: false } },
  template: '<div v-if="modelValue"><slot /></div>',
})

function mountGuard(props: Record<string, unknown> = {}) {
  return mount(ReplaceAccountGuard, {
    attachTo: document.body,
    props,
    global: {
      mocks: {
        $t: (k: string, p?: { word?: string }) =>
          messages[k] ?? (p ? `${k}:${p.word}` : k),
      },
      stubs: { QDialog: QDialogStub },
    },
  })
}

describe('ReplaceAccountGuard (#304)', () => {
  it('leads with Cancel and confirm-current; the replace form is hidden until asked', () => {
    const w = mountGuard()
    expect(w.find('[data-test="cancel"]').exists()).toBe(true)
    expect(w.find('[data-test="confirm-current"]').exists()).toBe(true)
    expect(w.find('[data-test="replace-form"]').exists()).toBe(false)
    expect(w.emitted('acknowledge')).toBeUndefined()
  })

  it('focuses the heading on entry', async () => {
    const w = mountGuard()
    await nextTick()
    expect(document.activeElement).toBe(w.get('h2').element)
    w.unmount()
  })

  it('hides confirm-current when the phrase is already confirmed', () => {
    const w = mountGuard({ confirmed: true })
    expect(w.find('[data-test="confirm-current"]').exists()).toBe(false)
    expect(w.find('[data-test="confirmed"]').exists()).toBe(true)
  })

  it('hides confirm-current when there is no stored seed (#308)', () => {
    const w = mountGuard({ hasSeed: false })
    expect(w.find('[data-test="confirm-current"]').exists()).toBe(false)
    expect(w.find('[data-test="cancel"]').exists()).toBe(true)
    expect(w.find('[data-test="replace-toggle"]').exists()).toBe(true)
  })

  it('cancel emits cancel only', async () => {
    const w = mountGuard()
    await w.get('[data-test="cancel"]').trigger('click')
    expect(w.emitted('cancel')).toHaveLength(1)
    expect(w.emitted('acknowledge')).toBeUndefined()
  })

  it('confirm-current opens the stored-phrase confirmation dialog', async () => {
    const w = mountGuard()
    await w.get('[data-test="confirm-current"]').trigger('click')
    expect(w.find('[data-test="dialog"]').exists()).toBe(true)
  })

  it('replacing needs the exact word: wrong text announces politely and emits nothing', async () => {
    const w = mountGuard({})
    await w.get('[data-test="replace-toggle"]').trigger('click')
    await nextTick()
    const toggle = w.get('[data-test="replace-toggle"]')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    const input = w.get('input')
    expect(w.get('label').attributes('for')).toBe(input.attributes('id'))
    expect(document.activeElement).toBe(input.element)

    for (const wrong of ['', 'replace', 'REPLAC', 'yes', 'REPLACE NOW']) {
      await input.setValue(wrong)
      await w.get('form').trigger('submit')
      await nextTick()
      expect(w.emitted('acknowledge')).toBeUndefined()
      expect(w.get('[role="status"]').text()).toBe('replaceGuard.mismatch')
      expect(input.attributes('aria-invalid')).toBe('true')
    }
    w.unmount()
  })

  it('the exact word (surrounding spaces ignored) emits acknowledge once', async () => {
    const w = mountGuard()
    await w.get('[data-test="replace-toggle"]').trigger('click')
    await w.get('input').setValue('  REPLACE ')
    await w.get('form').trigger('submit')
    expect(w.emitted('acknowledge')).toHaveLength(1)
  })

  it('clears mismatch and aria-invalid as soon as the user starts retyping (#308)', async () => {
    const w = mountGuard()
    await w.get('[data-test="replace-toggle"]').trigger('click')
    await nextTick()
    const input = w.get('input')
    await input.setValue('wrong')
    await w.get('form').trigger('submit')
    await nextTick()
    expect(w.get('[role="status"]').text()).toBe('replaceGuard.mismatch')
    expect(input.attributes('aria-invalid')).toBe('true')

    await input.setValue('wron')
    await nextTick()
    expect(w.get('[role="status"]').text()).toBe('')
    expect(input.attributes('aria-invalid')).toBe('false')
    w.unmount()
  })

  it('exercises the French word REMPLACER and rejects REPLACE (#308)', async () => {
    const frMessages: Record<string, string> = {
      'replaceGuard.word': 'REMPLACER',
    }
    const w = mount(ReplaceAccountGuard, {
      attachTo: document.body,
      global: {
        mocks: {
          $t: (k: string, p?: { word?: string }) =>
            frMessages[k] ?? (p ? `${k}:${p.word}` : k),
        },
        stubs: { QDialog: QDialogStub },
      },
    })
    await w.get('[data-test="replace-toggle"]').trigger('click')
    await nextTick()
    const input = w.get('input')

    // English word must fail
    await input.setValue('REPLACE')
    await w.get('form').trigger('submit')
    await nextTick()
    expect(w.emitted('acknowledge')).toBeUndefined()
    expect(w.get('[role="status"]').text()).toBe('replaceGuard.mismatch')

    // French word must succeed
    await input.setValue('  REMPLACER  ')
    await w.get('form').trigger('submit')
    await nextTick()
    expect(w.emitted('acknowledge')).toHaveLength(1)
    w.unmount()
  })
})
