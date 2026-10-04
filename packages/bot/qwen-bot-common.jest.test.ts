import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { JsonRpcProvider, Wallet } from 'ethers'

import { MonadTxSubmitter } from '@frank/wallet/monad-account-tx'
import { setUpDurableFundedStampClient } from './qwen-bot-common'

describe('Qwen durable stamp-wallet lifecycle', () => {
  let root: string
  let walletJsonPath: string
  let logSpy: jest.SpyInstance

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qwen-wallet-lifecycle-'))
    walletJsonPath = join(root, 'main-wallet.json')
    const mainWallet = Wallet.createRandom()
    writeFileSync(
      walletJsonPath,
      JSON.stringify({
        address: mainWallet.address,
        privateKey: mainWallet.privateKey,
      }),
      { mode: 0o600 },
    )
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    logSpy.mockRestore()
    rmSync(root, { recursive: true, force: true })
  })

  function provider(): JsonRpcProvider {
    return new JsonRpcProvider('http://127.0.0.1:1', 10143, {
      staticNetwork: true,
      cacheTimeout: -1,
    })
  }

  function submitter(): jest.Mocked<MonadTxSubmitter> {
    return {
      submitRawTransaction: jest.fn(),
      getTransactionReceipt: jest.fn(),
    }
  }

  function open(stateRoot: string) {
    return setUpDurableFundedStampClient({
      rpcUrl: 'http://127.0.0.1:1',
      relayBaseUrl: 'https://relay.invalid',
      mainWalletJsonPath: walletJsonPath,
      stateRoot,
      stampValueWei: 10_000n,
      label: 'test',
      provider: provider(),
      httpClient: submitter(),
    })
  }

  it('reopens the same HD accounts and releases every store on close', async () => {
    const stateRoot = join(root, 'wallet-state')
    const first = await open(stateRoot)
    first.pool.ensureUnfundedSize(2)
    await first.pool.flush()
    const addresses = first.pool.records().map(record => record.address)
    await first.close()

    const reopened = await open(stateRoot)
    expect(reopened.pool.records().map(record => record.address)).toEqual(
      addresses,
    )
    await reopened.close()
    await reopened.close()

    const afterRelease = await open(stateRoot)
    await afterRelease.close()
  })
})

// #703: the canonical sender is composed only from public producer/owner APIs. These tests open
// the real typed wallet through the chain factory and the wallet's own canonical bridge, with a
// loopback listener standing where the relay and its RPC proxy would be, so any startup or
// correlation request would be counted. No account is funded and nothing is sent.
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { getBytes } from 'ethers'
import { openDirectMessage } from '@frank/cashweb/relay/canonical-dm'
import { openNodeDirectoryStore } from '@frank/directory-admission/node'
import type { MonadChainConfig } from '@frank/wallet/chain/monad-chain'
import type { PublicRevisionZeroInput } from '@frank/wallet/monad-wallet-handle'
import {
  createMonadWalletMaterial,
  type MonadRootBundle,
} from '@frank/wallet/monad-wallet-material'
import domainVectors from '../domain-roots/vectors/domain-roots-v1.json'
import {
  loadQwenCanonicalRoots,
  setUpCanonicalQwenSender,
  type QwenCanonicalDirectory,
} from './qwen-bot-common'
import {
  QwenBotStateStore,
  qwenCouplingPrepared,
  type QwenResponseContext,
} from './qwen-bot-state'
import { QwenResponseWorkflow } from './qwen-response-workflow'

describe('#703 canonical Qwen sender composition', () => {
  const NETWORK = 'monad-testnet'
  const PEER = '0x52908400098527886E0F7030069857D2E4169EE7'
  let root: string
  let server: Server
  let requests: string[]
  let logs: string[]
  let cleanup: Array<() => Promise<void>>
  let directories = 0

  function roots(index: number): MonadRootBundle {
    const outputs = domainVectors.vectors[index].outputs
    const one = <
      P extends
        | 'evm-wallet'
        | 'identity-authentication'
        | 'messaging-encryption',
    >(
      purpose: P,
    ) => ({
      registry: 'frank-domain-roots-v1' as const,
      purpose,
      bytes: getBytes(`0x${outputs[purpose]}`),
    })
    return {
      evm: one('evm-wallet'),
      authentication: one('identity-authentication'),
      messaging: one('messaging-encryption'),
    }
  }

  function chain(): MonadChainConfig {
    return {
      networkId: 'monad-testnet',
      rpcChain: 'monad-testnet',
      chainId: 10143,
      relayBaseUrl: `http://127.0.0.1:${
        (server.address() as AddressInfo).port
      }`,
      networkTag: 'MONT',
      stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
      defaultStampValueWei: 32n,
      defaultTopicVoteValueWei: 1n,
      subAccountPoolSize: 2,
      walletStorageLocation: join(root, 'wallet'),
    }
  }

  /** Real signed revision-zero evidence admitted by the real Node directory policy. */
  async function directory(senderRoots: MonadRootBundle = roots(0)) {
    const enroll = async (bundle: MonadRootBundle, binding: 'A' | 'B') => {
      const material = createMonadWalletMaterial(bundle)
      const tuple = (label: string) => ({
        processId: label,
        origin: `https://${label}.example`,
        tuple: {
          relayId: new Uint8Array(16).fill(label === 'a' ? 1 : 2),
          endpoint: `https://${label}.example`,
          identity: {
            keyType: 1,
            keyBytes:
              material.canonicalRoles!.publicGenerationZeroPoints().auth,
          },
          expiry: { seconds: 3700n, nanoseconds: 0 },
          unknownFields: new Map(),
        },
      })
      const input: PublicRevisionZeroInput = {
        networkTag: 'MONT',
        network: NETWORK,
        chainId: 10143n,
        issuedAt: { seconds: 100n, nanoseconds: 0 },
        expiresAt: { seconds: 3700n, nanoseconds: 0 },
        now: { seconds: 100n, nanoseconds: 0 },
        relayA: tuple('a'),
        relayB: tuple('b'),
        subjectBinding: binding,
      }
      const exported = material.canonicalRoles!.prepareRevisionZero(input)
      const store = await openNodeDirectoryStore({
        location: join(root, `directory-${directories++}`),
        anchor: {
          network: NETWORK,
          subject: { keyType: 1, keyBytes: exported.auth.compressedPoint },
          revisionZero: exported.t1,
        },
        mode: { kind: 'new' },
      })
      const current = await store.enroll(
        [{ statement: exported.statement, attestation: exported.attestation }],
        {
          now: input.now,
          relay: binding === 'A' ? input.relayA.tuple : input.relayB.tuple,
        },
      )
      cleanup.push(async () => {
        await store.close()
        material.dispose()
      })
      return { material, current }
    }
    const sender = await enroll(senderRoots, 'A'),
      recipient = await enroll(roots(1), 'B')
    const lookups: string[] = []
    const installed: QwenCanonicalDirectory = {
      currents: async peer => {
        lookups.push(peer)
        return peer.toLowerCase() === PEER.toLowerCase()
          ? {
              senderCurrent: sender.current,
              recipientCurrent: recipient.current,
            }
          : undefined
      },
    }
    return { installed, lookups, sender, recipient }
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'qwen-canonical-setup-'))
    requests = []
    logs = []
    cleanup = []
    server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`)
      response.statusCode = 500
      response.end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    for (const method of ['log', 'warn'] as const)
      jest.spyOn(console, method).mockImplementation((...args) => {
        logs.push(JSON.stringify(args))
      })
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    for (const close of cleanup.reverse()) await close()
    await new Promise(resolve => server.close(resolve))
    rmSync(root, { recursive: true, force: true })
  })

  async function open(
    installed: QwenCanonicalDirectory,
    bundle: MonadRootBundle = roots(0),
  ) {
    const setup = await setUpCanonicalQwenSender({
      chain: chain(),
      roots: bundle,
      directory: installed,
      label: 'test',
    })
    const state = new QwenBotStateStore(join(root, 'bot'))
    await state.Open()
    const context: QwenResponseContext = {
      botAddress: 'bot',
      fundingAddress: setup.accountAddress.toLowerCase(),
      networkTag: 'MONT',
      relayBaseUrl: chain().relayBaseUrl,
      stampValueWei: '32',
    }
    const reply = jest.fn(async () => ({
      content: 'REPLY_SENTINEL',
      reasoning: 'REASONING_SENTINEL',
    }))
    const run = new QwenResponseWorkflow({
      state,
      context,
      systemPrompt: 'SYSTEM_SENTINEL',
      generator: { reply },
      canonical: setup.sender,
    })
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      await state.Close()
      await setup.close()
    }
    cleanup.push(close)
    return { setup, state, run, reply, close }
  }

  const turn = {
    payloadHashHex: '01',
    senderAddress: PEER,
    senderPubKeyHex: '02',
    prompt: 'PROMPT_SENTINEL',
  }

  it('opens the public typed owner and correlates without any relay, RPC, signing or replay effect', async () => {
    const { installed, lookups } = await directory()
    const first = await open(installed)
    expect(await first.run.recover()).toBeUndefined()
    expect(first.setup.sender.wallet.reconcileWorkflowLinks([])).toEqual([])
    expect(requests).toEqual([])
    expect(lookups).toEqual([])
    // One economic owner: a second composition over the same account is refused while open.
    await expect(
      setUpCanonicalQwenSender({
        chain: chain(),
        roots: roots(0),
        directory: installed,
        label: 'test',
      }),
    ).rejects.toThrow('already open')
    await first.close()
    const again = await open(installed)
    expect(await again.run.recover()).toBeUndefined()
    expect(requests).toEqual([])
  }, 30000)

  it('seals the saved result once through the shared producer and holds, without a wallet intent, while the typed owner has no spendable inventory', async () => {
    const { installed, sender, recipient } = await directory()
    const first = await open(installed)
    expect(await first.run.respond(turn)).toBe('held')
    const saved = first.state.getCoupling('01')!
    expect(saved.phase).toBe('envelope-ready')
    if (saved.phase !== 'envelope-ready') throw new Error('expected envelope')
    expect(saved.binding.accountId).toBe(
      first.setup.accountAddress.toLowerCase(),
    )
    expect(saved.binding.network).toBe(NETWORK)
    // The recipient's own role keys open exactly the retained bytes.
    const prepared = qwenCouplingPrepared(saved.binding)
    const opened = openDirectMessage({
      mode: 'receive',
      network: NETWORK,
      payload: prepared.payload,
      context: prepared.context,
      roles: recipient.material.canonicalRoles!.create(
        NETWORK,
        recipient.current,
      ),
      senderCurrent: sender.current,
      recipientCurrent: recipient.current,
    })
    expect(Buffer.from(opened.content).toString('latin1')).toContain(
      'REPLY_SENTINEL',
    )
    expect(JSON.stringify(saved)).not.toContain('SENTINEL')
    expect(first.setup.sender.wallet.lookup(prepared)).toBeUndefined()
    expect(first.state.getResponse('01')?.phase).toBe('response-ready')

    await first.close()
    const again = await open(installed)
    expect(await again.run.recover()).toBeUndefined()
    expect(await again.run.resume('01')).toBe('held')
    // The retained envelope is reused byte for byte; the model is not asked again.
    expect(again.state.getCoupling('01')).toEqual(saved)
    expect(again.reply).not.toHaveBeenCalled()
    expect(first.reply).toHaveBeenCalledTimes(1)
    expect(again.setup.sender.wallet.lookup(prepared)).toBeUndefined()
    expect(requests).toEqual([])
    expect(logs.join()).toContain('intent-preparation-failed')
    expect(logs.join()).not.toContain('SENTINEL')
  }, 30000)

  it('holds a peer with no admitted directory entry before sealing anything', async () => {
    const { installed } = await directory()
    const first = await open(installed)
    expect(
      await first.run.respond({
        ...turn,
        senderAddress: '0x' + 'ef'.repeat(20),
      }),
    ).toBe('held')
    expect(first.state.getCoupling('01')).toBeUndefined()
    expect(first.state.getResponse('01')?.phase).toBe('response-ready')
    expect(requests).toEqual([])
    expect(logs.join()).toContain('peer-directory-unavailable')
  }, 30000)

  it('holds a saved envelope when the wallet is reopened under a different account', async () => {
    const original = await directory()
    const first = await open(original.installed)
    expect(await first.run.respond(turn)).toBe('held')
    const saved = first.state.getCoupling('01')
    await first.close()
    // Same identity roots, a different economic root: another stamp account and pool.
    const moved = { ...roots(0), evm: roots(1).evm }
    const other = await directory(moved)
    const changed = await open(other.installed, moved)
    expect(await changed.run.recover()).toBe('wallet-binding-mismatch')
    expect(await changed.run.resume('01')).toBe('held')
    expect(changed.state.getCoupling('01')).toEqual(saved)
    expect(requests).toEqual([])
  }, 30000)

  it('refuses a non-Monad tag or ephemeral wallet storage', async () => {
    const { installed } = await directory()
    await expect(
      setUpCanonicalQwenSender({
        chain: { ...chain(), networkTag: 'fixture' },
        roots: roots(0),
        directory: installed,
        label: 'test',
      }),
    ).rejects.toThrow('installed Monad network')
    await expect(
      setUpCanonicalQwenSender({
        chain: { ...chain(), walletStorageLocation: false },
        roots: roots(0),
        directory: installed,
        label: 'test',
      }),
    ).rejects.toThrow('durable wallet storage')
  })

  it('loads an operator-provisioned root bundle and never creates or echoes one', () => {
    const path = join(root, 'roots.json')
    expect(() => loadQwenCanonicalRoots(path)).toThrow(path)
    expect(() => readFileSyncOrUndefined(path)).not.toThrow()
    expect(readFileSyncOrUndefined(path)).toBeUndefined()
    const outputs = domainVectors.vectors[0].outputs
    writeFileSync(
      path,
      JSON.stringify({ registry: 'frank-domain-roots-v1', roots: outputs }),
      { mode: 0o600 },
    )
    const loaded = loadQwenCanonicalRoots(path)
    expect(Buffer.from(loaded.evm.bytes).toString('hex')).toBe(
      outputs['evm-wallet'],
    )
    expect(loaded.messaging.purpose).toBe('messaging-encryption')
    writeFileSync(
      path,
      JSON.stringify({
        registry: 'frank-domain-roots-v1',
        roots: { ...outputs, 'evm-wallet': 'ROOT_SECRET_SENTINEL' },
      }),
    )
    let message = ''
    try {
      loadQwenCanonicalRoots(path)
    } catch (error) {
      message = String((error as Error).message)
    }
    expect(message).toContain('not a frank-domain-roots-v1 bundle')
    expect(message).not.toContain('SENTINEL')
  })
})

function readFileSyncOrUndefined(path: string): string | undefined {
  try {
    return require('fs').readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}
