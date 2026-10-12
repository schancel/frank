import { PublicKey, VersionedMessage, VersionedTransaction, PACKET_DATA_SIZE } from '@solana/web3.js'
import { getBase58Decoder } from '@solana/codecs-strings'
import { ed25519 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha256'
import { u64 } from './amount'
import type { SolanaPaymentAsset, SolanaPaymentMember, SolanaSignedPayment, SolanaSpendPosition } from './types'
export interface SolanaTransferPolicy { intent: { asset: SolanaPaymentAsset }; members: Pick<SolanaPaymentMember, 'amount' | 'destination' | 'sourceAddresses' | 'rentLamports' | 'createDestinationAta'>[] }
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
const base58 = getBase58Decoder()
export function associatedAccount(owner: string, mint: string): string {
  // Standard Solana PDA derivation; this web3 version exposes only async PDA helpers.
  for (let bump = 255; bump >= 0; bump--) {
    const hash = sha256(Buffer.concat([new PublicKey(owner).toBytes(), TOKEN.toBytes(), new PublicKey(mint).toBytes(), Uint8Array.of(bump), ATA.toBytes(), Buffer.from('ProgramDerivedAddress')]))
    if (!PublicKey.isOnCurve(hash)) return new PublicKey(hash).toBase58()
  }
  throw new Error('Unable to derive associated account')
}
/** Defense in depth against custody adapter corruption: only one exact transfer
 * plus experimental memo, no lookup tables, extras, fee payer or authority changes. */
export function validateOriginal(bytes: Uint8Array, operation: SolanaTransferPolicy, source: SolanaSpendPosition, lifetime: { blockhash: string; lastValidBlockHeight: number }, memberIndex = 0): SolanaSignedPayment {
  if (bytes.length > PACKET_DATA_SIZE) throw new Error('Solana transaction exceeds packet limit')
  const tx = VersionedTransaction.deserialize(bytes)
  validatePolicy(tx, operation, source, lifetime, memberIndex)
  if (!ed25519.verify(tx.signatures[0], tx.message.serialize(), new PublicKey(source.owner).toBytes(), { zip215: false })) throw new Error('Invalid signed transaction policy')
  const member = operation.members[memberIndex]
  return { memberIndex, sourceOwner: source.owner, signature: base58.decode(tx.signatures[0]), transaction: Buffer.from(bytes).toString('base64'), blockhash: lifetime.blockhash, lastValidBlockHeight: lifetime.lastValidBlockHeight, sourceAddresses: [...member.sourceAddresses], destination: structuredClone(member.destination!), amount: member.amount, feeLamports: '0', rentLamports: member.rentLamports }
}

export function validateUnsigned(bytes: Uint8Array, operation: SolanaTransferPolicy, source: SolanaSpendPosition, lifetime: { blockhash: string; lastValidBlockHeight: number }, memberIndex: number): void {
  if (bytes.length > PACKET_DATA_SIZE - 65) throw new Error('Solana transaction exceeds packet limit')
  const message = VersionedMessage.deserialize(bytes)
  if (Buffer.compare(Buffer.from(message.serialize()), Buffer.from(bytes)) !== 0) throw new Error('Noncanonical unsigned message')
  const tx = new VersionedTransaction(message)
  if (tx.serialize().length > PACKET_DATA_SIZE) throw new Error('Solana transaction exceeds packet limit')
  validatePolicy(tx, operation, source, lifetime, memberIndex)
}

function validatePolicy(tx: VersionedTransaction, operation: SolanaTransferPolicy, source: SolanaSpendPosition, lifetime: { blockhash: string; lastValidBlockHeight: number }, memberIndex: number): void {
  const message = tx.message
  const member = operation.members[memberIndex]
  if (!member) throw new Error('Unknown payment member')
  if (message.version !== 0 || message.addressTableLookups.length || new Set(message.staticAccountKeys.map(key => key.toBase58())).size !== message.staticAccountKeys.length || tx.signatures.length !== 1 || message.header.numRequiredSignatures !== 1 || message.header.numReadonlySignedAccounts !== 0 || message.recentBlockhash !== lifetime.blockhash || !message.staticAccountKeys[0].equals(new PublicKey(source.owner)) || message.compiledInstructions.length !== (member.createDestinationAta ? 3 : 2)) throw new Error('Invalid signed transaction policy')
  const destination = member.destination
  if (!destination) throw new Error('Missing destination')
  if (source.owner === destination.destinationOwner) throw new Error('Recipient must differ from source')
  const transfer = message.compiledInstructions[member.createDestinationAta ? 1 : 0], memo = message.compiledInstructions[member.createDestinationAta ? 2 : 1]
  if (message.staticAccountKeys[memo.programIdIndex]?.toBase58() !== MEMO || memo.accountKeyIndexes.length || !/^frank:solana-custody-primary:experimental-v1:[0-9a-f]{64}$/.test(Buffer.from(memo.data).toString('utf8'))) throw new Error('Invalid authorization memo')
  const key = (index: number) => message.staticAccountKeys[transfer.accountKeyIndexes[index]]?.toBase58()
  const data = Buffer.from(transfer.data)
  if (operation.intent.asset.kind === 'native') {
    if (member.createDestinationAta || message.staticAccountKeys.length !== 4 || message.header.numReadonlyUnsignedAccounts !== 2 || message.staticAccountKeys[transfer.programIdIndex]?.toBase58() !== '11111111111111111111111111111111' || transfer.accountKeyIndexes.length !== 2 || key(0) !== source.owner || key(1) !== destination.destinationOwner || data.length !== 12 || data.readUInt32LE(0) !== 2 || data.readBigUInt64LE(4) !== u64(member.amount)) throw new Error('Native transfer does not match intent')
  } else {
    const asset = operation.intent.asset
    if (message.staticAccountKeys.length !== (member.createDestinationAta ? 9 : 6) || message.header.numReadonlyUnsignedAccounts !== (member.createDestinationAta ? 6 : 3) || message.staticAccountKeys[transfer.programIdIndex]?.toBase58() !== asset.program || transfer.accountKeyIndexes.length !== 4 || key(0) !== source.address || key(1) !== asset.mint || key(2) !== associatedAccount(destination.destinationOwner, asset.mint) || key(3) !== source.owner || data.length !== 10 || data[0] !== 12 || data.readBigUInt64LE(1) !== u64(member.amount) || data[9] !== asset.decimals) throw new Error('SPL transfer does not match intent')
    if (member.createDestinationAta) {
      const create = message.compiledInstructions[0]
      const accounts = create.accountKeyIndexes.map(index => message.staticAccountKeys[index]?.toBase58())
      const expected = [source.owner, associatedAccount(destination.destinationOwner, asset.mint), destination.destinationOwner, asset.mint, '11111111111111111111111111111111', asset.program]
      if (message.staticAccountKeys[create.programIdIndex]?.toBase58() !== ATA.toBase58() || create.data.length !== 1 || create.data[0] !== 1 || JSON.stringify(accounts) !== JSON.stringify(expected)) throw new Error('ATA construction does not match authorization')
    }
  }
}
