/**
 * The command line's messaging account.
 *
 * Messages are sent and read as an account: three keys derived from one account root, a
 * directory entry published on the relay, and a wallet that pays for stamps. The account root is
 * 32 random bytes kept in `<data dir>/account/account-root.hex` (mode 0600), created the first
 * time a message command runs and reused after that, the same way a bot keeps its own.
 *
 * This is a different key from the mnemonic identity the balance, sweep and topic commands use,
 * so the account has its own address. A paid message is paid from the account's own main address,
 * which has to hold the stamp and its fee.
 */
import { createHash, randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

import { DirectoryManager } from '@frank/bot-framework/directory-manager'
import { RelayProfileManager } from '@frank/bot-framework/relay-profile-manager'
import type { MessageItem } from '@frank/cashweb/types/messages'
import { deriveDomainRoot } from '@frank/domain-roots'
import type { DirectMessageReceived } from '@frank/wallet/chain/active-chain'
import { installMessageItemRegistry } from '@frank/wallet/chain/monad-canonical-dm'
import {
  createEvmChain,
  installCanonicalDirectory,
  loadMonadChainConfigFromEnv,
} from '@frank/wallet/chain/monad-chain'
import type { EvmChainWalletHandle } from '@frank/wallet/evm-wallet-handle'
import { createMonadWalletMaterial } from '@frank/wallet/monad-wallet-material'
import { createDefaultMessageItemRegistry } from '@frank/wallet/message-item-plugins/default-registry'
import { pluginCapabilitiesNotYetAvailable } from '@frank/wallet/message-item-plugins/registry'

import type { SignetConfig } from './config'

export interface CliAccount {
  /** The account's address: what a correspondent sends to. */
  address: string
  /** The address that pays for this account's stamps. */
  mainAccount: string
  /** Sends one message and waits until the relay has delivered it. Returns its payload digest.
   * A message an earlier run handed to the relay and could not confirm is followed to its end
   * instead: the same message is never sent, or paid for, a second time. */
  send(to: string, items: MessageItem[], stampValueWei: bigint): Promise<string>
  /** Messages received at or after `sinceMs`, oldest first. */
  receivedSince(sinceMs: number): Promise<DirectMessageReceived[]>
  close(): Promise<void>
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function accountRootFile(dataDir: string): string {
  return join(dataDir, 'account', 'account-root.hex')
}

function rootsOf(rootHex: string) {
  const accountRoot = Uint8Array.from(Buffer.from(rootHex, 'hex'))
  try {
    return {
      evm: deriveDomainRoot(accountRoot, 'evm-wallet'),
      authentication: deriveDomainRoot(accountRoot, 'identity-authentication'),
      messaging: deriveDomainRoot(accountRoot, 'messaging-encryption'),
    }
  } finally {
    accountRoot.fill(0)
  }
}

/** The messaging account's address and the address that pays for its stamps, or undefined when
 * no message command has run yet (the account is created by the first one). Reads the root
 * file; contacts nothing. */
export function cliAccountAddresses(
  dataDir: string,
): { address: string; mainAccount: string } | undefined {
  const rootFile = accountRootFile(dataDir)
  if (!existsSync(rootFile)) return undefined
  const rootHex = readFileSync(rootFile, 'utf8').trim()
  if (!/^[0-9a-f]{64}$/i.test(rootHex)) return undefined
  const material = createMonadWalletMaterial(rootsOf(rootHex))
  try {
    return {
      address: material.identity.address.raw,
      mainAccount: material.mainAccount.address,
    }
  } finally {
    material.dispose()
  }
}

/** Messages handed to the relay whose delivery no run has confirmed yet: what was asked for
 * (recipient, items and stamp, hashed) mapped to the payload digest of the message sent for it. */
function readUnconfirmed(file: string): Record<string, string> {
  if (!existsSync(file)) return {}
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
}

function writeUnconfirmed(file: string, entries: Record<string, string>): void {
  const next = `${file}.next`
  writeFileSync(next, JSON.stringify(entries), { mode: 0o600 })
  renameSync(next, file)
}

/**
 * Sends one message, or follows the one an earlier run already handed to the relay for the same
 * request, until the relay has delivered it. Returns its payload digest.
 *
 * `file` records each message from the moment it may have reached the relay until it is known
 * delivered or dead. While a request has a record, running it again resumes that message.
 */
export async function sendOrResume(params: {
  file: string
  to: string
  items: MessageItem[]
  stampValueWei: bigint
  /** Sends a new message. Calls `onAttemptCreated` once it may reach the relay. */
  send(onAttemptCreated: (digest: string) => void): Promise<string>
  /** What the wallet and relay now know about a message; re-submits its same bytes if needed. */
  status(digest: string): Promise<string>
  waitMs?: number
  pollMs?: number
}): Promise<string> {
  const key = createHash('sha256')
    .update(
      JSON.stringify([params.to.toLowerCase(), params.items, params.stampValueWei.toString()]),
    )
    .digest('hex')
  const forget = () => {
    const entries = readUnconfirmed(params.file)
    delete entries[key]
    writeUnconfirmed(params.file, entries)
  }
  let digest: string | undefined = readUnconfirmed(params.file)[key]
  if (digest === undefined) {
    try {
      const sent = await params.send(created => {
        digest = created
        writeUnconfirmed(params.file, { ...readUnconfirmed(params.file), [key]: created })
      })
      if (digest !== undefined) forget()
      return sent
    } catch (err) {
      // Nothing was handed to the relay: the send simply failed.
      if (digest === undefined) throw err
    }
  }
  // The relay may have the message although its answer was lost, or an earlier run stopped
  // here. The same message is followed to its end; a second one is never sent in its place.
  const deadline = Date.now() + (params.waitMs ?? 180_000)
  for (;;) {
    const status = await params.status(digest)
    if (status === 'delivered') {
      forget()
      return digest
    }
    if (status === 'dead') {
      forget()
      throw new Error(
        `The relay will never deliver message ${digest}. Nothing more can land for it; running the command again sends a new message.`,
      )
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Message ${digest} was handed to the relay but is not confirmed delivered (status ${status}). Run the same command again to follow this message: it resumes it and does not send or pay again.`,
      )
    }
    await sleep(params.pollMs ?? 3000)
  }
}

export async function openCliAccount(params: {
  dataDir: string
  config: SignetConfig
  relayUrl?: string
}): Promise<CliAccount> {
  const relayBaseUrl = (params.relayUrl ?? params.config.relayUrl).replace(/\/+$/, '')
  const dir = join(params.dataDir, 'account')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const rootFile = accountRootFile(params.dataDir)
  if (!existsSync(rootFile)) {
    writeFileSync(rootFile, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' })
  }
  const rootHex = readFileSync(rootFile, 'utf8').trim()
  if (!/^[0-9a-f]{64}$/i.test(rootHex)) {
    throw new Error(`${rootFile} is not a 32-byte account root; it is left untouched`)
  }
  const roots = rootsOf(rootHex)

  const networkTag = params.config.networkTag
  if (networkTag !== 'MONT' && networkTag !== 'MON1') {
    throw new Error(`Messages are sent on Monad (network tag MONT or MON1), not "${networkTag}"`)
  }
  const chain = createEvmChain({
    ...loadMonadChainConfigFromEnv({ isTestnet: params.config.chainId !== 143 }),
    relayBaseUrl,
    networkTag,
    stampBurnAddress: params.config.stampBurnAddress,
    walletStorageLocation: join(dir, 'chain-storage'),
    subAccountPoolSize: 1,
  })
  const handle = (await chain.createWallet(roots)) as EvmChainWalletHandle
  const directory = DirectoryManager.create({
    handle,
    networkTag,
    relayBaseUrl,
    location: join(dir, 'directory'),
  })
  // The helpers below report progress with console.log. A command's standard output is its
  // result (JSON with --json), so progress goes to standard error while they run.
  const log = console.log
  console.log = (...args: unknown[]) => console.error(...args)
  try {
    await directory.publishWithRetry('cli')
    installCanonicalDirectory(handle, directory.rawDirectory)
    installMessageItemRegistry(
      handle,
      createDefaultMessageItemRegistry(pluginCapabilitiesNotYetAvailable),
    )
    await RelayProfileManager.registerProfile({
      relayBaseUrl,
      identity: handle.identity,
      label: 'cli',
      profile: { name: 'cli', bot: false },
    })
  } catch (err) {
    await directory.close().catch(() => {})
    await handle.close().catch(() => {})
    throw err
  } finally {
    console.log = log
  }

  return {
    address: handle.identity.address.raw,
    mainAccount: (await handle.getReceiveAddress()).raw,
    send(to, items, stampValueWei) {
      return sendOrResume({
        file: join(dir, 'unconfirmed-sends.json'),
        to,
        items,
        stampValueWei,
        send: async onAttemptCreated =>
          (
            await chain.directMessages.send({
              wallet: handle,
              recipient: { raw: to },
              items,
              stampValue: stampValueWei,
              onAttemptCreated,
            })
          ).payloadDigest,
        status: async digest =>
          (
            await chain.directMessages.reconcileAttempts({
              wallet: handle,
              payloadDigests: [digest],
            })
          )[digest],
      })
    },
    async receivedSince(sinceMs) {
      const messages = await chain.directMessages.fetchSince({ wallet: handle, sinceMs })
      return messages
        .filter(message => !message.outbound)
        .sort((a, b) => a.receivedTime - b.receivedTime)
    },
    async close() {
      await directory.close()
      await handle.close()
    },
  }
}
