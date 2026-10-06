import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

import {
  decryptEnvelope,
  parseEnvelope,
} from '@frank/cashweb/relay/monad-message-envelope'
import { fetchMonadMessagesSince } from '@frank/cashweb/relay/monad-message-feed'
import type { MessageItem } from '@frank/cashweb/types/messages'
import { deserializeMessageItems } from '@frank/wallet/chain/monad-chain'
import { fetchMonadProfile, mailboxAuthFor } from '@frank/wallet/monad-identity'

import { loadConfig, loadIdentity, resolveDataDir } from '../config'
import { outputError, outputResult } from '../util'

export interface InboxOptions {
  limit?: string
  unread?: boolean
  dataDir?: string
  password?: string
  json?: boolean
}

export interface ListenOptions {
  follow?: boolean
  dataDir?: string
  password?: string
  json?: boolean
}

export interface DecryptedInboxMessage {
  payloadDigest: string
  sender: string
  recipient: string
  timestamp: number
  date: string
  text: string
  items: MessageItem[]
}

function getCursorPath(walletDir: string): string {
  return join(walletDir, 'inbox-cursor.json')
}

function loadCursor(walletDir: string): number {
  const path = getCursorPath(walletDir)
  if (existsSync(path)) {
    try {
      const data = JSON.parse(readFileSync(path, 'utf8')) as {
        lastReadTimestamp?: number
      }
      return typeof data.lastReadTimestamp === 'number'
        ? data.lastReadTimestamp
        : 0
    } catch {
      return 0
    }
  }
  return 0
}

function saveCursor(walletDir: string, timestamp: number): void {
  const path = getCursorPath(walletDir)
  try {
    writeFileSync(
      path,
      JSON.stringify({ lastReadTimestamp: timestamp }, null, 2),
      {
        mode: 0o600,
      },
    )
  } catch {}
}

async function fetchAndDecryptMessages(params: {
  identity: import('@frank/wallet/monad-identity').MonadIdentity
  relayUrl: string
  sinceMs?: number
  walletDir: string
  unreadOnly?: boolean
}): Promise<DecryptedInboxMessage[]> {
  const lastRead = params.unreadOnly ? loadCursor(params.walletDir) : 0
  const auth = mailboxAuthFor(params.identity, params.relayUrl)

  const stored = await fetchMonadMessagesSince({
    ...auth,
    sinceMs: params.sinceMs ?? (params.unreadOnly ? lastRead + 1 : 0),
    pageLimit: 100,
  })

  const messages: DecryptedInboxMessage[] = []
  const myAddress = params.identity.displayAddress.toLowerCase()
  let maxTimestamp = lastRead

  // Cache profiles for senders in this batch
  const profileCache = new Map<string, Buffer>()

  for (const record of stored) {
    if (!record.message) continue
    if (record.timestamp > maxTimestamp) {
      maxTimestamp = record.timestamp
    }
    if (params.unreadOnly && record.timestamp <= lastRead) {
      continue
    }

    const payloadDigest = Buffer.from(record.message.payloadHash).toString(
      'hex',
    )
    const envelope = parseEnvelope(record.message.encryptedPayload)
    if (!envelope) continue
    if (envelope.to.toLowerCase() !== myAddress) continue

    const senderAddress = envelope.from
    let senderPubKey = profileCache.get(senderAddress.toLowerCase())

    if (!senderPubKey) {
      try {
        const profile = await fetchMonadProfile({
          relayBaseUrl: params.relayUrl,
          address: { raw: senderAddress },
        })
        if (profile?.pubKey) {
          senderPubKey = Buffer.from(profile.pubKey)
          profileCache.set(senderAddress.toLowerCase(), senderPubKey)
        }
      } catch {}
    }

    if (!senderPubKey) continue

    let decryptedText = ''
    let items: MessageItem[] = []
    try {
      const plaintext = decryptEnvelope({
        envelope,
        myPrivateKey: params.identity.toNakamotoPrivateKey(),
        senderPubKey,
      })

      try {
        items = deserializeMessageItems(plaintext)
        decryptedText = items
          .filter(i => i.type === 'text')
          .map(i => (i as { type: 'text'; text: string }).text)
          .join('\n')
      } catch {
        decryptedText = plaintext
        items = [{ type: 'text', text: plaintext }]
      }
    } catch {
      continue
    }

    messages.push({
      payloadDigest,
      sender: senderAddress,
      recipient: envelope.to,
      timestamp: record.timestamp,
      date: new Date(record.timestamp).toISOString(),
      text: decryptedText,
      items,
    })
  }

  if (params.unreadOnly && maxTimestamp > lastRead) {
    saveCursor(params.walletDir, maxTimestamp)
  }

  return messages
}

export async function inboxCommand(options: InboxOptions): Promise<void> {
  try {
    const dataDir = resolveDataDir(options.dataDir)
    const config = loadConfig(dataDir)
    const { identity, walletDir } = await loadIdentity(
      dataDir,
      undefined,
      options.password,
    )

    let messages = await fetchAndDecryptMessages({
      identity,
      relayUrl: config.relayUrl,
      walletDir,
      unreadOnly: options.unread,
    })

    if (options.limit) {
      const limit = parseInt(options.limit, 10)
      if (!isNaN(limit) && limit > 0) {
        messages = messages.slice(-limit)
      }
    }

    outputResult(
      messages,
      () => {
        if (messages.length === 0) {
          console.log(
            options.unread ? 'No unread direct messages.' : 'Inbox is empty.',
          )
          return
        }
        console.log(`Direct Messages (${messages.length}):\n`)
        for (const msg of messages) {
          console.log(`[${msg.date}] From: ${msg.sender}`)
          console.log(`  Digest:  ${msg.payloadDigest}`)
          console.log(`  Message: ${msg.text}\n`)
        }
      },
      options.json,
    )
  } catch (err) {
    outputError(err, options.json)
  }
}

export async function listenCommand(options: ListenOptions): Promise<void> {
  try {
    const dataDir = resolveDataDir(options.dataDir)
    const config = loadConfig(dataDir)
    const { identity, walletDir } = await loadIdentity(
      dataDir,
      undefined,
      options.password,
    )

    const seenDigests = new Set<string>()
    let sinceMs = Date.now() - 60_000 // Start from last minute

    if (!options.json) {
      console.log(
        `Listening for incoming messages on ${config.relayUrl} for ${identity.displayAddress}...`,
      )
      if (options.follow) {
        console.log('Streaming in real-time. Press Ctrl-C to exit.\n')
      }
    }

    const poll = async () => {
      try {
        const messages = await fetchAndDecryptMessages({
          identity,
          relayUrl: config.relayUrl,
          sinceMs,
          walletDir,
        })

        for (const msg of messages) {
          if (!seenDigests.has(msg.payloadDigest)) {
            seenDigests.add(msg.payloadDigest)
            if (msg.timestamp >= sinceMs) {
              sinceMs = msg.timestamp + 1
            }

            if (options.json) {
              console.log(JSON.stringify(msg))
            } else {
              console.log(`[${msg.date}] From: ${msg.sender}`)
              console.log(`  Digest:  ${msg.payloadDigest}`)
              console.log(`  Message: ${msg.text}\n`)
            }
          }
        }
      } catch (err) {
        // Suppress transient network poll errors in follow mode
        if (!options.follow) throw err
      }
    }

    await poll()

    if (options.follow) {
      let active = true
      const interval = setInterval(async () => {
        if (!active) return
        await poll()
      }, 2500)

      const shutdown = () => {
        active = false
        clearInterval(interval)
        process.exit(0)
      }

      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)

      // Keep event loop alive
      await new Promise(() => {})
    }
  } catch (err) {
    outputError(err, options.json)
  }
}
