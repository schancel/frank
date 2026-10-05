import * as fs from 'fs'
import * as path from 'path'

import enUS from './en-us'
import frFR from './fr-fr'

function flatten(node: unknown, prefix = ''): Record<string, string> {
  if (typeof node === 'string') return { [prefix]: node }
  if (node && typeof node === 'object') {
    return Object.entries(node).reduce(
      (all, [key, value]) => ({
        ...all,
        ...flatten(value, prefix ? `${prefix}.${key}` : key),
      }),
      {},
    )
  }
  return {}
}

const en = flatten(enUS)
const fr = flatten(frFR)

/** fr-fr strings that are legitimately the same word in French. Everything else identical to
 * en-us is an untranslated placeholder (ticket #274: `noContactMessage` shipped English). */
const SAME_IN_FRENCH = new Set([
  'leftDrawer.contacts',
  'leftDrawer.forum',
  'walletPanel.monad',
  'walletPanel.monadTestnet',
  'walletPanel.ecash',
  'walletPanel.ecashTestnet',
  'walletPanel.solana',
  'walletPanel.solanaTestnet',
  'walletPanel.zeroXec',
  'walletPanel.zeroTxec',
  'walletPanel.zeroSol',
  'walletPanel.zeroTsol',
  'SettingPanel.contacts',
  'contactBookDialog.contacts',
  'chatRightDrawer.notifications',
  'transactionDialog.txType',
  'sendStealthDialog.amountPlaceholder',
])

const placeholders = (text: string) =>
  (text.match(/\{\w+\}/g) ?? []).sort().join(',')

describe('locale completeness (ticket #274)', () => {
  it('fr-fr has exactly the keys en-us has, in every namespace', () => {
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort())
  })

  it('every fr-fr string keeps the same {placeholders} as its en-us source', () => {
    const drift = Object.keys(en).filter(
      key => key in fr && placeholders(en[key]) !== placeholders(fr[key]),
    )
    expect(drift).toEqual([])
  })

  it('no fr-fr string is identical to en-us unless it is an allow-listed cognate', () => {
    const untranslated = Object.keys(en).filter(
      key => fr[key] === en[key] && !SAME_IN_FRENCH.has(key),
    )
    expect(untranslated).toEqual([])
  })

  it('every allow-listed cognate really is still identical (the list cannot go stale)', () => {
    for (const key of SAME_IN_FRENCH) expect(fr[key]).toBe(en[key])
  })

  it('labels the wallet balance "Solde", not "Crédit"', () => {
    expect(fr['chatList.balance']).toBe('Solde')
  })
})

describe('translation keys used in the source', () => {
  const srcRoot = path.join(__dirname, '..')
  const walk = (dir: string): string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap(entry =>
        entry.isDirectory()
          ? walk(path.join(dir, entry.name))
          : [path.join(dir, entry.name)],
      )
  const sources = walk(srcRoot).filter(
    file => /\.(vue|ts)$/.test(file) && !/\.jest\.test\.ts$/.test(file),
  )
  const used = new Set<string>()
  for (const file of sources) {
    const text = fs.readFileSync(file, 'utf8')
    for (const match of text.matchAll(/\$t\(\s*'([\w.]+)'/g)) used.add(match[1])
  }
  // Keys assembled at runtime: ChatMessageSuffixButtons builds `chatMessage.${button}Message`.
  for (const button of ['reply', 'forward', 'info', 'delete']) {
    used.add(`chatMessage.${button}Message`)
  }

  it('finds the keys (sanity check that the scan reads real sources)', () => {
    expect(used.size).toBeGreaterThan(20)
    expect(used.has('chatMessage.failedToSend')).toBe(true)
  })

  it.each([...used].sort())('%s exists in en-us and fr-fr', key => {
    expect(en).toHaveProperty([key])
    expect(fr).toHaveProperty([key])
  })
})
