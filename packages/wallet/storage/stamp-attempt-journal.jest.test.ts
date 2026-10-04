import {
  LevelStampAttemptJournal,
  OutgoingStampAttempt,
} from './stamp-attempt-journal'

it('persists an exact outgoing attempt across restart until deletion', async () => {
  const os = await import('os')
  const path = await import('path')
  const fs = await import('fs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-attempt-journal-'))
  const attempt: OutgoingStampAttempt = {
    payloadHashHex: 'ab'.repeat(32),
    messageBytes: [1, 2, 3],
    leaseIndices: [4, 7],
  }
  try {
    const first = new LevelStampAttemptJournal(dir)
    await first.Open()
    await first.put(attempt)
    await first.Close()

    const reopened = new LevelStampAttemptJournal(dir)
    await reopened.Open()
    expect(reopened.getAll()).toEqual([attempt])
    await reopened.delete(attempt.payloadHashHex)
    expect(reopened.getAll()).toEqual([])
    await reopened.Close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

it('C0 retains the other exact obligation when one owner is deleted and disk is reopened', async () => {
  const fs = await import('fs')
  const os = await import('os')
  const path = await import('path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c0-attempt-owners-'))
  const attempts: OutgoingStampAttempt[] = [
    {
      payloadHashHex: 'ab'.repeat(32),
      messageBytes: [0, 255, 17],
      leaseIndices: [4, 7],
    },
    {
      payloadHashHex: 'cd'.repeat(32),
      messageBytes: [255, 0, 18],
      leaseIndices: [9, 11],
    },
  ]
  let journal = new LevelStampAttemptJournal(dir)
  let opened = false
  try {
    await journal.Open()
    opened = true
    for (const attempt of attempts) await journal.put(attempt)
    await journal.delete(attempts[0].payloadHashHex)
    await journal.Close()
    opened = false
    journal = new LevelStampAttemptJournal(dir)
    await journal.Open()
    opened = true
    expect(journal.getAll()).toEqual([attempts[1]])
    await journal.delete(attempts[0].payloadHashHex)
    expect(journal.getAll()).toEqual([attempts[1]])
  } finally {
    if (opened) await journal.Close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

import level, { type LevelDB } from 'level'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { Wallet, Transaction, getBytes } from 'ethers'
import {
  cborMap,
  decodeCanonical,
  encodeFrame,
  fromHex,
  parseFrame,
  toHex,
} from '@frank/codec'
import {
  freezeCanonicalRequest,
  type CanonicalExactRequest,
} from '@frank/cashweb/relay/canonical-dm-transport'
import corpus from '../../../docs/protocol/cbor/vectors/dm-runtime.json'
import {
  LevelCanonicalStampAttemptJournal,
  type CanonicalAttemptCorrelation,
  type CanonicalAttemptTerminal,
  type CanonicalJournalAttempt,
  type CanonicalPreparedAttempt,
} from './stamp-attempt-journal'

const wire = corpus.canonical_facade_final_http_case.wire

/** Captured suite-1 ciphertext/context plus a synthetic offline signed transaction. No admitted
 * Current, chain receipt or network/payment effect is fabricated by this storage fixture. */
type FixtureWire = Pick<
  typeof wire,
  | 'network'
  | 'payload'
  | 'context'
  | 't3'
  | 'sender_t1'
  | 'recipient_t1'
  | 'destination'
  | 't4'
>
async function canonicalFixture(
  index = 0,
  boundary = 'journal-frozen-boundary',
  captured: FixtureWire = wire,
) {
  const payload = fromHex(captured.payload),
    context = fromHex(captured.context)
  const decodedContext = decodeCanonical(context) as Map<
    bigint,
    Map<bigint, Uint8Array>
  >
  const stampKey = decodedContext.get(8n)!.get(1n)!
  const parsed = parseFrame(payload)
  if (parsed.kind !== 'parsed' || parsed.typed?.type !== 5)
    throw new Error('fixture payload')
  const signer = new Wallet('0x' + '19'.repeat(32))
  const raw = await signer.signTransaction({
    chainId: 10143,
    type: 2,
    nonce: index,
    to: '0x' + captured.destination,
    value: 1n,
    gasLimit: 100000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
    data: '0x' + captured.t4,
  })
  const tx = Transaction.from(raw)
  const delivery = encodeFrame(
    { typeId: 1, schemaVersion: 1, minReaderVersion: 1 },
    cborMap([
      [0, captured.network],
      [
        1,
        cborMap([
          [0, 1],
          [1, stampKey],
        ]),
      ],
      [2, payload],
      [3, fromHex(captured.t3)],
      [
        4,
        [
          cborMap([
            [0, 0],
            [1, getBytes(tx.hash!)],
            [2, new Uint8Array(32).fill(0).map((_, i) => (i === 31 ? 1 : 0))],
            [3, fromHex(captured.destination)],
            [4, fromHex(captured.t4)],
          ]),
        ],
      ],
    ]),
  )
  const request = freezeCanonicalRequest(
    { delivery, context, transactions: [getBytes(raw)] },
    `${boundary}-${index}`,
  )
  const prepared: CanonicalPreparedAttempt = {
    walletBindingId: 'wallet-test',
    accountId: 'account-test',
    chainId: '10143',
    network: captured.network,
    senderSubject: toHex(parsed.typed.sender.keyBytes),
    recipientSubject: toHex(parsed.typed.recipient.keyBytes),
    senderT1: captured.sender_t1,
    recipientT1: captured.recipient_t1,
    payload,
    context,
    economicBinding: Uint8Array.of(0xa1, 0, 1),
  }
  return {
    prepared,
    request,
    reservations: [{ id: `reservation-${index}`, index }],
    consumerId: `workflow-${index}`,
  }
}

function correlation(
  attempt: CanonicalJournalAttempt,
): CanonicalAttemptCorrelation {
  return {
    attemptRef: attempt.attemptRef,
    prepared: attempt.prepared,
    request: attempt.request,
    reservations: attempt.reservations,
    consumerId: attempt.consumerId,
  }
}

function delivered(
  request: CanonicalExactRequest,
): Extract<CanonicalAttemptTerminal, { phase: 'delivered' }> {
  return {
    version: 1,
    phase: 'delivered',
    identity: request.identity,
    mailbox_committed_at_ms: 1234,
  }
}

function database(journal: LevelCanonicalStampAttemptJournal): LevelDB {
  // Probe the actual opened Level completion boundary, rather than replacing the journal API.
  return (journal as unknown as { database: LevelDB }).database
}

function barrier() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function withCanonicalJournal(
  run: (
    journal: LevelCanonicalStampAttemptJournal,
    location: string,
  ) => Promise<void>,
  limits = {},
) {
  const location = await mkdtemp(join(tmpdir(), 'canonical-stamp-journal-'))
  const journal = new LevelCanonicalStampAttemptJournal(location, limits)
  await journal.Open()
  try {
    await run(journal, location)
  } finally {
    await journal.Close()
    await rm(location, { recursive: true, force: true })
  }
}

describe('canonical exact-attempt storage', () => {
  it.each(['release', 'reject'] as const)(
    'waits for the real Level completion before the producer may submit: %s',
    async outcome => {
      await withCanonicalJournal(async journal => {
        const fixture = await canonicalFixture()
        const db = database(journal),
          original = db.batch.bind(db),
          entered = barrier(),
          gate = barrier()
        const spy = jest.spyOn(db, 'batch').mockImplementation(((
          ...args: unknown[]
        ) => {
          entered.resolve()
          return gate.promise.then(() =>
            (original as (...args: unknown[]) => Promise<unknown>)(...args),
          )
        }) as never)
        const networkEffect = jest.fn()
        const producing = journal.prepare(fixture).then(networkEffect)
        const observed = producing.then(
          () => null,
          error => error,
        )
        await entered.promise
        expect(journal.getAll()).toEqual([])
        expect(networkEffect).not.toHaveBeenCalled()
        if (outcome === 'reject')
          gate.reject(new Error('underlying Level write failed'))
        else gate.resolve()
        const error = await observed
        spy.mockRestore()
        if (outcome === 'reject') {
          expect(error?.message).toContain('underlying Level write failed')
          expect(() => journal.getAll()).toThrow('corrupt')
          expect(networkEffect).not.toHaveBeenCalled()
        } else {
          expect(error).toBeNull()
          expect(networkEffect).toHaveBeenCalledTimes(1)
          expect(journal.lookup(fixture.prepared)?.request.body).toEqual(
            fixture.request.body,
          )
        }
        await journal.Close()
        await journal.Open()
        expect(journal.getAll()).toHaveLength(outcome === 'release' ? 1 : 0)
        expect(journal.reconcile([]).every(row => row.state === 'hold')).toBe(
          true,
        )
      })
    },
  )

  it('serializes idempotent producers, snapshots caller bytes and rejects alternate raw sets or multipart boundaries', async () => {
    await withCanonicalJournal(async journal => {
      const fixture = await canonicalFixture()
      const saved = new Uint8Array(fixture.request.body)
      const first = journal.prepare(fixture),
        second = journal.prepare(fixture)
      fixture.request.body.fill(0)
      fixture.prepared.economicBinding.fill(9)
      const [a, b] = await Promise.all([first, second])
      expect(a.attemptRef).toBe(b.attemptRef)
      expect(a.request.body).toEqual(saved)
      expect(journal.getAll()).toHaveLength(1)
      a.request.body.fill(0)
      a.prepared.payload.fill(0)
      expect(journal.getAll()[0].request.body).toEqual(saved)
      const boundaryChanged = await canonicalFixture(0, 'different-boundary')
      await expect(journal.prepare(boundaryChanged)).rejects.toThrow('conflict')
      const anotherRawSet = await canonicalFixture(1)
      await expect(journal.prepare(anotherRawSet)).rejects.toThrow('conflict')
      const original = await canonicalFixture()
      expect(journal.lookup(original.prepared)?.attemptRef).toBe(b.attemptRef)
      expect(() =>
        journal.lookup({
          ...original.prepared,
          economicBinding: Uint8Array.of(1),
        }),
      ).toThrow('conflict')
    })
  })

  it('holds missing, orphan, mismatched and ambiguous correlation and grants only explicit one-shot replay', async () => {
    await withCanonicalJournal(async journal => {
      const row = await journal.prepare(await canonicalFixture()),
        match = correlation(row)
      expect(journal.reconcile([])).toEqual([
        { attemptRef: row.attemptRef, state: 'hold', reason: 'orphan' },
      ])
      expect(
        journal.reconcile([
          { ...match, attemptRef: 'canonical-v1:0000000000000999' },
        ]),
      ).toEqual([
        { attemptRef: row.attemptRef, state: 'hold', reason: 'orphan' },
        {
          attemptRef: 'canonical-v1:0000000000000999',
          state: 'hold',
          reason: 'missing',
        },
      ])
      expect(
        journal.reconcile([{ ...match, consumerId: 'other-workflow' }])[0],
      ).toMatchObject({ state: 'hold', reason: 'mismatch' })
      expect(journal.reconcile([match, match])[0]).toMatchObject({
        state: 'hold',
        reason: 'ambiguous',
      })
      await expect(
        journal.beginReplay({ attemptRef: row.attemptRef }),
      ).rejects.toThrow('replay')
      const ready = journal.reconcile([match])[0]
      if (ready.state !== 'ready') throw new Error('not ready')
      expect(
        (await journal.beginReplay(ready.eligibility)).request.body,
      ).toEqual(row.request.body)
      await expect(journal.beginReplay(ready.eligibility)).rejects.toThrow(
        'replay',
      )
      const concurrent = journal.reconcile([match])[0]
      if (concurrent.state !== 'ready') throw new Error('not ready')
      await expect(journal.beginReplay(concurrent.eligibility)).rejects.toThrow(
        'replay',
      )
      journal.endReplay(ready.eligibility)
      const stale = journal.reconcile([match])[0]
      if (stale.state !== 'ready') throw new Error('not ready')
      journal.reconcile([])
      await expect(journal.beginReplay(stale.eligibility)).rejects.toThrow(
        'replay',
      )
      const priorOpen = journal.reconcile([match])[0]
      if (priorOpen.state !== 'ready') throw new Error('not ready')
      await journal.Close()
      await journal.Open()
      await expect(journal.beginReplay(priorOpen.eligibility)).rejects.toThrow(
        'replay',
      )
    })
  })

  it('persists terminal evidence before permitting cleanup, preserves it on reopen and refuses foreign/retained results', async () => {
    await withCanonicalJournal(async journal => {
      const fixture = await canonicalFixture(),
        row = await journal.prepare(fixture)
      await expect(journal.completeCleanup(row.attemptRef)).rejects.toThrow(
        'cleanup',
      )
      await expect(
        journal.recordTerminal(row.attemptRef, {
          ...delivered(row.request),
          identity: {
            ...row.request.identity,
            submission_identity: 'ab'.repeat(32),
          },
        }),
      ).rejects.toThrow()
      await expect(
        journal.recordTerminal(row.attemptRef, {
          version: 1,
          phase: 'retained',
          identity: row.request.identity,
        } as unknown as CanonicalAttemptTerminal),
      ).rejects.toThrow()
      const db = database(journal),
        original = db.put.bind(db),
        entered = barrier(),
        gate = barrier()
      const spy = jest.spyOn(db, 'put').mockImplementation(((
        ...args: unknown[]
      ) => {
        entered.resolve()
        return gate.promise.then(() =>
          (original as (...args: unknown[]) => Promise<unknown>)(...args),
        )
      }) as never)
      const completion = journal.recordTerminal(
        row.attemptRef,
        delivered(row.request),
      )
      await entered.promise
      expect(journal.getAll()[0].terminal).toBeNull()
      expect(journal.getAll()[0].cleanupComplete).toBe(false)
      gate.resolve()
      await completion
      spy.mockRestore()
      await journal.Close()
      await journal.Open()
      const reopened = journal.lookup(fixture.prepared)!
      expect(reopened.terminal).toEqual(delivered(row.request))
      expect(reopened.cleanupComplete).toBe(false)
      expect(journal.reconcile([correlation(reopened)])[0]).toMatchObject({
        state: 'terminal',
      })
      await expect(
        journal.acknowledge(row.attemptRef, fixture.consumerId),
      ).rejects.toThrow('cleanup')
      await journal.completeCleanup(row.attemptRef)
      await expect(
        journal.acknowledge(row.attemptRef, 'foreign-workflow'),
      ).rejects.toThrow('cleanup')
      await expect(
        journal.recordTerminal(row.attemptRef, {
          ...delivered(row.request),
          mailbox_committed_at_ms: 9999,
        }),
      ).rejects.toThrow('conflict')
      await journal.acknowledge(row.attemptRef, fixture.consumerId)
      expect(journal.getAll()).toEqual([])
    })
  })

  it('retains out-of-order acknowledged results under backpressure until the linked frontier advances', async () => {
    await withCanonicalJournal(
      async journal => {
        const one = await canonicalFixture(),
          first = await journal.prepare(one)
        // Distinct prepared envelope/recipient identity, using a distinct captured suite-1 corpus.
        // Changing policy/account alone must NOT create another financial attempt for the same T3.
        const other = await canonicalFixture(
          1,
          'second-envelope',
          corpus.canonical_facade_browser_case,
        )
        const second = await journal.prepare(other)
        await journal.recordTerminal(
          second.attemptRef,
          delivered(second.request),
        )
        await journal.completeCleanup(second.attemptRef)
        await journal.acknowledge(second.attemptRef, second.consumerId)
        expect(journal.getAll()).toHaveLength(2)
        expect(journal.getAll()[1].acknowledged).toBe(true)
        await journal.Close()
        await journal.Open()
        expect(journal.getAll()).toHaveLength(2)
        const archivedVector = corpus.runtime_case
        const third = await canonicalFixture(2, 'third-envelope', {
          ...archivedVector,
          network: corpus.network,
          sender_t1: archivedVector.t1,
          recipient_t1: archivedVector.t1,
          destination: corpus.destinations[0].address,
        })
        await expect(journal.prepare(third)).rejects.toThrow('capacity')
        await journal.recordTerminal(first.attemptRef, delivered(first.request))
        await journal.completeCleanup(first.attemptRef)
        await journal.acknowledge(first.attemptRef, first.consumerId)
        expect(journal.getAll()).toEqual([])
        const next = await journal.prepare(one)
        expect(next.attemptRef).toBe('canonical-v1:0000000000000003')
      },
      { maxRecords: 2 },
    )
    await withCanonicalJournal(
      async journal => {
        await expect(journal.prepare(await canonicalFixture())).rejects.toThrow(
          'capacity',
        )
        expect(journal.getAll()).toEqual([])
      },
      { maxBytes: 1 },
    )
  })

  it('fails closed on a corrupted request while preserving the untouched legacy namespace', async () => {
    await withCanonicalJournal(async (journal, location) => {
      const legacy = new LevelStampAttemptJournal(location),
        record = {
          payloadHashHex: 'ab'.repeat(32),
          messageBytes: [1, 2],
          leaseIndices: [9],
        }
      await legacy.Open()
      await legacy.put(record)
      await legacy.Close()
      const row = await journal.prepare(await canonicalFixture())
      await journal.Close()
      const db = level(join(location, 'canonical-stamp-attempts-v1'))
      const key = 'attempt:0000000000000001',
        saved = JSON.parse(await db.get(key))
      saved.request.contentType = 'application/x-protobuf'
      await db.put(key, JSON.stringify(saved), { sync: true })
      await db.close()
      await expect(journal.Open()).rejects.toThrow('corrupt')
      await legacy.Open()
      expect(legacy.getAll()).toEqual([record])
      await legacy.Close()
      const repair = level(join(location, 'canonical-stamp-attempts-v1'))
      saved.request.contentType = row.request.contentType
      await repair.put(key, JSON.stringify(saved), { sync: true })
      await repair.close()
      await journal.Open()
      expect(journal.getAll()[0].attemptRef).toBe(row.attemptRef)
    })
  })

  it.each(['pending', 'terminal'] as const)(
    'reopens exact %s state after a durable child barrier and SIGKILL without clean Close',
    async phase => {
      await withCanonicalJournal(async (journal, location) => {
        const fixture = await canonicalFixture()
        await journal.Close()
        const moduleUrl = pathToFileURL(
          join(__dirname, 'stamp-attempt-journal.ts'),
        ).href
        const child = spawn(
          process.execPath,
          [
            '--import',
            'tsx',
            '--input-type=module',
            '-e',
            `
        import { LevelCanonicalStampAttemptJournal } from ${JSON.stringify(
          moduleUrl,
        )};
        import { restoreCanonicalRequest } from '@frank/cashweb/relay/canonical-dm-transport';
        const input=JSON.parse(process.env.CANONICAL_JOURNAL_FIXTURE);
        const prepared={...input.prepared};
        for(const k of ['payload','context','economicBinding']) prepared[k]=new Uint8Array(Buffer.from(prepared[k],'base64'));
        const request=restoreCanonicalRequest({body:new Uint8Array(Buffer.from(input.body,'base64')),contentType:input.contentType});
        const journal=new LevelCanonicalStampAttemptJournal(process.env.CANONICAL_JOURNAL_LOCATION);
        await journal.Open();
        const row=await journal.prepare({prepared,request,reservations:input.reservations,consumerId:input.consumerId});
        if(process.env.CANONICAL_JOURNAL_PHASE==='terminal') await journal.recordTerminal(row.attemptRef,{version:1,phase:'delivered',identity:request.identity,mailbox_committed_at_ms:1234});
        console.log('DURABLE '+row.attemptRef); setInterval(()=>{},1000);
      `,
          ],
          {
            cwd: join(__dirname, '../../..'),
            env: {
              ...process.env,
              CANONICAL_JOURNAL_LOCATION: location,
              CANONICAL_JOURNAL_PHASE: phase,
              CANONICAL_JOURNAL_FIXTURE: JSON.stringify({
                prepared: {
                  ...fixture.prepared,
                  payload: Buffer.from(fixture.prepared.payload).toString(
                    'base64',
                  ),
                  context: Buffer.from(fixture.prepared.context).toString(
                    'base64',
                  ),
                  economicBinding: Buffer.from(
                    fixture.prepared.economicBinding,
                  ).toString('base64'),
                },
                body: Buffer.from(fixture.request.body).toString('base64'),
                contentType: fixture.request.contentType,
                reservations: fixture.reservations,
                consumerId: fixture.consumerId,
              }),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
        let stderr = '',
          output = ''
        child.stderr!.on('data', chunk => {
          stderr += chunk.toString()
        })
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () =>
                reject(new Error(`child durable barrier timeout: ${stderr}`)),
              10000,
            )
            child.on('error', error => {
              clearTimeout(timer)
              reject(error)
            })
            child.on('exit', code => {
              clearTimeout(timer)
              reject(new Error(`child exited ${code}: ${stderr}`))
            })
            child.stdout!.on('data', chunk => {
              output += chunk.toString()
              if (output.includes('DURABLE ')) {
                clearTimeout(timer)
                resolve()
              }
            })
          })
        } finally {
          const exit = new Promise<void>(resolve => {
            if (child.exitCode !== null || child.signalCode !== null) resolve()
            else child.once('exit', () => resolve())
          })
          if (child.exitCode === null && child.signalCode === null)
            child.kill('SIGKILL')
          await exit
          await journal.Open()
        }
        const row = journal.lookup(fixture.prepared)!
        expect(row.request.body).toEqual(fixture.request.body)
        expect(row.request.contentType).toBe(fixture.request.contentType)
        expect(row.terminal).toEqual(
          phase === 'terminal' ? delivered(row.request) : null,
        )
        expect(row.cleanupComplete).toBe(false)
        await expect(
          journal.beginReplay({ attemptRef: row.attemptRef }),
        ).rejects.toThrow('replay')
      })
    },
    20000,
  )
})
