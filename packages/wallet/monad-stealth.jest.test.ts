import { getBytes, randomBytes, SigningKey, Transaction, verifyMessage, Wallet } from 'ethers'
import { toHex } from '@frank/codec'
import {
  deriveEvmStealthAddress,
  deriveEvmStealthPrivateKey,
  evmStealthItem,
  stealthCoinFromItem,
  stealthItemTransfer,
} from './monad-stealth'

describe('Monad / EVM Stealth Direct Payment Engine (#897)', () => {
  it('derives matching stealth address and private key for secp256k1 (DKSAP)', () => {
    // Generate recipient identity / spend keypair
    const recipientWallet = Wallet.createRandom()
    const recipientSpendSecret = getBytes(recipientWallet.privateKey)
    const recipientSpendPubKey = getBytes(
      SigningKey.computePublicKey(recipientSpendSecret, true),
    )

    // Sender generates ephemeral secret and derives stealth address
    const ephemeralSecret = getBytes(randomBytes(32))
    const senderDerivation = deriveEvmStealthAddress({
      recipientSpendPubKey,
      ephemeralSecret,
    })

    // Recipient uses the ephemeral public key to derive private key and address
    const recipientDerivation = deriveEvmStealthPrivateKey({
      recipientSpendSecret,
      ephemeralPubKey: senderDerivation.ephemeralPubKey,
    })

    // Both must match
    expect(recipientDerivation.stealthAddress.toLowerCase()).toBe(
      senderDerivation.stealthAddress.toLowerCase(),
    )
    expect(toHex(recipientDerivation.stealthPublicKey)).toBe(
      toHex(senderDerivation.stealthPublicKey),
    )

    // The derived private key must control the stealth address
    const derivedWallet = new Wallet(recipientDerivation.stealthPrivateKey)
    expect(derivedWallet.address.toLowerCase()).toBe(
      senderDerivation.stealthAddress.toLowerCase(),
    )
  })

  it('rejects invalid public key lengths and secret lengths', () => {
    expect(() =>
      deriveEvmStealthAddress({
        recipientSpendPubKey: new Uint8Array(20),
      }),
    ).toThrow('recipientSpendPubKey must be 33 or 65 bytes')

    expect(() =>
      deriveEvmStealthAddress({
        recipientSpendPubKey: new Uint8Array(33),
        ephemeralSecret: new Uint8Array(16),
      }),
    ).toThrow('ephemeralSecret must be 32 bytes')

    expect(() =>
      deriveEvmStealthPrivateKey({
        recipientSpendSecret: new Uint8Array(16),
        ephemeralPubKey: new Uint8Array(33),
      }),
    ).toThrow('recipientSpendSecret must be 32 bytes')
  })

  it('signs and verifies a message using the derived stealth private key', async () => {
    const recipientWallet = Wallet.createRandom()
    const recipientSpendSecret = getBytes(recipientWallet.privateKey)
    const recipientSpendPubKey = getBytes(
      SigningKey.computePublicKey(recipientSpendSecret, true),
    )

    const senderDerivation = deriveEvmStealthAddress({
      recipientSpendPubKey,
    })

    const recipientDerivation = deriveEvmStealthPrivateKey({
      recipientSpendSecret,
      ephemeralPubKey: senderDerivation.ephemeralPubKey,
    })

    const stealthWallet = new Wallet(recipientDerivation.stealthPrivateKey)
    const message = 'Hello stealth transfer'
    const signature = await stealthWallet.signMessage(message)
    const recovered = verifyMessage(message, signature)

    expect(recovered.toLowerCase()).toBe(
      senderDerivation.stealthAddress.toLowerCase(),
    )
  })

  describe('the item a payment carries and the coin it becomes', () => {
    const CHAIN_ID = 10143n
    const recipient = new Wallet('0x' + '0b'.repeat(32))
    const recipientSpendPubKey = getBytes(recipient.signingKey.compressedPublicKey)
    const payer = new Wallet('0x' + '0a'.repeat(32))
    const signedTransferTo = (to: string, value: bigint, chainId = CHAIN_ID) =>
      payer.signTransaction({
        type: 2,
        chainId,
        nonce: 0,
        to,
        value,
        gasLimit: 21_000n,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n,
      })

    it('the recipient derives the coin of a payment from its item, pending and worth nothing', async () => {
      const destination = deriveEvmStealthAddress({ recipientSpendPubKey })
      const raw = await signedTransferTo(destination.stealthAddress, 5_000n)
      const item = evmStealthItem({
        networkTag: 'MONT',
        ephemeralPubKey: destination.ephemeralPubKey,
        rawTransaction: raw,
        amountWei: 5_000n,
        memo: 'lunch',
      })
      expect(item).toEqual({
        type: 'stealth',
        networkTag: 'MONT',
        keyType: 1,
        ephemeralPubKey: toHex(destination.ephemeralPubKey),
        transactions: [raw.slice(2)],
        amount: 5_000,
        memo: 'lunch',
      })

      const coin = stealthCoinFromItem({
        item,
        recipientSpendSecret: recipient.privateKey,
        payloadDigest: '0xAB' + 'cd'.repeat(31),
        discoveredAtMs: 7,
      })!
      expect(coin).toEqual({
        address: destination.stealthAddress.toLowerCase(),
        privateKey: coin.privateKey,
        origin: 'stealth',
        state: 'pending',
        amountWei: '0',
        claimedAmountWei: '5000',
        transactions: [raw.slice(2)],
        payloadDigest: 'ab' + 'cd'.repeat(31),
        ephemeralPubKey: toHex(destination.ephemeralPubKey),
        discoveredAtMs: 7,
      })
      // The stored key is the one-time account's own.
      expect(new Wallet(coin.privateKey).address.toLowerCase()).toBe(coin.address)
      // The carried transfer is one the holder may broadcast: it pays this coin on this chain.
      expect(
        stealthItemTransfer(coin.transactions, coin.address, CHAIN_ID),
      ).toEqual({ txHash: Transaction.from(raw).hash, rawTransaction: raw })
    })

    it('nobody else derives that coin: another key gives another account', async () => {
      const destination = deriveEvmStealthAddress({ recipientSpendPubKey })
      const item = evmStealthItem({
        networkTag: 'MONT',
        ephemeralPubKey: destination.ephemeralPubKey,
        rawTransaction: await signedTransferTo(destination.stealthAddress, 1n),
        amountWei: 1n,
      })
      // The payer knows the ephemeral secret and the recipient's public key, and still cannot
      // make the account's key: it needs the recipient's secret.
      const asPayer = stealthCoinFromItem({
        item,
        recipientSpendSecret: payer.privateKey,
        discoveredAtMs: 1,
      })!
      expect(asPayer.address).not.toBe(destination.stealthAddress.toLowerCase())
    })

    it('a carried transaction that pays someone else, or another chain, is not broadcast', async () => {
      const destination = deriveEvmStealthAddress({ recipientSpendPubKey })
      const address = destination.stealthAddress
      const elsewhere = await signedTransferTo(payer.address, 1n)
      const otherChain = await signedTransferTo(address, 1n, 1n)
      expect(stealthItemTransfer([elsewhere.slice(2)], address, CHAIN_ID)).toBeUndefined()
      expect(stealthItemTransfer([otherChain.slice(2)], address, CHAIN_ID)).toBeUndefined()
      expect(stealthItemTransfer(['zz', '1234'], address, CHAIN_ID)).toBeUndefined()
      // A bare hash names a transfer and gives nothing to broadcast.
      expect(stealthItemTransfer(['99'.repeat(32)], address, CHAIN_ID)).toEqual({
        txHash: '0x' + '99'.repeat(32),
      })
    })

    it('an item for another curve or with a malformed key is no coin', () => {
      const base = { transactions: [], amount: 1 }
      expect(
        stealthCoinFromItem({
          item: { ...base, keyType: 2, ephemeralPubKey: '11'.repeat(32) },
          recipientSpendSecret: recipient.privateKey,
          discoveredAtMs: 1,
        }),
      ).toBeUndefined()
      expect(
        stealthCoinFromItem({
          item: { ...base, keyType: 1, ephemeralPubKey: '02' + '00'.repeat(32) },
          recipientSpendSecret: recipient.privateKey,
          discoveredAtMs: 1,
        }),
      ).toBeUndefined()
    })
  })
})
