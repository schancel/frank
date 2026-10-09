/* eslint-env node */
// Safety net: no test in this package may ever read or write the developer's real home or a
// real bot state directory. Every test file starts with HOME and the bot state-dir variables
// pointed at a fresh throwaway directory (a test that needs a specific value still sets its own).
const { mkdtempSync } = require('fs')
const { tmpdir } = require('os')
const { join } = require('path')

const sandbox = mkdtempSync(join(tmpdir(), 'bot-jest-home-'))
process.env.HOME = sandbox
process.env.USERPROFILE = sandbox
for (const name of [
  'BOT_STATE_DIR',
  'BLACKJACK_BOT_STATE_DIR',
  'RAFFLE_BOT_STATE_DIR',
  'QWEN_BOT_STATE_DIR',
  'VENDOR_BOT_STATE_DIR',
  'FAUCET_STATE_DIR',
  'FRANK_DEMO_STATE_DIR',
]) {
  process.env[name] = join(sandbox, name.toLowerCase())
}
