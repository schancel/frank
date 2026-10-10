/**
 * The few SPL Token facts a swap needs: where a wallet's token account lives, what a mint's
 * decimals are, and the instructions that create a token account and wrap or unwrap SOL.
 * Everything about a token (decimals, owning token program, balance) is read from the chain.
 */
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js'

import { NATIVE_SOL_MINT, type SolanaSwapToken } from './venues'

export const TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
)
export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
)
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
)
/** Size of a plain token account; its rent is what creating one costs. */
export const TOKEN_ACCOUNT_SIZE = 165

export interface AccountData {
  readonly owner: PublicKey
  readonly lamports: bigint | number
  readonly data: Uint8Array
}

/** The RPC reads used here. A web3.js `Connection` satisfies it. */
export interface SplReader {
  getBalance(address: PublicKey): Promise<bigint | number>
  getMultipleAccountsInfo(
    addresses: PublicKey[],
  ): Promise<(AccountData | null)[]>
}

function readU64(data: Uint8Array, offset: number): bigint {
  let value = 0n
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(data[offset + i])
  return value
}

export function isTokenProgram(programId: PublicKey): boolean {
  return (
    programId.equals(TOKEN_PROGRAM_ID) ||
    programId.equals(TOKEN_2022_PROGRAM_ID)
  )
}

/** Decimals and owning token program of a mint account. Rejects anything that is not a mint. */
export function decodeMint(
  mint: string,
  account: AccountData | null,
): { decimals: number; tokenProgram: PublicKey } {
  if (!account)
    throw new Error(`Token mint ${mint} does not exist on this network`)
  if (!isTokenProgram(account.owner) || account.data.length < 82) {
    throw new Error(`${mint} is not a token mint`)
  }
  return { decimals: account.data[44], tokenProgram: account.owner }
}

export interface TokenAccountState {
  readonly mint: PublicKey
  readonly owner: PublicKey
  readonly amount: bigint
  /** Someone allowed to spend from the account, if any. */
  readonly delegate: string | null
  /** Someone other than the owner allowed to close the account, if any. */
  readonly closeAuthority: string | null
}

/** A token account's state, or undefined when the account does not exist. */
export function decodeTokenAccount(
  account: AccountData | null,
): TokenAccountState | undefined {
  if (!account) return undefined
  if (
    !isTokenProgram(account.owner) ||
    account.data.length < TOKEN_ACCOUNT_SIZE
  ) {
    throw new Error('Account is not a token account')
  }
  const data = account.data
  const optionalKey = (offset: number) =>
    readU64(data, offset) % 2n ** 32n === 0n
      ? null
      : new PublicKey(data.slice(offset + 4, offset + 36)).toBase58()
  return {
    mint: new PublicKey(data.slice(0, 32)),
    owner: new PublicKey(data.slice(32, 64)),
    amount: readU64(data, 64),
    delegate: optionalKey(72),
    closeAuthority: optionalKey(129),
  }
}

/** The wallet's associated token account for a mint. */
export async function findAssociatedTokenAddress(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID,
): Promise<PublicKey> {
  const [address] = await PublicKey.findProgramAddress(
    [owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )
  return address
}

/** Creates the associated token account if it is missing; does nothing if it exists. */
export function createAssociatedTokenAccountIdempotentInstruction(params: {
  payer: PublicKey
  associatedToken: PublicKey
  owner: PublicKey
  mint: PublicKey
  tokenProgram: PublicKey
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: params.associatedToken, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: false, isWritable: false },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: params.tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Uint8Array.of(1),
  })
}

/**
 * A temporary wrapped-SOL account for one swap: created at an address derived from the wallet
 * and a seed (the swap's blockhash), holding `lamports` of wrapped SOL, and closed again by
 * `unwrapSolInstruction`. The wallet's own wrapped-SOL account, if it has one, is never touched.
 */
export async function temporaryWrappedSolAccount(params: {
  owner: PublicKey
  seed: string
  rentLamports: bigint
  lamports: bigint
}): Promise<{ address: PublicKey; instructions: TransactionInstruction[] }> {
  const mint = new PublicKey(NATIVE_SOL_MINT)
  const address = await PublicKey.createWithSeed(
    params.owner,
    params.seed,
    TOKEN_PROGRAM_ID,
  )
  const initialize = new Uint8Array(33)
  initialize[0] = 18 // InitializeAccount3
  initialize.set(params.owner.toBytes(), 1)
  return {
    address,
    instructions: [
      SystemProgram.createAccountWithSeed({
        fromPubkey: params.owner,
        basePubkey: params.owner,
        seed: params.seed,
        newAccountPubkey: address,
        lamports: params.rentLamports + params.lamports,
        space: TOKEN_ACCOUNT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      new TransactionInstruction({
        programId: TOKEN_PROGRAM_ID,
        keys: [
          { pubkey: address, isSigner: false, isWritable: true },
          { pubkey: mint, isSigner: false, isWritable: false },
        ],
        data: initialize,
      }),
    ],
  }
}

/** Unwraps SOL: closes a wrapped-SOL account and returns all its lamports to the wallet. */
export function unwrapSolInstruction(params: {
  owner: PublicKey
  wrappedSolAccount: PublicKey
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: params.wrappedSolAccount, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: true, isWritable: false },
    ],
    data: Uint8Array.of(9), // CloseAccount
  })
}

/** Moves tokens between two accounts of the same mint, checking the mint and its decimals. */
export function transferCheckedInstruction(params: {
  source: PublicKey
  mint: PublicKey
  destination: PublicKey
  owner: PublicKey
  amount: bigint
  decimals: number
  tokenProgram: PublicKey
}): TransactionInstruction {
  const data = new Uint8Array(10)
  data[0] = 12 // TransferChecked
  for (let i = 0; i < 8; i++) {
    data[1 + i] = Number((params.amount >> BigInt(8 * i)) & 0xffn)
  }
  data[9] = params.decimals
  return new TransactionInstruction({
    programId: params.tokenProgram,
    keys: [
      { pubkey: params.source, isSigner: false, isWritable: true },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: params.destination, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: true, isWritable: false },
    ],
    data,
  })
}

export interface SolanaSwapTokenBalance extends SolanaSwapToken {
  readonly decimals: number
  /** Spendable balance in base units. For SOL this is the wallet's lamports. */
  readonly amount: bigint
  readonly native: boolean
}

/** Balances of the given tokens for one wallet, with each mint's decimals read from chain. */
export async function fetchSwapTokenBalances(
  connection: SplReader,
  owner: PublicKey,
  tokens: readonly SolanaSwapToken[],
): Promise<SolanaSwapTokenBalance[]> {
  const mints = tokens.map(token => new PublicKey(token.mint))
  const mintAccounts = await connection.getMultipleAccountsInfo(mints)
  const decoded = tokens.map((token, i) =>
    decodeMint(token.mint, mintAccounts[i]),
  )
  const tokenAccounts = await connection.getMultipleAccountsInfo(
    await Promise.all(
      mints.map((mint, i) =>
        findAssociatedTokenAddress(owner, mint, decoded[i].tokenProgram),
      ),
    ),
  )
  const lamports = BigInt(await connection.getBalance(owner))
  return tokens.map((token, i) => {
    const native = token.mint === NATIVE_SOL_MINT
    return {
      ...token,
      decimals: decoded[i].decimals,
      amount: native
        ? lamports
        : decodeTokenAccount(tokenAccounts[i])?.amount ?? 0n,
      native,
    }
  })
}
