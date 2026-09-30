/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'

import enUS from '../../i18n/en-us'
import frFR from '../../i18n/fr-fr'
import SeedConfirmStep from './SeedConfirmStep.vue'

const SEED = 'test test test test test test test test test test test junk'
// Quasar renders nothing under the SSR build Jest aliases to, so stand in for QBtn with the native
// button it renders (same `type` default, attributes passed through to the button).
const QBtn = defineComponent({
  name: 'QBtn',
  props: { label: String, type: { type: String, default: 'button' } },
  setup(props, { attrs }) {
    return () => h('button', { ...attrs, type: props.type }, props.label)
  },
})
const t = (k: string, p?: { n?: number; positions?: string }) =>
  p ? `${k}:${p.n ?? p.positions}` : k

function mountStep(props: Record<string, unknown> = {}) {
  return mount(SeedConfirmStep, {
    attachTo: document.body,
    props: { seed: SEED, positions: [3, 7, 12], ...props },
    global: { mocks: { $t: t }, components: { QBtn } },
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

  // Distinct words so a wrong field is unambiguous: positions 3, 7, 12 are test, test, junk.
  const live = (w: ReturnType<typeof mountStep>) =>
    w.find('[aria-live="polite"]')
  const invalid = (w: ReturnType<typeof mountStep>) =>
    w.findAll('input').map(i => i.attributes('aria-invalid'))
  const errorText = (w: ReturnType<typeof mountStep>, i: number) => {
    const id = w.findAll('input')[i].attributes('aria-describedby')
    return id ? (w.find(`#${id}`).text() as string) : undefined
  }

  it('one wrong of three marks only that field, names its position, focuses it', async () => {
    const w = mountStep()
    await answer(w, ['test', 'test', 'wrong'])

    expect(w.emitted('confirmed')).toBeUndefined()
    expect(invalid(w)).toEqual(['false', 'false', 'true'])
    expect(errorText(w, 2)).toBe('seedConfirm.wordError:12')
    expect(w.findAll('input')[0].attributes('aria-describedby')).toBeUndefined()
    expect(w.findAll('input')[1].attributes('aria-describedby')).toBeUndefined()
    expect(document.activeElement).toBe(inputs(w)[2])
    expect(live(w).attributes('role')).toBe('status')
    expect(live(w).text()).toBe('seedConfirm.recheck:12')
  })

  it('two wrong marks exactly those two; focus goes to the first of them', async () => {
    const w = mountStep()
    await answer(w, ['nope', 'test', 'nah'])

    expect(invalid(w)).toEqual(['true', 'false', 'true'])
    expect(errorText(w, 0)).toBe('seedConfirm.wordError:3')
    expect(errorText(w, 2)).toBe('seedConfirm.wordError:12')
    expect(document.activeElement).toBe(inputs(w)[0])
    expect(live(w).text()).toBe('seedConfirm.recheck:3, 12')

    await answer(w, ['test', 'nope', 'junk'])
    expect(invalid(w)).toEqual(['false', 'true', 'false'])
    expect(document.activeElement).toBe(inputs(w)[1])
    expect(live(w).text()).toBe('seedConfirm.recheck:7')
  })

  it.each([
    ['en-us', enUS, 'Word #12 does not match', 'word numbers: 12'],
    ['fr-fr', frFR, 'Le mot n° 12 ne correspond pas', 'n° : 12'],
  ])(
    'renders the real %s messages with the position',
    async (_l, msgs, one, all) => {
      // Resolve the real catalog entry and fill its {param}s, as vue-i18n would.
      const real = (k: string, p: Record<string, unknown> = {}) =>
        k
          .split('.')
          .reduce((o: any, part) => o[part], msgs as any)
          .replace(/\{(\w+)\}/g, (_m: string, name: string) => String(p[name]))
      const w = mount(SeedConfirmStep, {
        attachTo: document.body,
        props: { seed: SEED, positions: [3, 7, 12] },
        global: { mocks: { $t: real }, components: { QBtn } },
      })
      await answer(w, ['test', 'test', 'nope'])
      expect(errorText(w, 2)).toBe(one)
      expect(live(w).text()).toContain(all)
      expect(w.html()).not.toContain('junk')
    },
  )

  it('all right confirms with no error state', async () => {
    const w = mountStep()
    await answer(w, ['nope', 'test', 'junk'])
    await answer(w, [' Test', 'TEST ', 'junk'])
    expect(w.emitted('confirmed')).toHaveLength(1)
    expect(invalid(w).every(v => v === 'false')).toBe(true)
    expect(live(w).text()).toBe('')
  })

  it('editing a wrong field clears only its own error', async () => {
    const w = mountStep()
    await answer(w, ['nope', 'test', 'nah'])
    await w.findAll('input')[0].setValue('t')

    expect(invalid(w)).toEqual(['false', 'false', 'true'])
    expect(errorText(w, 0)).toBeUndefined()
    expect(errorText(w, 2)).toBe('seedConfirm.wordError:12')
    expect(live(w).text()).toBe('seedConfirm.recheck:12')
    await w.findAll('input')[2].setValue('j')
    expect(live(w).text()).toBe('')
  })

  it('never puts a correct word in any text or attribute of an error state', async () => {
    const seed =
      'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima'
    const w = mountStep({ seed })
    await answer(w, ['wrongone', 'wrongtwo', 'wrongthree'])
    const html = w.html()
    for (const word of ['charlie', 'golf', 'lima']) {
      expect(html).not.toContain(word)
    }
    expect(invalid(w)).toEqual(['true', 'true', 'true'])
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

  it('the two actions are Quasar buttons, matching the rest of setup (ticket #369)', () => {
    const w = mountStep()
    const buttons = w.findAllComponents({ name: 'QBtn' })
    expect(buttons.map(b => b.props('label'))).toEqual([
      'seedConfirm.check',
      'seedConfirm.showPhrase',
    ])
    // Primary action submits the form; the toggle never does.
    expect(buttons.map(b => b.props('type'))).toEqual(['submit', 'button'])
    expect(w.findAll('button[type="submit"]')).toHaveLength(1)
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
    expect(invalid(w)).toEqual(['false', 'false', 'false'])
    expect(w.find('ol').exists()).toBe(false)
  })

  it('shows the confirmed state instead of the questions', () => {
    const w = mountStep({ confirmed: true })
    expect(w.find('input').exists()).toBe(false)
    expect(w.text()).toContain('seedConfirm.success')
  })
})
