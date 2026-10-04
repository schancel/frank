import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
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

// #703/#778: the canonical bot is an ordinary account on the open directory, composed only from
// public producer/owner/directory APIs. These tests open real typed wallets through the chain
// factory and the wallet's own canonical bridge, the shared open directory over real Node
// admission stores (one independent root per account), and the real producer and opener. The
// relay's directory routes are the shared fake relay, which verifies signatures with the real
// codec. A loopback listener stands where the relay's RPC proxy and message routes would be, so
// any startup or correlation request is counted. No account is funded and nothing is sent, so
// these stop at "held: no spendable inventory".
import { statSync } from 'fs'
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
import type { CanonicalInboxRecord } from '@frank/cashweb/relay/monad-mailbox-client'
import {
  createFakeRelay,
  testAccount,
  type FakeRelay,
} from '@frank/cashweb/relay/open-directory-fake-relay.testutil'
import {
  createCanonicalMessageRoles,
  type MonadChainConfig,
} from '@frank/wallet/chain/monad-chain'
import type { MonadRootBundle } from '@frank/wallet/monad-wallet-material'
import domainVectors from '../domain-roots/vectors/domain-roots-v1.json'
import {
  loadQwenCanonicalRoots,
  openQwenCanonicalWallet,
  openQwenDirectory,
  publishQwenDirectoryEntry,
  setUpCanonicalQwenSender,
  type QwenCanonicalWallet,
  type QwenOpenDirectory,
} from './qwen-bot-common'
import {
  QwenBotStateStore,
  qwenCouplingPrepared,
  type QwenResponseContext,
} from './qwen-bot-state'
import { QwenInboundWorkflow } from './qwen-inbound-workflow'
import { QwenResponseWorkflow } from './qwen-response-workflow'

describe('#703/#778 canonical Qwen composition on the open directory', () => {
  const NETWORK = 'monad-testnet'
  const RELAY = 'https://a.example'
  let root: string
  let server: Server
  let requests: string[]
  let logs: string[]
  let cleanup: Array<() => Promise<void>>
  let relay: FakeRelay

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

  /** One account: its own typed wallet and its own directory root. Nothing is published. */
  async function account(index: number, name: string) {
    const wallet = await openQwenCanonicalWallet({
      chain: {
        ...chain(),
        walletStorageLocation: join(root, `${name}-wallet`),
      },
      roots: roots(index),
    })
    const directory = openQwenDirectory({
      wallet,
      networkTag: 'MONT',
      relayBaseUrl: RELAY,
      location: join(root, `${name}-directory`),
      fetch: relay.fetch,
    })
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      await directory.close()
      await wallet.close()
    }
    cleanup.push(close)
    return { wallet, directory, close }
  }
  type Account = Awaited<ReturnType<typeof account>>
  const openBot = () => account(0, 'bot')
  /** A second, unrelated typed account. All it ever does is publish its own entry. */
  async function openSender() {
    const sender = await account(1, 'sender')
    await sender.directory.publish()
    return sender
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'qwen-canonical-setup-'))
    requests = []
    logs = []
    cleanup = []
    relay = createFakeRelay({ endpoint: RELAY })
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

  async function open(bot: {
    wallet: QwenCanonicalWallet
    directory: QwenOpenDirectory
  }) {
    const setup = setUpCanonicalQwenSender({
      wallet: bot.wallet,
      networkTag: 'MONT',
      directory: bot.directory,
      label: 'test',
    })
    const state = new QwenBotStateStore(join(root, 'bot'))
    await state.Open()
    const inboxContext = {
      botAddress: setup.identityAddress,
      networkTag: 'MONT',
      relayBaseUrl: bot.directory.homeEndpoint,
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
  type Opened = Awaited<ReturnType<typeof open>>
  /** The production inbound source, with only the relay page read replaced. */
  const inbound = (bot: Opened, page: CanonicalInboxRecord[]) =>
    new QwenInboundWorkflow({
      state: bot.state,
      context: bot.inboxContext,
      responses: bot.run,
      canonical: {
        ...bot.setup.inbound,
        fetchPage: async () => ({ records: page.splice(0) }),
      },
      peerBlockReason: async () => undefined,
      reserveReply: () => true,
    })

  /** What the sender's own client would send: a real sealed text in a real delivery frame,
   * sealed to the bot's entry as the sender itself read and verified it from the relay. */
  async function from(
    sender: Account,
    botSubject: string,
    text: string,
  ): Promise<CanonicalInboxRecord> {
    const senderCurrent = await sender.directory.selfCurrent()
    const botCurrent = (await sender.directory.peerCurrent(botSubject))!
    const roles = createCanonicalMessageRoles(
      sender.wallet.handle,
      senderCurrent,
    )
    let sealed
    try {
      sealed = prepareDirectMessage({
        network: NETWORK,
        senderCurrent,
        recipientCurrent: botCurrent,
        messageId: new Uint8Array(16).fill(7),
        items: [directMessageText(text)],
        roles,
      })
    } finally {
      roles.dispose()
    }
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
      delivery,
      context: sealed.context,
      submissionIdentity: 'ab'.repeat(32),
      timestampMs: 1000,
    }
  }
  const directoryRequests = () =>
    relay.requests.map(
      request =>
        `${request.method} ${request.path.replace(/[0-9a-f]{66}/, 'P')}`,
    )

  it('publishes its own self-signed entry at startup with nothing else configured, and adopts it on restart', async () => {
    const bot = await openBot()
    // Opening contacts nobody and there is nothing to read yet.
    expect(relay.requests).toEqual([])
    await expect(bot.directory.selfCurrent()).rejects.toThrow(
      'not been published',
    )
    await publishQwenDirectoryEntry({ directory: bot.directory, label: 'test' })
    expect(directoryRequests()).toEqual([
      'GET /relay/v1/info',
      `GET /directory/v1/${NETWORK}/P/head`,
      `PUT /directory/v1/${NETWORK}/P/head`,
    ])
    // The relay holds exactly one entry: the bot's own key, signed by the bot, naming this relay.
    expect([...relay.subjects()]).toEqual([bot.wallet.subject])
    expect(relay.chain(bot.wallet.subject)).toHaveLength(1)
    expect(bot.directory.selfSubject).toBe(bot.wallet.subject)
    expect(bot.directory.network).toBe(NETWORK)
    expect(bot.directory.homeEndpoint).toBe(RELAY + '/')
    const self = await bot.directory.selfCurrent()
    expect(self.revision).toBe(0n)
    expect(toHex(self.evidence.attestation)).toBe(
      toHex(relay.chain(bot.wallet.subject)[0]),
    )
    expect(logs.join()).toContain('directory entry published')
    // A key that never published is simply not usable; that is not an error.
    expect(
      await bot.directory.peerCurrent('02' + '11'.repeat(32)),
    ).toBeUndefined()
    expect(await bot.directory.peerCurrent('not a key')).toBeUndefined()

    // Restart: the entry the relay already holds is adopted, nothing new is signed or stored.
    await bot.close()
    relay.requests.length = 0
    const again = await openBot()
    await publishQwenDirectoryEntry({
      directory: again.directory,
      label: 'test',
    })
    expect(directoryRequests()).toEqual([
      'GET /relay/v1/info',
      `GET /directory/v1/${NETWORK}/P/head`,
    ])
    expect(relay.chain(bot.wallet.subject)).toHaveLength(1)
    expect((await again.directory.selfCurrent()).evidence.hash).toEqual(
      self.evidence.hash,
    )
    // No roots, no RPC, no message route.
    for (const secret of Object.values(domainVectors.vectors[0].outputs))
      expect(logs.join()).not.toContain(secret)
    expect(requests).toEqual([])
  }, 60000)

  it('is not started while its relay is down, retries with backoff, and publishes when the relay comes back', async () => {
    const bot = await openBot()
    relay.down = true
    const delays: number[] = []
    let published = false
    const starting = publishQwenDirectoryEntry({
      directory: bot.directory,
      label: 'test',
      maxDelayMs: 3000,
      sleep: async ms => {
        delays.push(ms)
        // Still nothing published, and the bot has no entry to read mail or answer with.
        expect([...relay.subjects()]).toEqual([])
        await expect(bot.directory.selfCurrent()).rejects.toThrow(
          'not been published',
        )
        expect(published).toBe(false)
        if (delays.length === 4) relay.down = false
      },
    }).then(() => {
      published = true
    })
    await starting
    expect(delays).toEqual([1000, 2000, 3000, 3000])
    expect([...relay.subjects()]).toEqual([bot.wallet.subject])
    expect(await bot.directory.selfCurrent()).toBeDefined()
    const output = logs.join('\n')
    expect(
      output.split('the relay could not be reached (unreachable)'),
    ).toHaveLength(5)
    expect(output).toContain('retrying in 1000 ms')
    expect(output.indexOf('directory entry published')).toBeGreaterThan(
      output.lastIndexOf('not published'),
    )
    for (const secret of Object.values(domainVectors.vectors[0].outputs))
      expect(output).not.toContain(secret)

    // A failure that is not a directory failure is not retried.
    await expect(
      publishQwenDirectoryEntry({
        directory: {
          publish: async () => {
            throw new Error('custody')
          },
        },
        label: 'test',
        sleep: async () => {
          throw new Error('must not wait')
        },
      }),
    ).rejects.toThrow('custody')
    expect(requests).toEqual([])
  }, 60000)

  it('opens the public typed owner and correlates without any RPC, signing or replay effect', async () => {
    const bot = await openBot()
    await bot.directory.publish()
    const first = await open(bot)
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
    // A wallet that is not the account this directory publishes never gets a canonical consumer.
    const other = await account(1, 'other')
    expect(() =>
      setUpCanonicalQwenSender({
        wallet: other.wallet,
        networkTag: 'MONT',
        directory: bot.directory,
        label: 'test',
      }),
    ).toThrow('wallet-not-directory-subject')
    expect(requests).toEqual([])
  }, 60000)

  it('answers a sender it has never seen: one inference and one coupled reply sealed to the key in that sender’s own directory entry', async () => {
    let bot = await openBot()
    await bot.directory.publish()
    // Nothing about the sender exists on the bot's side: it only published its own entry.
    const sender = await openSender()
    const senderCurrent = await sender.directory.selfCurrent()
    const record = await from(sender, bot.wallet.subject, 'PROMPT_SENTINEL')
    const first = await open(bot)
    await first.state.initializeInbox(first.inboxContext, 0)
    const before = relay.requests.length
    const workflow = inbound(first, [record])
    await workflow.import()
    // Imported durably before the directory, the model or the reply path is touched.
    expect(first.reply).not.toHaveBeenCalled()
    expect(relay.requests).toHaveLength(before)
    expect(requests).toEqual([])
    expect(await workflow.drain(10)).toBe(0)
    // The sender's entry was fetched from the relay by the key the envelope names.
    expect(directoryRequests().slice(before)).toEqual([
      `GET /directory/v1/${NETWORK}/P/head`,
    ])
    expect(relay.requests[before].path).toContain(sender.wallet.subject)
    expect(first.reply).toHaveBeenCalledTimes(1)
    expect(first.reply.mock.calls[0][0]).toEqual([
      { role: 'system', content: 'SYSTEM_SENTINEL' },
      { role: 'user', content: 'PROMPT_SENTINEL' },
    ])
    const turn = first.state.pendingResponses()[0]
    expect(turn).toMatchObject({
      phase: 'response-ready',
      senderAddress: sender.wallet.identityAddress,
      senderPubKeyHex: sender.wallet.subject,
    })
    const saved = first.state.getCoupling(turn.payloadHashHex)!
    if (saved.phase !== 'envelope-ready') throw new Error('expected envelope')
    expect(saved.binding).toMatchObject({
      accountId: first.setup.accountAddress.toLowerCase(),
      network: NETWORK,
      senderSubject: bot.wallet.subject,
      recipientSubject: sender.wallet.subject,
      senderT1: toHex((await bot.directory.selfCurrent()).evidence.hash),
      recipientT1: toHex(senderCurrent.evidence.hash),
    })
    // The sender's own role keys open exactly the retained reply bytes: it was sealed to the
    // message key published in that sender's entry.
    const prepared = qwenCouplingPrepared(saved.binding)
    const roles = createCanonicalMessageRoles(
      sender.wallet.handle,
      senderCurrent,
    )
    const opened = openDirectMessage({
      mode: 'receive',
      network: NETWORK,
      payload: prepared.payload,
      context: prepared.context,
      roles,
      senderCurrent: (await sender.directory.peerCurrent(bot.wallet.subject))!,
      recipientCurrent: senderCurrent,
    })
    roles.dispose()
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
    await bot.close()
    bot = await openBot()
    await bot.directory.publish()
    const again = await open(bot)
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

  it('does not answer or pay for a sender whose directory entry is forged, and answers once the real entry is served', async () => {
    const bot = await openBot()
    await bot.directory.publish()
    const sender = await openSender()
    const record = await from(sender, bot.wallet.subject, 'PROMPT_SENTINEL')
    const first = await open(bot)
    await first.state.initializeInbox(first.inboxContext, 0)
    const workflow = inbound(first, [record])
    await workflow.import()

    const mallory = testAccount(41)
    const seconds = BigInt(Math.floor(Date.now() / 1000))
    const validity = {
      network: NETWORK,
      revision: 0n,
      predecessor: null,
      issuedAt: { seconds: seconds - 60n, nanoseconds: 0 },
      expiresAt: { seconds: seconds + 86_400n, nanoseconds: 0 },
      relay: relay.binding,
    }
    // An entry naming the sender's key but signed by another key, then that other account's
    // own valid entry served in the sender's place.
    for (const forged of [
      mallory.sign({ ...validity, claimSubject: sender.wallet.subject }),
      mallory.sign(validity),
    ]) {
      relay.tamper = path =>
        path.endsWith(`/${sender.wallet.subject}/head`) ? forged : undefined
      expect(await workflow.drain(10)).toBe(0)
      expect(
        await bot.directory.peerCurrent(sender.wallet.subject),
      ).toBeUndefined()
    }
    expect(first.reply).not.toHaveBeenCalled()
    expect(first.state.pendingResponses()).toEqual([])
    // Never opened, never answered: the ciphertext stays retained, undecided.
    expect(first.state.pendingInbox()).toHaveLength(1)
    // No inventory funding, no intent, no signature, no message request.
    expect(requests).toEqual([])
    expect(logs.join()).toContain(
      `directory entry of ${sender.wallet.identityAddress} not usable: invalid`,
    )
    expect(logs.join().split('not usable: invalid')).toHaveLength(2)
    expect(logs.join()).not.toContain('SENTINEL')

    // The forgery pinned nothing: the sender's real entry is accepted afterwards.
    relay.tamper = undefined
    expect(await workflow.drain(10)).toBe(0)
    expect(first.reply).toHaveBeenCalledTimes(1)
    expect(first.state.pendingResponses()[0]).toMatchObject({
      senderPubKeyHex: sender.wallet.subject,
    })
  }, 60000)

  it('satisfies a forced peer read only with an entry the relay served just now', async () => {
    const bot = await openBot()
    await bot.directory.publish()
    const sender = await openSender()
    const subject = sender.wallet.subject
    const reads = () =>
      relay.requests.filter(request => request.path.endsWith(`${subject}/head`))
        .length
    const start = reads()
    expect(await bot.directory.peerCurrent(subject)).toBeDefined()
    expect(await bot.directory.peerCurrent(subject, true)).toBeDefined()
    expect(reads()).toBe(start + 1)
    const real = Date.now()
    const clock = jest.spyOn(Date, 'now')
    // The shared directory still reuses its recent entry: that is not a fresh read.
    clock.mockImplementation(() => real + 10_000)
    expect(await bot.directory.peerCurrent(subject)).toBeDefined()
    expect(await bot.directory.peerCurrent(subject, true)).toBeUndefined()
    expect(reads()).toBe(start + 1)
    // Once it asks the relay again, the forced read is satisfied.
    clock.mockImplementation(() => real + 31_000)
    expect(await bot.directory.peerCurrent(subject, true)).toBeDefined()
    expect(reads()).toBe(start + 2)
  }, 60000)

  it('refuses a non-Monad tag or ephemeral wallet storage before opening anything', async () => {
    await expect(
      openQwenCanonicalWallet({
        chain: { ...chain(), networkTag: 'fixture' },
        roots: roots(0),
      }),
    ).rejects.toThrow('network-not-monad')
    await expect(
      openQwenCanonicalWallet({
        chain: { ...chain(), walletStorageLocation: false },
        roots: roots(0),
      }),
    ).rejects.toThrow('wallet-storage-not-durable')
    expect(existsSync(join(root, 'wallet'))).toBe(false)
  })

  it('creates a 0600 roots file once when the path is missing, reuses it on the next start, and never echoes it', () => {
    const path = join(root, 'secrets', 'roots.json')
    const created = loadQwenCanonicalRoots(path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const file = JSON.parse(readFileSync(path, 'utf8'))
    expect(file.registry).toBe('frank-domain-roots-v1')
    expect(Object.keys(file.roots).sort()).toEqual([
      'evm-wallet',
      'identity-authentication',
      'messaging-encryption',
    ])
    const values = Object.values(file.roots) as string[]
    for (const value of values) expect(value).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set(values).size).toBe(3)
    expect(toHex(created.evm.bytes)).toBe(file.roots['evm-wallet'])
    expect(created.authentication.purpose).toBe('identity-authentication')
    // Only the fact and the path are logged.
    expect(logs).toEqual([
      JSON.stringify([`[bot] created canonical roots file at ${path}`]),
    ])
    for (const value of values) expect(logs.join()).not.toContain(value)

    // Next start: the same file, byte for byte, and nothing is logged or rewritten.
    const before = readFileSync(path, 'utf8')
    const reused = loadQwenCanonicalRoots(path)
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(logs).toHaveLength(1)
    for (const purpose of ['evm', 'authentication', 'messaging'] as const)
      expect(toHex(reused[purpose].bytes)).toBe(toHex(created[purpose].bytes))
  })

  it('refuses an existing roots file with loose permissions or bad contents and never replaces it', () => {
    const path = join(root, 'roots.json')
    const outputs = domainVectors.vectors[0].outputs
    const good = JSON.stringify({
      registry: 'frank-domain-roots-v1',
      roots: outputs,
    })
    writeFileSync(path, good, { mode: 0o600 })
    // Secret material readable by group or others is refused, with a fixed reason.
    chmodSync(path, 0o644)
    expect(() => loadQwenCanonicalRoots(path)).toThrow('roots-file-permissions')
    expect(readFileSync(path, 'utf8')).toBe(good)
    chmodSync(path, 0o600)
    const loaded = loadQwenCanonicalRoots(path)
    expect(Buffer.from(loaded.evm.bytes).toString('hex')).toBe(
      outputs['evm-wallet'],
    )
    expect(loaded.messaging.purpose).toBe('messaging-encryption')
    const bad = JSON.stringify({
      registry: 'frank-domain-roots-v1',
      roots: { ...outputs, 'evm-wallet': 'ROOT_SECRET_SENTINEL' },
    })
    writeFileSync(path, bad)
    let message = ''
    try {
      loadQwenCanonicalRoots(path)
    } catch (error) {
      message = String((error as Error).message)
    }
    expect(message).toContain('not a frank-domain-roots-v1 bundle')
    expect(message).toContain(path)
    expect(message).not.toContain('SENTINEL')
    expect(readFileSync(path, 'utf8')).toBe(bad)
    expect(logs).toEqual([])
  })
})
