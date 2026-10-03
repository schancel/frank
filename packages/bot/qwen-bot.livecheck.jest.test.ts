import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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
        const hash = Buffer.from(id).toString('hex')
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
      expect(state.getConversation('peer')).toHaveLength(5)
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
