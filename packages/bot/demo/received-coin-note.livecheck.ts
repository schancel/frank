/**
 * A received coin's note to self, through the REAL relay binary: the relay accepts the free note
 * a wallet writes to itself about a coin, keeps it, and hands it to a second wallet of the same
 * account, which finds the coin from the note alone.
 *
 * It spends NOTHING and needs no funded wallet: the note is a free message, and the coin here is
 * a claim (a stealth payment item addressed to the account's own key, with no transfer behind
 * it). No message that could lead to the coin is ever sent, so the only way the second wallet
 * can learn of it is the note in the account's own mailbox. That a coin found this way is really
 * SPENT from is not shown here (it needs money): that is
 * packages/wallet/chain/received-payments.anvil.integration.ts, on a real EVM node.
 *
 *   FRANK_DEMO_ENV_FILE=/path/to/.env \            # MONAD_TESTNET_HTTP_RPC_URL, read by the relay
 *   COIN_NOTE_LIVECHECK_DIR=/path/outside/the/repo \
 *   TSX_TSCONFIG_PATH=packages/bot/tsconfig.json node --import tsx \
 *     packages/bot/demo/received-coin-note.livecheck.ts
 *
 * `COIN_NOTE_LIVECHECK_RELAY_URL` uses a relay that is already running; otherwise this starts
 * the real relay (`backend/cashweb/run-local-monad.sh`) on a free port, with its database under
 * the directory, and stops it afterwards. `COIN_NOTE_LIVECHECK_DIR/roots.json` holds the
 * account's roots (created when missing, mode 600, never printed). The account never holds
 * money. Each run uses new wallet state directories beside it.
 *
 * What it shows, in order:
 *  1. a wallet records a coin and, after a mailbox read, sends its note: the real relay accepts
 *     a free message to self carrying the `received-coin` item;
 *  2. a second wallet, opened from the same roots with empty state, reads its mailbox from the
 *     real relay: the note is applied through the wallet sync boundary, the coin did not exist
 *     before it and exists after it, pending, with the same account;
 *  3. no chat message is handed on for the note, and the second wallet writes no note of its own;
 *  4. a third read changes nothing.
 */
import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { hexlify } from 'ethers'
import type { ReceivedCoinItem } from '@frank/cashweb/types/messages'
import type { MonadRootBundle } from '@frank/wallet/chain/active-chain'
import { installMessageItemRegistry } from '@frank/wallet/chain/monad-canonical-dm'
import {
  createEvmChain,
  installCanonicalDirectory,
} from '@frank/wallet/chain/monad-chain'
import type { EvmChainWalletHandle } from '@frank/wallet/evm-wallet-handle'
import { createDefaultMessageItemRegistry } from '@frank/wallet/message-item-plugins/default-registry'
import { pluginCapabilitiesNotYetAvailable } from '@frank/wallet/message-item-plugins/registry'
import { registerMonadIdentity } from '@frank/wallet/monad-identity'
import { deriveEvmStealthAddress } from '@frank/wallet/monad-stealth'
import { DirectoryManager } from '@frank/bot-framework/directory-manager'

import { freePort, startRealRelay, type RealRelay } from './real-stack'

const CHAIN = 'monad-testnet'
const PURPOSES = [
  'evm-wallet',
  'identity-authentication',
  'messaging-encryption',
] as const

function loadRoots(dir: string): MonadRootBundle {
  const file = join(dir, 'roots.json')
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      file,
      JSON.stringify(
        Object.fromEntries(
          PURPOSES.map(purpose => [purpose, randomBytes(32).toString('hex')]),
        ),
      ),
      { mode: 0o600 },
    )
  }
  const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<
    string,
    string
  >
  const root = (purpose: (typeof PURPOSES)[number]) => ({
    registry: 'frank-domain-roots-v1' as const,
    purpose,
    bytes: Uint8Array.from(Buffer.from(stored[purpose]!, 'hex')),
  })
  return {
    evm: root('evm-wallet'),
    authentication: root('identity-authentication'),
    messaging: root('messaging-encryption'),
  } as MonadRootBundle
}

/** A wallet with messaging, as a host composes one: directory entry published and installed. */
async function openWallet(relayBaseUrl: string, dir: string, state: string) {
  const chain = createEvmChain({
    networkId: CHAIN,
    chainIdentifier: CHAIN,
    chainId: 10143,
    rpcChain: CHAIN,
    relayBaseUrl,
    networkTag: 'MONT',
    stampBurnAddress:
      process.env.MONAD_STAMP_BURN_ADDRESS ??
      '0x000000000000000000000000000000000000dEaD',
    defaultStampValueWei: 10n ** 12n,
    defaultTopicVoteValueWei: 10n ** 12n,
    subAccountPoolSize: 0,
    walletStorageLocation: join(dir, state, 'wallet'),
  })
  mkdirSync(join(dir, state), { recursive: true })
  // Every message this wallet hands the relay, and how the relay answered. The note pass
  // swallows a failure; here it is said.
  const sent: { items: string[]; payloadDigest?: string; error?: string }[] = []
  const send = chain.directMessages.send.bind(chain.directMessages)
  chain.directMessages.send = async params => {
    const entry: (typeof sent)[number] = {
      items: params.items.map(item => item.type),
    }
    sent.push(entry)
    try {
      const result = await send(params)
      entry.payloadDigest = result.payloadDigest
      return result
    } catch (error) {
      entry.error =
        error instanceof Error ? `${error.name}: ${error.message}` : `${error}`
      throw error
    }
  }
  const wallet = (await chain.createWallet(
    loadRoots(dir),
  )) as EvmChainWalletHandle
  await registerMonadIdentity({
    relayBaseUrl,
    identity: wallet.identity,
    profile: { name: 'coin note livecheck' },
  }).catch(() => undefined)
  const directory = DirectoryManager.create({
    handle: wallet,
    networkTag: 'MONT',
    relayBaseUrl,
    location: join(dir, state, 'directory'),
  })
  await directory.publishWithRetry('coin-note-livecheck')
  const removeDirectory = installCanonicalDirectory(
    wallet,
    directory.rawDirectory,
  )
  const removeItems = installMessageItemRegistry(
    wallet,
    createDefaultMessageItemRegistry(pluginCapabilitiesNotYetAvailable),
  )
  return {
    chain,
    wallet,
    sent,
    close: async () => {
      removeItems()
      removeDirectory()
      await directory.close()
      await wallet.close()
    },
  }
}

function check(what: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`)
  if (!ok) throw new Error(`failed: ${what}`)
}

async function main(): Promise<void> {
  const dir = process.env.COIN_NOTE_LIVECHECK_DIR
  if (!dir) throw new Error('Set COIN_NOTE_LIVECHECK_DIR')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  let relay: RealRelay | undefined
  let relayBaseUrl = process.env.COIN_NOTE_LIVECHECK_RELAY_URL
  if (!relayBaseUrl) {
    relay = await startRealRelay({ port: await freePort(), stateDir: dir })
    relayBaseUrl = relay.url
  }
  const run = `run-${Date.now()}`
  console.log(`relay ${relayBaseUrl} (${relay ? 'started here' : 'given'}), ${run}`)
  try {
    // 1. Device one: a coin, and its note.
    const first = await openWallet(relayBaseUrl, dir, `${run}-a`)
    let address: string
    let ephemeralPubKey: string
    const payloadDigest = randomBytes(32).toString('hex')
    try {
      const destination = deriveEvmStealthAddress({
        recipientSpendPubKey: first.wallet.identity.compressedPubKey,
      })
      address = destination.stealthAddress.toLowerCase()
      ephemeralPubKey = hexlify(destination.ephemeralPubKey).slice(2)
      await first.wallet.recordStealthPayment(
        {
          type: 'stealth',
          networkTag: 'MONT',
          keyType: 1,
          ephemeralPubKey,
          // A hash the chain does not know: a claim, with no money behind it.
          transactions: [randomBytes(32).toString('hex')],
          amount: 1,
          amountWei: '1',
        },
        { payloadDigest, timestampMs: Date.now() },
      )
      check(
        'device one holds the coin',
        first.wallet.getReceivedPayments!().some(c => c.address === address),
        address,
      )
      // The coin list's first read of the whole mailbox, then the note pass.
      await first.chain.directMessages.fetchSince({
        wallet: first.wallet,
        sinceMs: 0,
      })
      await first.wallet.noteReceivedCoins!()
      const notes = first.sent.filter(entry =>
        entry.items.includes('received-coin'),
      )
      check(
        'the real relay accepted the free note to self',
        notes.length >= 1 && notes.every(entry => entry.error === undefined),
        JSON.stringify(notes),
      )
      // Reading it back and passing again sends nothing more.
      await first.chain.directMessages.fetchSince({
        wallet: first.wallet,
        sinceMs: 0,
      })
      await first.wallet.noteReceivedCoins!()
      check(
        'device one writes the note once',
        first.sent.filter(entry => entry.items.includes('received-coin'))
          .length === notes.length,
      )
    } finally {
      await first.close()
    }

    // 2. Device two: the same roots, empty state.
    const second = await openWallet(relayBaseUrl, dir, `${run}-b`)
    try {
      check(
        'device two starts with no coin',
        second.wallet.getReceivedPayments!().length === 0,
      )
      const applied: { note: ReceivedCoinItem; knownBefore: boolean }[] = []
      const record = second.wallet.recordReceivedCoin!.bind(second.wallet)
      second.wallet.recordReceivedCoin = async note => {
        applied.push({
          note,
          knownBefore: second.wallet
            .getReceivedPayments!()
            .some(c => c.address === note.address.toLowerCase()),
        })
        return record(note)
      }
      const messages = await second.chain.directMessages.fetchSince({
        wallet: second.wallet,
        sinceMs: 0,
      })
      const mine = applied.find(
        entry => entry.note.address.toLowerCase() === address,
      )
      check(
        'the relay handed device two the note, and the coin was not known before it',
        mine !== undefined && !mine.knownBefore,
        JSON.stringify(mine?.note),
      )
      const coin = second.wallet
        .getReceivedPayments!()
        .find(c => c.address === address)
      check(
        'device two holds the coin, from the note alone, as a claim until the chain is read',
        coin !== undefined &&
          coin.origin === 'stealth' &&
          coin.ephemeralPubKey === ephemeralPubKey &&
          coin.payloadDigest === payloadDigest &&
          coin.claimedAmountWei === 1n &&
          !coin.spendable,
        JSON.stringify(coin, (_k, v) =>
          typeof v === 'bigint' ? v.toString() : v,
        ),
      )
      check(
        'no chat message is handed on for the note',
        messages.every(m => m.items.every(i => i.type !== 'received-coin')),
        `${messages.length} message(s)`,
      )
      // 3. It read the note, so it writes none.
      await second.wallet.noteReceivedCoins!()
      check(
        'device two sends no note of its own',
        second.sent.length === 0,
        JSON.stringify(second.sent),
      )
      // 4. Again: the same coins.
      const before = second.wallet.getReceivedPayments!().length
      await second.chain.directMessages.fetchSince({
        wallet: second.wallet,
        sinceMs: 0,
      })
      check(
        'a second read adds nothing',
        second.wallet.getReceivedPayments!().length === before,
        `${before} coin(s)`,
      )
    } finally {
      await second.close()
    }
    console.log('PASS')
  } finally {
    await relay?.stop()
  }
}

if (require.main === module)
  main().then(
    () => process.exit(0),
    error => {
      console.error(error)
      process.exit(1)
    },
  )
