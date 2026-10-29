/** Actual list/sync account observations; scripted RPC is not live-chain conformance. */
import { Wallet, type Provider } from "ethers";
import { EvmCoinList, type StoredEvmListCoin } from "./evm-coin-list";
import { EvmCoinListSync } from "./evm-coin-list-sync";
import { EvmBlockWatcher } from "./evm-block-watcher";
import { receivedAccountBalanceSnapshot } from "./evm-wallet-coin-list";
import {
  createReceivedPaymentProjection,
  createEvmReceivedCoinAndContactManager,
  type EvmReceivedCoinAndContactManagerParams,
} from "./evm-received-coin-manager";
import { MemoryRecordStore, type EvmCoin } from "./storage/evm-coin-store";

const signer = new Wallet("0x" + "01".padStart(64, "0"));
const account = signer.address.toLowerCase();
const received = 200000000000000000n;
const hash = "ab".repeat(32);
const base: EvmCoin = {
  address: account,
  privateKey: signer.privateKey,
  origin: "stealth",
  state: "unspent",
  amountWei: received.toString(),
  receivedAmountWei: received.toString(),
  claimedAmountWei: received.toString(),
  discoveredAtMs: 1,
  checkedAtMs: 2,
  transactions: [hash],
  ephemeralPubKey: "02" + "33".repeat(32),
  payloadDigest: "aa".repeat(32),
};

async function fixture(coins: EvmCoin[] = [base], rows?: StoredEvmListCoin[]) {
  const store = new MemoryRecordStore<StoredEvmListCoin>();
  for (const row of rows ?? [])
    await store.put(`${row.account}:${row.nonce}`, row);
  const list = await EvmCoinList.open(store);
  const rpc = {
    getBlockNumber: jest.fn(async () => 100),
    getBalance: jest.fn(async () => received),
    getTransactionCount: jest.fn(async () => 0),
  };
  const watcher = new EvmBlockWatcher({ provider: rpc });
  const sync = new EvmCoinListSync({
    list,
    provider: rpc as unknown as Provider,
    watcher,
    sources: () => [
      { account, origin: "stealth", privateKey: () => signer.privateKey },
    ],
  });
  const receipts = new MemoryRecordStore<EvmCoin>();
  for (const coin of coins) await receipts.put(coin.address, coin);
  // Only the read projection is installed/exercised; transport, signing and recovery owners
  // are deliberately absent. Any accidental call beyond this boundary must fail the test.
  const manager = createEvmReceivedCoinAndContactManager({
    chainIdentifier: "monad-regtest",
    chainId: 20143n,
    coinStore: receipts,
    provider: rpc,
    currentReceivedBalances: (addresses: readonly string[]) =>
      receivedAccountBalanceSnapshot(list, sync, addresses),
    receivedCoinFloorWei: () => 10n,
  } as unknown as EvmReceivedCoinAndContactManagerParams);
  return {
    coins,
    receipts,
    store,
    list,
    sync,
    rpc,
    manager,
    read: () => manager.getReceivedPayments()[0]!,
  };
}

it.each([false, true])(
  "historical receipt survives full account spend without old receipt/header reads (plural=%s)",
  async (plural) => {
    const coin = plural
      ? {
          ...base,
          transactions: [hash, "cd".repeat(32)],
          settledTransactions: [hash, "cd".repeat(32)],
        }
      : base;
    const f = await fixture([coin]);
    await f.sync.refreshAccounts([account]);
    expect(f.read()).toMatchObject({
      status: "received",
      amountWei: received,
      receivedAmountWei: received,
      spendable: true,
    });
    f.rpc.getBalance.mockResolvedValue(0n);
    f.rpc.getTransactionCount.mockResolvedValue(1);
    f.sync.markDirty(account);
    await f.sync.refreshAccounts([account]);
    const state = f.coins.map((c) => ({ ...c }));
    const inventory = f.list.all();
    const rpcCalls = f.rpc.getBalance.mock.calls.length;
    for (let i = 0; i < 3; i++)
      expect(f.read()).toMatchObject({
        status: "received",
        amountWei: 0n,
        receivedAmountWei: received,
        spendable: false,
        ...(plural
          ? {
              settledTransactions: coin.settledTransactions,
              transactions: coin.transactions,
            }
          : {}),
      });
    expect(f.coins).toEqual(state);
    expect(f.list.all()).toEqual(inventory);
    expect(f.rpc.getBalance).toHaveBeenCalledTimes(rpcCalls);
    // The finite zero remains last-known when a later observation is invalidated and fails.
    f.sync.markDirty(account);
    f.rpc.getBalance.mockRejectedValue(new Error("unreadable"));
    const warn = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    await f.sync.refreshAccounts([account]);
    expect(f.sync.hasObservedEmpty(account)).toBe(false);
    expect(f.read()).toMatchObject({
      amountWei: 0n,
      spendable: false,
      receivedAmountWei: received,
    });
    warn.mockRestore();
    await f.sync.stop();
  }
);

it("confirmed nonzero successor is current funds; consuming its preceding nonce is not empty evidence", async () => {
  const f = await fixture();
  await f.list.put({
    account,
    nonce: 0,
    privateKey: signer.privateKey,
    valueWei: received,
    origin: "stealth",
    listedInBlock: 90,
  });
  expect(f.read().amountWei).toBe(received);
  await f.list.recordMined({ account, nonce: 0 }, { block: 100 });
  // This intermediate source-only checkpoint says nothing about the successor balance.
  expect(f.read()).toMatchObject({ amountWei: received, spendable: true });
  await f.list.put({
    account,
    nonce: 1,
    privateKey: signer.privateKey,
    valueWei: 7n,
    origin: "stealth",
    listedInBlock: 100,
    lastSpentInBlock: 100,
  });
  expect(f.read()).toMatchObject({
    status: "received",
    amountWei: 7n,
    receivedAmountWei: received,
    spendable: true,
    tooSmall: true,
  });
  // Reopen the actual stored list: current successor beats the old arrival record.
  const reopened = await EvmCoinList.open(f.store);
  const read = createReceivedPaymentProjection({
    coins: () => [base],
    floorWei: () => 10n,
    currentBalances: (addresses) =>
      receivedAccountBalanceSnapshot(reopened, f.sync, addresses),
  });
  expect(read.read()[0]).toMatchObject({
    amountWei: 7n,
    receivedAmountWei: received,
    spendable: true,
    tooSmall: true,
  });
  await f.sync.stop();
});

it("confirmed explicit zero successor survives reopen and no unknown input resurrects its arrival balance", async () => {
  const f = await fixture();
  await f.list.put({
    account,
    nonce: 1,
    privateKey: signer.privateKey,
    valueWei: 0n,
    origin: "stealth",
    listedInBlock: 100,
    lastSpentInBlock: 100,
  });
  expect(f.read()).toMatchObject({ amountWei: 0n, spendable: false });
  const reopened = await EvmCoinList.open(f.store);
  const read = createReceivedPaymentProjection({
    coins: () => [base],
    floorWei: () => 10n,
    currentBalances: (addresses) =>
      receivedAccountBalanceSnapshot(reopened, f.sync, addresses),
  });
  expect(read.read()[0]).toMatchObject({
    status: "received",
    amountWei: 0n,
    receivedAmountWei: received,
    spendable: false,
  });
  await f.list.recordGone({ account, nonce: 1 });
  expect(f.sync.hasObservedEmpty(account)).toBe(false);
  expect(f.read()).toMatchObject({ amountWei: 0n, spendable: false });
  await f.sync.stop();
});

it.each([
  "absent",
  "reserved",
  "ambiguous",
  "provisional",
  "unconfirmed",
  "dirty",
] as const)(
  "%s is not proof that a historically received account was emptied",
  async (kind) => {
    const row: StoredEvmListCoin = {
      account,
      nonce: 0,
      privateKey: signer.privateKey,
      valueWei: "0",
      origin: "stealth",
      state: kind === "ambiguous" ? "pending_receipt" : "unspent",
      listedInBlock: 90,
      ...(kind === "ambiguous"
        ? {
            holder: "original",
            spendingTx: await signer.signTransaction({
              chainId: 20143n,
              nonce: 0,
              to: account,
              value: 1n,
              gasLimit: 21000n,
              gasPrice: 1n,
            }),
          }
        : {}),
    };
    const rows =
      kind === "absent" || kind === "reserved"
        ? []
        : [
            {
              ...row,
              ...(kind === "provisional"
                ? { after: { account: "0x" + "44".repeat(20), nonce: 0 } }
                : {}),
              ...(kind === "unconfirmed" ? { listedInBlock: undefined } : {}),
            },
          ];
    const f = await fixture([base], rows);
    if (kind === "reserved") {
      await f.list.put({
        account,
        nonce: 0,
        privateKey: signer.privateKey,
        valueWei: received,
        origin: "stealth",
        listedInBlock: 90,
      });
      expect(
        f.list.select({
          holder: "other-operation",
          amountWei: 1n,
          feeReserveWei: 1n,
        })
      ).toBeDefined();
    }
    if (kind === "dirty") f.sync.markDirty(account);
    expect(f.read()).toMatchObject({
      status: "received",
      amountWei: received,
      receivedAmountWei: received,
      spendable: true,
    });
    await f.sync.stop();
  }
);

it("a read overtaken by a dirty mark cannot create empty evidence", async () => {
  const f = await fixture();
  await f.sync.refreshAccounts([account]);
  expect(f.read().amountWei).toBe(received);
  let finish!: (v: bigint) => void;
  let started!: () => void;
  const underway = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.rpc.getBalance.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
        started();
      })
  );
  const refresh = f.sync.refreshAccounts([account]);
  await underway;
  f.sync.markDirty(account);
  finish(0n);
  await refresh;
  expect(f.sync.hasObservedEmpty(account)).toBe(false);
  expect(f.read()).toMatchObject({ amountWei: received, spendable: true });
  await f.sync.stop();
});

it("unverified claims do not become received or spendable through the derived projection", async () => {
  const f = await fixture([
    { ...base, state: "pending", amountWei: "0", receivedAmountWei: undefined },
  ]);
  await f.sync.refreshAccounts([account]);
  expect(f.read()).toMatchObject({
    status: "unverifiable",
    amountWei: 0n,
    spendable: false,
  });
  await f.sync.stop();
});
