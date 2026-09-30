/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

import SeedConfirmStep from './SeedConfirmStep.vue'

const SEED = 'test test test test test test test test test test test junk'
const t = (k: string, p?: { n?: number }) => (p ? `${k}:${p.n}` : k)

function mountStep(props: Record<string, unknown> = {}) {
  return mount(SeedConfirmStep, {
    attachTo: document.body,
    props: { seed: SEED, positions: [3, 7, 12], ...props },
    global: { mocks: { $t: t } },
  })
}
const inputs = (w: ReturnType<typeof mountStep>) =>
  w.findAll('input').map(i => i.element as HTMLInputElement)

async function answer(w: ReturnType<typeof mountStep>, values: string[]) {
  const els = w.findAll('input')
  for (let i = 0; i < values.length; i++) await els[i].setValue(values[i])
  await w.find('form').trigger('submit')
  await nextTick()
}

describe('SeedConfirmStep', () => {
  it('asks for exactly the given positions, each input has an associated label', () => {
    const w = mountStep()
    const labels = w.findAll('label')
    expect(labels.map(l => l.text())).toEqual([
      'seedConfirm.wordLabel:3',
      'seedConfirm.wordLabel:7',
      'seedConfirm.wordLabel:12',
    ])
    inputs(w).forEach((input, i) => {
      expect(labels[i].attributes('for')).toBe(input.id)
    })
  })

  it('does not render the phrase until the user asks to see it', () => {
    const w = mountStep()
    expect(w.find('ol').exists()).toBe(false)
    expect(w.html()).not.toContain('junk')
  })

  it('correct answers emit confirmed', async () => {
    const w = mountStep()
    await answer(w, ['test', 'TEST ', 'junk'])
    expect(w.emitted('confirmed')).toHaveLength(1)
  })

  it('wrong answers block, show a polite live error, focus the first field, and allow retry', async () => {
    const w = mountStep()
    await answer(w, ['test', 'test', 'wrong'])

    expect(w.emitted('confirmed')).toBeUndefined()
    const live = w.find('[aria-live="polite"]')
    expect(live.text()).toBe('seedConfirm.error')
    expect(live.attributes('role')).toBe('status')
    expect(w.findAll('input')[0].attributes('aria-invalid')).toBe('true')
    expect(w.findAll('input')[0].attributes('aria-describedby')).toBe(
      live.attributes('id'),
    )
    expect(document.activeElement).toBe(inputs(w)[0])

    await answer(w, ['test', 'test', 'junk'])
    expect(w.emitted('confirmed')).toHaveLength(1)
    expect(w.find('[aria-live="polite"]').text()).toBe('')
  })

  it('empty answers are wrong', async () => {
    const w = mountStep()
    await answer(w, [])
    expect(w.emitted('confirmed')).toBeUndefined()
  })

  it('can show the phrase again (in order, focusable) and hide it', async () => {
    const w = mountStep()
    const toggle = w.find('button[type="button"]')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    await toggle.trigger('click')
    await nextTick()

    const items = w.findAll('ol li').map(li => li.text())
    expect(items.join(' ')).toBe(SEED)
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(w.find('ol').element)

    await toggle.trigger('click')
    expect(w.find('ol').exists()).toBe(false)
  })

  it('is keyboard operable: controls are native inputs/buttons in a submitting form', () => {
    const w = mountStep()
    expect(w.findAll('button').every(b => b.element.tagName === 'BUTTON')).toBe(
      true,
    )
    expect(w.find('button[type="submit"]').exists()).toBe(true)
    expect(w.find('form').attributes('aria-labelledby')).toBe(
      w.find('h2').attributes('id'),
    )
  })

  it('a new phrase or new positions clears answers, error and the revealed phrase', async () => {
    const w = mountStep()
    await answer(w, ['x', 'y', 'z'])
    await w.find('button[type="button"]').trigger('click')

    await w.setProps({
      positions: [1, 2, 4],
      seed: SEED.replace('junk', 'zoo'),
    })
    await nextTick()

    expect(inputs(w).map(i => i.value)).toEqual(['', '', ''])
    expect(w.find('[aria-live="polite"]').text()).toBe('')
    expect(w.find('ol').exists()).toBe(false)
  })

  it('shows the confirmed state instead of the questions', () => {
    const w = mountStep({ confirmed: true })
    expect(w.find('input').exists()).toBe(false)
    expect(w.text()).toContain('seedConfirm.success')
  })
})
