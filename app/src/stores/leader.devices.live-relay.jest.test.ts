/** @jest-environment node */

/**
 * The active device of an account, through the REAL relay and real wallets on monad-regtest.
 *
 * Two devices of one account (the harness's `openRealWallet` with one account root, each with its
 * own state directory) and a peer account, each with its own copy of the app's chat store,
 * active-device store and reconciliation tick. The app's chain object forwards every direct
 * message call to the device's own real wallet. A device reads its mailbox with the wallet's
 * `fetchSince`, through `toReceivedMessageWrapper` and `receiveMessages`, as the poll does.
 * BroadcastChannel is removed, so a claim can reach the other device only through the relay.
 *
 *   FRANK_LIVE_RELAY_URL=http://127.0.0.1:18180 FRANK_SOLONET_RPC_URL=http://127.0.0.1:48080 \
 *     yarn --cwd app jest src/stores/leader.devices.live-relay.jest.test.ts
 *
 * It spends nothing and funds nothing: the claims and the step are free, and the test checks
 * that each send paid nothing. The accounts are new each run. Their keys (the account roots the
 * harness writes before anything else) are in a new directory under `FRANK_LIVE_STATE_DIR`
 * (default: the system temp directory; point it at your scratch folder). At the end every
 * account the keys hold is checked on solonet (`FRANK_SOLONET_RPC_URL`), anything found is swept
 * to the faucet, and the directory is deleted only when nothing is left; otherwise it is kept
 * and its path printed (`FRANK_LIVE_KEEP=1` always keeps it).
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { Pinia } from 'pinia'
import type { useChatStore, Conversation } from './chats'
import type { DirectMessageSendResult } from '@frank/wallet/chain'
import type { MessageItem } from '@frank/cashweb/types/messages'
import type { RealWallet } from '../../../packages/bot/demo/real-stack'

const RELAY = process.env.FRANK_LIVE_RELAY_URL
const SOLONET = process.env.FRANK_SOLONET_RPC_URL ?? 'http://127.0.0.1:48080'
const live = RELAY ? describe : describe.skip

interface Disk {
  rows: Map<string, unknown>
  suppressed: Set<string>
}
const mockDisks: { current: Disk } = {
  current: { rows: new Map(), suppressed: new Set() },
}
jest.mock('../adapters/level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: async (row: { index: string }) => {
      mockDisks.current.rows.set(
        row.index,
        JSON.parse(
          JSON.stringify(row, (_key, value) =>
            typeof value === 'bigint' ? value.toString() : value,
          ),
        ),
      )
    },
    deleteMessage: async (index: string) => {
      mockDisks.current.rows.delete(index)
    },
    suppressAndDelete: async (
      _recipient: string,
      digests: string[],
      suppressions: Array<{ payloadDigest: string }>,
    ) => {
      for (const digest of digests) mockDisks.current.rows.delete(digest)
      for (const entry of suppressions)
        mockDisks.current.suppressed.add(entry.payloadDigest)
    },
    suppressedRelayReceipts: async (
      _recipient: string,
      receipts: Array<{ payloadDigest: string }>,
    ) =>
      new Set(
        receipts
          .map(receipt => receipt.payloadDigest)
          .filter(digest => mockDisks.current.suppressed.has(digest)),
      ),
    quarantineRelayReceipts: async () => undefined,
    mostRecentMessageTime: async () => 0,
    relayCursor: async () => 0,
    getIterator: async function* () {
      /* never reloaded */
    },
    financialEnvelopeBindings: async () => [],
    bindFinancialEnvelope: async () => undefined,
  }),
}))
jest.mock('../utils/notifications', () => ({ desktopNotify: jest.fn() }))
jest.mock('../composables/useBalance', () => ({
  useBalance: () => ({ refresh: jest.fn() }),
}))
jest.mock('../utils/directory-peer', () => ({
  fetchContactProfile: jest.fn().mockResolvedValue(undefined),
}))

interface Device {
  name: string
  wallet: RealWallet
  pinia: Pinia
  activate: () => void
  disk: Disk
  chats: ReturnType<typeof useChatStore>
  leader: {
    isActiveMaster: boolean
    myInstanceId: string
    masterInstanceId: string | null
    noteUserActivity(send: unknown): Promise<void>
    claimIdle(): Promise<void>
    resetForTesting(): void
  }
  maintainCalls: Array<{ startNew?: boolean } | undefined>
  sent: Array<{
    items: MessageItem[]
    stampValue?: bigint
    result?: DirectMessageSendResult
    error?: string
  }>
  startClaims: (firstRead: Promise<unknown>) => { stop: () => void }
  userActs: () => Promise<void>
  startTick: () => { stop: () => void }
  stepOperationId: (conversationId: string, key: string) => string
  toWrapper: (record: unknown) => Promise<unknown>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const globals = global as any

live('the active device, through the real relay', () => {
  let stateDir: string
  const relayUrl = RELAY as string
  const devices: Device[] = []
  const stoppers: Array<{ stop: () => void }> = []
  let one: Device
  let two: Device
  let peer: Device
  let savedBroadcastChannel: unknown

  async function openDevice(
    name: string,
    label: string,
    foreground: boolean,
    rootFrom?: string,
  ): Promise<Device> {
    const dir = join(stateDir, name)
    if (rootFrom) {
      mkdirSync(join(dir, 'wallets', label), { recursive: true, mode: 0o700 })
      copyFileSync(
        join(stateDir, rootFrom, 'wallets', label, 'account-root.hex'),
        join(dir, 'wallets', label, 'account-root.hex'),
      )
    }
    let load: (() => Promise<Device>) | undefined
    delete globals.document
    jest.isolateModules(() => {
      /* eslint-disable @typescript-eslint/no-var-requires */
      const {
        openRealWallet,
      } = require('../../../packages/bot/demo/real-stack')
      const { conversationIdSaltOf } = require('@frank/wallet/chain/evm-chain')
      const { createPinia, setActivePinia } = require('pinia')
      const { createApp } = require('vue')
      const chatsModule = require('./chats')
      const leaderModule = require('./leader')
      const adapter = require('../adapters/pinia-chain-adapter')
      const games = require('../utils/automatic-game-steps')
      const { useContactStore } = require('./contacts')
      const { activeChain } = require('@frank/wallet/chain')
      /* eslint-enable @typescript-eslint/no-var-requires */
      load = async () => {
        const wallet: RealWallet = await openRealWallet({
          label,
          relayUrl,
          stateDir: dir,
          network: { rpcChain: 'monad-regtest', networkTag: 'MONR' },
        })
        const pinia = createPinia()
        createApp({}).use(pinia)
        setActivePinia(pinia)
        chatsModule.setConversationIdSalt(conversationIdSaltOf(wallet.handle))
        Object.assign(useContactStore(pinia), {
          refresh: async () => undefined,
        })
        const sent: Device['sent'] = []
        // The app's chain object passes every direct-message call to this device's real wallet.
        const real = wallet.chain.directMessages as unknown as Record<
          string,
          unknown
        >
        const app = activeChain.directMessages as unknown as Record<
          string,
          unknown
        >
        for (const key of Object.keys(app)) {
          if (typeof app[key] !== 'function') continue
          if (typeof real[key] !== 'function') continue
          jest
            .spyOn(app as never, key as never)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .mockImplementation(((params: any) => {
              const call = (real[key] as (p: unknown) => Promise<unknown>).call(
                real,
                params,
              )
              if (key !== 'send') return call
              const entry: Device['sent'][number] = {
                items: params.items,
                stampValue: params.stampValue,
              }
              sent.push(entry)
              return (call as Promise<DirectMessageSendResult>).then(
                result => {
                  entry.result = result
                  return result
                },
                error => {
                  entry.error = String(error?.message ?? error)
                  throw error
                },
              )
            }) as never)
        }
        const maintainCalls: Device['maintainCalls'] = []
        const handle = wallet.handle as unknown as {
          maintainCoins: (o?: { startNew?: boolean }) => Promise<unknown>
        }
        const realMaintain = handle.maintainCoins.bind(handle)
        handle.maintainCoins = async options => {
          maintainCalls.push(options)
          return realMaintain(options)
        }
        const leader = leaderModule.useLeaderStore(pinia)
        const doc = {
          hasFocus: () => foreground,
          visibilityState: foreground ? 'visible' : 'hidden',
        }
        const made: Device = {
          name,
          wallet,
          pinia,
          activate: () => setActivePinia(pinia),
          disk: { rows: new Map(), suppressed: new Set<string>() },
          chats: chatsModule.useChatStore(pinia),
          leader,
          maintainCalls,
          sent,
          startClaims: firstRead => {
            setActivePinia(pinia)
            const saved = globals.document
            globals.document = doc
            try {
              return leaderModule.startActiveDeviceClaims({
                wallet: wallet.handle,
                firstRead,
              })
            } finally {
              globals.document = saved
            }
          },
          userActs: () =>
            leader.noteUserActivity(
              leaderModule.deviceClaimSender(wallet.handle),
            ),
          startTick: () => {
            setActivePinia(pinia)
            return adapter.startOutgoingReconciliation({
              wallet: wallet.handle,
              intervalMs: 300,
              maxIntervalMs: 300,
              idleIntervalMs: 300,
              backgroundIntervalMs: 300,
            })
          },
          stepOperationId: (conversationId, key) =>
            games.automaticStepOperationId(conversationId, key),
          toWrapper: adapter.toReceivedMessageWrapper,
        }
        return made
      }
    })
    globals.document = { hasFocus: () => true }
    if (!load) throw new Error('device was not loaded')
    const made = await load()
    devices.push(made)
    return made
  }

  async function on<T>(
    target: Device,
    act: (chats: Device['chats']) => T | Promise<T>,
  ): Promise<T> {
    mockDisks.current = target.disk
    target.activate()
    return act(target.chats)
  }

  async function sync(target: Device): Promise<void> {
    const records = await target.wallet.chain.directMessages.fetchSince({
      wallet: target.wallet.handle,
      sinceMs: 0,
    })
    const wrappers = []
    for (const record of records) {
      const wrapper = await target.toWrapper(record)
      if (wrapper !== undefined) wrappers.push(wrapper)
    }
    await on(target, chats =>
      chats.receiveMessages(wrappers as never, target.wallet.address),
    )
  }

  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  /** Runs both devices' real reconciliation ticks for a while. */
  async function tickBoth(ms: number) {
    for (const each of [one, two]) each.maintainCalls.length = 0
    const ticks = [one.startTick(), two.startTick()]
    await pause(ms)
    for (const tick of ticks) tick.stop()
    await pause(500)
  }
  const startedNew = (target: Device) =>
    target.maintainCalls.filter(call => call?.startNew === true).length
  const finishedOnly = (target: Device) =>
    target.maintainCalls.filter(call => call?.startNew === false).length

  beforeAll(async () => {
    stateDir = mkdtempSync(
      join(
        process.env.FRANK_LIVE_STATE_DIR ?? tmpdir(),
        'frank-active-device-',
      ),
    )
    savedBroadcastChannel = globals.BroadcastChannel
    delete globals.BroadcastChannel
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    jest.spyOn(console, 'debug').mockImplementation(() => undefined)
    one = await openDevice('device-one', 'me', true)
    two = await openDevice('device-two', 'me', false, 'device-one')
    peer = await openDevice('peer', 'peer', false)
    expect(two.wallet.address).toBe(one.wallet.address)
    expect(peer.wallet.address).not.toBe(one.wallet.address)
  }, 300_000)

  afterAll(async () => {
    for (const each of stoppers) each.stop()
    for (const each of devices) each.leader.resetForTesting()
    for (const each of devices) await each.wallet.close().catch(() => undefined)
    globals.BroadcastChannel = savedBroadcastChannel
    // Nothing here is funded: the claims and the step are free. Every account the run's keys
    // hold is still checked, and anything found goes back to the faucet. The key files are
    // deleted only when nothing is left in them; otherwise their directory is kept and named.
    /* eslint-disable @typescript-eslint/no-var-requires */
    const { findWallets } = require('../../../packages/bot/demo/funds')
    const {
      sweepToFaucet,
    } = require('../../../packages/bot/demo/regtest/monad-regtest')
    const { JsonRpcProvider } = require('ethers')
    /* eslint-enable @typescript-eslint/no-var-requires */
    const provider = new JsonRpcProvider(SOLONET)
    const seen = new Set<string>()
    let held = 0n
    let left = 0n
    let unchecked = 0
    try {
      for (const wallet of await findWallets(stateDir))
        for (const account of wallet.accounts) {
          const address = account.address.toLowerCase()
          if (!account.privateKey || seen.has(address)) continue
          seen.add(address)
          try {
            const balance = BigInt(await provider.getBalance(address))
            held += balance
            if (balance > 0n) {
              await sweepToFaucet(account.privateKey, SOLONET)
              left += BigInt(await provider.getBalance(address))
            }
          } catch (err) {
            unchecked += 1
            process.stderr.write(
              `could not check or sweep ${address}: ${err}\n`,
            )
          }
        }
    } finally {
      provider.destroy()
    }
    process.stderr.write(
      `${seen.size} accounts checked: held ${held} wei, ${left} wei left after sweeping to the faucet\n`,
    )
    if (process.env.FRANK_LIVE_KEEP === '1' || unchecked > 0 || left > 0n)
      process.stderr.write(`the run's keys are kept in ${stateDir}\n`)
    else rmSync(stateDir, { recursive: true, force: true })
  }, 300_000)

  it("a claim reaches the account's other device through its mailbox, and only the claiming device starts merges", async () => {
    let readOne: () => void = () => undefined
    let readTwo: () => void = () => undefined
    stoppers.push(one.startClaims(new Promise<void>(r => (readOne = r))))
    stoppers.push(two.startClaims(new Promise<void>(r => (readTwo = r))))
    await sync(one)
    readOne()
    await sync(two)
    readTwo()
    await pause(200)
    await one.leader.claimIdle()
    // Device one, open in the foreground, claimed; device two, hidden, did not.
    const claims = (target: Device) =>
      target.sent.filter(s => s.items.some(i => i.type === 'device-claim'))
    expect(claims(one)).toHaveLength(1)
    expect(claims(one)[0].error).toBeUndefined()
    expect(claims(one)[0].result?.stampValueWei).toBe(0n)
    expect(claims(one)[0].result?.stampPayments).toEqual([])
    expect(claims(one)[0].result?.preparationTxHashes).toEqual([])
    expect(claims(two)).toHaveLength(0)
    expect(one.leader.isActiveMaster).toBe(true)

    // Device two learns it from its mailbox.
    await sync(two)
    expect(two.leader.masterInstanceId).toBe(one.leader.myInstanceId)
    expect(two.leader.isActiveMaster).toBe(false)

    await tickBoth(4_000)
    expect(startedNew(one)).toBeGreaterThan(0)
    expect(startedNew(two)).toBe(0)
    expect(finishedOnly(two)).toBeGreaterThan(0)

    // The user acts on device two: it claims, and device one reads that from the relay.
    await two.userActs()
    await two.leader.claimIdle()
    expect(claims(two)).toHaveLength(1)
    expect(claims(two)[0].error).toBeUndefined()
    expect(claims(two)[0].result?.stampValueWei).toBe(0n)
    expect(one.leader.isActiveMaster).toBe(true)
    await sync(one)
    expect(one.leader.masterInstanceId).toBe(two.leader.myInstanceId)
    expect(one.leader.isActiveMaster).toBe(false)
    expect(two.leader.isActiveMaster).toBe(true)

    await tickBoth(4_000)
    expect(startedNew(one)).toBe(0)
    expect(finishedOnly(one)).toBeGreaterThan(0)
    expect(startedNew(two)).toBeGreaterThan(0)

    // Reading everything again changes nothing.
    await sync(one)
    await sync(two)
    expect(two.leader.isActiveMaster).toBe(true)
    expect(one.leader.isActiveMaster).toBe(false)
  }, 600_000)

  it('an automatic step sent by both devices is one message at the peer and on each sender', async () => {
    const peerShown = peer.wallet.address
    const conversationId = await on(
      one,
      chats =>
        chats.openDirectConversation(peerShown, [one.wallet.address, peerShown])
          .id,
    )
    const sameOnTwo = await on(
      two,
      chats =>
        chats.openDirectConversation(peerShown, [two.wallet.address, peerShown])
          .id,
    )
    expect(sameOnTwo).toBe(conversationId)

    const items = [{ type: 'text', text: 'the live reveal' }] as MessageItem[]
    const operationId = one.stepOperationId(conversationId, 'dice:live-1')
    expect(two.stepOperationId(conversationId, 'dice:live-1')).toBe(operationId)
    const outcomes: unknown[] = []
    for (const each of [one, two]) {
      try {
        outcomes.push(
          await on(each, chats =>
            chats.sendMessage({
              wallet: each.wallet.handle as never,
              address: peerShown,
              conversationId,
              items,
              stampValue: 0n,
              operationId,
            }),
          ),
        )
      } catch (err) {
        outcomes.push({ thrown: String(err) })
      }
    }
    process.stderr.write(
      `step send outcomes: ${JSON.stringify(outcomes, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      )}\n`,
    )
    const stepSends = (target: Device) =>
      target.sent.filter(s =>
        s.items.some(i => i.type === 'text' && i.text === 'the live reveal'),
      )
    process.stderr.write(
      `step sends: ${JSON.stringify(
        [one, two].map(each =>
          stepSends(each).map(s => ({
            device: each.name,
            stampValue: s.stampValue,
            error: s.error,
            digest: s.result?.payloadDigest,
            stampValueWei: s.result?.stampValueWei,
            payments: s.result?.stampPayments?.length,
          })),
        ),
        (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      )}\n`,
    )

    const report = (target: Device) => {
      const conversation = target.chats.conversations[conversationId] as
        | Conversation
        | undefined
      return (conversation?.messages ?? []).map(m => ({
        outbound: m.outbound,
        status: m.status,
        text: m.items.flatMap(i => (i.type === 'text' ? [i.text] : [])),
        stampValueWei: m.stampValueWei?.toString(),
        digest: m.payloadDigest,
        logicalMessageId: m.logicalMessageId,
      }))
    }
    // Let the relay deliver, then everyone reads (twice, in both orders).
    for (let round = 0; round < 10; round++) {
      await pause(3_000)
      for (const each of [one, two, peer]) await sync(each)
      const peerHolds = report(peer).length
      if (peerHolds >= 1 && round >= 2) break
    }
    for (const each of [two, one, peer, peer, one, two]) await sync(each)
    process.stderr.write(
      `shown: ${JSON.stringify({
        one: report(one),
        two: report(two),
        peer: report(peer),
      })}\n`,
    )
    // Both devices sent it, and it cost nothing.
    for (const each of [one, two]) {
      const sends = stepSends(each)
      expect(sends).toHaveLength(1)
      expect(sends[0].error).toBeUndefined()
      expect(sends[0].result?.stampValueWei).toBe(0n)
      expect(sends[0].result?.stampPayments ?? []).toEqual([])
      expect(sends[0].result?.preparationTxHashes ?? []).toEqual([])
    }
    for (const each of [one, two]) {
      const held = report(each)
      expect(held).toHaveLength(1)
      expect(held[0].outbound).toBe(true)
      expect(held[0].status).not.toBe('error')
    }
    const atPeer = report(peer)
    expect(atPeer.every(m => !m.outbound)).toBe(true)
    expect(atPeer).toHaveLength(1)
  }, 600_000)
})
