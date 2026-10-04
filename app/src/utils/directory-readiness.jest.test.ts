/** @jest-environment node */
/**
 * Readiness barrier with two real typed wallets, real signed revision-zero exports, the real
 * operator bundle builder and real public directory admission (Node store). The participants'
 * status reads and the relay's directory route are in-memory stand-ins for separate processes.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getBytes } from 'ethers'
import { toHex } from '@frank/codec'
import { openNodeDirectoryStore } from '@frank/directory-admission/node'
import type { Checkpoint } from '@frank/directory-admission'
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
import {
  checkDirectoryReadiness,
  parseCheckpoint,
  preparePublicExport,
  serializeCheckpoint,
  type PublicExportFile,
  type ReadinessDeps,
} from './directory-readiness'

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
  mkdirSync(join(dir, 'stores'))
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
  const session = (wallet: MonadChainWalletHandle) => ({
    state: { status: 'ready', revision: 3, account: { id: 'account' } },
    getWallet: async () => wallet,
  })
  const deployed = new Map<string, Uint8Array>([
    ['bootstrap-policy.json', bytes(policy)],
  ])
  // Stand-in relay directory route: one retained head per subject, served only when published.
  const heads = new Map<string, Uint8Array>()
  const directoryRequests: string[] = []
  const directoryFetch: DirectoryFetch = async (url, init) => {
    directoryRequests.push(`${init.method} ${url}`)
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
    openStore: options =>
      openNodeDirectoryStore({
        location: join(dir, 'stores', options.name.replace(/[^a-z0-9]/g, '-')),
        anchor: options.anchor,
        mode: options.mode,
      }),
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
    deps,
    setNow: (value: bigint) => (now = value),
    setForeign: (id: Participant['processId'] | undefined) => (foreignAt = id),
    /** The operator's explicit step: approve, install everywhere, and the bot publishes itself. */
    install(exports: { ui: PublicExportFile; bot: PublicExportFile } = files) {
      approved = buildApprovedBundle(policy, exports)
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

    // Reload: automatic check reopens the retained stores and publishes nothing.
    f.directoryRequests.length = 0
    const resumed = await f.check(false)
    if (resumed.status !== 'ready') throw new Error(resumed.reason)
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

  it('never enrolls automatically on a device that has not joined the directory', async () => {
    f.install()
    expect(await reason(false)).toBe('enrollment-required')
    expect(f.directoryRequests).toEqual([])
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
})
