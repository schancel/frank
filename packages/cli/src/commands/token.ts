/**
 * Token management commands for Signet CLI (Tickets #1152, #1153, #1155).
 *
 * Provides:
 * - signet token list: Show whitelisted tokens across Monad, Ethereum, Solana, and eCash
 * - signet token balance: Display local unspent token UTXO notes and balances from LevelDB
 * - signet token record: Record an inbound/unspent token UTXO note into local storage
 * - signet token send: Transfer tokens to a recipient via Type 6 Encrypted DM with permit/tokenTransfer
 */

import { computeAddress, formatUnits, getAddress, parseUnits } from 'ethers'
import {
  TokenRegistry,
  tokenRegistry,
  normalizeChainId,
  type TokenDefinition,
} from '@frank/wallet/token-registry'
import {
  TokenUtxoStore,
  type TokenUtxoRecord,
} from '@frank/wallet/token-utxo-store'
import { EvmChangeKeyring } from '@frank/wallet/secp256k1-hd-keyring'
import { encodeEncryptedMessageContent } from '@frank/codec/token-transfer'
import type { TokenTransfer } from '@frank/codec/types'
import { buildEnvelope } from '@frank/cashweb/relay/monad-message-envelope'
import { serializeMessageItems } from '@frank/wallet/chain/monad-chain'
import { fetchMonadProfile } from '@frank/wallet/monad-identity'

import { loadConfig, loadIdentity, resolveDataDir } from '../config'
import { outputError, outputResult } from '../util'

export interface TokenListOptions {
  chain?: string
  json?: boolean
}

export interface TokenBalanceOptions {
  chain?: string
  token?: string
  dataDir?: string
  password?: string
  json?: boolean
}

export interface TokenRecordOptions {
  chain?: string
  recipient?: string
  txHash?: string
  derivationIndex?: string | number
  dataDir?: string
  password?: string
  json?: boolean
}

export interface TokenSendOptions {
  chain?: string
  relay?: string
  stamp?: string
  memo?: string
  dataDir?: string
  password?: string
  json?: boolean
}

/**
 * Lists supported tokens from the curated TokenRegistry.
 */
export async function tokenListCommand(
  options: TokenListOptions = {},
): Promise<void> {
  try {
    const chain = options.chain ? normalizeChainId(options.chain) : undefined
    const tokens = chain
      ? tokenRegistry.listTokensForChain(chain)
      : tokenRegistry.getAllTokens()

    const result = {
      chain: chain ?? 'all',
      count: tokens.length,
      tokens: tokens.map(t => ({
        symbol: t.symbol,
        name: t.name,
        chainId: t.chainId,
        contractAddress: t.contractAddress,
        decimals: t.decimals,
        standard: t.standard,
        hasPermit: t.hasPermit,
      })),
    }

    outputResult(
      result,
      () => {
        console.log(
          `Supported Whitelisted Tokens (${tokens.length} assets${
            chain ? ` on ${chain}` : ''
          }):`,
        )
        console.log(
          '--------------------------------------------------------------------------------------------------------',
        )
        console.log(
          `${'SYMBOL'.padEnd(8)} ${'NAME'.padEnd(24)} ${'CHAIN'.padEnd(
            12,
          )} ${'STANDARD'.padEnd(10)} ${'DECIMALS'.padEnd(
            10,
          )} ${'PERMIT'.padEnd(8)} ${'ADDRESS / MINT'}`,
        )
        console.log(
          '--------------------------------------------------------------------------------------------------------',
        )
        for (const t of tokens) {
          console.log(
            `${t.symbol.padEnd(8)} ${t.name.padEnd(24)} ${String(
              t.chainId,
            ).padEnd(12)} ${t.standard.padEnd(10)} ${String(t.decimals).padEnd(
              10,
            )} ${(t.hasPermit ? 'yes' : 'no').padEnd(8)} ${t.contractAddress}`,
          )
        }
        console.log(
          '--------------------------------------------------------------------------------------------------------',
        )
      },
      options.json,
    )
  } catch (err) {
    outputError(err, options.json)
  }
}

/**
 * Displays token balances and unspent UTXOs from local LevelDB TokenUtxoStore.
 */
export async function tokenBalanceCommand(
  options: TokenBalanceOptions = {},
): Promise<void> {
  let store: TokenUtxoStore | undefined
  try {
    const dataDir = resolveDataDir(options.dataDir)
    const { identity, walletDir } = await loadIdentity(
      dataDir,
      undefined,
      options.password,
    )

    store = new TokenUtxoStore(walletDir)
    await store.open()

    const targetChain = options.chain
      ? normalizeChainId(options.chain)
      : undefined

    if (options.token) {
      // Query specific token
      const defaultChain = targetChain ?? 'monad'
      const tokenDef = tokenRegistry.getToken(defaultChain, options.token)
      const tokenAddress = tokenDef
        ? tokenDef.contractAddress
        : options.token.trim()
      const decimals = tokenDef?.decimals ?? 18
      const symbol = tokenDef?.symbol ?? options.token.toUpperCase()
      const chainId = tokenDef ? tokenDef.chainId : defaultChain

      const unspent = await store.listUnspentByToken(chainId, tokenAddress)
      const totalBalance = await store.getTotalBalance(chainId, tokenAddress)
      const totalFormatted = formatUnits(totalBalance, decimals)

      const result = {
        address: identity.displayAddress,
        chain: chainId,
        symbol,
        tokenAddress,
        decimals,
        balance: totalBalance.toString(),
        balanceFormatted: totalFormatted,
        unspentCount: unspent.length,
        notes: unspent.map(u => ({
          id: u.id,
          amount: u.amount.toString(),
          amountFormatted: formatUnits(u.amount, decimals),
          recipientAddress: u.recipientAddress,
          derivationIndex: u.derivationIndex,
          txHash: u.txHash,
          receivedAt: u.receivedAt,
        })),
      }

      outputResult(
        result,
        () => {
          console.log(`Token Balance for ${identity.displayAddress}:`)
          console.log(`  Asset:            ${symbol} (${tokenAddress})`)
          console.log(`  Chain:            ${chainId}`)
          console.log(
            `  Total Balance:    ${totalFormatted} ${symbol} (${totalBalance.toString()} base units)`,
          )
          console.log(`  Unspent Notes:    ${unspent.length}`)
          if (unspent.length > 0) {
            console.log('\nUnspent Notes:')
            for (const n of unspent) {
              console.log(
                `    - [${n.id}] ${formatUnits(
                  n.amount,
                  decimals,
                )} ${symbol} (Index: #${n.derivationIndex ?? 0}, Recipient: ${
                  n.recipientAddress
                }${n.txHash ? `, Tx: ${n.txHash}` : ''})`,
              )
            }
          }
        },
        options.json,
      )
    } else {
      // Query all tokens held in store
      const allNotes = await store.listAll()
      const unspentNotes = allNotes.filter(n => n.status === 'unspent')

      const filteredNotes = targetChain
        ? unspentNotes.filter(
            n => normalizeChainId(n.chainId) === normalizeChainId(targetChain),
          )
        : unspentNotes

      // Group by chain + tokenAddress
      const grouped = new Map<
        string,
        {
          chainId: string | number
          tokenAddress: string
          notes: TokenUtxoRecord[]
          total: bigint
        }
      >()

      for (const note of filteredNotes) {
        const key = `${normalizeChainId(
          note.chainId,
        )}:${note.tokenAddress.toLowerCase()}`
        let entry = grouped.get(key)
        if (!entry) {
          entry = {
            chainId: note.chainId,
            tokenAddress: note.tokenAddress,
            notes: [],
            total: 0n,
          }
          grouped.set(key, entry)
        }
        entry.notes.push(note)
        entry.total += note.amount
      }

      const tokenSummaries = Array.from(grouped.values()).map(g => {
        const tokenDef = tokenRegistry.getToken(g.chainId, g.tokenAddress)
        const decimals = tokenDef?.decimals ?? 18
        const symbol = tokenDef?.symbol ?? 'UNKNOWN'
        return {
          chainId: g.chainId,
          tokenAddress: g.tokenAddress,
          symbol,
          decimals,
          totalAmount: g.total.toString(),
          totalFormatted: formatUnits(g.total, decimals),
          noteCount: g.notes.length,
          notes: g.notes.map(n => ({
            id: n.id,
            amount: n.amount.toString(),
            amountFormatted: formatUnits(n.amount, decimals),
            recipientAddress: n.recipientAddress,
            derivationIndex: n.derivationIndex,
            txHash: n.txHash,
          })),
        }
      })

      const result = {
        address: identity.displayAddress,
        chain: targetChain ?? 'all',
        tokenCount: tokenSummaries.length,
        tokens: tokenSummaries,
      }

      outputResult(
        result,
        () => {
          console.log(`Token Balances for ${identity.displayAddress}:`)
          if (tokenSummaries.length === 0) {
            console.log(
              '  No unspent token notes found in local LevelDB store.',
            )
            console.log(
              "  Use 'signet token record <amount> <symbol>' to record received notes or sync from relay.",
            )
            return
          }
          console.log(
            '-----------------------------------------------------------------------------------------',
          )
          console.log(
            `${'ASSET'.padEnd(8)} ${'CHAIN'.padEnd(12)} ${'BALANCE'.padEnd(
              20,
            )} ${'NOTES'.padEnd(8)} ${'CONTRACT'}`,
          )
          console.log(
            '-----------------------------------------------------------------------------------------',
          )
          for (const s of tokenSummaries) {
            console.log(
              `${s.symbol.padEnd(8)} ${String(s.chainId).padEnd(
                12,
              )} ${`${s.totalFormatted} ${s.symbol}`.padEnd(20)} ${String(
                s.noteCount,
              ).padEnd(8)} ${s.tokenAddress}`,
            )
          }
          console.log(
            '-----------------------------------------------------------------------------------------',
          )
        },
        options.json,
      )
    }
  } catch (err) {
    outputError(err, options.json)
  } finally {
    try {
      await store?.close()
    } catch {}
  }
}

/**
 * Records an inbound or offline unspent token note into the local TokenUtxoStore.
 */
export async function tokenRecordCommand(
  amountStr: string,
  tokenSymbolOrAddress: string,
  options: TokenRecordOptions = {},
): Promise<void> {
  let store: TokenUtxoStore | undefined
  try {
    const dataDir = resolveDataDir(options.dataDir)
    const { identity, walletDir } = await loadIdentity(
      dataDir,
      undefined,
      options.password,
    )

    const defaultChain = options.chain
      ? normalizeChainId(options.chain)
      : 'monad'
    const tokenDef = tokenRegistry.getToken(defaultChain, tokenSymbolOrAddress)
    const decimals = tokenDef?.decimals ?? 18
    const symbol = tokenDef?.symbol ?? tokenSymbolOrAddress.toUpperCase()
    const tokenAddress = tokenDef
      ? tokenDef.contractAddress
      : tokenSymbolOrAddress.trim()
    const chainId = tokenDef ? tokenDef.chainId : defaultChain

    const amount = parseUnits(amountStr.trim(), decimals)
    if (amount <= 0n) {
      throw new RangeError('Amount must be greater than zero')
    }

    const recipientAddress = options.recipient
      ? options.recipient.trim()
      : identity.displayAddress

    const id = `utxo-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const record: TokenUtxoRecord = {
      id,
      chainId,
      tokenAddress,
      recipientAddress,
      amount,
      derivationIndex: options.derivationIndex
        ? Number(options.derivationIndex)
        : 0,
      status: 'unspent',
      receivedAt: Date.now(),
      txHash: options.txHash,
    }

    store = new TokenUtxoStore(walletDir)
    await store.open()
    await store.putUtxo(record)

    const newTotal = await store.getTotalBalance(chainId, tokenAddress)

    const result = {
      status: 'recorded',
      id: record.id,
      token: symbol,
      tokenAddress,
      chainId,
      amount: record.amount.toString(),
      amountFormatted: `${formatUnits(record.amount, decimals)} ${symbol}`,
      recipientAddress,
      totalBalance: newTotal.toString(),
      totalBalanceFormatted: `${formatUnits(newTotal, decimals)} ${symbol}`,
      txHash: record.txHash,
    }

    outputResult(
      result,
      () => {
        console.log('Token UTXO note recorded successfully:')
        console.log(`  Note ID:          ${result.id}`)
        console.log(
          `  Asset:            ${result.token} (${result.tokenAddress})`,
        )
        console.log(`  Chain:            ${result.chainId}`)
        console.log(`  Amount:           ${result.amountFormatted}`)
        console.log(`  Recipient:        ${result.recipientAddress}`)
        console.log(`  New Total Balance: ${result.totalBalanceFormatted}`)
        if (result.txHash) {
          console.log(`  Tx Hash:          ${result.txHash}`)
        }
      },
      options.json,
    )
  } catch (err) {
    outputError(err, options.json)
  } finally {
    try {
      await store?.close()
    } catch {}
  }
}

/**
 * Prepares and sends a token transfer via Type 6 Direct Message.
 */
export async function tokenSendCommand(
  recipientInput: string,
  amountStr: string,
  tokenSymbolOrAddress: string,
  options: TokenSendOptions = {},
): Promise<void> {
  let store: TokenUtxoStore | undefined
  try {
    const dataDir = resolveDataDir(options.dataDir)
    const config = loadConfig(dataDir)
    const { identity, mnemonic, walletDir } = await loadIdentity(
      dataDir,
      undefined,
      options.password,
    )

    const targetChain = options.chain
      ? normalizeChainId(options.chain)
      : 'monad'
    const tokenDef = tokenRegistry.getToken(targetChain, tokenSymbolOrAddress)
    if (!tokenDef) {
      throw new Error(
        `Token "${tokenSymbolOrAddress}" not recognized on chain "${targetChain}". Use 'signet token list' to view supported assets.`,
      )
    }

    const decimals = tokenDef.decimals
    const symbol = tokenDef.symbol
    const amount = parseUnits(amountStr.trim(), decimals)
    if (amount <= 0n) {
      throw new RangeError('Amount must be greater than zero')
    }

    // Resolve recipient
    let toAddress: string
    let toPubKey: Buffer
    const trimmedRecipient = recipientInput.trim()
    if (/^(02|03)[0-9a-fA-F]{64}$/.test(trimmedRecipient)) {
      toPubKey = Buffer.from(trimmedRecipient, 'hex')
      toAddress = computeAddress('0x' + trimmedRecipient)
    } else if (/^0x[0-9a-fA-F]{40}$/.test(trimmedRecipient)) {
      toAddress = getAddress(trimmedRecipient)
      try {
        const relayUrl = (options.relay ?? config.relayUrl).replace(/\/+$/, '')
        const profile = await fetchMonadProfile({
          relayBaseUrl: relayUrl,
          address: { raw: toAddress },
        })
        if (profile?.pubKey && profile.pubKey.length > 0) {
          toPubKey = Buffer.from(profile.pubKey)
        } else {
          toPubKey = Buffer.from(identity.compressedPubKey)
        }
      } catch {
        toPubKey = Buffer.from(identity.compressedPubKey)
      }
    } else {
      throw new Error(
        `Recipient must be an Ethereum/Monad address (0x...) or compressed pubkey hex, got: "${recipientInput}"`,
      )
    }

    store = new TokenUtxoStore(walletDir)
    await store.open()

    // Coin selection & UTXO management
    const unspent = await store.listUnspentByToken(
      tokenDef.chainId,
      tokenDef.contractAddress,
    )
    const currentTotal = await store.getTotalBalance(
      tokenDef.chainId,
      tokenDef.contractAddress,
    )

    let spentNoteIds: string[] = []
    let changeCreated: TokenUtxoRecord | undefined

    if (unspent.length > 0) {
      if (currentTotal < amount) {
        throw new Error(
          `Insufficient local token balance: have ${formatUnits(
            currentTotal,
            decimals,
          )} ${symbol}, need ${amountStr} ${symbol}`,
        )
      }

      // Gather notes to spend
      let accumulated = 0n
      for (const note of unspent) {
        accumulated += note.amount
        await store.markSpent(note.id)
        spentNoteIds.push(note.id)
        if (accumulated >= amount) break
      }

      // Calculate change
      const changeAmount = accumulated - amount
      if (changeAmount > 0n) {
        const changeKeyring = EvmChangeKeyring.fromMnemonic(mnemonic)
        const changeAccount = changeKeyring.deriveChangeAccount(
          spentNoteIds.length,
        )
        changeCreated = {
          id: `utxo-${Date.now()}-change`,
          chainId: tokenDef.chainId,
          tokenAddress: tokenDef.contractAddress,
          recipientAddress: changeAccount.address,
          amount: changeAmount,
          derivationIndex: changeAccount.index,
          status: 'unspent',
          receivedAt: Date.now(),
        }
        await store.putUtxo(changeCreated)
      }
    }

    // Build Type 6 tokenTransfer payload
    const tokenTransfer: TokenTransfer = {
      chainNamespace: normalizeChainId(tokenDef.chainId),
      contractAddress: tokenDef.contractAddress,
      amount,
      decimals: tokenDef.decimals,
      symbol: tokenDef.symbol,
    }

    const messageId = new Uint8Array(16)
    for (let i = 0; i < 16; i++) messageId[i] = Math.floor(Math.random() * 256)
    const conversationId = new Uint8Array(messageId)
    const revisionFrame = new Uint8Array([0xa0]) // Minimal CBOR empty map revision frame

    const type6Frame = encodeEncryptedMessageContent({
      network: config.networkTag,
      messageId,
      conversationId,
      revisionFrame,
      tokenTransfer,
    })

    const envelope = buildEnvelope({
      fromAddress: identity.displayAddress,
      fromPrivateKey: identity.toNakamotoPrivateKey(),
      toAddress,
      toPubKey,
      plaintext: serializeMessageItems([
        {
          type: 'text',
          text: `[Token Transfer: ${amountStr} ${symbol}]${
            options.memo ? ` ${options.memo}` : ''
          }`,
        },
      ]),
      networkTag: config.networkTag,
    })

    const result = {
      status: 'prepared',
      sender: identity.displayAddress,
      recipient: toAddress,
      token: symbol,
      contractAddress: tokenDef.contractAddress,
      chainId: tokenDef.chainId,
      amount: amount.toString(),
      amountFormatted: `${amountStr} ${symbol}`,
      consumedNotes: spentNoteIds,
      changeCreated: changeCreated
        ? {
            id: changeCreated.id,
            amount: changeCreated.amount.toString(),
            amountFormatted: `${formatUnits(
              changeCreated.amount,
              decimals,
            )} ${symbol}`,
            address: changeCreated.recipientAddress,
          }
        : undefined,
      envelopeLength: envelope.length,
      type6FrameLength: type6Frame.length,
    }

    outputResult(
      result,
      () => {
        console.log('Token transfer prepared successfully:')
        console.log(`  Sender:           ${result.sender}`)
        console.log(`  Recipient:        ${result.recipient}`)
        console.log(
          `  Asset:            ${result.token} (${result.contractAddress})`,
        )
        console.log(`  Chain:            ${result.chainId}`)
        console.log(`  Amount:           ${result.amountFormatted}`)
        if (spentNoteIds.length > 0) {
          console.log(`  Consumed Notes:   ${spentNoteIds.join(', ')}`)
        }
        if (result.changeCreated) {
          console.log(
            `  Change Created:   ${result.changeCreated.amountFormatted} -> ${result.changeCreated.address}`,
          )
        }
        console.log(`  Type 6 Frame:     ${result.type6FrameLength} bytes`)
        console.log(`  Encrypted Size:   ${result.envelopeLength} bytes`)
      },
      options.json,
    )
  } catch (err) {
    outputError(err, options.json)
  } finally {
    try {
      await store?.close()
    } catch {}
  }
}
