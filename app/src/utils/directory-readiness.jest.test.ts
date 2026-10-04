/** @jest-environment node */
/**
 * Readiness barrier with two real typed wallets, real signed revision-zero exports, the real
 * operator bundle builder and real public directory admission (Node store). The participants'
 * status reads and the relay's directory route are in-memory stand-ins for separate processes.
 */
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getBytes } from 'ethers'
import { toHex } from '@frank/codec'
import { openBrowserDirectoryStore } from '@frank/directory-admission/browser'
import type { Checkpoint } from '@frank/directory-admission'
import * as monadChain from '@frank/wallet/chain/monad-chain'
import {
  createMonadChain,
  type MonadChainWalletHandle,
} from '@frank/wallet/chain/monad-chain'
import type { MonadRootBundle } from '@frank/wallet/monad-wallet-material'
import type { DirectoryFetch } from '@frank/cashweb/relay/directory-client'
import rootsVector from '../../../packages/domain-roots/vectors/domain-roots-v1.json'
import {
  configurationIdentity,
  expectedConfiguration,
  type ApprovedPolicy,
  type BootstrapPolicy,
  type InstallationSnapshot,
  type Participant,
} from './directory-provisioning'
import {
  buildApprovedBundle,
  buildBootstrapPolicy,
  relayDirectoryToml,
} from './directory-operator'
import { discardUnenrolledDirectoryStore } from './directory-store-reset'
import {
  checkDirectoryReadiness,
  parseCheckpoint,
  preparePublicExport,
  serializeCheckpoint,
  type PublicExportFile,
  type ReadinessDeps,
} from './directory-readiness'

jest.mock('@frank/wallet/chain/monad-chain', () => {
  const actual = jest.requireActual('@frank/wallet/chain/monad-chain')
  return {
    ...actual,
    prepareMonadRevisionZeroExport: jest.fn(
      actual.prepareMonadRevisionZeroExport,
    ),
  }
})
// The only operation in this barrier that signs with the account's authentication key.
const signing = monadChain.prepareMonadRevisionZeroExport as jest.Mock
const RELAY_A = 'https://relay-a.example'
const NOW = 1_000_000_000_000n
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value))
function roots(index: number): MonadRootBundle {
  const outputs = rootsVector.vectors[index].outputs
  const root = <
    P extends 'evm-wallet' | 'identity-authentication' | 'messaging-encryption',
  >(
    purpose: P,
  ) => ({
    registry: 'frank-domain-roots-v1' as const,
    purpose,
    bytes: getBytes(`0x${outputs[purpose]}`),
  })
  return {
    evm: root('evm-wallet'),
    authentication: root('identity-authentication'),
    messaging: root('messaging-encryption'),
  }
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'directory-readiness-'))
  // A fresh browser profile per test: the real IndexedDB admission store runs against it.
  globalThis.indexedDB = new IDBFactory()
  const chain = createMonadChain({
    networkId: 'monad-testnet',
    rpcChain: 'monad-testnet',
    chainId: 10143,
    relayBaseUrl: RELAY_A,
    networkTag: 'MONT',
    stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
    defaultStampValueWei: 1000n,
    defaultTopicVoteValueWei: 1000n,
    subAccountPoolSize: 0,
    walletStorageLocation: join(dir, 'wallet'),
  })
  const ui = (await chain.createWallet(roots(0))) as MonadChainWalletHandle,
    bot = (await chain.createWallet(roots(1))) as MonadChainWalletHandle
  const relayKey = toHex(ui.identity.compressedPubKey)
  const policy: BootstrapPolicy = buildBootstrapPolicy({
    networkTag: 'MONT',
    network: 'monad-testnet',
    chainId: '10143',
    participants: (['relay-a', 'relay-b', 'bot'] as const).map(processId => ({
      processId,
      origin: `https://${processId}.example`,
      trustReference: `${processId}-local-demo`,
    })),
    relayTuples: (['relay-a', 'relay-b'] as const).map(processId => ({
      processId,
      id: (processId === 'relay-a' ? '01' : '02').repeat(16),
      endpoint: `https://${processId}.example/`,
      key: relayKey,
      expiryNs: (NOW + 3_000_000_000_000n).toString(),
    })),
    exportValidity: {
      issuedAtNs: (NOW - 1n).toString(),
      expiresAtNs: (NOW + 3_000_000_000_000n).toString(),
    },
  })
  const accounts = new Map<MonadChainWalletHandle, unknown>()
  const session = (wallet: MonadChainWalletHandle) => {
    if (!accounts.has(wallet))
      accounts.set(wallet, {
        receipt: { context: { accountId: `account-${accounts.size}` } },
      })
    return {
      state: { status: 'ready', revision: 3, account: accounts.get(wallet) },
      getWallet: async () => wallet,
    }
  }
  const savedExports = new Map<string, string>()
  const failDirectory: { next?: number } = {}
  const failEnroll = { next: false }
  const deployed = new Map<string, Uint8Array>([
    ['bootstrap-policy.json', bytes(policy)],
  ])
  // Stand-in relay directory route: one retained head per subject, served only when published.
  const heads = new Map<string, Uint8Array>()
  const directoryRequests: string[] = []
  const directoryFetch: DirectoryFetch = async (url, init) => {
    directoryRequests.push(`${init.method} ${url}`)
    if (failDirectory.next !== undefined) {
      const status = failDirectory.next
      failDirectory.next = undefined
      return { status, url, headers: { get: () => null }, body: null }
    }
    const subject = url.split('/')[6]
    if (init.method === 'PUT') heads.set(subject, new Uint8Array(init.body!))
    const head = heads.get(subject)
    let read = false
    return {
      status: head ? 200 : 404,
      url,
      headers: {
        get: name =>
          ({
            'content-type': 'application/vnd.frank.cbor',
            'x-frank-directory-evidence': 'fresh-current',
          }[name.toLowerCase()] ?? null),
      },
      body: head
        ? {
            getReader: () => ({
              read: async () =>
                read
                  ? { done: true }
                  : ((read = true), { done: false, value: head }),
              cancel: async () => undefined,
            }),
          }
        : null,
    }
  }
  const checkpoints = new Map<string, string>()
  let now = NOW
  const process = {
    'relay-a': { epoch: 'a1'.repeat(16), generation: '1', down: false },
    'relay-b': { epoch: 'b1'.repeat(16), generation: '1', down: false },
    'bot': { epoch: 'c1'.repeat(16), generation: '1', down: false },
  }
  let approved: ApprovedPolicy | undefined
  let foreignAt: Participant['processId'] | undefined
  const snapshotReads: string[] = []
  const deps = (wallet: MonadChainWalletHandle): ReadinessDeps => ({
    session: session(wallet),
    relayBaseUrl: RELAY_A,
    nowNs: () => now,
    loadDeployed: async name => deployed.get(name) ?? null,
    async fetchSnapshot(participant, manifest): Promise<InstallationSnapshot> {
      snapshotReads.push(participant.processId)
      const state = process[participant.processId]
      if (state.down || !approved || manifest !== approved.bundleIdentity)
        throw new Error('no installation')
      const configuration = expectedConfiguration(approved)
      if (foreignAt === participant.processId)
        configuration.principals[0].bindingExpiryNs = '5'
      return {
        version: 1,
        kind: 'published-directory-installation',
        runtimeEpoch: state.epoch,
        generation: state.generation,
        configuration,
        publicConfigurationIdentity: configurationIdentity(configuration),
        sampledAtNs: now.toString(),
        classification: 'historical-installation-snapshot',
        states: configuration.principals.map(p => {
          const head = heads.get(p.subjectP)
          const enrolled = participant.processId === 'relay-a' && !!head
          return {
            network: p.network,
            subjectP: p.subjectP,
            enrollment: enrolled ? 'enrolled' : 'unenrolled',
            historicalHead: enrolled ? p.revisionZeroT1 : null,
            historicalRevision: enrolled ? '0' : null,
            messageGeneration: enrolled ? '0' : null,
            stampGeneration: enrolled ? '0' : null,
            forked: false,
            unavailable: false,
          }
        }),
      }
    },
    async openStore(options) {
      const store = await openBrowserDirectoryStore(options)
      if (!failEnroll.next) return store
      failEnroll.next = false
      return {
        ...store,
        enroll: async () => {
          throw new Error('local enrollment interrupted')
        },
      }
    },
    discardUnenrolled: discardUnenrolledDirectoryStore,
    exports: {
      load: key => savedExports.get(key) ?? null,
      save: (key, value) => void savedExports.set(key, value),
    },
    checkpoints: {
      load: key =>
        checkpoints.has(key) ? parseCheckpoint(checkpoints.get(key)!) : null,
      save: (key, value: Checkpoint) =>
        void checkpoints.set(key, serializeCheckpoint(value)),
    },
    directoryFetch,
  })
  const exportOf = async (wallet: MonadChainWalletHandle) => {
    const result = await preparePublicExport(
      deps(wallet),
      new AbortController().signal,
    )
    if (!result.ok) throw new Error(result.reason)
    return result.file
  }
  const files = { ui: await exportOf(ui), bot: await exportOf(bot) }
  return {
    dir,
    ui,
    bot,
    policy,
    files,
    deployed,
    heads,
    process,
    checkpoints,
    directoryRequests,
    snapshotReads,
    savedExports,
    exportOf,
    failDirectory,
    failEnroll,
    deps,
    setNow: (value: bigint) => (now = value),
    setForeign: (id: Participant['processId'] | undefined) => (foreignAt = id),
    /** The operator's explicit step: approve, install everywhere, and the bot publishes itself. */
    install(exports: { ui: PublicExportFile; bot: PublicExportFile } = files) {
      approved = buildApprovedBundle(policy, exports, now)
      deployed.set('approved-bundle.json', bytes(approved))
      heads.set(
        files.bot.subjectP,
        Uint8Array.from(Buffer.from(files.bot.attestation, 'base64url')),
      )
      return approved
    },
    check: (allowEnrollment = true, wallet = ui) =>
      checkDirectoryReadiness(deps(wallet), {
        allowEnrollment,
        signal: new AbortController().signal,
      }),
    async close() {
      await ui.close()
      await bot.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

describe('local/demo directory readiness barrier', () => {
  jest.setTimeout(30_000)
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => {
    f = await fixture()
  })
  afterEach(() => f.close())
  const reason = async (allowEnrollment = true) => {
    const result = await f.check(allowEnrollment)
    return result.status === 'pending' ? result.reason : 'ready'
  }

  it('exports public evidence only, deterministically, and stays pending until the operator installs', async () => {
    const again = await preparePublicExport(
      f.deps(f.ui),
      new AbortController().signal,
    )
    expect(again).toEqual({ ok: true, file: f.files.ui })
    expect(Object.keys(f.files.ui).sort()).toEqual(
      [
        'attestation',
        'authAddress',
        'bootstrapPolicyIdentity',
        'chainId',
        'homeProcessId',
        'kind',
        'messagePoint',
        'network',
        'networkTag',
        'revisionZeroT1',
        'stampPoint',
        'statement',
        'subjectP',
        'version',
      ].sort(),
    )
    expect(
      new Set([
        f.files.ui.subjectP,
        f.files.ui.messagePoint,
        f.files.ui.stampPoint,
      ]).size,
    ).toBe(3)
    expect(await reason()).toBe('bundle-missing')
    expect(f.directoryRequests).toEqual([])
    expect(f.snapshotReads).toEqual([])
    f.deployed.delete('bootstrap-policy.json')
    expect(await reason()).toBe('policy-missing')
  })

  it('becomes ready only after every participant reports the approved bundle and the browser admits both subjects', async () => {
    const approved = f.install()
    const result = await f.check()
    if (result.status !== 'ready') throw new Error(result.reason)
    expect(result.participants).toEqual({
      'relay-a': 'matched',
      'relay-b': 'matched',
      'bot': 'matched',
    })
    // Own evidence was published to the installed home relay; the peer was only read.
    expect(f.directoryRequests.filter(r => r.startsWith('PUT'))).toEqual([
      `PUT ${RELAY_A}/directory/v1/monad-testnet/${f.files.ui.subjectP}/head`,
    ])
    expect(f.snapshotReads).toHaveLength(6)
    const { directory } = result.activation
    const self = await directory.selfCurrent()
    expect(toHex(self.evidence.hash)).toBe(f.files.ui.revisionZeroT1)
    const peer = await directory.peerCurrent({
      address: result.activation.peerAddress,
    })
    expect(peer?.subject).toBe(f.files.bot.subjectP)
    expect(toHex(peer!.current.evidence.hash)).toBe(f.files.bot.revisionZeroT1)
    expect(
      await directory.peerCurrent({ subject: f.files.ui.subjectP }),
    ).toBeUndefined()
    expect(directory.homeEndpoint).toBe(RELAY_A + '/')
    await result.activation.close()

    // Reload: automatic check reopens the retained stores, signs nothing and publishes nothing.
    f.directoryRequests.length = 0
    signing.mockClear()
    const resumed = await f.check(false)
    if (resumed.status !== 'ready') throw new Error(resumed.reason)
    expect(signing).not.toHaveBeenCalled()
    expect(f.directoryRequests.every(r => r.startsWith('GET'))).toBe(true)
    await resumed.activation.close()

    const toml = relayDirectoryToml(
      approved,
      { clockFile: '/c/clock', stateDir: '/c/state', bundleRoot: '/c/bundle' },
      'new',
    )
    expect(toml.match(/\[\[registry\.directory\.principals\]\]/g)).toHaveLength(
      2,
    )
    expect(toml).toContain(`manifest_identity = "${approved.bundleIdentity}"`)
    expect(toml).toContain(`revision_zero = "${f.files.ui.revisionZeroT1}"`)
  })

  it('automatic start signs nothing and contacts no participant on a device that has not joined', async () => {
    f.install()
    signing.mockClear()
    expect(await reason(false)).toBe('enrollment-required')
    expect(signing).not.toHaveBeenCalled()
    expect(f.directoryRequests).toEqual([])
    expect(f.snapshotReads).toEqual([])
  })

  it('automatic start refuses a saved export that is not this wallet or this policy', async () => {
    f.install()
    const first = await f.check()
    if (first.status !== 'ready') throw new Error(first.reason)
    await first.activation.close()
    const [key] = [...f.savedExports.keys()]
    const saved = JSON.parse(f.savedExports.get(key)!)
    f.savedExports.set(
      key,
      JSON.stringify({ ...saved, bootstrapPolicyIdentity: 'ee'.repeat(32) }),
    )
    signing.mockClear()
    expect(await reason(false)).toBe('enrollment-required')
    // Another account's public export under this account's key is never activated.
    f.savedExports.set(key, JSON.stringify(f.files.bot))
    expect(await reason(false)).toBe('bundle-not-this-account')
    expect(signing).not.toHaveBeenCalled()
  })

  it.each([409, 429, 503])(
    'a first enrollment the relay answers with %s can simply be checked again',
    async status => {
      f.install()
      f.failDirectory.next = status
      expect(await reason()).toBe('admission-failed')
      expect(f.checkpoints.size).toBe(0)
      const retried = await f.check()
      if (retried.status !== 'ready') throw new Error(retried.reason)
      await retried.activation.close()
    },
  )

  it('a first enrollment interrupted after its prospective checkpoint was saved can be checked again', async () => {
    f.install()
    f.failEnroll.next = true
    expect(await reason()).toBe('admission-failed')
    const saved = [...f.checkpoints.values()].map(v => parseCheckpoint(v).kind)
    expect(saved).toEqual(['ProspectiveEnrollment'])
    // Automatic start does not repair or enroll; the explicit action does.
    expect(await reason(false)).toBe('enrollment-required')
    const retried = await f.check()
    if (retried.status !== 'ready') throw new Error(retried.reason)
    expect(
      [...f.checkpoints.values()].map(v => parseCheckpoint(v).kind),
    ).toEqual(['CommittedPrefix', 'CommittedPrefix'])
    await retried.activation.close()
  })

  it('never discards admitted state: a lost checkpoint or an emptied store stays failed', async () => {
    f.install()
    const first = await f.check()
    if (first.status !== 'ready') throw new Error(first.reason)
    await first.activation.close()
    const names = (await indexedDB.databases()).map(db => db.name!).sort()
    expect(names).toHaveLength(2)

    // Checkpoints lost, admitted stores intact: nothing is deleted and nothing re-enrolls.
    const checkpoints = new Map(f.checkpoints)
    f.checkpoints.clear()
    expect(await reason()).toBe('admission-failed')
    expect((await indexedDB.databases()).map(db => db.name!).sort()).toEqual(
      names,
    )
    for (const [key, value] of checkpoints) f.checkpoints.set(key, value)
    const restored = await f.check(false)
    if (restored.status !== 'ready') throw new Error(restored.reason)
    await restored.activation.close()

    // Acknowledged checkpoints intact, stores wiped: never treated as a fresh enrollment.
    for (const name of names)
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name)
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
      })
    expect(await reason()).toBe('admission-failed')
    expect(await reason()).toBe('admission-failed')
    expect([...f.checkpoints.values()]).toEqual([...checkpoints.values()])
  })

  it.each(['relay-a', 'relay-b', 'bot'] as const)(
    'stays pending while %s has no installation or a different one',
    async id => {
      f.install()
      f.process[id].down = true
      const down = await f.check()
      expect(down).toMatchObject({
        status: 'pending',
        reason: 'participant-unavailable',
      })
      expect(down.participants[id]).toBe('unavailable')
      f.process[id].down = false
      f.setForeign(id)
      const foreign = await f.check()
      expect(foreign).toMatchObject({
        status: 'pending',
        reason: 'participant-mismatch',
      })
      expect(foreign.participants[id]).toBe('mismatch')
      // Partial installation never reaches the directory or publishes evidence.
      expect(f.directoryRequests).toEqual([])
    },
  )

  it('rejects a bundle approved for another account, a restarted participant and an expired policy', async () => {
    // The operator installed a bundle whose UI subject is some other account.
    f.install({ ui: f.files.bot, bot: f.files.ui })
    expect(await reason()).toBe('bundle-not-this-account')
    expect(f.snapshotReads).toEqual([])

    f.install()
    f.heads.delete(f.files.bot.subjectP)
    expect(await reason()).toBe('admission-failed')

    f.install()
    const original = f.deps(f.ui).fetchSnapshot
    let reads = 0
    const restarting: ReadinessDeps = {
      ...f.deps(f.ui),
      fetchSnapshot: async (participant, manifest, signal) => {
        if (++reads === 4) f.process['relay-b'].epoch = 'b2'.repeat(16)
        return original(participant, manifest, signal)
      },
    }
    expect(
      await checkDirectoryReadiness(restarting, {
        allowEnrollment: true,
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ status: 'pending', reason: 'changed-during-check' })

    f.setNow(BigInt(f.policy.exportValidity.expiresAtNs))
    expect(await reason()).toBe('policy-expired')
  })

  it('operator approval rejects exports whose public fields, validity or policy time do not match what was signed', async () => {
    const now = NOW
    const approve = (
      ui: PublicExportFile,
      at = now,
      bot: PublicExportFile = f.files.bot,
    ) => buildApprovedBundle(f.policy, { ui, bot }, at)
    expect(approve(f.files.ui).subjects).toHaveLength(2)
    // Unsigned convenience fields must agree with the signed statement they describe.
    expect(() =>
      approve({ ...f.files.ui, authAddress: f.files.bot.authAddress }),
    ).toThrow('authAddress')
    expect(() =>
      approve({ ...f.files.ui, messagePoint: f.files.bot.messagePoint }),
    ).toThrow('messagePoint')
    expect(() =>
      approve({ ...f.files.ui, stampPoint: f.files.bot.stampPoint }),
    ).toThrow('stampPoint')
    expect(() =>
      approve(f.files.ui, now, {
        ...f.files.bot,
        stampPoint: f.files.ui.stampPoint,
      }),
    ).toThrow('stampPoint')
    // The policy must be inside its own validity when the operator approves.
    expect(() =>
      approve(f.files.ui, BigInt(f.policy.exportValidity.expiresAtNs)),
    ).toThrow('validity')
    expect(() =>
      approve(f.files.ui, BigInt(f.policy.exportValidity.issuedAtNs) - 1n),
    ).toThrow('validity')
    // A statement signed for another validity window cannot be relabelled for this policy.
    const other = buildBootstrapPolicy({
      networkTag: f.policy.networkTag,
      network: f.policy.network,
      chainId: f.policy.chainId,
      participants: f.policy.participants,
      relayTuples: f.policy.relayTuples,
      exportValidity: {
        issuedAtNs: f.policy.exportValidity.issuedAtNs,
        expiresAtNs: (
          BigInt(f.policy.exportValidity.expiresAtNs) - 1n
        ).toString(),
      },
    })
    f.deployed.set(
      'bootstrap-policy.json',
      new TextEncoder().encode(JSON.stringify(other)),
    )
    const relabelled = {
      ...(await f.exportOf(f.ui)),
      bootstrapPolicyIdentity: f.policy.policyIdentity,
    }
    expect(relabelled.revisionZeroT1).not.toBe(f.files.ui.revisionZeroT1)
    expect(() => approve(relabelled)).toThrow('signed validity')
  })
})
