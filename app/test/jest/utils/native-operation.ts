import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Transaction, Wallet } from 'ethers'
import { EvmNativeOperationJournal } from '@frank/wallet/storage/evm-native-operation-journal'

/** Real disposable owner, with deterministic test-only signing material. */
export async function includedNativeTransfer(fanIn = false) {
  const location = await mkdtemp(join(tmpdir(), 'frank-native-ui-'))
  const signer = new Wallet('0x' + '41'.repeat(32))
  const staging = new Wallet('0x' + '42'.repeat(32))
  const signers = fanIn ? [signer, staging] : [signer]
  const recipient = '0x000000000000000000000000000000000000dead'
  const binding = {
    chainIdentifier: 'monad-testnet',
    nativeChainId: '10143',
    publicTuple: 'native UI fixture',
  }
  let journal = new EvmNativeOperationJournal({ location, binding })
  await journal.Open()
  let row = await journal.prepare({
    kind: 'legacy',
    recipient,
    intendedValueWei: '10000000000000000',
    members: signers.map((wallet, index) => ({
      source: { kind: 'main', address: wallet.address.toLowerCase() },
      unsignedTransaction: Transaction.from({
        type: 2,
        chainId: 10143n,
        nonce: 0,
        to: fanIn && index === 0 ? staging.address : recipient,
        value: 10000000000000000n,
        gasLimit: 21000n,
        maxFeePerGas: 102000000000n,
        maxPriorityFeePerGas: 102000000000n,
      }).unsignedSerialized,
      dependencies: index ? [0] : [],
    })),
  })
  let hash = ''
  for (let index = 0; index < signers.length; index++) {
    row = await journal.checkpointSigned(
      row.operationId,
      index,
      await signers[index]!.signTransaction(
        Transaction.from(row.members[index]!.unsignedTransaction),
      ),
    )
    hash = row.members[index]!.signed!.transactionHash
    await journal.markExposed(row.operationId, index)
    await journal.recordObservation(
      journal.beginCapture(row.operationId, index),
      {
        state: 'included-success',
        transactionHash: hash,
        blockHash: '0x' + '12'.repeat(32),
        blockNumber: 69526794,
        transactionIndex: index,
        feeWei: '2142000000000000',
      },
      null,
    )
  }
  return {
    hash,
    operationId: row.operationId,
    get journal() {
      return journal
    },
    async reopen() {
      await journal.Close()
      journal = new EvmNativeOperationJournal({ location, binding })
      await journal.Open()
    },
    async close() {
      await journal.Close()
      await rm(location, { recursive: true, force: true })
    },
  }
}
