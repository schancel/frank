import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

import type { MessageItem } from '@frank/cashweb/types/messages'

import { openCliAccount, type CliAccount } from '../account'
import { loadConfig, resolveDataDir } from '../config'
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

/** The account's received messages, oldest first. `unreadOnly` returns those after the saved
 * cursor and moves the cursor past them. */
async function fetchMessages(params: {
  account: CliAccount
  cursorDir: string
  unreadOnly?: boolean
  sinceMs?: number
}): Promise<DecryptedInboxMessage[]> {
  const lastRead = params.unreadOnly ? loadCursor(params.cursorDir) : 0
  const sinceMs = params.sinceMs ?? (params.unreadOnly ? lastRead + 1 : 0)
  const received = await params.account.receivedSince(sinceMs)
  const messages = received.map(message => ({
    payloadDigest: message.payloadDigest,
    sender: message.senderAddress.raw,
    recipient: message.recipientAddress.raw,
    timestamp: message.receivedTime,
    date: new Date(message.receivedTime).toISOString(),
    text: message.items
      .map(item => (item.type === 'text' ? item.text : `[${item.type}]`))
      .join('\n'),
    items: message.items,
  }))
  const newest = messages.reduce((max, message) => Math.max(max, message.timestamp), lastRead)
  if (params.unreadOnly && newest > lastRead) saveCursor(params.cursorDir, newest)
  return messages
}

export async function inboxCommand(options: InboxOptions): Promise<void> {
  let account: CliAccount | undefined
  try {
    const dataDir = resolveDataDir(options.dataDir)
    const config = loadConfig(dataDir)
    account = await openCliAccount({ dataDir, config })

    let messages = await fetchMessages({
      account,
      cursorDir: join(dataDir, 'account'),
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
  } finally {
    await account?.close().catch(() => {})
  }
}

export async function listenCommand(options: ListenOptions): Promise<void> {
  let account: CliAccount | undefined
  try {
    const dataDir = resolveDataDir(options.dataDir)
    const config = loadConfig(dataDir)
    const opened = await openCliAccount({ dataDir, config })
    account = opened

    const seenDigests = new Set<string>()
    let sinceMs = Date.now() - 60_000 // Start from last minute

    if (!options.json) {
      console.log(
        `Listening for incoming messages on ${config.relayUrl} for ${opened.address}...`,
      )
      if (options.follow) {
        console.log('Streaming in real-time. Press Ctrl-C to exit.\n')
      }
    }

    const poll = async () => {
      try {
        const messages = await fetchMessages({
          account: opened,
          cursorDir: join(dataDir, 'account'),
          sinceMs,
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
        void opened.close().finally(() => process.exit(0))
      }

      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)

      // Keep event loop alive
      await new Promise(() => {})
    }
  } catch (err) {
    outputError(err, options.json)
  } finally {
    await account?.close().catch(() => {})
  }
}
