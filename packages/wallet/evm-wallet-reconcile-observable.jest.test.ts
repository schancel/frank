import { runWalletReconcile, type WalletReconcileDeps } from './evm-wallet-reconcile'
import type {
  EvmNativeMember,
  EvmNativeOperation,
} from './storage/evm-native-operation-journal'

const signing = { rawTransaction: '0x02', transactionHash: `0x${'ab'.repeat(32)}` }

function member(signed: EvmNativeMember['signed']): EvmNativeMember {
  return {
    source: { kind: 'account' } as unknown as EvmNativeMember['source'],
    unsignedTransaction: '0x',
    dependencies: [],
    signed,
    exposed: signed !== null,
    observation: { state: 'pending' },
    account: null,
    syncApplied: false,
  }
}

function operation(
  operationId: string,
  members: EvmNativeMember[],
): EvmNativeOperation {
  return {
    version: 1,
    operationId,
    binding: {} as EvmNativeOperation['binding'],
    kind: 'transaction-set',
    recipient: '0x',
    intendedValueWei: '0',
    maximumFeeWei: '0',
    members,
    cancelled: false,
    reservedBytes: 0,
  }
}

function deps(operations: EvmNativeOperation[]) {
  const observed: string[] = []
  const value: WalletReconcileDeps = {
    chainIdentifier: 'monad-testnet',
    readMailbox: async () => [],
    recordReceivedCoins: async () => undefined,
    receivedCoins: () => [],
    coinListAccounts: () => [],
    walkSeed: async () => undefined,
    operations: () => operations,
    observeOperation: async op => {
      observed.push(op.operationId)
    },
    assertOpen: () => undefined,
  }
  return { value, observed }
}

describe('runWalletReconcile: which journal operations it reads from the chain', () => {
  it('reads an operation whose every member is signed', async () => {
    const { value, observed } = deps([
      operation('signed', [member(signing), member(signing)]),
    ])
    const summary = await runWalletReconcile(value)
    expect(observed).toEqual(['signed'])
    expect(summary.operationsObserved).toBe(1)
  })

  // An unsigned member carries `signed: null`: the chain has nothing to say about a plan that
  // was never signed, so the operation is not read.
  it('skips an operation with an unsigned member', async () => {
    const { value, observed } = deps([
      operation('unsigned', [member(null)]),
      operation('partly-signed', [member(signing), member(null)]),
      operation('signed', [member(signing)]),
    ])
    const summary = await runWalletReconcile(value)
    expect(observed).toEqual(['signed'])
    expect(summary.operationsObserved).toBe(1)
  })
})
