/**
 * Where a background merge of coins goes, derived so that every device of the account computes
 * the same account from the same coins, with no allocation and no message between them
 * (AGENTS.md §5).
 *
 * The target is an account of the wallet's change branch, at an index in the branch's upper half
 * (`EVM_MERGE_TARGET_BASE` and up). The change allocator hands out indexes from 0 upward, one per
 * payment's change coin, so it never reaches that half: a merge target cannot collide with a
 * payment's change. The same branch rather than a new one because it is the wallet's internal
 * branch already: the same keyring derives it, and the coin list, recovery and every tool that
 * holds the change keyring can sign for it. The index is a keyed hash of the merge's anchor (the
 * lowest [account, nonce] it spends) and the chain, under a salt only this account's keys give,
 * so no one else can tell from the chain which index a merge used.
 *
 * Finding the money again: the anchor is the last transaction of an account the merge emptied.
 * A device that knows a spent coin, or that walks the seed and finds an account emptied at nonce
 * n, computes the target of anchor [account, n - 1] and reads it (`probeAnchors`). A restored
 * device therefore finds every merge target whose anchor account the walk or its coin list knows.
 */
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import { concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
import { coinKey } from './evm-coin-list'
import type { MonadChangeKeyring } from './secp256k1-hd-keyring'

/** The first change index reserved for merge targets: the branch's upper half. */
export const EVM_MERGE_TARGET_BASE = 2 ** 30
/** The change index whose key the salt is made from; above every merge target. */
const SALT_INDEX = 2 ** 31 - 1
const TARGET_SPAN = SALT_INDEX - EVM_MERGE_TARGET_BASE

export function isMergeTargetIndex(index: number): boolean {
  return index >= EVM_MERGE_TARGET_BASE
}

export interface EvmMergeAnchor {
  readonly account: string
  readonly nonce: number
}

/** The lowest [account, nonce] among the coins a merge spends. */
export function evmMergeAnchor(coins: readonly EvmMergeAnchor[]): EvmMergeAnchor {
  if (coins.length === 0) throw new Error('A merge spends at least one coin')
  return [...coins]
    .map(coin => ({ account: coin.account.toLowerCase(), nonce: coin.nonce }))
    .sort((a, b) => (coinKey(a.account, a.nonce) < coinKey(b.account, b.nonce) ? -1 : 1))[0]!
}

export class EvmMergeTargets {
  private readonly salt: Uint8Array
  /** Targets this wallet watches as its own: account -> change index. */
  private readonly watched = new Map<string, number>()
  /** Anchors already read this session. */
  private readonly probed = new Set<string>()

  constructor(
    private readonly chainIdentifier: string,
    private readonly keyring: Pick<MonadChangeKeyring, 'deriveChangeAccount'>,
  ) {
    const key = keyring.deriveChangeAccount(SALT_INDEX).privateKey
    this.salt = sha256(concatBytes(utf8ToBytes('frank/evm-merge-target-salt/v1'), hexToBytes(key.replace(/^0x/, ''))))
  }

  /** The target of a merge whose anchor is `anchor`. */
  targetFor(anchor: EvmMergeAnchor): { account: string; changeIndex: number } {
    const digest = hmac(
      sha256,
      this.salt,
      utf8ToBytes(JSON.stringify(['frank/evm-merge-target/v1', this.chainIdentifier, coinKey(anchor.account, anchor.nonce)])),
    )
    const word = ((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0
    const changeIndex = EVM_MERGE_TARGET_BASE + (word % TARGET_SPAN)
    return { account: this.keyring.deriveChangeAccount(changeIndex).address.toLowerCase(), changeIndex }
  }

  /** Watch this target as one of the wallet's own accounts from now on. */
  watch(target: { account: string; changeIndex: number }): void {
    this.watched.set(target.account.toLowerCase(), target.changeIndex)
  }

  watchedTargets(): { account: string; changeIndex: number; privateKey: () => string }[] {
    return [...this.watched].map(([account, changeIndex]) => ({
      account,
      changeIndex,
      privateKey: () => this.keyring.deriveChangeAccount(changeIndex).privateKey,
    }))
  }

  /** Reads the target of each anchor not read yet this session, and watches every one the chain
   * shows in use. Returns the accounts it began to watch. */
  async probeAnchors(
    anchors: readonly EvmMergeAnchor[],
    inUse: (account: string) => Promise<boolean>,
  ): Promise<string[]> {
    const found: string[] = []
    for (const anchor of anchors) {
      const key = coinKey(anchor.account, anchor.nonce)
      if (this.probed.has(key)) continue
      const target = this.targetFor(anchor)
      if (this.watched.has(target.account)) {
        this.probed.add(key)
        continue
      }
      if (await inUse(target.account)) {
        this.watch(target)
        found.push(target.account)
      }
      this.probed.add(key)
    }
    return found
  }
}
