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
import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
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
import { MonadIdentity } from '@frank/wallet/monad-identity'
import { createDefaultMessageItemRegistry } from '@frank/wallet/message-item-plugins/default-registry'
import { pluginCapabilitiesNotYetAvailable } from '@frank/wallet/message-item-plugins/registry'

import type { SignetConfig } from './config'

export interface CliAccount {
  /** The account's address: what a correspondent sends to. */
  address: string
  /** The address that pays for this account's stamps. */
  mainAccount: string
  /** Sends one message and waits until the relay has delivered it. Returns its payload digest. */
  send(to: string, items: MessageItem[], stampValueWei: bigint): Promise<string>
  /** Messages received at or after `sinceMs`, oldest first. */
  receivedSince(sinceMs: number): Promise<DirectMessageReceived[]>
  close(): Promise<void>
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function accountRootFile(dataDir: string): string {
  return join(dataDir, 'account', 'account-root.hex')
}

/** The messaging account's address, or undefined when no message command has run yet (the
 * account is created by the first one). Reads the root file; contacts nothing. */
export function cliAccountAddress(dataDir: string): string | undefined {
  const rootFile = accountRootFile(dataDir)
  if (!existsSync(rootFile)) return undefined
  const rootHex = readFileSync(rootFile, 'utf8').trim()
  if (!/^[0-9a-f]{64}$/i.test(rootHex)) return undefined
  const accountRoot = Uint8Array.from(Buffer.from(rootHex, 'hex'))
  try {
    return MonadIdentity.fromDomainRoot(deriveDomainRoot(accountRoot, 'identity-authentication'))
      .address.raw
  } finally {
    accountRoot.fill(0)
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
  const accountRoot = Uint8Array.from(Buffer.from(rootHex, 'hex'))
  const roots = {
    evm: deriveDomainRoot(accountRoot, 'evm-wallet'),
    authentication: deriveDomainRoot(accountRoot, 'identity-authentication'),
    messaging: deriveDomainRoot(accountRoot, 'messaging-encryption'),
  }
  accountRoot.fill(0)

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
    async send(to, items, stampValueWei) {
      let digest: string | undefined
      try {
        const sent = await chain.directMessages.send({
          wallet: handle,
          recipient: { raw: to },
          items,
          stampValue: stampValueWei,
          onAttemptCreated: created => {
            digest = created
          },
        })
        return sent.payloadDigest
      } catch (err) {
        // Nothing was handed to the relay: the send simply failed.
        if (digest === undefined) throw err
      }
      // The relay may have the message although its answer was lost. The same message is
      // followed to its end; a second one is never sent in its place.
      const deadline = Date.now() + 180_000
      for (;;) {
        const status = (
          await chain.directMessages.reconcileAttempts({ wallet: handle, payloadDigests: [digest] })
        )[digest]
        if (status === 'delivered') return digest
        if (status === 'dead') {
          throw new Error(`The relay will never deliver message ${digest}`)
        }
        if (Date.now() > deadline) {
          throw new Error(
            `Message ${digest} was handed to the relay but is not confirmed delivered (status ${status}). Run the command again to follow it; do not send it anew.`,
          )
        }
        await sleep(3000)
      }
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
