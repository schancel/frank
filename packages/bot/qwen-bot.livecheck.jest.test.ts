import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { QwenBotStateStore } from './qwen-bot-state'

it('real CLI process confirms only receipt fields from a BigInt-bearing send result, polls again, and handles a second input', async () => {
  const location = mkdtempSync(join(tmpdir(), 'qwen-receipt-process-'))
  const run = () => {
    const child = spawnSync(
      process.execPath,
      [
        '--require',
        require.resolve('tsx/cjs'),
        join(__dirname, 'qwen-bot-process.fixture.ts'),
      ],
      {
        encoding: 'utf8',
        timeout: 15000,
        env: {
          PATH: process.env.PATH,
          TSX_TSCONFIG_PATH: join(__dirname, 'tsconfig.json'),
          QWEN_BOT_MODE: 'stub',
          QWEN_BOT_MAX_REPLIES: '0',
          QWEN_BOT_MAX_GREETINGS: '0',
          QWEN_BOT_IDLE_TIMEOUT_MS: '100',
          QWEN_BOT_POLL_INTERVAL_MS: '1',
          QWEN_BOT_MESSAGE_SINCE_MS: '0',
          QWEN_BOT_STATE_DIR: location,
          QWEN_BOT_WALLET_STATE_DIR: join(location, 'wallet'),
          QWEN_BOT_HANDOFF_JSON: join(location, 'handoff.json'),
          MONAD_TESTNET_HTTP_RPC_URL: 'http://127.0.0.1:1',
          FRANK_NETWORK_TAG: 'fixture',
          CASHWEB_STAMP_MIN_BURN_VALUE_WEI: '1',
        },
      },
    )
    const summary = child.stdout
      .split('\n')
      .find(line => line.startsWith('QWEN_PROCESS_FIXTURE '))
    return {
      child,
      summary: summary
        ? JSON.parse(summary.slice('QWEN_PROCESS_FIXTURE '.length))
        : undefined,
    }
  }
  try {
    const first = run()
    expect({ status: first.child.status, ...first.summary }).toMatchObject({
      status: 0,
      generations: 2,
      sends: 2,
      closed: 1,
    })
    expect(first.summary.polls).toBeGreaterThanOrEqual(3)
    const state = new QwenBotStateStore(location)
    await state.Open()
    try {
      for (const [index, id] of ['first', 'second'].entries()) {
        const hash = createHash('sha256').update(id).digest('hex')
        const row = state.getResponse(hash)
        expect(row?.phase).toBe('confirmed')
        if (row?.phase !== 'confirmed')
          throw new Error('Expected confirmed fixture row')
        expect(row.receipt).toEqual({
          payloadHashHex: `reply-${index + 1}`,
          txHashes: [`tx-${index + 1}`],
        })
        expect(state.hasProcessed(hash)).toBe(true)
      }
      expect(state.getConversation('0x' + 'cd'.repeat(20))).toHaveLength(5)
    } finally {
      await state.Close()
    }
    const restart = run()
    expect({ status: restart.child.status, ...restart.summary }).toMatchObject({
      status: 0,
      generations: 0,
      sends: 0,
      closed: 1,
    })
    for (const result of [first, restart]) {
      expect(result.child.stdout + result.child.stderr).not.toContain(
        'PROCESS_PROMPT_SENTINEL',
      )
      expect(result.child.stderr).not.toContain('QWEN BOT FAILED')
    }
  } finally {
    rmSync(location, { recursive: true, force: true })
  }
}, 20000)

const fixtureHash = (id: string) =>
  createHash('sha256').update(id).digest('hex')
function runInbound(location: string, scenario: string, crash?: string) {
  return spawnSync(
    process.execPath,
    [
      '--require',
      require.resolve('tsx/cjs'),
      join(__dirname, 'qwen-bot-process.fixture.ts'),
    ],
    {
      encoding: 'utf8',
      timeout: 15000,
      env: {
        PATH: process.env.PATH,
        TSX_TSCONFIG_PATH: join(__dirname, 'tsconfig.json'),
        QWEN_BOT_MODE: 'stub',
        QWEN_BOT_MAX_REPLIES: '0',
        QWEN_BOT_MAX_GREETINGS: '0',
        QWEN_BOT_IDLE_TIMEOUT_MS: '100',
        QWEN_BOT_POLL_INTERVAL_MS: '1',
        QWEN_BOT_MESSAGE_SINCE_MS: '0',
        QWEN_BOT_STATE_DIR: location,
        QWEN_BOT_WALLET_STATE_DIR: join(location, 'wallet'),
        QWEN_BOT_HANDOFF_JSON: join(location, 'handoff.json'),
        MONAD_TESTNET_HTTP_RPC_URL: 'http://127.0.0.1:1',
        FRANK_NETWORK_TAG: 'fixture',
        CASHWEB_STAMP_MIN_BURN_VALUE_WEI: '1',
        QWEN_PROCESS_SCENARIO: scenario,
        QWEN_PROCESS_CRASH: crash,
      },
    },
  )
}
function counters(child: ReturnType<typeof runInbound>) {
  const line = child.stdout
    .split('\n')
    .find(line => line.startsWith('QWEN_PROCESS_FIXTURE '))
  return line
    ? JSON.parse(line.slice('QWEN_PROCESS_FIXTURE '.length))
    : undefined
}

it('production CLI retains B behind held A across an empty-mailbox restart while independent C completes', async () => {
  const location = mkdtempSync(join(tmpdir(), 'qwen-inbound-process-'))
  try {
    const first = runInbound(location, 'held')
    expect({ status: first.status, ...counters(first) }).toMatchObject({
      status: 0,
      generations: 2,
      sends: 1,
    })
    let state = new QwenBotStateStore(location)
    await state.Open()
    try {
      expect(state.getResponse(fixtureHash('first'))?.phase).toBe(
        'model-started',
      )
      expect(state.getResponse(fixtureHash('other'))?.phase).toBe('confirmed')
      // Read the durable boundary directly so the exact regression runs on pre-inbox code.
      const retained = await (state as any).db
        .get('inbox:v1:' + fixtureHash('second'))
        .catch(() => undefined)
      expect(retained && JSON.parse(retained)).toMatchObject({
        phase: 'pending',
        payloadHashHex: fixtureHash('second'),
      })
      expect(state.pendingInbox().map(row => row.payloadHashHex)).toEqual([
        fixtureHash('second'),
      ])
      expect(state.getInboxScan().origin).toBe(0)
    } finally {
      await state.Close()
    }
    const second = runInbound(location, 'empty')
    expect({ status: second.status, ...counters(second) }).toMatchObject({
      status: 0,
      generations: 0,
      sends: 0,
    })
    state = new QwenBotStateStore(location)
    await state.Open()
    try {
      expect(state.pendingInbox().map(row => row.payloadHashHex)).toEqual([
        fixtureHash('second'),
      ])
    } finally {
      await state.Close()
    }
    for (const result of [first, second]) {
      expect(result.stdout + result.stderr).not.toMatch(
        /PROCESS_PROMPT_SENTINEL|MODEL_BODY_SENTINEL/,
      )
    }
  } finally {
    rmSync(location, { recursive: true, force: true })
  }
}, 20000)

it.each(['page', 'model', 'confirmation'])(
  'SIGKILL immediately after synced %s commit survives without Close/flush',
  async boundary => {
    const location = mkdtempSync(join(tmpdir(), 'qwen-inbound-kill-'))
    try {
      const killed = runInbound(location, 'one', boundary)
      expect(killed.signal).toBe('SIGKILL')
      const state = new QwenBotStateStore(location)
      await state.Open()
      try {
        expect(state.getInboxScan().revision).toBe(1)
        expect(state.pendingInbox()).toHaveLength(boundary === 'page' ? 1 : 0)
        expect(state.getResponse(fixtureHash('first'))?.phase).toBe(
          boundary === 'page'
            ? undefined
            : boundary === 'model'
            ? 'model-started'
            : 'confirmed',
        )
        expect(state.hasProcessed(fixtureHash('first'))).toBe(
          boundary === 'confirmation',
        )
      } finally {
        await state.Close()
      }
      const restarted = runInbound(location, 'empty')
      expect({
        status: restarted.status,
        ...counters(restarted),
      }).toMatchObject({
        status: 0,
        generations: boundary === 'page' ? 1 : 0,
        sends: boundary === 'page' ? 1 : 0,
      })
      const replay = runInbound(location, 'one')
      expect({ status: replay.status, ...counters(replay) }).toMatchObject({
        status: 0,
        generations: 0,
        sends: 0,
      })
    } finally {
      rmSync(location, { recursive: true, force: true })
    }
  },
  20000,
)

it('a competing CLI process cannot open the same Level root or run another drain', async () => {
  const location = mkdtempSync(join(tmpdir(), 'qwen-inbound-lock-'))
  const state = new QwenBotStateStore(location)
  await state.Open()
  try {
    const child = runInbound(location, 'one')
    expect({ status: child.status, ...counters(child) }).toMatchObject({
      status: 1,
      generations: 0,
      sends: 0,
    })
  } finally {
    await state.Close()
    rmSync(location, { recursive: true, force: true })
  }
})
