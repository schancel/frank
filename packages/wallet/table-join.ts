/**
 * A player's authorization to sit at a game table with a buy-in lock: a signature by the account
 * the lock was sent from (the player's main account) over which table, which lock, and which
 * identity may sit with it. Lock ids are public (the contract's `Locked` event), so without it
 * anyone could name someone else's lock in a join and play with that buy-in.
 *
 * `frank/table-join/v1`:
 *
 *   digest    = keccak256(abi.encode(string "frank/table-join/v1", string chainIdentifier,
 *                 address contract, string game, bytes16 tableId, bytes32 lockId,
 *                 address joiner))
 *   signature = EIP-191 personal_sign(digest bytes) by the locking account (65 bytes r‖s‖v)
 *
 * `chainIdentifier` is the canonical network identifier (docs/protocol/chains/v1.json) and
 * `contract` the network's GenericHTLC: the same lock id on another chain or contract is another
 * authorization. `joiner` is the identity address the join comes from (it commits to the
 * identity's public key). The EIP-191 prefix keeps the signature from ever being a transaction
 * signature. Golden vectors in table-join.jest.test.ts.
 */
import {
  AbiCoder,
  getAddress,
  getBytes,
  keccak256,
  verifyMessage,
  type Wallet,
} from 'ethers'

export const TABLE_JOIN_DOMAIN = 'frank/table-join/v1'

export interface TableJoinAuthorization {
  chainIdentifier: string
  contract: string
  game: string
  /** 16 bytes, 32 lowercase hex digits without `0x`. */
  tableId: string
  /** `0x` and 64 hex digits. */
  lockId: string
  /** The identity address the join comes from. */
  joiner: string
}

export function tableJoinDigest(a: TableJoinAuthorization): string {
  if (!/^[0-9a-f]{32}$/.test(a.tableId))
    throw new Error('A table id is 16 bytes of lowercase hex')
  if (!/^0x[0-9a-fA-F]{64}$/.test(a.lockId))
    throw new Error('A lock id is 32 bytes of 0x-prefixed hex')
  if (!a.chainIdentifier || !a.game)
    throw new Error('A table join names its network and game')
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ['string', 'string', 'address', 'string', 'bytes16', 'bytes32', 'address'],
      [
        TABLE_JOIN_DOMAIN,
        a.chainIdentifier,
        getAddress(a.contract),
        a.game,
        '0x' + a.tableId,
        a.lockId.toLowerCase(),
        getAddress(a.joiner),
      ],
    ),
  )
}

/** Signs `a` with `account` (custody-internal; hosts use a {@link TableJoinSigner}). */
export function signTableJoinWith(
  account: Pick<Wallet, 'signMessageSync'>,
  a: TableJoinAuthorization,
): string {
  return account.signMessageSync(getBytes(tableJoinDigest(a))).toLowerCase()
}

/** Whether `signature` is `account`'s authorization `a`. Never throws. */
export function verifyTableJoin(
  a: TableJoinAuthorization,
  account: string,
  signature: string,
): boolean {
  try {
    return (
      getAddress(verifyMessage(getBytes(tableJoinDigest(a)), signature)) ===
      getAddress(account)
    )
  } catch {
    return false
  }
}

/** What a player's wallet hands out to join a table: the main account it locks from, and its
 * signature over exactly a table-join authorization on the wallet's own network, nothing else. */
export interface TableJoinSigner {
  readonly chainIdentifier: string
  /** The main account: the lock's sender and refund address. */
  account(): string
  signTableJoin(
    a: Omit<TableJoinAuthorization, 'chainIdentifier'>,
  ): string
}
