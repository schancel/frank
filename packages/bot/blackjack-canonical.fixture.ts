/**
 * Test-only stand-in for the wallet's canonical direct-message client, with its durable facts in
 * an append-only file so a killed child process and its parent see the same history. It models
 * the contract `@frank/wallet/chain/monad-canonical-dm` gives a consumer:
 *
 *  - `send` refuses while an earlier payment set is unresolved;
 *  - the payment set and its link are durable BEFORE `onAttemptCreated` runs, and that callback
 *    is awaited before the relay is contacted;
 *  - `reconcileAttempts`/`unattributedAttempts` re-send the same set and never make a new one.
 *
 * `kill` names one barrier at which the process SIGKILLs itself with no Close.
 */
import { randomBytes } from 'crypto'
import { appendFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'

import type { DirectMessageClient } from '@frank/wallet/chain/active-chain'

import {
  BlackjackCanonicalOutbox,
  BlackjackCanonicalStore,
} from './blackjack-canonical'

export type FakeRelay = 'delivered' | 'fail' | 'retained' | 'dead'
export const KILL_POINTS = [
  'send-called',
  'linked',
  'attempt-saved',
  'relay-accepted',
  'delivered-recorded',
  'drive-returned',
] as const

export function fileWallet(
  root: string,
  options: { kill?: string; relay?: FakeRelay } = {},
) {
  const path = join(root, 'wallet-events.log')
  const events = (): string[] =>
    existsSync(path)
      ? readFileSync(path, 'utf8').split('\n').filter(Boolean)
      : []
  const record = (event: string) => appendFileSync(path, event + '\n')
  const dieAt = (point: string) => {
    if (options.kill === point) process.kill(process.pid, 'SIGKILL')
  }
  const state = { relay: options.relay ?? ('delivered' as FakeRelay) }
  const of = (prefix: string) =>
    events()
      .filter(event => event.startsWith(prefix + ':'))
      .map(event => event.split(':')[1])
  const outcome = (digest: string) =>
    of('delivered').includes(digest)
      ? 'delivered'
      : of('dead').includes(digest)
      ? 'dead'
      : 'live'
  /** One PUT of the journaled set; throws when the outcome stays unknown. */
  const put = (digest: string) => {
    if (state.relay === 'fail') throw new Error('relay unreachable')
    record(`put:${digest}`)
    dieAt('relay-accepted')
    if (state.relay === 'retained') throw new Error('retained')
    record(`${state.relay === 'dead' ? 'dead' : 'delivered'}:${digest}`)
    dieAt('delivered-recorded')
  }
  const settle = () => {
    for (const digest of of('link'))
      if (outcome(digest) === 'live')
        try {
          put(digest)
        } catch {
          // Unknown outcome: the same set is offered again on a later pass.
        }
  }
  const messages: Pick<
    DirectMessageClient,
    'send' | 'reconcileAttempts' | 'unattributedAttempts'
  > = {
    async send(params) {
      dieAt('send-called')
      settle()
      if (of('link').some(digest => outcome(digest) === 'live'))
        throw new Error('pending attempt')
      const digest = randomBytes(32).toString('hex')
      record(`seal:${digest}:${JSON.stringify(params.items)}`)
      record(`link:${digest}`)
      dieAt('linked')
      await params.onAttemptCreated?.(digest)
      dieAt('attempt-saved')
      put(digest)
      if (outcome(digest) !== 'delivered') throw new Error('terminal')
      return {
        payloadDigest: digest,
        stampValueWei: params.stampValue ?? 0n,
        stampPayments: [],
        preparationTxHashes: [],
      }
    },
    async reconcileAttempts(params) {
      settle()
      return Object.fromEntries(
        params.payloadDigests.map(digest => [
          digest,
          of('link').includes(digest) ? outcome(digest) : 'unknown',
        ]),
      )
    },
    async unattributedAttempts(params) {
      settle()
      return of('link').filter(
        digest =>
          outcome(digest) !== 'dead' && !params.knownDigests.includes(digest),
      )
    },
  }
  return { messages, events, state, dieAt }
}

/** Child-process entry: save one reply, drive it, and die at the configured barrier. */
export async function runOutboxChild(): Promise<void> {
  const root = process.env.BLACKJACK_OUTBOX_ROOT!
  const store = new BlackjackCanonicalStore(root)
  await store.Open()
  const wallet = fileWallet(root, {
    kill: process.env.BLACKJACK_OUTBOX_KILL,
    relay: (process.env.BLACKJACK_OUTBOX_RELAY ?? 'delivered') as FakeRelay,
  })
  const outbox = new BlackjackCanonicalOutbox({
    store,
    messages: wallet.messages,
    wallet: {} as never,
    stampValueWei: 1n,
  })
  await outbox.enqueue('inbound-1:0', '0x' + 'aa'.repeat(20), [
    { type: 'text', text: 'REPLY_SENTINEL' },
  ])
  const delivered = await outbox.drive()
  wallet.dieAt('drive-returned')
  console.log(`CHILD_DELIVERED ${delivered}`)
  // No Close: the parent reopens whatever a killed or abandoned process left behind.
  process.kill(process.pid, 'SIGKILL')
}
