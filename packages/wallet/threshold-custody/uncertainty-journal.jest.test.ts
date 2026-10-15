import { mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import level, { type LevelDB } from 'level'
import { secp256k1 } from '@noble/curves/secp256k1'
import * as durability from '../storage/level-durability'
import {
  SigningUncertaintyJournal,
  type SigningKeyBinding,
  type SigningUncertaintyRecord,
} from './uncertainty-journal'
import {
  describeKeyShare,
  exportKeyShare,
  importKeyShare,
  keygenStep,
  signStep,
  startKeygen,
  startSign,
} from '../../threshold-ecdsa/src/index'
import { forgetBurnedSharesForTests } from '../../threshold-ecdsa/src/key-share'
import { bytesToInt } from '../../threshold-ecdsa/src/bytes'
import { CURVE_ORDER } from '../../threshold-ecdsa/src/group'
import {
  ciphertextBytes,
  encrypt,
  paillierPublicKey,
} from '../../threshold-ecdsa/src/paillier'
import { HEADER_BYTES } from '../../threshold-ecdsa/src/wire'
import {
  cloneState,
  drive,
  hex,
  must,
  replace,
} from '../../threshold-ecdsa/src/test-support'

const COMPONENT = 'threshold-signing-uncertainty-v1'
const originalPut = durability.durablePut
const h = (byte: number) => byte.toString(16).padStart(2, '0').repeat(32)
const binding = (scalar = 1): SigningKeyBinding => ({
  keyId: `opaque-key-${scalar}`,
  localPublicShareHex: secp256k1.ProjectivePoint.BASE.multiply(
    BigInt(scalar),
  ).toHex(true),
  termsHashHex: h(10),
  role: 'initiator',
  allowedSessions: [
    { sessionIdHex: h(11), digestHex: h(12) },
    { sessionIdHex: h(13), digestHex: h(14) },
  ],
})
const frame = (byte = 1) => new Uint8Array([byte, 2, 3])
const output = () => ({ output: new Uint8Array([7, 8, 9]), terminal: false })
const finished = () => ({ ...output(), terminal: true })
const roots: string[] = []
const journals: SigningUncertaintyJournal[] = []
const rawDbs: LevelDB[] = []
function root(): string {
  const location = mkdtempSync(join(tmpdir(), 'frank-c0-uncertainty-test-'))
  roots.push(location)
  return location
}
async function create(location = root()): Promise<SigningUncertaintyJournal> {
  const journal = await SigningUncertaintyJournal.create(location)
  journals.push(journal)
  return journal
}
async function reopen(
  location: string,
  readOnly = false,
): Promise<SigningUncertaintyJournal> {
  const journal = await (readOnly
    ? SigningUncertaintyJournal.openReadOnly(location)
    : SigningUncertaintyJournal.openForMutation(location))
  journals.push(journal)
  return journal
}
async function admitted(key = binding(), location = root()) {
  const journal = await create(location)
  await journal.createKey(key)
  await journal.beginSession(key, key.allowedSessions[0]!, 0)
  return { journal, key, location }
}
function fault(
  predicate: (record: SigningUncertaintyRecord) => boolean,
  afterCommit = false,
) {
  return jest
    .spyOn(durability, 'durablePut')
    .mockImplementation(async (db, key, value) => {
      const reject = predicate(JSON.parse(value) as SigningUncertaintyRecord)
      if (reject && !afterCommit)
        throw new Error('injected before native sync write')
      const result = await originalPut(db, key, value)
      if (reject) throw new Error('injected lost native commit acknowledgment')
      return result
    })
}
async function raw(location: string): Promise<LevelDB> {
  const db = level(join(location, COMPONENT))
  await db.open()
  rawDbs.push(db)
  return db
}

afterEach(async () => {
  jest.restoreAllMocks()
  forgetBurnedSharesForTests()
  for (const journal of journals.splice(0)) await journal.close()
  for (const db of rawDbs.splice(0)) await db.close()
  for (const location of roots.splice(0))
    rmSync(location, { recursive: true, force: true })
})

describe('native durable signing uncertainty journal (no production activation)', () => {
  it('keeps absent read-only namespaces absent and forbids mutations through an existing read-only view', async () => {
    const location = root()
    await expect(
      SigningUncertaintyJournal.openReadOnly(location),
    ).rejects.toThrow('namespace missing')
    await expect(
      SigningUncertaintyJournal.openForMutation(location),
    ).rejects.toThrow('namespace missing')
    expect(readdirSync(location)).toEqual([])
    const journal = await create(location)
    expect(journal.inspect(binding())).toBeUndefined()
    await journal.createKey(binding())
    await journal.close()
    const view = await reopen(location, true)
    expect(view.inspect(binding())?.record.revision).toBe(0)
    await expect(
      view.beginSession(binding(), binding().allowedSessions[0]!, 0),
    ).rejects.toThrow('read-only')
    await expect(view.createKey(binding(2))).rejects.toThrow('read-only')
    await expect(view.retire(binding(), 0)).rejects.toThrow('read-only')
    expect(view.inspect(binding())?.record.revision).toBe(0)
  })

  it.each([
    'invalid-json',
    'unsupported',
    'missing-binding',
    'wrong-point-key',
    'bad-point',
    'unknown-field',
  ])(
    'rejects %s restoration without rewriting or cleaning records',
    async kind => {
      const location = root()
      const journal = await create(location)
      const key = binding()
      await journal.createKey(key)
      const record = journal.inspect(key)!.record
      await journal.close()
      const db = await raw(location)
      const value =
        kind === 'invalid-json'
          ? '{'
          : JSON.stringify(
              kind === 'unsupported'
                ? { ...record, schemaVersion: 100 }
                : kind === 'missing-binding'
                ? {
                    schemaVersion: 1,
                    revision: 0,
                    sessions: [],
                    state: { kind: 'ready' },
                  }
                : kind === 'bad-point'
                ? {
                    ...record,
                    binding: {
                      ...key,
                      localPublicShareHex: `02${'ff'.repeat(32)}`,
                    },
                  }
                : kind === 'unknown-field'
                ? { ...record, secret: 'must-never-be-silently-dropped' }
                : {
                    ...record,
                    binding: {
                      ...key,
                      localPublicShareHex: binding(2).localPublicShareHex,
                    },
                  },
            )
      await db.put(key.localPublicShareHex, value, { sync: true })
      await db.close()
      await expect(
        SigningUncertaintyJournal.openReadOnly(location),
      ).rejects.toThrow()
      await expect(
        SigningUncertaintyJournal.openForMutation(location),
      ).rejects.toThrow()
      const verify = await raw(location)
      expect(await verify.get(key.localPublicShareHex)).toBe(value)
      expect([...readdirSync(location)]).toEqual([COMPONENT])
    },
  )

  it('commits exact frame uncertainty before invoking signer and withholds output until success sync completes', async () => {
    const { journal, key } = await admitted()
    let release!: () => void
    let successReached!: () => void
    const reached = new Promise<void>(resolve => {
      successReached = resolve
    })
    const barrier = new Promise<void>(resolve => {
      release = resolve
    })
    const signer = jest.fn(() => {
      const pending = journal.inspect(key)!.record
      expect(pending.state.kind).toBe('step-in-progress')
      expect(pending.revision).toBe(2)
      expect(pending.sessions[0]!.steps).toEqual([])
      return finished()
    })
    jest
      .spyOn(durability, 'durablePut')
      .mockImplementation(async (db, key, value) => {
        const record = JSON.parse(value) as SigningUncertaintyRecord
        if (record.revision === 3) {
          successReached()
          await barrier
        }
        return originalPut(db, key, value)
      })
    let escaped = false
    const result = journal
      .runGuardedStep(key, key.allowedSessions[0]!, 1, 0, frame(), signer)
      .then(value => {
        escaped = true
        return value
      })
    await reached
    expect(signer).toHaveBeenCalledTimes(1)
    expect(escaped).toBe(false)
    release()
    expect(await result).toEqual({ revision: 3, output: finished().output })
  })

  it('allows sequential distinct steps and a terminally admitted second session; consumes session IDs permanently', async () => {
    const { journal, key, location } = await admitted()
    const signer = jest.fn(output)
    await journal.runGuardedStep(
      key,
      key.allowedSessions[0]!,
      1,
      0,
      frame(),
      signer,
    )
    await expect(
      journal.beginSession(key, key.allowedSessions[1]!, 3),
    ).rejects.toThrow('active')
    await journal.runGuardedStep(
      key,
      key.allowedSessions[0]!,
      3,
      1,
      frame(2),
      finished,
    )
    await expect(
      journal.beginSession(key, key.allowedSessions[0]!, 5),
    ).rejects.toThrow('consumed')
    await journal.beginSession(key, key.allowedSessions[1]!, 5)
    await journal.runGuardedStep(
      key,
      key.allowedSessions[1]!,
      6,
      0,
      frame(3),
      finished,
    )
    expect(journal.inspect(key)?.refusal).toBe('sessions-exhausted')
    await journal.close()
    const restored = await reopen(location)
    await expect(
      restored.beginSession(key, key.allowedSessions[0]!, 8),
    ).rejects.toThrow()
    expect(restored.inspect(key)?.record.sessions).toHaveLength(2)
  })

  it('does not invoke signer if the owner closes while native pre-step commit acknowledgment is pending', async () => {
    const { journal, key, location } = await admitted()
    let committed!: () => void
    let release!: () => void
    const reached = new Promise<void>(resolve => {
      committed = resolve
    })
    const barrier = new Promise<void>(resolve => {
      release = resolve
    })
    jest
      .spyOn(durability, 'durablePut')
      .mockImplementation(async (db, point, value) => {
        const result = await originalPut(db, point, value)
        if (
          (JSON.parse(value) as SigningUncertaintyRecord).state.kind ===
          'step-in-progress'
        ) {
          committed()
          await barrier
        }
        return result
      })
    const signer = jest.fn(output)
    const operation = journal.runGuardedStep(
      key,
      key.allowedSessions[0]!,
      1,
      0,
      frame(),
      signer,
    )
    await reached
    await journal.close()
    release()
    await expect(operation).rejects.toThrow('quarantined')
    expect(signer).not.toHaveBeenCalled()
    jest.restoreAllMocks()
    const restored = await reopen(location)
    expect(restored.inspect(key)?.refusal).toBe('step-uncertain')
  })

  it('quarantines an actual Level close/reopen while a guarded callback is interrupted', async () => {
    const { journal, key, location } = await admitted()
    let entered!: () => void
    let release!: (result: ReturnType<typeof output>) => void
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    const waiting = new Promise<ReturnType<typeof output>>(resolve => {
      release = resolve
    })
    const operation = journal.runGuardedStep(
      key,
      key.allowedSessions[0]!,
      1,
      0,
      frame(),
      () => {
        entered()
        return waiting
      },
    )
    await started
    await journal.close()
    const restored = await reopen(location)
    expect(restored.inspect(key)?.refusal).toBe('step-uncertain')
    const signer = jest.fn(output)
    await expect(
      restored.runGuardedStep(
        key,
        key.allowedSessions[0]!,
        2,
        0,
        frame(),
        signer,
      ),
    ).rejects.toThrow('quarantined')
    expect(signer).not.toHaveBeenCalled()
    release(output())
    await expect(operation).rejects.toThrow('quarantined')
  })

  it.each([false, true])(
    'quarantines reopened active sessions (successful nonterminal step=%s)',
    async stepped => {
      const { journal, key, location } = await admitted()
      if (stepped)
        await journal.runGuardedStep(
          key,
          key.allowedSessions[0]!,
          1,
          0,
          frame(),
          output,
        )
      await journal.close()
      const restored = await reopen(location)
      expect(restored.inspect(key)?.refusal).toBe('interrupted-session')
      const signer = jest.fn(output)
      await expect(
        restored.runGuardedStep(
          key,
          key.allowedSessions[0]!,
          stepped ? 3 : 1,
          stepped ? 1 : 0,
          frame(2),
          signer,
        ),
      ).rejects.toThrow('quarantined')
      expect(signer).not.toHaveBeenCalled()
    },
  )

  it.each([false, true])(
    'denies callback when uncertainty sync fails (write actually committed=%s)',
    async afterCommit => {
      const { journal, key, location } = await admitted()
      const signer = jest.fn(output)
      fault(record => record.state.kind === 'step-in-progress', afterCommit)
      await expect(
        journal.runGuardedStep(
          key,
          key.allowedSessions[0]!,
          1,
          0,
          frame(),
          signer,
        ),
      ).rejects.toThrow('uncertain')
      expect(signer).not.toHaveBeenCalled()
      expect(journal.inspect(key)?.usable).toBe(false)
      await journal.close()
      jest.restoreAllMocks()
      const restored = await reopen(location)
      expect(restored.inspect(key)?.usable).toBe(false)
      await expect(
        restored.runGuardedStep(
          key,
          key.allowedSessions[0]!,
          restored.inspect(key)!.record.revision,
          0,
          frame(),
          signer,
        ),
      ).rejects.toThrow('quarantined')
      expect(signer).not.toHaveBeenCalled()
    },
  )

  it.each(['callback-throws', 'success-before-write', 'success-after-write'])(
    'quarantines %s despite failing final retirement; never returns output',
    async failure => {
      const { journal, key, location } = await admitted()
      let escaped = false
      const retirementRevisions: number[] = []
      fault(
        record =>
          record.state.kind === 'retired' ||
          (failure.startsWith('success') && record.revision === 3),
        failure === 'success-after-write',
      )
      // For lost success acknowledgment, retirement must fail BEFORE writing too.
      if (failure === 'success-after-write') {
        jest.restoreAllMocks()
        jest
          .spyOn(durability, 'durablePut')
          .mockImplementation(async (db, point, value) => {
            const record = JSON.parse(value) as SigningUncertaintyRecord
            if (record.state.kind === 'retired') {
              retirementRevisions.push(record.revision)
              throw new Error('retirement cannot write')
            }
            const result = await originalPut(db, point, value)
            if (record.revision === 3)
              throw new Error('success committed; acknowledgment lost')
            return result
          })
      }
      const signer = jest.fn(() => {
        if (failure === 'callback-throws')
          throw new Error('local primitive rejected')
        return finished()
      })
      await expect(
        journal
          .runGuardedStep(key, key.allowedSessions[0]!, 1, 0, frame(), signer)
          .then(value => {
            escaped = true
            return value
          }),
      ).rejects.toThrow('quarantined')
      expect(signer).toHaveBeenCalledTimes(1)
      expect(escaped).toBe(false)
      if (failure === 'success-after-write')
        expect(retirementRevisions).toEqual([4])
      expect(journal.inspect(key)?.usable).toBe(false)
      await journal.close()
      jest.restoreAllMocks()
      const restored = await reopen(location)
      expect(restored.inspect(key)?.usable).toBe(false)
      await expect(
        restored.beginSession(
          key,
          key.allowedSessions[1]!,
          restored.inspect(key)!.record.revision,
        ),
      ).rejects.toThrow('quarantined')
    },
  )

  it('fences competing starts, duplicate frames, stale revisions and all immutable binding mismatches before callbacks', async () => {
    const journal = await create()
    const key = binding()
    await journal.createKey(key)
    const starts = await Promise.allSettled([
      journal.beginSession(key, key.allowedSessions[0]!, 0),
      journal.beginSession(key, key.allowedSessions[1]!, 0),
    ])
    expect(starts.map(result => result.status)).toEqual([
      'fulfilled',
      'rejected',
    ])
    const signer = jest.fn(output)
    await expect(
      journal.runGuardedStep(
        key,
        key.allowedSessions[0]!,
        0,
        0,
        frame(),
        signer,
      ),
    ).rejects.toThrow('stale')
    for (const wrong of [
      { ...key, keyId: 'alias' },
      { ...key, termsHashHex: h(22) },
      { ...key, role: 'responder' as const },
      {
        ...key,
        allowedSessions: [
          { ...key.allowedSessions[0]!, digestHex: h(23) },
          key.allowedSessions[1]!,
        ],
      },
    ])
      await expect(
        journal.runGuardedStep(
          wrong,
          key.allowedSessions[0]!,
          1,
          0,
          frame(),
          signer,
        ),
      ).rejects.toThrow('binding mismatch')
    await expect(
      journal.runGuardedStep(
        key,
        { ...key.allowedSessions[0]!, digestHex: h(24) },
        1,
        0,
        frame(),
        signer,
      ),
    ).rejects.toThrow('session/digest')
    await expect(
      journal.runGuardedStep(
        key,
        key.allowedSessions[1]!,
        1,
        0,
        frame(),
        signer,
      ),
    ).rejects.toThrow('session/digest')
    await expect(
      journal.runGuardedStep(
        key,
        key.allowedSessions[0]!,
        1,
        1,
        frame(),
        signer,
      ),
    ).rejects.toThrow('out-of-order')
    expect(signer).not.toHaveBeenCalled()
    await journal.runGuardedStep(
      key,
      key.allowedSessions[0]!,
      1,
      0,
      frame(),
      signer,
    )
    await expect(
      journal.runGuardedStep(
        key,
        key.allowedSessions[0]!,
        3,
        1,
        frame(),
        signer,
      ),
    ).rejects.toThrow('duplicate')
    expect(signer).toHaveBeenCalledTimes(1)
  })

  it('excludes concurrent same-key callbacks while unrelated keys continue', async () => {
    const { journal, key } = await admitted()
    const other = binding(2)
    await journal.createKey(other)
    await journal.beginSession(other, other.allowedSessions[0]!, 0)
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    const waiting = new Promise<void>(resolve => {
      release = resolve
    })
    const pending = journal.runGuardedStep(
      key,
      key.allowedSessions[0]!,
      1,
      0,
      frame(),
      async () => {
        entered()
        await waiting
        return output()
      },
    )
    await started
    const competitor = jest.fn(output)
    await expect(
      journal.runGuardedStep(
        key,
        key.allowedSessions[0]!,
        2,
        0,
        frame(4),
        competitor,
      ),
    ).rejects.toThrow('in progress')
    await journal.runGuardedStep(
      other,
      other.allowedSessions[0]!,
      1,
      0,
      frame(4),
      finished,
    )
    expect(competitor).not.toHaveBeenCalled()
    release()
    await pending
  })

  it('applies retirement to local public share aliases before and after native reopen', async () => {
    const { journal, key, location } = await admitted()
    await journal.retire(key, 1)
    const alias = { ...key, keyId: 'fresh-looking-alias' }
    await expect(journal.createKey(alias)).rejects.toThrow('already admitted')
    const signer = jest.fn(output)
    await expect(
      journal.runGuardedStep(
        alias,
        alias.allowedSessions[0]!,
        2,
        0,
        frame(),
        signer,
      ),
    ).rejects.toThrow('binding mismatch')
    await journal.close()
    const restored = await reopen(location)
    expect(restored.inspect(key)?.refusal).toBe('retired')
    await expect(restored.createKey(alias)).rejects.toThrow('already admitted')
    expect(signer).not.toHaveBeenCalled()
  })

  it('denies second native Level ownership of the same path', async () => {
    const location = root()
    const journal = await create(location)
    await journal.createKey(binding())
    const writes = jest.spyOn(durability, 'durablePut')
    await expect(
      SigningUncertaintyJournal.openForMutation(location),
    ).rejects.toThrow(/lock/i)
    expect(writes).not.toHaveBeenCalled()
    expect(journal.inspect(binding())?.record.revision).toBe(0)
    expect(journal.inspect(binding(2))).toBeUndefined()
  })

  it('documents the authentic snapshot limit with an actual old-record restore', async () => {
    const location = root()
    const journal = await create(location)
    const key = binding()
    await journal.createKey(key)
    const authenticOldRecord = JSON.stringify(journal.inspect(key)!.record)
    await journal.retire(key, 0)
    await journal.close()
    const db = await raw(location)
    await db.put(key.localPublicShareHex, authenticOldRecord, { sync: true })
    await db.close()
    const rolledBack = await reopen(location)
    // No outside monotonic authority exists: replacing every durable fact restores old permission.
    expect(rolledBack.inspect(key)?.usable).toBe(true)
    expect(rolledBack.inspect(key)?.record.revision).toBe(0)
  })

  it('persists only bounded public metadata and hashes, with no nonce state or output bytes', async () => {
    const { journal, key, location } = await admitted()
    await journal.runGuardedStep(
      key,
      key.allowedSessions[0]!,
      1,
      0,
      frame(),
      finished,
    )
    await journal.close()
    const db = await raw(location)
    const row = JSON.parse(await db.get(key.localPublicShareHex))
    expect(Object.keys(row).sort()).toEqual([
      'binding',
      'revision',
      'schemaVersion',
      'sessions',
      'state',
    ])
    expect(Object.keys(row.sessions[0].steps[0]).sort()).toEqual([
      'artifactHashHex',
      'frameHashHex',
      'terminal',
    ])
    expect(row.sessions[0].steps[0].artifactHashHex).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(row)).not.toMatch(
      /nonce|secret|ciphertext|private|070809/,
    )
  })

  it('read-only quarantine of an interrupted session does not rewrite its durable application record', async () => {
    const { journal, key, location } = await admitted()
    const before = JSON.stringify(journal.inspect(key)!.record)
    await journal.close()
    const view = await reopen(location, true)
    expect(view.inspect(key)?.refusal).toBe('interrupted-session')
    expect(JSON.stringify(view.inspect(key)!.record)).toBe(before)
    await view.close()
    const db = await raw(location)
    expect(await db.get(key.localPublicShareHex)).toBe(before)
  })

  it('quarantines acknowledged completed sessions on reopen rather than granting a second session', async () => {
    const { journal, key, location } = await admitted()
    await journal.runGuardedStep(
      key,
      key.allowedSessions[0]!,
      1,
      0,
      frame(),
      finished,
    )
    expect(journal.inspect(key)?.usable).toBe(true)
    await journal.close()
    const restored = await reopen(location)
    expect(restored.inspect(key)?.record.state.kind).toBe('ready')
    expect(restored.inspect(key)?.refusal).toBe('key-quarantined')
    const signer = jest.fn(output)
    await expect(
      restored.beginSession(key, key.allowedSessions[1]!, 3),
    ).rejects.toThrow('quarantined')
    await expect(
      restored.runGuardedStep(
        key,
        key.allowedSessions[0]!,
        3,
        1,
        frame(2),
        signer,
      ),
    ).rejects.toThrow('quarantined')
    expect(signer).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'fails closed on initial admission failure (write committed=%s)',
    async afterCommit => {
      const location = root()
      const journal = await create(location)
      const key = binding()
      fault(record => record.revision === 0, afterCommit)
      await expect(journal.createKey(key)).rejects.toThrow('uncertain')
      expect(() => journal.inspect(key)).toThrow('quarantined')
      await expect(
        journal.createKey({ ...key, keyId: 'alias' }),
      ).rejects.toThrow('already admitted')
      await journal.close()
      jest.restoreAllMocks()
      const restored = await reopen(location)
      // No session/nonce/signing callback was authorized by an ambiguous metadata-only admission.
      expect(restored.inspect(key)?.record.revision).toBe(
        afterCommit ? 0 : undefined,
      )
    },
  )

  it.each([false, true])(
    'closes signing on session-consumption failure (write committed=%s)',
    async afterCommit => {
      const location = root()
      const journal = await create(location)
      const key = binding()
      await journal.createKey(key)
      fault(record => record.revision === 1, afterCommit)
      await expect(
        journal.beginSession(key, key.allowedSessions[0]!, 0),
      ).rejects.toThrow('uncertain')
      const signer = jest.fn(output)
      await expect(
        journal.runGuardedStep(
          key,
          key.allowedSessions[0]!,
          0,
          0,
          frame(),
          signer,
        ),
      ).rejects.toThrow('quarantined')
      expect(signer).not.toHaveBeenCalled()
      expect(journal.inspect(key)?.usable).toBe(false)
      await journal.close()
      jest.restoreAllMocks()
      const restored = await reopen(location)
      // A pre-write rejection can leave a ready key: no nonce callback ever ran.
      expect(restored.inspect(key)?.usable).toBe(!afterCommit)
    },
  )

  it.each([false, true])(
    'keeps failed retirement closed after a session was consumed (write committed=%s)',
    async afterCommit => {
      const { journal, key, location } = await admitted()
      fault(record => record.state.kind === 'retired', afterCommit)
      await expect(journal.retire(key, 1)).rejects.toThrow('uncertain')
      expect(journal.inspect(key)?.usable).toBe(false)
      await journal.close()
      jest.restoreAllMocks()
      const restored = await reopen(location)
      expect(restored.inspect(key)?.usable).toBe(false)
      const signer = jest.fn(output)
      await expect(
        restored.runGuardedStep(
          key,
          key.allowedSessions[0]!,
          restored.inspect(key)!.record.revision,
          0,
          frame(),
          signer,
        ),
      ).rejects.toThrow('quarantined or retired')
      expect(signer).not.toHaveBeenCalled()
    },
  )

  it('records a durable tombstone when a local signer rejects', async () => {
    const { journal, key, location } = await admitted()
    await expect(
      journal.runGuardedStep(
        key,
        key.allowedSessions[0]!,
        1,
        0,
        frame(),
        () => {
          throw new Error('rejected local step')
        },
      ),
    ).rejects.toThrow('quarantined')
    expect(journal.inspect(key)?.record.state).toEqual({
      kind: 'retired',
      reason: 'step-failed',
    })
    await journal.close()
    const restored = await reopen(location)
    expect(restored.inspect(key)?.refusal).toBe('retired')
  })

  it('withholds pending output when explicit retirement occurs during local computation', async () => {
    const { journal, key } = await admitted()
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    const waiting = new Promise<void>(resolve => {
      release = resolve
    })
    const operation = journal.runGuardedStep(
      key,
      key.allowedSessions[0]!,
      1,
      0,
      frame(),
      async () => {
        entered()
        await waiting
        return finished()
      },
    )
    await started
    await journal.retire(key, 2)
    release()
    await expect(operation).rejects.toThrow('quarantined')
    expect(journal.inspect(key)?.record.state).toEqual({
      kind: 'retired',
      reason: 'explicit',
    })
  })

  it('rejects unsupported browser hosts before namespace creation', async () => {
    const location = root()
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    })
    try {
      await expect(SigningUncertaintyJournal.create(location)).rejects.toThrow(
        'browser custody unsupported',
      )
      await expect(
        SigningUncertaintyJournal.openReadOnly(location),
      ).rejects.toThrow('browser custody unsupported')
      expect(readdirSync(location)).toEqual([])
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  })

  it('guards a genuine fresh-share malicious-ciphertext burn and rejects old-share/session reuse after reopen when the tombstone fails', async () => {
    const rng = (length: number) => new Uint8Array(randomBytes(length))
    const keygenId = rng(32)
    const alice = new Uint8Array([1])
    const bob = new Uint8Array([2])
    const generated = drive(
      startKeygen({
        role: 'initiator',
        sessionId: keygenId,
        localId: alice,
        peerId: bob,
        secretSeed: rng(32),
        randomBytes: rng,
      }),
      startKeygen({
        role: 'responder',
        sessionId: keygenId,
        localId: bob,
        peerId: alice,
        secretSeed: rng(32),
        randomBytes: rng,
      }),
      keygenStep,
    )
    const a = generated.initiatorResult!
    const b = generated.responderResult!
    const oldShare = must(exportKeyShare(a))
    const sessionId = rng(32)
    const digest = rng(32)
    // Fixture-only access to a public point/modulus, following the primitive's existing burn tests.
    const publicFields = a as unknown as {
      localPoint: Uint8Array
      modulus: Uint8Array
    }
    const key: SigningKeyBinding = {
      keyId: hex(must(describeKeyShare(a)).keyId),
      localPublicShareHex: hex(publicFields.localPoint),
      termsHashHex: h(10),
      role: 'initiator',
      allowedSessions: [
        { sessionIdHex: hex(sessionId), digestHex: hex(digest) },
      ],
    }
    const trace = drive(
      startSign({ keyShare: a, sessionId, digest, randomBytes: rng }),
      startSign({ keyShare: b, sessionId, digest, randomBytes: rng }),
      signStep,
    )
    const probe = ciphertextBytes(
      encrypt(
        paillierPublicKey(bytesToInt(publicFields.modulus)),
        CURVE_ORDER + 12345n,
        7n,
      ),
    )
    const maliciousFrame = replace(trace.messages[3]!, HEADER_BYTES, probe)
    const { journal, location } = await admitted(key)
    fault(record => record.state.kind === 'retired')
    let observedState: string | undefined
    let burnResult: ReturnType<typeof signStep> | undefined
    const signer = jest.fn((incoming: Uint8Array) => {
      observedState = journal.inspect(key)?.record.state.kind
      burnResult = signStep(cloneState(trace.before[3]!), incoming)
      if (!burnResult.ok)
        throw new Error('trusted wrapper propagates primitive failure')
      return {
        output: burnResult.value.outgoing ?? new Uint8Array(),
        terminal: false,
      }
    })
    await expect(
      journal.runGuardedStep(
        key,
        key.allowedSessions[0]!,
        1,
        0,
        maliciousFrame,
        signer,
      ),
    ).rejects.toThrow('quarantined')
    expect(signer).toHaveBeenCalledTimes(1)
    // Assertions live outside the callback: its errors are intentionally caught by the journal.
    expect(observedState).toBe('step-in-progress')
    expect(burnResult?.ok).toBe(false)
    if (!burnResult || burnResult.ok)
      throw new Error('no actual primitive rejection')
    expect(burnResult.error.keyShareBurned).toBe(true)
    expect(must(describeKeyShare(a)).burned).toBe(true)
    await journal.close()
    jest.restoreAllMocks()
    // Simulate a fresh primitive process: its process-local burn set alone cannot stop this import.
    forgetBurnedSharesForTests()
    expect(importKeyShare(oldShare).ok).toBe(true)
    const restored = await reopen(location)
    expect(restored.inspect(key)?.refusal).toBe('step-uncertain')
    const reused = jest.fn(output)
    await expect(
      restored.runGuardedStep(
        key,
        key.allowedSessions[0]!,
        2,
        0,
        maliciousFrame,
        reused,
      ),
    ).rejects.toThrow('quarantined')
    expect(reused).not.toHaveBeenCalled()
  }, 300_000)
})
