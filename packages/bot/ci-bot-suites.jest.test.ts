import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

// Jest treats these arguments as filters: an obsolete name can silently remove coverage.
// Pin the retained suites and the current host/plugin successors, not the deleted Qwen loop.
const workflow = readFileSync(
  join(__dirname, '..', '..', '.github', 'workflows', 'app-lint-and-test.yml'),
  'utf8',
)
const botJob = workflow.split('\n  bot-demo-suites:\n')[1]?.split(/^  \S/m)[0] ?? ''
const commands = botJob.split('\n').filter(line =>
  line.includes('yarn workspace @frank/bot test'),
)
const named = commands.flatMap(line => line.match(/[\w./-]+\.jest\.test\.ts/g) ?? [])

describe('the bot suites hosted CI names', () => {
  it('runs the launcher and complete framework suites', () => {
    expect(commands.some(line => /\bdemo\//.test(line))).toBe(true)
    expect(botJob).toContain('yarn workspace @frank/bot-framework test --ci --runInBand')
  })

  it.each(named)('%s exists', name => {
    expect(existsSync(join(__dirname, name))).toBe(true)
  })

  it.each([
    'qwen-host-safety.jest.test.ts',
    'qwen-reply.jest.test.ts',
    'bot-state-dir.jest.test.ts',
    'src/bots/qwen-bot.jest.test.ts',
    'src/bots/blackjack-host.jest.test.ts',
    'ci-bot-suites.jest.test.ts',
  ])('runs retained/current coverage in %s', name => {
    expect(named).toContain(name)
  })
})
