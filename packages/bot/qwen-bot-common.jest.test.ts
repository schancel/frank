import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
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

// #703/#778: the canonical bot is composed only from public producer/owner/directory APIs.
// These tests open the real typed wallet through the chain factory and the wallet's own canonical
// bridge, the real Node directory store behind the real directory client, and the real producer
// and opener. A loopback listener stands where the relay's RPC proxy and message routes would be,
// so any startup or correlation request is counted; the relay's Directory routes are a local
// responder that only stores and returns published attestation bytes. No account is funded and
// nothing is sent, so these stop at "held: no spendable inventory".
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { Transaction, Wallet as EthersWallet, getBytes } from 'ethers'
import {
  cborMap,
  encodeFrame,
  paymentCommitment,
  recipientPayloadDigest,
  toHex,
} from '@frank/codec'
import {
  directMessageText,
  openDirectMessage,
  prepareDirectMessage,
} from '@frank/cashweb/relay/canonical-dm'
import type { DirectoryFetch } from '@frank/cashweb/relay/directory-client'
import type { CanonicalInboxRecord } from '@frank/cashweb/relay/monad-mailbox-client'
import type { MonadChainConfig } from '@frank/wallet/chain/monad-chain'
import {
  createMonadWalletMaterial,
  type MonadRootBundle,
} from '@frank/wallet/monad-wallet-material'
import domainVectors from '../domain-roots/vectors/domain-roots-v1.json'
import {
  buildApprovedBundle,
  buildBootstrapPolicy,
} from '../../app/src/utils/directory-operator'
import {
  configurationMatches,
  parseInstallationSnapshot,
} from '../../app/src/utils/directory-provisioning'
import {
  loadQwenCanonicalRoots,
  openQwenCanonicalWallet,
  openQwenInstalledDirectory,
  startQwenInstallationServer,
  readQwenApprovedBundle,
  readQwenBootstrapPolicy,
  setUpCanonicalQwenSender,
  type QwenCanonicalDirectory,
  type QwenPublicExportFile,
} from './qwen-bot-common'
import {
  QwenBotStateStore,
  qwenCouplingPrepared,
  type QwenResponseContext,
} from './qwen-bot-state'
import { QwenInboundWorkflow } from './qwen-inbound-workflow'
import { QwenResponseWorkflow } from './qwen-response-workflow'

describe('#703/#778 canonical Qwen composition', () => {
  const NETWORK = 'monad-testnet'
  const NOW_NS = 200_000_000_000n
  let root: string
  let server: Server
  let requests: string[]
  let logs: string[]
  let cleanup: Array<() => Promise<void>>
  let published: Map<string, Uint8Array>
  let directoryRequests: string[]

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

  async function wallet(bundle: MonadRootBundle, storage: string) {
    const opened = await openQwenCanonicalWallet({
      chain: { ...chain(), walletStorageLocation: join(root, storage) },
      roots: bundle,
    })
    cleanup.push(() => opened.close())
    return opened
  }

  /** The two public files an operator installs, built by the operator tool's own functions and
   * read back through the bot's strict readers. */
  async function install(options: { botRoots?: MonadRootBundle } = {}) {
    const relayKey = Buffer.from(
      createMonadWalletMaterial(
        roots(1),
      ).canonicalRoles!.publicGenerationZeroPoints().auth,
    ).toString('hex')
    const policyPath = join(root, 'bootstrap-policy.json')
    writeFileSync(
      policyPath,
      JSON.stringify(
        buildBootstrapPolicy({
          networkTag: 'MONT',
          network: NETWORK,
          chainId: '10143',
          participants: (['relay-a', 'relay-b', 'bot'] as const).map(
            processId => ({
              processId,
              origin: `https://${
                processId === 'bot' ? 'bot' : processId.slice(-1)
              }.example`,
              trustReference: processId,
            }),
          ),
          relayTuples: (['a', 'b'] as const).map(label => ({
            processId: `relay-${label}` as const,
            id: (label === 'a' ? '01' : '02').repeat(16),
            endpoint: `https://${label}.example`,
            key: relayKey,
            expiryNs: '3700000000000',
          })),
          exportValidity: {
            issuedAtNs: '100000000000',
            expiresAtNs: '3700000000000',
          },
        }),
      ),
    )
    const policy = readQwenBootstrapPolicy(policyPath)
    const exportFor = async (bundle: MonadRootBundle, storage: string) => {
      const opened = await wallet(bundle, storage)
      const file = opened.publicExport({
        policy,
        home: 'relay-a',
        nowNs: NOW_NS,
      })
      await opened.close()
      return file
    }
    const bot = await exportFor(options.botRoots ?? roots(0), 'export-bot'),
      ui = await exportFor(roots(1), 'export-ui')
    const bundlePath = join(root, 'approved-bundle.json')
    writeFileSync(
      bundlePath,
      JSON.stringify(buildApprovedBundle(policy, { ui, bot })),
    )
    return { policy, bundle: readQwenApprovedBundle(bundlePath), bot, ui }
  }

  /** Stand-in for the relay's public Directory routes: stores and returns published heads. */
  const directoryFetch: DirectoryFetch = async (url, init) => {
    const match =
      /^https:\/\/a\.example\/directory\/v1\/([^/]+)\/([^/]+)\/head$/.exec(url)
    directoryRequests.push(
      `${init.method} ${match ? match[2].slice(0, 8) : url}`,
    )
    const key = match ? `${match[1]}/${match[2]}` : ''
    if (match && init.method === 'PUT')
      published.set(key, Uint8Array.from(init.body as Uint8Array))
    const head = published.get(key)
    let sent = false
    return {
      url,
      status: head ? 200 : 404,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type'
            ? 'application/vnd.frank.cbor'
            : name.toLowerCase() === 'x-frank-directory-evidence'
            ? 'fresh-current'
            : null,
      },
      body: {
        getReader: () => ({
          read: async () =>
            sent || !head
              ? { done: true as const, value: undefined }
              : ((sent = true), { done: false as const, value: head }),
          cancel: async () => undefined,
          releaseLock: () => undefined,
        }),
      },
    } as Awaited<ReturnType<DirectoryFetch>>
  }
  const publishUi = (ui: QwenPublicExportFile) =>
    published.set(
      `${NETWORK}/${ui.subjectP}`,
      new Uint8Array(Buffer.from(ui.attestation, 'base64url')),
    )

  async function openDirectory(
    installed: Awaited<ReturnType<typeof install>>,
    bundle = roots(0),
  ) {
    const opened = await wallet(bundle, 'wallet')
    const directory = await openQwenInstalledDirectory({
      wallet: opened,
      policy: installed.policy,
      bundle: installed.bundle,
      location: join(root, 'directory'),
      fetch: directoryFetch,
      nowNs: () => NOW_NS,
      peerRefreshMs: 0,
    })
    cleanup.push(() => directory.close())
    return Object.assign(directory, { wallet: opened })
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'qwen-canonical-setup-'))
    requests = []
    logs = []
    cleanup = []
    published = new Map()
    directoryRequests = []
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

  async function open(directory: Awaited<ReturnType<typeof openDirectory>>) {
    const setup = setUpCanonicalQwenSender({
      wallet: directory.wallet,
      networkTag: 'MONT',
      directory,
      label: 'test',
    })
    const state = new QwenBotStateStore(join(root, 'bot'))
    await state.Open()
    const inboxContext = {
      botAddress: setup.identityAddress,
      networkTag: 'MONT',
      relayBaseUrl: directory.homeEndpoint,
    }
    const context: QwenResponseContext = {
      ...inboxContext,
      fundingAddress: setup.accountAddress.toLowerCase(),
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
    }
    cleanup.push(close)
    return { setup, state, run, reply, close, inboxContext }
  }

  /** What the typed UI account would send: a real sealed text in a real delivery frame. */
  async function fromUi(
    text: string,
    directory: QwenCanonicalDirectory,
  ): Promise<{
    record: CanonicalInboxRecord
    ui: ReturnType<typeof createMonadWalletMaterial>
    uiCurrent: NonNullable<
      Awaited<ReturnType<QwenCanonicalDirectory['peerCurrent']>>
    >
  }> {
    const ui = createMonadWalletMaterial(roots(1))
    cleanup.push(async () => ui.dispose())
    const uiSubject = Buffer.from(
      ui.canonicalRoles!.publicGenerationZeroPoints().auth,
    ).toString('hex')
    const uiCurrent = (await directory.peerCurrent(uiSubject))!
    const botCurrent = await directory.selfCurrent()
    const sealed = prepareDirectMessage({
      network: NETWORK,
      senderCurrent: uiCurrent,
      recipientCurrent: botCurrent,
      messageId: new Uint8Array(16).fill(7),
      items: [directMessageText(text)],
      roles: ui.canonicalRoles!.create(NETWORK, uiCurrent),
    })
    const digest = recipientPayloadDigest(NETWORK, sealed.payload)
    const raw = await new EthersWallet(
      '0x' + '00'.repeat(31) + '01',
    ).signTransaction({
      type: 2,
      chainId: 10143n,
      nonce: 0,
      gasLimit: 50000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
      value: 32n,
      to: '0x' + '11'.repeat(20),
      data: '0x504f4e4402' + toHex(paymentCommitment(digest, 0)),
    })
    const tx = Transaction.from(raw)
    const delivery = encodeFrame(
      { typeId: 1, schemaVersion: 1, minReaderVersion: 1 },
      cborMap([
        [0, NETWORK],
        [
          1,
          cborMap([
            [0, 1],
            [1, botCurrent.stampKey.keyBytes],
          ]),
        ],
        [2, sealed.payload],
        [3, digest],
        [
          4,
          [
            cborMap([
              [0, 0],
              [1, getBytes(tx.hash!)],
              [2, getBytes('0x' + tx.value.toString(16).padStart(64, '0'))],
              [3, getBytes('0x' + '11'.repeat(20))],
              [4, paymentCommitment(digest, 0)],
            ]),
          ],
        ],
      ]),
    )
    return {
      record: {
        delivery,
        context: sealed.context,
        submissionIdentity: 'ab'.repeat(32),
        timestampMs: 1000,
      },
      ui,
      uiCurrent,
    }
  }

  it("exports only public evidence, publishes only the bot's own attestation, admits a peer only from that peer's published evidence, and reports the installed configuration", async () => {
    const installed = await install()
    for (const secret of Object.values(domainVectors.vectors[0].outputs))
      expect(JSON.stringify(installed.bot)).not.toContain(secret)
    expect(Object.keys(installed.bot).sort()).toEqual(
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
    const directory = await openDirectory(installed)
    expect(directory.selfSubject).toBe(installed.bot.subjectP)
    expect(directoryRequests).toEqual([
      `PUT ${installed.bot.subjectP.slice(0, 8)}`,
    ])
    expect(toHex((await directory.selfCurrent()).evidence.hash)).toBe(
      installed.bot.revisionZeroT1,
    )
    // Installed but not yet published by its owner: not usable, never enrolled from the file.
    expect(await directory.peerCurrent(installed.ui.subjectP)).toBeUndefined()
    // Not installed at all: no relay request is even made.
    const before = directoryRequests.length
    expect(await directory.peerCurrent('02' + '11'.repeat(32))).toBeUndefined()
    expect(directoryRequests).toHaveLength(before)

    // The readiness endpoint: exact headers, the app's own strict parser and comparator.
    const status = await startQwenInstallationServer({ directory, port: 0 })
    cleanup.push(() => status.close())
    const read = (manifest: string) =>
      fetch(
        `http://127.0.0.1:${status.port}/directory-installation/${manifest}`,
      )
    const response = await read(installed.bundle.bundleIdentity)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    const snapshot = parseInstallationSnapshot(
      new Uint8Array(await response.arrayBuffer()),
    )
    expect(configurationMatches(snapshot, installed.bundle)).toBe(true)
    const stateOf = (subject: string, from = snapshot) =>
      from.states.find(state => state.subjectP === subject)!
    expect(stateOf(installed.bot.subjectP)).toMatchObject({
      enrollment: 'enrolled',
      historicalHead: installed.bot.revisionZeroT1,
      forked: false,
      unavailable: false,
    })
    expect(stateOf(installed.ui.subjectP)).toMatchObject({
      enrollment: 'unenrolled',
      historicalHead: null,
      forked: false,
      unavailable: false,
    })
    expect((await read('00'.repeat(32))).status).toBe(404)
    expect(
      (await fetch(`http://127.0.0.1:${status.port}/anything-else`)).status,
    ).toBe(404)

    publishUi(installed.ui)
    const peer = await directory.peerCurrent(installed.ui.subjectP)
    expect(toHex(peer!.evidence.hash)).toBe(installed.ui.revisionZeroT1)
    const later = parseInstallationSnapshot(
      new Uint8Array(
        await (await read(installed.bundle.bundleIdentity)).arrayBuffer(),
      ),
    )
    expect(stateOf(installed.ui.subjectP, later)).toMatchObject({
      enrollment: 'enrolled',
      historicalHead: installed.ui.revisionZeroT1,
    })
    expect(later.runtimeEpoch).toBe(snapshot.runtimeEpoch)
    expect(later.generation).toBe(snapshot.generation)

    // Restart: whole checkpoints reopen both stores; the same bytes are published again.
    await directory.close()
    await directory.wallet.close()
    directoryRequests = []
    const again = await openDirectory(installed)
    expect(directoryRequests).toEqual([
      `PUT ${installed.bot.subjectP.slice(0, 8)}`,
    ])
    expect(toHex((await again.selfCurrent()).evidence.hash)).toBe(
      installed.bot.revisionZeroT1,
    )
    expect(await again.peerCurrent(installed.ui.subjectP)).toBeDefined()
    expect(requests).toEqual([])
  }, 60000)

  it("refuses a bundle that does not carry this wallet's own exact evidence, before any relay request", async () => {
    // Same identity, another messaging root: a different signed statement for the same P.
    const foreign = await install({
      botRoots: { ...roots(0), messaging: roots(1).messaging },
    })
    await expect(openDirectory(foreign)).rejects.toThrow('own evidence')
    expect(directoryRequests).toEqual([])
    expect(requests).toEqual([])
  }, 60000)

  it('opens the public typed owner and correlates without any relay, RPC, signing or replay effect', async () => {
    const directory = await openDirectory(await install())
    const first = await open(directory)
    expect(await first.run.recover()).toBeUndefined()
    expect(first.setup.sender.wallet.reconcileWorkflowLinks([])).toEqual([])
    expect(requests).toEqual([])
    // One economic owner: a second wallet over the same account is refused while open.
    await expect(
      openQwenCanonicalWallet({
        chain: { ...chain(), walletStorageLocation: join(root, 'second') },
        roots: roots(0),
      }),
    ).rejects.toThrow('already open')
    // Roots that are not the installed bot subject never get a canonical consumer.
    const other = await wallet(roots(1), 'other')
    expect(() =>
      setUpCanonicalQwenSender({
        wallet: other,
        networkTag: 'MONT',
        directory,
        label: 'test',
      }),
    ).toThrow('installed directory subject')
    expect(requests).toEqual([])
  }, 60000)

  it('turns one canonical text from an installed typed account into one inference and one coupled reply envelope for that account', async () => {
    const installed = await install()
    let directory = await openDirectory(installed)
    publishUi(installed.ui)
    const first = await open(directory)
    const { record, ui, uiCurrent } = await fromUi('PROMPT_SENTINEL', directory)
    await first.state.initializeInbox(first.inboxContext, 0)
    const inbound = (bot: typeof first, page: CanonicalInboxRecord[]) =>
      new QwenInboundWorkflow({
        state: bot.state,
        context: bot.inboxContext,
        responses: bot.run,
        // The production source, with only the relay page read replaced.
        canonical: {
          ...bot.setup.inbound,
          fetchPage: async () => ({ records: page.splice(0) }),
        },
        peerBlockReason: async () => undefined,
        reserveReply: () => true,
      })
    const workflow = inbound(first, [record])
    await workflow.import()
    expect(first.reply).not.toHaveBeenCalled()
    expect(requests).toEqual([])
    expect(await workflow.drain(10)).toBe(0)
    expect(first.reply).toHaveBeenCalledTimes(1)
    expect(first.reply.mock.calls[0][0]).toEqual([
      { role: 'system', content: 'SYSTEM_SENTINEL' },
      { role: 'user', content: 'PROMPT_SENTINEL' },
    ])
    const turn = first.state.pendingResponses()[0]
    expect(turn).toMatchObject({
      phase: 'response-ready',
      senderAddress: installed.ui.authAddress.toLowerCase(),
      senderPubKeyHex: installed.ui.subjectP,
    })
    const saved = first.state.getCoupling(turn.payloadHashHex)!
    if (saved.phase !== 'envelope-ready') throw new Error('expected envelope')
    expect(saved.binding).toMatchObject({
      accountId: first.setup.accountAddress.toLowerCase(),
      network: NETWORK,
      senderSubject: installed.bot.subjectP,
      recipientSubject: installed.ui.subjectP,
      senderT1: installed.bot.revisionZeroT1,
      recipientT1: installed.ui.revisionZeroT1,
    })
    // The typed account's own role keys open exactly the retained reply bytes.
    const prepared = qwenCouplingPrepared(saved.binding)
    const opened = openDirectMessage({
      mode: 'receive',
      network: NETWORK,
      payload: prepared.payload,
      context: prepared.context,
      roles: ui.canonicalRoles!.create(NETWORK, uiCurrent),
      senderCurrent: await directory.selfCurrent(),
      recipientCurrent: uiCurrent,
    })
    expect(Buffer.from(opened.content).toString('latin1')).toContain(
      'REPLY_SENTINEL',
    )
    expect(JSON.stringify(saved)).not.toContain('SENTINEL')
    // The wallet tried to fund inventory from its own account through the relay's RPC proxy,
    // which is down here: no intent, no signature, no message request.
    expect(first.setup.sender.wallet.lookup(prepared)).toBeUndefined()
    expect(logs.join()).toContain('inventory-unavailable')
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every(request => request.includes('/chain-rpc/'))).toBe(
      true,
    )

    await first.close()
    await directory.close()
    await directory.wallet.close()
    directory = await openDirectory(installed)
    const again = await open(directory)
    expect(await again.run.recover()).toBeUndefined()
    // The relay returns the same record again: terminal by digest, no second inference.
    const replay = inbound(again, [record])
    await replay.import()
    expect(await replay.drain(10)).toBe(0)
    expect(await again.run.resume(turn.payloadHashHex)).toBe('held')
    expect(again.state.getCoupling(turn.payloadHashHex)).toEqual(saved)
    expect(again.reply).not.toHaveBeenCalled()
    expect(requests.every(request => request.includes('/chain-rpc/'))).toBe(
      true,
    )
    expect(logs.join()).not.toContain('SENTINEL')
  }, 60000)

  it('refuses a non-Monad tag or ephemeral wallet storage before opening anything', async () => {
    await expect(
      openQwenCanonicalWallet({
        chain: { ...chain(), networkTag: 'fixture' },
        roots: roots(0),
      }),
    ).rejects.toThrow('installed Monad network')
    await expect(
      openQwenCanonicalWallet({
        chain: { ...chain(), walletStorageLocation: false },
        roots: roots(0),
      }),
    ).rejects.toThrow('durable wallet storage')
    expect(existsSync(join(root, 'wallet'))).toBe(false)
  })

  it('loads an operator-provisioned root bundle and never creates or echoes one', () => {
    const path = join(root, 'roots.json')
    expect(() => loadQwenCanonicalRoots(path)).toThrow(path)
    expect(existsSync(path)).toBe(false)
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
