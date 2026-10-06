/** @jest-environment jsdom */

import * as fs from 'fs'
import * as path from 'path'
import { mount } from '@vue/test-utils'

import About from './About.vue'
import enUS from 'src/i18n/en-us'
import frFR from 'src/i18n/fr-fr'
import {
  SILENCE_LABORATORIES_LICENSE,
  SILENCE_LABORATORIES_NOTICE,
} from 'src/licenses/silence-laboratories'

type Messages = Record<string, unknown>

function translator(messages: Messages) {
  return (key: string, values: Record<string, string> = {}): string => {
    const value = key
      .split('.')
      .reduce<unknown>((o, k) => (o as Messages | undefined)?.[k], messages)
    if (typeof value !== 'string') return key
    return value.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '')
  }
}

function mountAbout(messages: Messages) {
  return mount(About, {
    global: {
      mocks: { $t: translator(messages) },
      stubs: {
        QHeader: { template: '<header><slot /></header>' },
        QToolbar: { template: '<div><slot /></div>' },
        QToolbarTitle: { template: '<h1><slot /></h1>' },
        QBtn: { template: '<button><slot /></button>' },
        QPageContainer: { template: '<main><slot /></main>' },
        QPage: { template: '<section><slot /></section>' },
        QAvatar: { template: '<div><slot /></div>' },
        QChip: { template: '<span><slot /></span>' },
        QCard: { template: '<article><slot /></article>' },
        QCardSection: { template: '<div><slot /></div>' },
        QIcon: { template: '<i><slot /></i>' },
      },
    },
  })
}

const text = (wrapper: ReturnType<typeof mountAbout>, name: string): string =>
  wrapper.find(`[data-test="${name}"]`).text()

describe('About: Silence Laboratories notices', () => {
  it('shows the required notice sentence verbatim, in every locale', () => {
    expect(SILENCE_LABORATORIES_NOTICE).toBe(
      'This software library is licensed under the Silence Laboratories License Agreement, Copyright © Silence Laboratories Pte. Ltd. All Rights Reserved.',
    )
    for (const messages of [enUS, frFR]) {
      expect(text(mountAbout(messages), 'dkls-notice')).toBe(
        SILENCE_LABORATORIES_NOTICE,
      )
    }
  })

  it('says the library is modified, by whom, when, and without Silence Laboratories', () => {
    const en = mountAbout(enUS)
    const modified = text(en, 'dkls-modified')
    expect(modified).toContain('modified version of the DKLs23 library')
    expect(modified).toContain('Silence Laboratories')
    expect(modified).toContain(
      'independently and without any involvement from Silence Laboratories',
    )
    expect(modified).toContain('2026-10-04')
    expect(text(en, 'dkls-changes')).toContain('adaptor pre-signing')
    expect(text(en, 'dkls-source')).toContain(
      'third_party/silent-shard-dkls23-ll',
    )
  })

  it('says the component is for non-commercial use only', () => {
    expect(text(mountAbout(enUS), 'dkls-non-commercial')).toContain(
      'non-commercial purposes only',
    )
    expect(text(mountAbout(frFR), 'dkls-non-commercial')).toContain(
      'fins non commerciales',
    )
  })

  it('renders the French strings in French', () => {
    const fr = mountAbout(frFR)
    expect(fr.find('h1').text()).toBe('À propos')
    expect(text(fr, 'dkls-modified')).toContain(
      'sans aucune participation de Silence Laboratories',
    )
  })

  it('shows the full licence text, identical to the file shipped with the source', () => {
    const shipped = fs.readFileSync(
      path.join(
        __dirname,
        '../../../third_party/silent-shard-dkls23-ll/LICENSE.md',
      ),
      'utf8',
    )
    expect(SILENCE_LABORATORIES_LICENSE).toBe(shipped)
    const shown = mountAbout(enUS).find('[data-test="dkls-license"]').element
      .textContent
    expect(shown).toBe(shipped)
    // The parts the licence names explicitly: its conditions and disclaimer.
    expect(shown).toContain('NON-COMMERCIAL USE LICENSE AGREEMENT')
    expect(shown).toContain('Grant of License')
    expect(shown).toContain('DISCLAIMER')
  })
})

describe('About: Frank & Stamp protocol overview', () => {
  it('renders hero branding with Frank tagline and badges', () => {
    const en = mountAbout(enUS)
    expect(text(en, 'about-hero')).toContain('Frank')
    expect(text(en, 'about-hero')).toContain(
      'Private, economically spam-resistant messaging for Monad.',
    )
    expect(text(en, 'about-hero')).toContain('Monad')
    expect(text(en, 'about-hero')).toContain('Stamp Protocol')
    expect(text(en, 'about-hero')).toContain('End-to-End Encrypted')
    expect(text(en, 'about-hero')).toContain('Permissionless Identity')
  })

  it('renders Frank identity and mission overview', () => {
    const en = mountAbout(enUS)
    const frank = text(en, 'about-frank')
    expect(frank).toContain('About Frank')
    expect(frank).toContain('decentralized, sovereign cryptomessenger')
    expect(frank).toContain('secp256k1')
    expect(frank).toContain('no phone numbers')
  })

  it('explains the Stamp protocol mechanism and economics', () => {
    const en = mountAbout(enUS)
    const stamp = text(en, 'about-stamp')
    expect(stamp).toContain('The Stamp Protocol: Speaking Is Not Free')
    expect(stamp).toContain('Direct Messages & Paid Delivery')
    expect(stamp).toContain('pays the recipient directly')
    expect(stamp).toContain('Topic Broadcasts & Burn Weights')
    expect(stamp).toContain('burn MON')
    expect(stamp).toContain('End-to-End Encryption')
  })

  it('renders links to GitHub and Stamp upstream', () => {
    const en = mountAbout(enUS)
    const links = en.find('[data-test="about-links"]')
    expect(links.text()).toContain('Links & Source Code')
    const buttons = links.findAll('button')
    expect(buttons.length).toBe(2)
    expect(buttons[0].attributes('href')).toBe('https://github.com/schancel/frank')
    expect(buttons[1].attributes('href')).toBe(
      'https://github.com/stampchat/stamp',
    )
  })

  it('renders localized Frank & Stamp content in French', () => {
    const fr = mountAbout(frFR)
    expect(text(fr, 'about-hero')).toContain(
      'Messagerie privée et résistante au spam économique pour Monad.',
    )
    expect(text(fr, 'about-frank')).toContain('À propos de Frank')
    expect(text(fr, 'about-stamp')).toContain(
      'Le protocole Stamp : la parole n’est pas gratuite',
    )
    expect(text(fr, 'about-links')).toContain('Liens et code source')
  })
})

