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

// The table buy-in escrow suites need anvil, so they run in their own job.
const tableJob = workflow.split('\n  bot-table-escrow:\n')[1]?.split(/^  \S/m)[0] ?? ''
const tableNamed = tableJob
  .split('\n')
  .filter(line => line.includes('yarn workspace @frank/bot test'))
  .flatMap(line => line.match(/[\w./-]+\.jest\.test\.ts/g) ?? [])

describe('the table escrow bot suites hosted CI names', () => {
  it('fails the step when no anvil binary is found', () => {
    expect(tableJob).toContain('test -x "$ANVIL_BIN"')
  })

  it.each(tableNamed)('%s exists', name => {
    expect(existsSync(join(__dirname, name))).toBe(true)
  })

  it.each(['src/bots/table-htlc.anvil.jest.test.ts', 'src/bots/table-join.anvil.jest.test.ts'])(
    'runs %s',
    name => {
      expect(tableNamed).toContain(name)
    },
  )
})
