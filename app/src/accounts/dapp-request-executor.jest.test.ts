import { HDNodeWallet, Wallet, verifyMessage } from 'ethers'
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js'
import { ed25519 } from '@noble/curves/ed25519'
import { deriveDappPersona } from '@frank/wallet/dapp-bridge/persona-keys'
import { executeApprovedDappRequest } from './dapp-request-executor'

const ORIGIN = 'https://dapp.example'
const MASTER = HDNodeWallet.fromSeed(new Uint8Array(32).fill(19))
const REF = { kind: 'site' as const, origin: ORIGIN }
const EVM_PERSONA = deriveDappPersona(MASTER, REF)
let SOLANA_KEY: Keypair

beforeAll(async () => {
  SOLANA_KEY = await Keypair.fromSeed(new Uint8Array(32).fill(21))
})

function fakeSession() {
  return {
    createDappPersonaSigner: async () => ({
      accountId: 'fixture',
      addresses: async (refs: readonly any[]) =>
        refs.map(ref => deriveDappPersona(MASTER, ref).address),
      signDigest: async (ref: any, digest: string) =>
        deriveDappPersona(MASTER, ref).node.signingKey.sign(digest).serialized,
    }),
    createDappSolanaSigner: async () => ({
      publicKey: SOLANA_KEY.publicKey.toBase58(),
      signMessage: async (message: Uint8Array) =>
        ed25519.sign(message, SOLANA_KEY.secretKey.slice(0, 32)),
      signTransaction: async (serialized: Uint8Array) => {
        const tx = VersionedTransaction.deserialize(serialized)
        await tx.sign([SOLANA_KEY])
        return tx.serialize()
      },
    }),
  } as any
}

describe('approved dApp request executor', () => {
  it('signs EVM personal messages with the site persona and returns a verifiable signature', async () => {
    const signature = (await executeApprovedDappRequest(
      {
        id: 'sign-1',
        origin: ORIGIN,
        method: 'personal_sign',
        params: ['0x68656c6c6f', EVM_PERSONA.address],
        chainIdHex: '0x1',
        personaRef: REF,
        personaAddress: EVM_PERSONA.address,
      },
      fakeSession(),
    )) as string
    expect(verifyMessage('hello', signature)).toBe(EVM_PERSONA.address)
  })

  it('hands an approved EVM transaction to the wallet subaccount send without app-side RPC', async () => {
    const originalFetch = global.fetch
    global.fetch = jest.fn(async () => {
      throw new Error('app must not broadcast')
    }) as typeof fetch
    const sendLegacyFromSubAccount = jest.fn(async () => ({
      operationId: 'journal-1',
      txHash: '0x' + 'ab'.repeat(32),
    }))
    const openEvmWallet = jest.fn(async (chainIdentifier: string) => ({
      wallet: { chainIdentifier, sendLegacyFromSubAccount },
    })) as any
    const request = {
      id: 'approved-1',
      origin: ORIGIN,
      method: 'eth_sendTransaction',
      chainIdHex: '0x1',
      personaRef: REF,
      personaAddress: EVM_PERSONA.address,
      params: [
        {
          from: EVM_PERSONA.address,
          to: Wallet.createRandom().address,
          value: '0x10',
          data: '0x1234',
          gas: '0xc350',
          maxFeePerGas: '0x5',
          maxPriorityFeePerGas: '0x2',
          type: '0x2',
        },
      ],
    }
    try {
      const hash = await executeApprovedDappRequest(request, fakeSession(), {
        openEvmWallet,
      })
      expect(hash).toBe('0x' + 'ab'.repeat(32))
      expect(openEvmWallet).toHaveBeenCalledWith('ethereum-mainnet')
      expect(sendLegacyFromSubAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          operationId: expect.stringMatching(/^dapp-[0-9a-f]{64}$/),
          source: REF,
          expectedSourceAddress: EVM_PERSONA.address,
          recipient: { raw: request.params[0].to },
          value: 16n,
          data: '0x1234',
          gasLimit: 50000n,
          type: 2,
          maxFeePerGasWei: 5n,
          maxPriorityFeePerGasWei: 2n,
        }),
      )
      await executeApprovedDappRequest(request, fakeSession(), {
        openEvmWallet,
      })
      expect(sendLegacyFromSubAccount.mock.calls[1]![0].operationId).toBe(
        sendLegacyFromSubAccount.mock.calls[0]![0].operationId,
      )
      expect(global.fetch).not.toHaveBeenCalled()
    } finally {
      global.fetch = originalFetch
    }
  })

  it('rejects a changed approved persona before opening a wallet', async () => {
    const openEvmWallet = jest.fn() as any
    await expect(
      executeApprovedDappRequest(
        {
          id: 'wrong-sender',
          origin: ORIGIN,
          method: 'eth_sendTransaction',
          chainIdHex: '0x1',
          personaRef: REF,
          personaAddress: EVM_PERSONA.address,
          params: [
            {
              from: Wallet.createRandom().address,
              to: Wallet.createRandom().address,
              value: '0x1',
            },
          ],
        },
        fakeSession(),
        { openEvmWallet },
      ),
    ).rejects.toThrow('sender')
    expect(openEvmWallet).not.toHaveBeenCalled()
  })

  it('returns the actual Solana key and signs a message with its matching Ed25519 key', async () => {
    const account = (await executeApprovedDappRequest(
      {
        id: 'sol-connect',
        origin: ORIGIN,
        method: 'solana_connect',
        params: {},
      },
      fakeSession(),
    )) as { address: string; publicKey: number[] }
    expect(account.address).toBe(SOLANA_KEY.publicKey.toBase58())
    expect(account.publicKey).toEqual(
      Array.from(SOLANA_KEY.publicKey.toBytes()),
    )
    const message = new Uint8Array([9, 8, 7])
    const result = (await executeApprovedDappRequest(
      {
        id: 'sol-sign',
        origin: ORIGIN,
        method: 'solana_signMessage',
        params: { message: Array.from(message), account: account.address },
        solanaAccountAddress: account.address,
      },
      fakeSession(),
    )) as { signature: number[] }
    expect(
      ed25519.verify(
        Uint8Array.from(result.signature),
        message,
        Uint8Array.from(account.publicKey),
      ),
    ).toBe(true)
  })

  it('refuses to sign when the Solana account changes after approval preview, even without params.account', async () => {
    const otherKey = await Keypair.fromSeed(new Uint8Array(32).fill(42))
    const signMessage = jest.fn(async () => new Uint8Array(64))
    const session = fakeSession()
    session.createDappSolanaSigner = async () => ({
      publicKey: otherKey.publicKey.toBase58(),
      signMessage,
      signTransaction: async (bytes: Uint8Array) => bytes,
    })

    await expect(
      executeApprovedDappRequest(
        {
          id: 'sol-account-switch',
          origin: ORIGIN,
          method: 'solana_signMessage',
          params: { message: [1, 2, 3] },
          solanaAccountAddress: SOLANA_KEY.publicKey.toBase58(),
        },
        session,
      ),
    ).rejects.toThrow('approved Solana account changed')
    expect(signMessage).not.toHaveBeenCalled()
  })

  it('signs and submits a serialized Solana transfer through the configured chain RPC', async () => {
    const destination = (
      await Keypair.fromSeed(new Uint8Array(32).fill(22))
    ).publicKey.toBytes()
    const blockhash = new Uint8Array(32).fill(4)
    const transferData = new Uint8Array(12)
    transferData.set([2, 0, 0, 0], 0)
    transferData[4] = 1
    const message = new Uint8Array([
      0x80, // v0 message
      1,
      0,
      1, // header: one signer, one readonly unsigned program
      3,
      ...SOLANA_KEY.publicKey.toBytes(),
      ...destination,
      ...new Uint8Array(32), // account keys
      ...blockhash,
      1, // instruction count
      2, // system program account index
      2,
      0,
      1, // signer and destination account indexes
      transferData.length,
      ...transferData,
      0, // address table lookup count
    ])
    const unsigned = new Uint8Array([1, ...new Uint8Array(64), ...message])
    const genesis = jest
      .spyOn(Connection.prototype, 'getGenesisHash')
      .mockResolvedValue('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')
    const send = jest
      .spyOn(Connection.prototype, 'sendRawTransaction')
      .mockImplementation(async bytes => {
        const tx = VersionedTransaction.deserialize(bytes)
        expect(
          ed25519.verify(
            tx.signatures[0]!,
            tx.message.serialize(),
            SOLANA_KEY.publicKey.toBytes(),
          ),
        ).toBe(true)
        const { default: bs58 } = await import('bs58')
        return bs58.encode(tx.signatures[0]!)
      })
    try {
      const signature = await executeApprovedDappRequest(
        {
          id: 'sol-send',
          origin: ORIGIN,
          method: 'solana_signAndSendTransaction',
          params: {
            transaction: Array.from(unsigned),
            account: SOLANA_KEY.publicKey.toBase58(),
            chain: 'solana:devnet',
          },
          solanaAccountAddress: SOLANA_KEY.publicKey.toBase58(),
        },
        fakeSession(),
      )
      expect(signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/)
      expect(send).toHaveBeenCalledTimes(1)
    } finally {
      send.mockRestore()
      genesis.mockRestore()
    }
  })
})
