import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import {
  QwenBotStateStore,
  QwenResponseContext,
  QwenResponseRow,
} from './qwen-bot-state'
import { QwenResponseWorkflow } from './qwen-response-workflow'

const PEER = '0x52908400098527886E0F7030069857D2E4169EE7'
const context: QwenResponseContext = {
  botAddress: 'bot',
  fundingAddress: 'funding',
  networkTag: 'fixture',
  relayBaseUrl: 'http://127.0.0.1:1',
  stampValueWei: '1',
}
const input = {
  payloadHashHex: '01',
  senderAddress: PEER,
  senderPubKeyHex: '02',
  prompt: 'PROMPT_SENTINEL',
}
const receipt = { payloadHashHex: '03', txHashes: ['tx-fixture'] }
type ResponseBatch = (
  operations: Array<{ type: string; key: string; value: string }>,
  options: { sync: boolean },
) => Promise<void>
type ResponseDatabase = { batch: ResponseBatch }
let location: string
let state: QwenBotStateStore
let logs: string[]

beforeEach(async () => {
  location = mkdtempSync(join(tmpdir(), 'qwen-response-'))
  state = new QwenBotStateStore(location)
  await state.Open()
  logs = []
  jest.spyOn(console, 'log').mockImplementation((...args) => {
    logs.push(JSON.stringify(args))
  })
  jest.spyOn(console, 'warn').mockImplementation((...args) => {
    logs.push(JSON.stringify(args))
  })
})

afterEach(async () => {
  jest.restoreAllMocks()
  await state.Close()
  rmSync(location, { recursive: true, force: true })
})

async function reopen() {
  await state.Close()
  state = new QwenBotStateStore(location)
  await state.Open()
}

function workflow(overrides: Partial<QwenResponseContext> = {}) {
  const reply = jest.fn(async () => ({
    content: 'REPLY_SENTINEL',
    reasoning: 'REASONING_SENTINEL',
  }))
  const send = jest.fn(async () => receipt)
  return {
    reply,
    send,
    run: new QwenResponseWorkflow({
      state,
      context: { ...context, ...overrides },
      systemPrompt: 'SYSTEM_SENTINEL',
      generator: { reply },
      send,
    }),
  }
}

it('retains one conversation and bounded terminal records across 32/64 turns and reopen', async () => {
  for (const total of [32, 64]) {
    const current = workflow()
    for (let turn = total - 32; turn < total; turn++) {
      await current.run.respond({
        ...input,
        payloadHashHex: turn.toString(16).padStart(4, '0'),
      })
    }
    await reopen()
    const rows = Array.from(
      { length: total },
      (_, turn) => state.getResponse(turn.toString(16).padStart(4, '0'))!,
    )
    const retainedHistory = rows.reduce(
      (count, row) =>
        count +
        ((row as unknown as { proposedHistory?: unknown[] }).proposedHistory
          ?.length ?? 0),
      0,
    )
    expect(retainedHistory).toBe(0)
    expect(state.getConversation(PEER)).toHaveLength(2 * total + 1)
    const firstSize = JSON.stringify(rows[0]).length
    const replay = workflow()
    for (const row of rows) {
      expect(row).not.toHaveProperty('response')
      expect(JSON.stringify(row)).toHaveLength(firstSize)
      expect(await replay.run.resume(row.payloadHashHex)).toBe('duplicate')
      expect(state.hasProcessed(row.payloadHashHex)).toBe(true)
    }
    expect(replay.reply).not.toHaveBeenCalled()
    expect(replay.send).not.toHaveBeenCalled()
  }
})

it.each([
  'model-started',
  'response-ready',
  'send-started',
  'confirmed',
] as const)(
  'failed %s write cannot publish success or cause an unsafe second effect',
  async phase => {
    const db = (state as unknown as { openedDb: ResponseDatabase }).openedDb
    const batch = db.batch.bind(db)
    const batchSpy = jest.spyOn(db, 'batch').mockImplementation(((
      operations: Array<{ type: string; key: string; value: string }>,
      options: { sync: boolean },
    ) => {
      if (JSON.parse(operations[0].value).phase === phase)
        return Promise.reject(new Error('DISK_ERROR_BODY_SENTINEL'))
      return batch(operations, options)
    }) as typeof db.batch)
    const first = workflow()
    await expect(first.run.respond(input)).rejects.toThrow('persistence failed')
    expect(first.send).toHaveBeenCalledTimes(phase === 'confirmed' ? 1 : 0)
    expect(state.hasProcessed(input.payloadHashHex)).toBe(false)
    expect(state.getConversation(PEER)).toBeUndefined()
    expect(state.getResponse(input.payloadHashHex)?.phase).toBe(
      {
        'model-started': undefined,
        'response-ready': 'model-started',
        'send-started': 'response-ready',
        'confirmed': 'send-started',
      }[phase],
    )
    // The current process fails closed after any uncertain write, even on another peer.
    await expect(
      first.run.respond({
        ...input,
        payloadHashHex: '04',
        senderAddress: 'other',
      }),
    ).rejects.toThrow('storage unavailable')
    batchSpy.mockRestore()
    await reopen()
    expect(state.hasProcessed(input.payloadHashHex)).toBe(false)
    expect(state.getConversation(PEER)).toBeUndefined()
    const restart = workflow()
    if (phase !== 'model-started') {
      const result = await restart.run.resume(input.payloadHashHex)
      expect(result).toBe(phase === 'send-started' ? 'confirmed' : 'held')
      expect(restart.reply).not.toHaveBeenCalled()
      expect(restart.send).toHaveBeenCalledTimes(
        phase === 'send-started' ? 1 : 0,
      )
    }
    expect(logs.join()).not.toContain('SENTINEL')
  },
)

it('commits receipt, history and processed marker in one fsynced batch; replay has no effects', async () => {
  const db = (state as unknown as { openedDb: ResponseDatabase }).openedDb
  const batchSpy = jest.spyOn(db, 'batch')
  const first = workflow()
  expect(await first.run.respond(input)).toBe('confirmed')
  expect(batchSpy).toHaveBeenLastCalledWith(
    [
      expect.objectContaining({ type: 'put', key: 'response:v1:01' }),
      expect.objectContaining({
        type: 'put',
        key: `conversation:${PEER.toLowerCase()}`,
      }),
      { type: 'put', key: 'processed:01', value: '1' },
    ],
    { sync: true },
  )
  expect(state.getResponse('01')).toMatchObject({ phase: 'confirmed', receipt })
  const saved = state.getResponse('01') as Extract<
    QwenResponseRow,
    { phase: 'confirmed' }
  >
  saved.receipt.txHashes.push('mutation')
  expect(state.getResponse('01')).toMatchObject({ receipt })
  expect(saved).not.toHaveProperty('proposedHistory')
  expect(state.getConversation(PEER)?.[0].content).toBe('SYSTEM_SENTINEL')
  await reopen()
  const restart = workflow()
  expect(await restart.run.respond(input)).toBe('duplicate')
  expect(await restart.run.resume('01')).toBe('duplicate')
  expect(restart.reply).not.toHaveBeenCalled()
  expect(restart.send).not.toHaveBeenCalled()
  expect(state.getConversation(PEER)).toEqual([
    { role: 'system', content: 'SYSTEM_SENTINEL' },
    { role: 'user', content: 'PROMPT_SENTINEL' },
    { role: 'assistant', content: 'REPLY_SENTINEL' },
  ])
  expect(logs.join()).not.toContain('SENTINEL')
})

it('holds a send-started crash, blocks later turns for that peer across casing, and lets another peer progress', async () => {
  await state.beginResponse({ ...input, context })
  await state.saveResponse('01', 'REPLY_SENTINEL', [
    { role: 'assistant', content: 'REPLY_SENTINEL' },
  ])
  await state.startResponseSend('01')
  await reopen()
  const restart = workflow()
  expect(await restart.run.resume('01')).toBe('held')
  expect(
    await restart.run.respond({
      ...input,
      payloadHashHex: '04',
      senderAddress: PEER.toLowerCase(),
    }),
  ).toBe('held')
  expect(restart.reply).not.toHaveBeenCalled()
  expect(restart.send).not.toHaveBeenCalled()
  expect(state.hasProcessed('04')).toBe(false)
  expect(
    await restart.run.respond({
      ...input,
      payloadHashHex: '05',
      senderAddress: 'other',
    }),
  ).toBe('confirmed')
  expect(restart.send).toHaveBeenCalledTimes(1)
  expect(state.getConversation(PEER)).toBeUndefined()
  expect(logs.join()).toContain('send-outcome-unknown')
  expect(logs.join()).toContain('earlier-turn-unresolved')
  expect(logs.join()).not.toContain('SENTINEL')
})

it('holds a saved response if the sending account or policy changes', async () => {
  await state.beginResponse({ ...input, context })
  await state.saveResponse('01', 'REPLY_SENTINEL', [])
  await reopen()
  const restart = workflow({ fundingAddress: 'different-funding-account' })
  expect(await restart.run.resume('01')).toBe('held')
  expect(restart.reply).not.toHaveBeenCalled()
  expect(restart.send).not.toHaveBeenCalled()
  expect(state.getResponse('01')?.phase).toBe('response-ready')
  expect(logs.join()).toContain('account-or-send-context-changed')
})

it('recognizes legacy processed records without generating a new workflow', async () => {
  state.addProcessed('01')
  await reopen()
  const current = workflow()
  expect(await current.run.respond(input)).toBe('duplicate')
  expect(current.reply).not.toHaveBeenCalled()
  expect(current.send).not.toHaveBeenCalled()
  expect(state.getResponse('01')).toBeUndefined()
})

it.each(['response-ready', 'send-started', 'confirmed'] as const)(
  'a lost %s commit acknowledgement never publishes volatile success',
  async phase => {
    const db = (state as unknown as { openedDb: ResponseDatabase }).openedDb
    const batch = db.batch.bind(db)
    const batchSpy = jest.spyOn(db, 'batch').mockImplementation((async (
      operations,
      options,
    ) => {
      await batch(operations, options)
      if (JSON.parse(operations[0].value).phase === phase)
        throw new Error('lost disk acknowledgement')
    }) as typeof db.batch)
    const first = workflow()
    await expect(first.run.respond(input)).rejects.toThrow('persistence failed')
    expect(state.hasProcessed('01')).toBe(false)
    expect(state.getConversation(PEER)).toBeUndefined()
    batchSpy.mockRestore()
    await reopen()
    expect(state.getResponse('01')?.phase).toBe(phase)
    const restart = workflow()
    expect(await restart.run.resume('01')).toBe(
      {
        'response-ready': 'confirmed',
        'send-started': 'held',
        'confirmed': 'duplicate',
      }[phase],
    )
    expect(restart.reply).not.toHaveBeenCalled()
    expect(restart.send).toHaveBeenCalledTimes(
      phase === 'response-ready' ? 1 : 0,
    )
  },
)

it.each(['response-ready', 'send-started'] as const)(
  'retains %s after a process is killed without Close or flush',
  async phase => {
    await state.Close()
    const child = spawnSync(
      process.execPath,
      [
        '--require',
        require.resolve('tsx/cjs'),
        '-e',
        `
        const { QwenBotStateStore } = require(${JSON.stringify(
          join(__dirname, 'qwen-bot-state.ts'),
        )});
        (async () => {
          const state = new QwenBotStateStore(${JSON.stringify(location)});
          await state.Open();
          await state.beginResponse(${JSON.stringify({ ...input, context })});
          await state.saveResponse('01', 'REPLY_SENTINEL', [{ role: 'assistant', content: 'REPLY_SENTINEL' }]);
          ${
            phase === 'send-started'
              ? "await state.startResponseSend('01');"
              : ''
          }
          process.kill(process.pid, 'SIGKILL');
        })().catch(() => process.exit(2));
      `,
      ],
      {
        encoding: 'utf8',
        timeout: 15000,
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: join(__dirname, 'tsconfig.json'),
        },
      },
    )
    state = new QwenBotStateStore(location)
    await state.Open()
    expect({
      status: child.status,
      signal: child.signal,
      stderr: child.stderr,
    }).toEqual({
      status: null,
      signal: 'SIGKILL',
      stderr: '',
    })
    expect(state.getResponse('01')?.phase).toBe(phase)
    const restart = workflow()
    expect(await restart.run.resume('01')).toBe(
      phase === 'response-ready' ? 'confirmed' : 'held',
    )
    expect(restart.reply).not.toHaveBeenCalled()
    expect(restart.send).toHaveBeenCalledTimes(
      phase === 'response-ready' ? 1 : 0,
    )
  },
)
