/** @jest-environment jsdom */

import fs from 'fs'
import path from 'path'

describe('Chat page bottom bar alignment and message bubble styling (#1043)', () => {
  const sfc = fs.readFileSync(path.join(__dirname, 'Chat.vue'), 'utf8')

  it('aligns chat input bar container min-height (64px) with sidebar balance footer', () => {
    expect(sfc).toMatch(/<q-footer[^>]*:height-hint="64"/)
    expect(sfc).toMatch(/<q-footer[^>]*class="[^"]*chat-footer/)
    expect(sfc).toMatch(
      /\.chat-footer,\s*\.chat-input-bar\s*\{[^}]*min-height:\s*64px/,
    )
    expect(sfc).toMatch(
      /\.chat-footer,\s*\.chat-input-bar\s*\{[^}]*box-sizing:\s*border-box/,
    )
  })

  it('prevents send button clipping with overflow visible and vertical centering', () => {
    expect(sfc).toMatch(
      /:deep\(\.chat-input-toolbar\)\s*\{[^}]*min-height:\s*64px/,
    )
    expect(sfc).toMatch(
      /:deep\(\.chat-input-toolbar\)\s*\{[^}]*align-items:\s*center/,
    )
    expect(sfc).toMatch(
      /:deep\(\.chat-input-toolbar\)\s*\{[^}]*overflow:\s*visible/,
    )
    expect(sfc).toMatch(
      /:deep\(\.chat-send-btn\)\s*\{[^}]*align-self:\s*center/,
    )
  })

  it('refines chat message bubbles corner radius matching the signet theme preview', () => {
    expect(sfc).toMatch(
      /:deep\(\)\s*\.q-message-text--sent\s*\{[^}]*border-radius:\s*18px 18px 4px 18px\s*!important/,
    )
    expect(sfc).toMatch(
      /:deep\(\)\s*\.q-message-text--received\s*\{[^}]*border-radius:\s*18px 18px 18px 4px\s*!important/,
    )
  })
})
