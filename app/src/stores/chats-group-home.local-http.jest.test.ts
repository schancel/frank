/** @jest-environment jsdom */
/** Actual typed chat store -> actual Rust router, with a disposable identity and in-memory relay. */
import { spawn } from 'child_process'
import { createInterface } from 'readline'
import axios from 'axios'
import { createPinia, setActivePinia } from 'pinia'
import { createApp } from 'vue'
import { developmentBuildActions } from '../../test/jest/utils/pinia-dev-build'
import {
  GROUP_TEST_ACCOUNTS,
  groupTestSigner,
} from '@frank/cashweb/groups/group-test.testutil'
import { verifyEpochFrame } from '@frank/cashweb/groups/group-crypto'
import { accountSession } from '../accounts/session'
import { useChatStore, setConversationIdSalt } from './chats'

jest.mock('../adapters/level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: jest.fn(),
    deleteMessage: jest.fn(),
    mostRecentMessageTime: async () => 0,
    getIterator: async () => [],
  }),
}))
jest.mock('../utils/identity-session', () => ({
  messagingWallet: () => undefined,
}))
jest.mock('../utils/notifications', () => ({
  errorNotify: jest.fn(),
  desktopNotify: jest.fn(),
}))

const fixture = process.env.FRANK_GROUP_HTTP_FIXTURE
const run = fixture ? test : test.skip
run(
  'creates and reads a real Rust-hosted group using installed home through per-action Pinia proxies',
  async () => {
    const server = spawn(fixture!, [], { stdio: ['ignore', 'pipe', 'inherit'] })
    const lines = createInterface({ input: server.stdout! })
    let stopHome: (() => void) | undefined
    const previousAdapter = axios.defaults.adapter
    const [alice] = GROUP_TEST_ACCOUNTS
    const publicKey = jest
      .spyOn(accountSession, 'getCurvePublicKey')
      .mockResolvedValue(alice.publicKey)
    const signer = jest
      .spyOn(accountSession, 'getGroupSigner')
      .mockImplementation(async (group, epoch) =>
        groupTestSigner(alice.address, group, epoch),
      )
    try {
      const home = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Rust fixture startup timed out')),
          10000,
        )
        server.once('exit', code => {
          clearTimeout(timer)
          reject(new Error(`Rust fixture exited ${code}`))
        })
        lines.once('line', line => {
          clearTimeout(timer)
          resolve(line.trim())
        })
      })
      expect(home).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      // jsdom otherwise picks XHR and enforces browser CORS across fixture origins.
      axios.defaults.adapter = jest.requireActual('axios/lib/adapters/http')
      const pinia = createPinia().use(developmentBuildActions)
      createApp({}).use(pinia)
      setActivePinia(pinia)
      setConversationIdSalt(new Uint8Array(16).fill(0x75))
      const chats = useChatStore()
      chats.flushPersistence = jest.fn(async () => undefined)
      stopHome = chats.configureGroupHomeRelay(home)
      expect(chats.getGroupHomeRelay()).toBe(home)
      const group = await chats.createGroupConversation({
        groupName: 'Disposable HTTP group',
        memberAddresses: [],
        creatorAddress: alice.address,
      })
      expect(group.kind).toBe('group')
      expect(group.membershipStatus).toBe('joined')
      expect(group.groupState?.homeRelay).toBe(home)
      expect(group.groupState?.pendingEpoch).toBeUndefined()
      const stored = await chats
        .getGroupRelayClient()
        .getLatestEpoch(group.groupId!)
      expect(verifyEpochFrame(stored, group.groupId!, group.groupPubKey!)).toBe(
        true,
      )
      expect(stored.epoch).toBe(0)
      expect(chats.flushPersistence).toHaveBeenCalled()
      // No wallet is installed in this fixture: the self welcome remains queued; no DM is sent.
      expect(
        Object.keys(group.groupState?.pendingMemberDeliveries ?? {}),
      ).toEqual([alice.address])
    } finally {
      stopHome?.()
      publicKey.mockRestore()
      signer.mockRestore()
      axios.defaults.adapter = previousAdapter
      lines.close()
      if (server.exitCode === null) {
        const exited = new Promise(resolve => server.once('exit', resolve))
        server.kill('SIGTERM')
        await exited
      }
    }
  },
  20000,
)
