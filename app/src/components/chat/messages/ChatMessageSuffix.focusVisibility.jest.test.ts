/** @jest-environment jsdom */

/**
 * Retry must not leave keyboard focus on the clipped Sending live region (#429).
 * The region stays visually hidden and still announces one status.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

import { mount } from '@vue/test-utils'

import ChatMessageSuffix from './ChatMessageSuffix.vue'
import enUS from '../../../i18n/en-us'

jest.mock('quasar', () => ({
  useQuasar: () => ({ platform: { is: { mobile: false } } }),
}))

function translator(messages: unknown) {
  return (key: string) => {
    const value = key
      .split('.')
      .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], messages)
    return typeof value === 'string' ? value : key
  }
}

function installProductionVisibilityCss(): void {
  const css = readFileSync(join(process.cwd(), 'src/css/app.scss'), 'utf8')
  const srOnly = css.match(/\.q-sr-only\s*\{[^}]*\}/)?.[0] ?? ''
  const focus =
    css.match(/\.outgoing-focus-target:focus\s*\{[^}]*\}/)?.[0] ?? ''
  const style = document.createElement('style')
  style.setAttribute('data-testid', 'retry-focus-rules')
  style.textContent = `${srOnly}\n${focus}`
  document.head.appendChild(style)
}

function isVisuallyHidden(node: Element): boolean {
  const style = window.getComputedStyle(node)
  return (
    style.position === 'absolute' &&
    style.width === '1px' &&
    style.height === '1px' &&
    style.overflow === 'hidden'
  )
}

function parseHex(hex: string): [number, number, number] {
  const raw = hex.replace('#', '')
  const full =
    raw.length === 3
      ? raw
          .split('')
          .map(channel => channel + channel)
          .join('')
      : raw
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ]
}

function focusRingRgb(): [number, number, number] {
  const css = readFileSync(join(process.cwd(), 'src/css/app.scss'), 'utf8')
  const focus =
    css.match(/\.outgoing-focus-target:focus\s*\{[^}]*\}/)?.[0] ?? ''
  const color =
    focus.match(/outline:\s*2px solid\s+([^;]+);/)?.[1]?.trim() ?? ''
  if (color === 'black' || color === '#000' || color === '#000000') {
    return [0, 0, 0]
  }
  if (color === 'var(--q-primary)') {
    const variables = readFileSync(
      join(process.cwd(), 'src/css/quasar.variables.scss'),
      'utf8',
    )
    const primary = variables.match(/\$primary:\s*(#[0-9a-fA-F]{3,8})/)?.[1]
    if (primary === undefined) throw new Error('missing $primary')
    return parseHex(primary)
  }
  if (color.startsWith('#')) return parseHex(color)
  throw new Error(`unresolved focus outline color: ${color}`)
}

function sentBubble(file: string): [number, number, number] {
  const css = readFileSync(join(process.cwd(), 'src/css', file), 'utf8')
  const hex = css.match(/--q-message-color-sent:\s*(#[0-9a-fA-F]{6})/)?.[1]
  if (hex === undefined) throw new Error(`missing sent bubble in ${file}`)
  return parseHex(hex)
}

function channel(value: number): number {
  const unit = value / 255
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
}

/** Quasar paints `.q-message-stamp` at opacity .6, and this ring is inside it. */
function ringContrast(bubbleFile: string): number {
  const fg = focusRingRgb()
  const bg = sentBubble(bubbleFile)
  const ring = fg.map(
    (value, index) => 0.6 * value + 0.4 * bg[index],
  ) as number[]
  const lum = (rgb: number[]) =>
    0.2126 * channel(rgb[0]) +
    0.7152 * channel(rgb[1]) +
    0.0722 * channel(rgb[2])
  const hi = Math.max(lum(ring), lum(bg))
  const lo = Math.min(lum(ring), lum(bg))
  return (hi + 0.05) / (lo + 0.05)
}

function mountFailed() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const wrapper = mount(ChatMessageSuffix, {
    attachTo: host,
    props: {
      stamp: '',
      amount: '',
      outbound: true,
      status: 'error',
      failureReason: 'unavailable',
    },
    global: {
      mocks: { $t: translator(enUS) },
      stubs: {
        QIcon: { template: '<i />' },
        QBtn: { template: '<button><slot /></button>' },
      },
    },
  })
  return { wrapper, host }
}

describe('Retry focus stays visible (#429)', () => {
  beforeEach(() => {
    document.head
      .querySelectorAll('[data-testid="retry-focus-rules"]')
      .forEach(node => node.remove())
    installProductionVisibilityCss()
  })

  it('focusStatus leaves the keyboard on a visible target, not the clipped live region', () => {
    const { wrapper, host } = mountFailed()
    const region = wrapper.get('[data-testid="outgoing-announcement"]')
    ;(wrapper.vm as unknown as { focusStatus: () => void }).focusStatus()

    const active = document.activeElement
    expect(active).toBeTruthy()
    expect(active).not.toBe(document.body)
    expect(isVisuallyHidden(active as Element)).toBe(false)
    expect(active).not.toBe(region.element)
    expect((active as HTMLElement).getAttribute('tabindex')).toBe('-1')
    expect(active).toBe(
      wrapper.get('[data-testid="outgoing-focus-target"]').element,
    )
    expect(region.classes()).toContain('q-sr-only')
    expect(isVisuallyHidden(region.element)).toBe(true)
    expect(region.attributes('tabindex')).toBeUndefined()

    const outline = window.getComputedStyle(active as Element).outline
    expect(outline).toMatch(/2px solid/)
    expect(outline).not.toBe('none')
    expect(ringContrast('light-mode.scss')).toBeGreaterThanOrEqual(3)
    expect(ringContrast('dark-mode.scss')).toBeGreaterThanOrEqual(3)

    wrapper.unmount()
    host.remove()
  })

  it('after a failed retry the live region still announces once and does not paint Sending', async () => {
    const { wrapper, host } = mountFailed()
    ;(wrapper.vm as unknown as { focusStatus: () => void }).focusStatus()
    await wrapper.setProps({ status: 'pending' })
    await wrapper.vm.$nextTick()

    const region = wrapper.get('[data-testid="outgoing-announcement"]')
    expect(region.text()).toBe('Sending…')
    expect(isVisuallyHidden(region.element)).toBe(true)
    expect(wrapper.findAll('[data-testid="outgoing-sending"]')).toHaveLength(1)
    expect(isVisuallyHidden(document.activeElement as Element)).toBe(false)
    expect(document.activeElement).toBe(
      wrapper.get('[data-testid="outgoing-focus-target"]').element,
    )

    wrapper.unmount()
    host.remove()
  })
})
