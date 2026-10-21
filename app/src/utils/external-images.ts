import type { Directive } from 'vue'
import { EXTERNAL_IMAGE_ATTRIBUTE } from './markdown'

/**
 * Click-to-load for the external pictures the sanitiser in `markdown.ts` turns into placeholders.
 * A placeholder holds the picture's web address in `EXTERNAL_IMAGE_ATTRIBUTE`, never in `src`;
 * only a click on it (or Enter/Space) puts that one picture in its place. Nothing is remembered:
 * the next rendering shows the placeholder again.
 */

const WEB_ADDRESS = /^https?:\/\//i
const SELECTOR = `[${EXTERNAL_IMAGE_ATTRIBUTE}]`

/** The app's translator (`$t`). */
export type Translate = (key: string) => string

/** Writes the placeholders' words in the reader's language. */
function labelPlaceholders(root: ParentNode, t: Translate) {
  root.querySelectorAll<HTMLElement>(SELECTOR).forEach(placeholder => {
    placeholder.title = t('chatImage.externalWarning')
    const label = placeholder.querySelector('.external-image__label')
    if (label) label.textContent = t('chatImage.externalLabel')
  })
}

/** Puts the picture a placeholder names in its place; only a web (http/https) address loads. */
export function loadExternalImage(placeholder: Element) {
  const url = placeholder.getAttribute(EXTERNAL_IMAGE_ATTRIBUTE) ?? ''
  if (!WEB_ADDRESS.test(url)) return
  const image = placeholder.ownerDocument.createElement('img')
  image.alt = placeholder.getAttribute('data-external-alt') ?? ''
  image.style.maxWidth = '100%'
  image.src = url
  placeholder.replaceWith(image)
}

function activate(event: Event) {
  if (event.type === 'keydown') {
    const key = (event as KeyboardEvent).key
    if (key !== 'Enter' && key !== ' ') return
  }
  const target = event.target as Element | null
  const placeholder = target?.closest?.(SELECTOR)
  if (!placeholder) return
  // A placeholder inside a link or a clickable card loads the picture and does nothing else.
  event.preventDefault()
  event.stopPropagation()
  loadExternalImage(placeholder)
}

/**
 * Labels the placeholders under `root` and loads one when it is clicked, by one delegated
 * listener on `root`. Returns the function that removes the listener.
 */
export function bindExternalImages(
  root: HTMLElement,
  t: Translate,
): () => void {
  labelPlaceholders(root, t)
  root.addEventListener('click', activate)
  root.addEventListener('keydown', activate)
  return () => {
    root.removeEventListener('click', activate)
    root.removeEventListener('keydown', activate)
  }
}

const unbinders = new WeakMap<HTMLElement, () => void>()

/** The component's `$t`; a component without one (a test) shows the message keys. */
function translatorOf(instance: unknown): Translate {
  const t = (instance as { $t?: Translate } | null)?.$t
  return typeof t === 'function' ? key => t(key) : key => key
}

/** `v-external-images` beside a `v-html` of sanitised content. */
export const vExternalImages: Directive<HTMLElement> = {
  mounted(el, binding) {
    unbinders.set(el, bindExternalImages(el, translatorOf(binding.instance)))
  },
  updated(el, binding) {
    labelPlaceholders(el, translatorOf(binding.instance))
  },
  beforeUnmount(el) {
    unbinders.get(el)?.()
    unbinders.delete(el)
  },
}
