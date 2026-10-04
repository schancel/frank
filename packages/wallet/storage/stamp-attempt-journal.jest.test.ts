import { canonicalStampDestination } from '@frank/cashweb/relay/canonical-dm-stamp'
import { inspectCanonicalPreparedEnvelope } from '../monad-stamp-stealth'
import { paymentCommitment } from '@frank/codec'
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
import { durablePut } from './level-durability'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import {
  Wallet,
  Transaction,
  getBytes,
  sha256,
  toUtf8Bytes,
  hexlify,
} from 'ethers'
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

type ProbeLevelDB = LevelDB & { batch(...args: unknown[]): Promise<unknown> }
function database(journal: LevelCanonicalStampAttemptJournal): ProbeLevelDB {
  // Probe the actual opened Level completion boundary, rather than replacing the journal API.
  return (journal as unknown as { database: ProbeLevelDB }).database
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

  it('holds after a committed-but-rejected storage callback and finds the original attempt on reopen', async () => {
    await withCanonicalJournal(async journal => {
      const fixture = await canonicalFixture()
      const db = database(journal),
        original = db.batch.bind(db)
      const spy = jest.spyOn(db, 'batch').mockImplementation((async (
        ...args: unknown[]
      ) => {
        await original(...args)
        throw new Error('completion became uncertain after commit')
      }) as never)
      const networkEffect = jest.fn()
      await expect(
        journal.prepare(fixture).then(networkEffect),
      ).rejects.toThrow('completion became uncertain')
      spy.mockRestore()
      expect(networkEffect).not.toHaveBeenCalled()
      expect(() => journal.prepare(fixture)).toThrow('corrupt')
      await journal.Close()
      await journal.Open()
      const retained = journal.lookup(fixture.prepared)!
      expect(retained.request.body).toEqual(fixture.request.body)
      expect((await journal.prepare(fixture)).attemptRef).toBe(
        retained.attemptRef,
      )
      expect(journal.getAll()).toHaveLength(1)
    })
  })

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
      await durablePut(db, key, JSON.stringify(saved))
      await db.close()
      await expect(journal.Open()).rejects.toThrow('corrupt')
      await legacy.Open()
      expect(legacy.getAll()).toEqual([record])
      await legacy.Close()
      const repair = level(join(location, 'canonical-stamp-attempts-v1'))
      saved.request.contentType = row.request.contentType
      await durablePut(repair, key, JSON.stringify(saved))
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
              TSX_TSCONFIG_PATH: join(__dirname, '../../bot/tsconfig.json'),
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
        expect(child.signalCode).toBe('SIGKILL')
        expect(child.exitCode).toBeNull()
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

async function unsignedIntentFixture(
  journal: LevelCanonicalStampAttemptJournal,
) {
  const fixture = await canonicalFixture()
  const tx = Transaction.from(hexlify(fixture.request.parts.transactions[0]))
  const tuple = JSON.stringify({
    version: 1,
    domain: 'frank-canonical-wallet-binding-v1',
    network: fixture.prepared.network,
    chainId: fixture.prepared.chainId,
    auth: `0x${fixture.prepared.senderSubject}`,
    main: '0x' + '11'.repeat(20),
  })
  await journal.bindPublicTuple(tuple)
  const prepared = {
    ...fixture.prepared,
    walletBindingId: sha256(toUtf8Bytes(tuple)).slice(2),
    accountId: JSON.parse(tuple).main,
  }
  const input = {
    prepared,
    consumerId: fixture.consumerId,
    boundary: fixture.request.contentType.slice(
      'multipart/form-data; boundary='.length,
    ),
    construction: Uint8Array.of(1),
    members: [
      {
        reservation: fixture.reservations[0],
        from: tx.from!.toLowerCase(),
        unsignedSerialized: tx.unsignedSerialized,
        rawTx: null,
      },
    ],
  }
  return { fixture, input, raw: tx.serialized }
}

async function recoveryStorageFixture(
  journal: LevelCanonicalStampAttemptJournal,
  count = 1,
  valueWei = 1n,
) {
  const fixture = await canonicalFixture()
  const envelope = inspectCanonicalPreparedEnvelope(
    fixture.prepared.payload,
    fixture.prepared.context,
  )
  const digest = fromHex(wire.t3)
  const payments = [],
    transactions = []
  for (let childIndex = 0; childIndex < count; childIndex++) {
    const destination = canonicalStampDestination({
      network: wire.network,
      stampKey: envelope.stampKey,
      sharedPoint: envelope.payload.sharedPoint,
      childIndex,
    })
    const commitment = paymentCommitment(digest, childIndex)
    const raw = await new Wallet('0x' + '19'.repeat(32)).signTransaction({
      type: 2,
      chainId: 10143n,
      nonce: childIndex,
      value: valueWei,
      to: '0x' + toHex(destination.address),
      gasLimit: 100000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
      data: '0x504f4e4401' + toHex(commitment),
    })
    const tx = Transaction.from(raw)
    transactions.push(getBytes(raw))
    payments.push(
      cborMap([
        [0, childIndex],
        [1, getBytes(tx.hash!)],
        [2, getBytes('0x' + valueWei.toString(16).padStart(64, '0'))],
        [3, destination.address],
        [4, commitment],
      ]),
    )
  }
  const delivery = encodeFrame(
    { typeId: 1, schemaVersion: 1, minReaderVersion: 1 },
    cborMap([
      [0, wire.network],
      [
        1,
        cborMap([
          [0, 1],
          [1, envelope.stampKey.keyBytes],
        ]),
      ],
      [2, fixture.prepared.payload],
      [3, digest],
      [4, payments],
    ]),
  )
  const obligationId = 'cd'.repeat(32)
  const request = freezeCanonicalRequest(
    { delivery, context: fixture.prepared.context, transactions },
    `frank-recovery-${obligationId.slice(0, 32)}`,
  )
  const tuple = JSON.stringify({
    version: 1,
    domain: 'frank-canonical-wallet-binding-v1',
    network: wire.network,
    chainId: '10143',
    auth: '0x' + fixture.prepared.recipientSubject,
    main: '0x' + '11'.repeat(20),
  })
  await journal.bindPublicTuple(tuple)
  return {
    obligationId,
    request,
    walletBindingId: sha256(toUtf8Bytes(tuple)).slice(2),
    confirmedChildren: transactions.map((_, i) => i),
    lifecycle: 'terminal:expired',
    stampGeneration: '0',
  }
}

describe('durable unsigned canonical intent', () => {
  it.each(['release', 'reject'] as const)(
    'waits for actual database intent completion before caller can acquire or sign: %s',
    async outcome => {
      await withCanonicalJournal(async journal => {
        const { input } = await unsignedIntentFixture(journal)
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
        const poolWrite = jest.fn(),
          sign = jest.fn()
        const started = journal.prepareIntent(input).then(() => {
          poolWrite()
          sign()
        })
        const observed = started.then(
          () => null,
          error => error,
        )
        await entered.promise
        expect(journal.getIntents()).toEqual([])
        expect(poolWrite).not.toHaveBeenCalled()
        expect(sign).not.toHaveBeenCalled()
        if (outcome === 'release') gate.resolve()
        else gate.reject(new Error('intent write rejected'))
        const error = await observed
        spy.mockRestore()
        if (outcome === 'reject') {
          expect(error.message).toBe('intent write rejected')
          expect(poolWrite).not.toHaveBeenCalled()
          expect(sign).not.toHaveBeenCalled()
        } else {
          expect(error).toBeNull()
          expect(poolWrite).toHaveBeenCalledTimes(1)
        }
        await journal.Close()
        await journal.Open()
        expect(journal.getIntents()).toHaveLength(outcome === 'release' ? 1 : 0)
      })
    },
  )
  it('reopens unsigned and partial member state then atomically promotes the identical full body', async () => {
    await withCanonicalJournal(async journal => {
      const { fixture, input, raw } = await unsignedIntentFixture(journal)
      const intent = await journal.prepareIntent(input)
      await journal.Close()
      await journal.Open()
      expect(journal.lookupIntent(input.prepared)).toEqual(intent)
      expect(journal.getAll()).toEqual([])
      await expect(
        journal.promoteIntent(intent.attemptRef, fixture.request),
      ).rejects.toThrow('conflict')
      await journal.checkpointSignedMember(intent.attemptRef, 0, raw)
      await journal.Close()
      await journal.Open()
      expect(journal.lookupIntent(input.prepared)!.members[0].rawTx).toBe(raw)
      const attempt = await journal.promoteIntent(
        intent.attemptRef,
        fixture.request,
      )
      expect(attempt.request.body).toEqual(fixture.request.body)
      expect(attempt.attemptRef).toBe(intent.attemptRef)
      expect(journal.getIntents()).toEqual([])
      await journal.Close()
      await journal.Open()
      expect(journal.lookup(input.prepared)!.request.body).toEqual(
        fixture.request.body,
      )
      expect(journal.getIntents()).toEqual([])
      expect(journal.reconcile([])[0].state).toBe('hold')
      expect(journal.wasAcknowledged(intent.attemptRef)).toBe(false)
    })
  })
  it('committed-but-rejected intent completion faults owner and preserves exact selection on reopen', async () => {
    await withCanonicalJournal(async journal => {
      const { input } = await unsignedIntentFixture(journal)
      const db = database(journal),
        original = db.batch.bind(db)
      const spy = jest.spyOn(db, 'batch').mockImplementation((async (
        ...args: unknown[]
      ) => {
        await (original as (...args: unknown[]) => Promise<unknown>)(...args)
        throw new Error('intent callback uncertain')
      }) as never)
      await expect(journal.prepareIntent(input)).rejects.toThrow(
        'intent callback uncertain',
      )
      expect(() => journal.getIntents()).toThrow('corrupt')
      spy.mockRestore()
      await journal.Close()
      await journal.Open()
      expect(journal.lookupIntent(input.prepared)!.members).toEqual(
        input.members,
      )
      expect(await journal.prepareIntent(input)).toEqual(
        journal.lookupIntent(input.prepared),
      )
      await expect(
        journal.prepareIntent({ ...input, consumerId: 'different-workflow' }),
      ).rejects.toThrow('conflict')
    })
  })
  it.each(['unsigned', 'signed-member', 'promoted'] as const)(
    'retains exact unsigned selection and fixed bytes after %s SIGKILL without clean Close',
    async phase => {
      await withCanonicalJournal(async (journal, location) => {
        const {
          fixture: original,
          input,
          raw,
        } = await unsignedIntentFixture(journal)
        const fixture = { ...original, prepared: input.prepared }
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
        const row=await journal.prepareIntent({prepared,consumerId:input.consumerId,boundary:input.boundary,construction:new Uint8Array(Buffer.from(input.construction,'base64')),members:input.members});
        if(process.env.CANONICAL_JOURNAL_PHASE!=='unsigned') await journal.checkpointSignedMember(row.attemptRef,0,input.raw);
        if(process.env.CANONICAL_JOURNAL_PHASE==='promoted') await journal.promoteIntent(row.attemptRef,request);
        console.log('DURABLE '+row.attemptRef); setInterval(()=>{},1000);
      `,
          ],
          {
            cwd: join(__dirname, '../../..'),
            env: {
              ...process.env,
              TSX_TSCONFIG_PATH: join(__dirname, '../../bot/tsconfig.json'),
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
                boundary: input.boundary,
                construction: Buffer.from(input.construction).toString(
                  'base64',
                ),
                members: input.members,
                raw,
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
        expect(child.signalCode).toBe('SIGKILL')
        expect(child.exitCode).toBeNull()
        if (phase === 'promoted') {
          const row = journal.lookup(input.prepared)!
          expect(row.request.body).toEqual(fixture.request.body)
          expect(row.request.contentType).toBe(fixture.request.contentType)
          expect(row.reservations).toEqual(fixture.reservations)
          expect(row.terminal).toBeNull()
          expect(row.cleanupComplete).toBe(false)
          expect(journal.getIntents()).toEqual([])
          await expect(
            journal.beginReplay({ attemptRef: row.attemptRef }),
          ).rejects.toThrow('replay')
        } else {
          const intent = journal.lookupIntent(input.prepared)!
          expect(intent.prepared).toEqual(input.prepared)
          expect(intent.boundary).toBe(input.boundary)
          expect(intent.construction).toEqual(input.construction)
          expect(intent.members).toEqual(
            input.members.map(member => ({
              ...member,
              rawTx: phase === 'signed-member' ? raw : null,
            })),
          )
          expect(intent.consumerId).toBe(input.consumerId)
          expect(journal.getAll()).toEqual([])
        }
        if (phase === 'promoted')
          expect(journal.reconcile([])[0].state).toBe('hold')
        else expect(journal.lookup(input.prepared)).toBeUndefined()
      })
    },
    20000,
  )
})

describe('retained canonical recovery durability', () => {
  it.each(['release', 'reject'] as const)(
    'waits for the actual import put completion before an ACK caller: %s',
    async outcome => {
      await withCanonicalJournal(async journal => {
        const input = await recoveryStorageFixture(journal)
        const db = database(journal),
          original = db.put.bind(db),
          entered = barrier(),
          gate = barrier()
        const spy = jest.spyOn(db, 'put').mockImplementation((async (
          ...args: unknown[]
        ) => {
          entered.resolve()
          await gate.promise
          return (original as (...args: unknown[]) => Promise<void>)(...args)
        }) as never)
        const ack = jest.fn()
        const importing = journal.importRecovery(input).then(ack)
        const observed = importing.then(
          () => null,
          error => error,
        )
        await entered.promise
        expect(journal.getImportedRecoveries()).toEqual([])
        expect(ack).not.toHaveBeenCalled()
        if (outcome === 'release') gate.resolve()
        else gate.reject(new Error('real import put rejected'))
        const error = await observed
        spy.mockRestore()
        if (outcome === 'release') {
          expect(error).toBeNull()
          expect(ack).toHaveBeenCalledTimes(1)
        } else {
          expect(error?.message).toBe('real import put rejected')
          expect(ack).not.toHaveBeenCalled()
        }
        await journal.Close()
        await journal.Open()
        expect(journal.getImportedRecoveries()).toHaveLength(
          outcome === 'release' ? 1 : 0,
        )
      })
    },
  )
  it('retains a committed-but-rejected import and exact recipient ACK fact across reopen', async () => {
    await withCanonicalJournal(async journal => {
      const input = await recoveryStorageFixture(journal),
        db = database(journal),
        original = db.put.bind(db)
      const spy = jest.spyOn(db, 'put').mockImplementation((async (
        ...args: unknown[]
      ) => {
        await (original as (...args: unknown[]) => Promise<void>)(...args)
        throw new Error('import committed but callback uncertain')
      }) as never)
      await expect(journal.importRecovery(input)).rejects.toThrow(
        'callback uncertain',
      )
      expect(() => journal.getImportedRecoveries()).toThrow('corrupt')
      spy.mockRestore()
      await journal.Close()
      await journal.Open()
      const retained = journal.importedRecovery(input.obligationId)!
      expect(retained.request.body).toEqual(input.request.body)
      expect(retained.accounts).toHaveLength(1)
      expect(retained.recipientAcknowledged).toBe(false)
      await journal.markRecoveryAcknowledged(input.obligationId)
      await journal.Close()
      await journal.Open()
      expect(journal.importedRecovery(input.obligationId)).toEqual({
        ...retained,
        recipientAcknowledged: true,
      })
      expect(journal.getAll()).toEqual([])
      expect(journal.getIntents()).toEqual([])
    })
  })
  it('retains all 64 verified members and applies shared record backpressure without eviction', async () => {
    await withCanonicalJournal(
      async journal => {
        const input = await recoveryStorageFixture(journal, 64)
        await journal.importRecovery({
          ...input,
          lifecycle: 'pending',
          confirmedChildren: input.confirmedChildren.slice(0, 32),
        })
        const imported = await journal.importRecovery(input)
        expect(imported.accounts).toHaveLength(64)
        await expect(
          journal.importRecovery({
            ...input,
            confirmedChildren: input.confirmedChildren.slice(0, 63),
          }),
        ).rejects.toThrow('conflict')
        await expect(journal.prepare(await canonicalFixture())).rejects.toThrow(
          'capacity',
        )
        expect(journal.getImportedRecoveries()).toHaveLength(1)
        expect(await journal.importRecovery(input)).toEqual(imported)
        await journal.Close()
        await journal.Open()
        expect(journal.importedRecovery(input.obligationId)!.accounts).toEqual(
          imported.accounts,
        )
      },
      { maxRecords: 1 },
    )
  }, 20000)
  it.each(['imported', 'acknowledged'] as const)(
    'retains exact recipient funds and ACK state after %s SIGKILL without clean Close',
    async phase => {
      await withCanonicalJournal(async (journal, location) => {
        const input = await recoveryStorageFixture(journal)
        const fixture = {
          request: input.request,
          prepared: (await canonicalFixture()).prepared,
          reservations: [],
          consumerId: 'unused-storage-fixture',
        }
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
        const row=await journal.importRecovery({request,walletBindingId:input.walletBindingId,obligationId:input.obligationId,confirmedChildren:input.confirmedChildren,lifecycle:input.lifecycle,stampGeneration:input.stampGeneration});
        if(process.env.CANONICAL_JOURNAL_PHASE==='acknowledged') await journal.markRecoveryAcknowledged(row.obligationId);
        console.log('DURABLE '+row.obligationId); setInterval(()=>{},1000);
      `,
          ],
          {
            cwd: join(__dirname, '../../..'),
            env: {
              ...process.env,
              TSX_TSCONFIG_PATH: join(__dirname, '../../bot/tsconfig.json'),
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
                walletBindingId: input.walletBindingId,
                obligationId: input.obligationId,
                confirmedChildren: input.confirmedChildren,
                lifecycle: input.lifecycle,
                stampGeneration: input.stampGeneration,
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
        expect(child.signalCode).toBe('SIGKILL')
        expect(child.exitCode).toBeNull()
        const retained = journal.importedRecovery(input.obligationId)!
        expect(retained.request.body).toEqual(input.request.body)
        expect(retained.request.contentType).toBe(input.request.contentType)
        expect(retained.accounts).toHaveLength(1)
        expect(retained.confirmedChildren).toEqual(input.confirmedChildren)
        expect(retained.lifecycle).toBe(input.lifecycle)
        expect(retained.recipientAcknowledged).toBe(phase === 'acknowledged')
        expect(journal.getAll()).toEqual([])
        expect(journal.getIntents()).toEqual([])
      })
    },
    20000,
  )
  it('reserves the real 64-member uint256 JSON maximum before prefix growth at an exact byte budget', async () => {
    const location = await mkdtemp(join(tmpdir(), 'canonical-recovery-budget-'))
    let journal = new LevelCanonicalStampAttemptJournal(location)
    await journal.Open()
    try {
      const input = await recoveryStorageFixture(journal, 64, (1n << 256n) - 1n)
      await journal.importRecovery({
        ...input,
        lifecycle: 'pending',
        confirmedChildren: [],
      })
      const encoded = await database(journal).get(
        `recovery:${input.obligationId}`,
      )
      const initial = JSON.parse(encoded)
      const maximum = {
        ...initial,
        confirmedChildren: input.confirmedChildren,
        accounts: input.request.parts.transactions.map((raw, childIndex) => {
          const tx = Transaction.from(hexlify(raw))
          return {
            childIndex,
            transactionHash: tx.hash!.toLowerCase(),
            address: tx.to!.toLowerCase(),
            valueWei: tx.value.toString(),
          }
        }),
        lifecycle: 'terminal:verification_failed',
        recipientAcknowledged: false,
      }
      const actualMaximumBytes = Buffer.byteLength(JSON.stringify(maximum))
      expect(initial.reservedBytes).toBe(actualMaximumBytes)
      expect(actualMaximumBytes).toBeGreaterThan(Buffer.byteLength(encoded))
      expect(maximum.accounts).toHaveLength(64)
      expect(maximum.confirmedChildren).toHaveLength(64)
      expect(maximum.accounts[63].valueWei).toHaveLength(78)
      await journal.Close()
      journal = new LevelCanonicalStampAttemptJournal(location, {
        maxBytes: actualMaximumBytes,
        maxRecords: 1,
      })
      await journal.Open()
      expect(journal.getImportedRecoveries()[0].accounts).toEqual([])
      await journal.importRecovery({
        ...input,
        lifecycle: 'terminal:verification_failed',
      })
      expect(journal.getImportedRecoveries()[0].accounts).toHaveLength(64)
      await journal.markRecoveryAcknowledged(input.obligationId)
      const finalEncoded = await database(journal).get(
        `recovery:${input.obligationId}`,
      )
      expect(JSON.parse(finalEncoded).reservedBytes).toBe(actualMaximumBytes)
      expect(Buffer.byteLength(finalEncoded)).toBeLessThanOrEqual(
        actualMaximumBytes,
      )
      await journal.Close()
      await journal.Open()
      expect(journal.getImportedRecoveries()[0].accounts).toHaveLength(64)
      expect(journal.getImportedRecoveries()[0].recipientAcknowledged).toBe(
        true,
      )
      await expect(journal.prepare(await canonicalFixture())).rejects.toThrow(
        'capacity',
      )
      expect(journal.getImportedRecoveries()).toHaveLength(1)
    } finally {
      await journal.Close()
      await rm(location, { recursive: true, force: true })
    }
  }, 20000)
})
