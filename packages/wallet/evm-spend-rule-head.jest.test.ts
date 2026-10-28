// A received payment is spent only once the node can see it. Monad's transaction pool judges a
// new transaction against the sender's balance at its last committed block minus
// `spendSpacingBlocks - 1` (monad-bft v0.16.4, monad-eth-txpool/src/pool/mod.rs); eth_blockNumber
// names the newest proposed block, which a loaded node lets run ahead of the committed one.
//
// The layout and timing are the blackjack livecheck's (PR #1947, run 13, hand 1): the player's
// bet of 0.04284 MON reached a fresh stealth account in block 348579; the dealer's payout spent
// all of it (0.040698 to the player plus 21,000 gas at 102 gwei) when the proposed head was
// 348588. The node refused it ("Signer had insufficient balance"), so its view was still before
// block 348579, and it kept refusing those bytes for 15 minutes.
import { Transaction, Wallet, type Provider } from "ethers";
import { installEvmTransactionSetRuntime } from "./evm-transaction-set-runtime";
import { EvmCoinList, type StoredEvmListCoin } from "./evm-coin-list";
import { EvmChangePool } from "./evm-change-pool";
import { EvmSubAccountPool } from "./evm-account-pool";
import { MonadHdKeyring, MonadChangeKeyring } from "./secp256k1-hd-keyring";
import { MonadIdentity } from "./evm-identity";
import { MemoryRecordStore, type EvmCoin } from "./storage/evm-coin-store";
import { EvmNativeOperationJournal } from "./storage/evm-native-operation-journal";
import { EvmTransactionSetInsufficientFundsError } from "./evm-transaction-set-types";
import {
  FinalizedHeadUnavailableError,
  MAX_FINALIZED_LAG_BLOCKS,
  readSpendRuleHead,
  spendRuleHeadReader,
} from "./chain/evm-spend-rule";
import { describeWalletFailure } from "./wallet-failure";
import { waitForSpendSpacing } from "./evm-stamp-payer";
import { getChainRegistryEntry } from "./chain/chains-registry";

const FUNDED = 348579;
const BET = 42_840_000_000_000_000n;
const PAYOUT = 40_698_000_000_000_000n;
const GAS_PRICE = 102_000_000_000n;
const SPACING = 3;
const mnemonic = "test test test test test test test test test test test junk";
const RECIPIENT = new Wallet("0x" + "50".repeat(32)).address;

/** A Monad node: `latest` is the proposed head, `finalized` the committed one. The pool admits a
 * transaction only if its sender held the gas it may pay at `finalized - (SPACING - 1)`. Like
 * monad-rpc (`get_block_key`), it answers a numbered read only up to the finalized block or for
 * the newest one; any other number is "Block requested not found", as a lagging replica behind
 * a load balancer answers. */
function monadNode(stealth: string, funded = FUNDED, spentAt?: number) {
  const heads = { latest: funded + 9, finalized: funded + 1 };
  // Behind a load balancer the replica that answers a read may be a block or two behind the
  // one that named the newest block: then no number above the finalized block is answered.
  // `finalized` set: the replica's own finalized block is that one, below what the wallet saw
  // from another replica, and it answers no number above it. `failing`: every numbered read
  // fails (a timeout, a 5xx).
  // `voted`: the node also answers the blocks it voted on, here every block to the newest.
  const replica: {
    lagging: boolean;
    finalized?: number;
    failing: boolean;
    voted: boolean;
  } = {
    lagging: false,
    failing: false,
    voted: false,
  };
  const balanceAt = (address: string, block: number) =>
    address.toLowerCase() === stealth && block >= funded ? BET : 0n;
  // `spentAt`: the account's one transfer was mined in that block.
  const nonceAt = (address: string, block: number) =>
    address.toLowerCase() === stealth &&
    spentAt !== undefined &&
    block >= spentAt
      ? 1
      : 0;
  const blockOf = (tag?: number | string) => {
    if (typeof tag !== "number") return heads.latest;
    if (replica.failing) throw new Error("504 Gateway Timeout");
    if (replica.finalized !== undefined && tag > replica.finalized)
      throw new Error("Block requested not found");
    if (
      tag > heads.finalized &&
      !(replica.voted && tag <= heads.latest) &&
      (replica.lagging || tag !== heads.latest)
    )
      throw new Error("Block requested not found");
    return tag;
  };
  const provider = {
    getBlockNumber: jest.fn(async () => heads.latest),
    getBlock: jest.fn(async (tag: string) => {
      if (tag !== "finalized") throw new Error(`unexpected block tag ${tag}`);
      return { number: heads.finalized };
    }),
    getBalance: jest.fn(async (address: string, tag?: number | string) =>
      balanceAt(address, blockOf(tag))
    ),
    getTransactionCount: jest.fn(
      async (address: string, tag?: number | string) =>
        nonceAt(address, tag === "pending" ? heads.latest : blockOf(tag))
    ),
    getFeeData: jest.fn(async () => ({ gasPrice: GAS_PRICE })),
  };
  const admits = (raw: string) => {
    const tx = Transaction.from(raw);
    const view = heads.finalized - (SPACING - 1);
    return balanceAt(tx.from!, view) >= tx.gasLimit * tx.gasPrice!;
  };
  return { heads, provider, admits, replica };
}

async function dealer(
  spendRuleHead: "latest" | "finalized" | undefined,
  funded = FUNDED,
  spentAt?: number
) {
  const stealthKey = new Wallet("0x" + "33".repeat(32));
  const stealth = stealthKey.address.toLowerCase();
  const node = monadNode(stealth, funded, spentAt);
  const coinStore = new MemoryRecordStore<EvmCoin>();
  await coinStore.put(stealth, {
    address: stealth,
    privateKey: stealthKey.privateKey,
    origin: "stealth",
    state: "unspent",
    amountWei: BET.toString(),
    claimedAmountWei: BET.toString(),
    transactions: [],
    discoveredAtMs: 0,
  });
  const changeKeyring = MonadChangeKeyring.fromMnemonic(mnemonic);
  const journal = new EvmNativeOperationJournal({
    testOnlyEphemeral: true,
    binding: {
      chainIdentifier: "monad-regtest",
      nativeChainId: "20143",
      publicTuple: "spend-rule-head",
    },
  });
  await journal.Open();
  const coinList = await EvmCoinList.open(
    new MemoryRecordStore<StoredEvmListCoin>()
  );
  const runtime = installEvmTransactionSetRuntime({
    mainAccount: new Wallet("0x" + "11".repeat(32)),
    identity: MonadIdentity.fromSeed({ mnemonic }),
    coinList,
    changeKeyring,
    changePool: new EvmChangePool({ keyring: changeKeyring }),
    pool: new EvmSubAccountPool({
      keyring: MonadHdKeyring.fromMnemonic(mnemonic),
    }),
    coinStore,
    provider: node.provider as unknown as Provider,
    journal,
    kind: "monad",
    knownNoCodeAddress: new Wallet("0x" + "22".repeat(32)).address,
    spendSpacingBlocks: SPACING,
    reserveBalanceWei: 10_000_000_000_000_000_000n,
    spendRuleHead,
  });
  const pay = (operationId: string) =>
    runtime.transactionSetPreparer.constructTransactionSet({
      operationId,
      amountWei: PAYOUT,
      kdf: () => RECIPIENT,
    });
  return { node, runtime, journal, stealth, pay, coinList };
}

it("the Monad networks count the spend rule from the finalized head", () => {
  for (const id of ["monad-testnet", "monad-regtest", "monad-mainnet"])
    expect(getChainRegistryEntry(id)?.spendRuleHead).toBe("finalized");
});

it("readSpendRuleHead names the finalized block on Monad and the newest one elsewhere", async () => {
  const { provider, heads } = monadNode("0x");
  await expect(readSpendRuleHead(provider, "finalized")).resolves.toBe(
    heads.finalized
  );
  await expect(readSpendRuleHead(provider, undefined)).resolves.toBe(
    heads.latest
  );
  await expect(readSpendRuleHead(provider, "latest")).resolves.toBe(
    heads.latest
  );
});

/** Every head step: refresh, then pay. Whatever the wallet signs, the node must admit. */
async function payAsHeadsMove(
  f: Awaited<ReturnType<typeof dealer>>,
  steps: readonly { finalized: number; latest: number }[]
) {
  const outcomes: (number | "paid")[] = [];
  // The wallet reads the finalized head again at most every 500 ms (`spendRuleHeadReader`):
  // each step is a few seconds later.
  let clock = Date.now();
  const time = jest.spyOn(Date, "now").mockImplementation(() => clock);
  for (const [i, step] of steps.entries()) {
    clock += 3_000;
    Object.assign(f.node.heads, step);
    await f.runtime.refresh();
    const result = await f.pay(`payout-${i}`).catch((error) => error);
    if (result instanceof EvmTransactionSetInsufficientFundsError) {
      outcomes.push(result.spendableFromBlock!);
      continue;
    }
    if (result instanceof Error) throw result;
    const raws = [...result.bundle, ...result.otherTransactions].map(
      (tx) => tx.rawTransaction
    );
    const payout = raws
      .map((raw) => Transaction.from(raw))
      .find((tx) => tx.to === RECIPIENT)!;
    expect(payout.from!.toLowerCase()).toBe(f.stealth);
    expect(payout.value).toBe(PAYOUT);
    for (const raw of raws) expect(f.node.admits(raw)).toBe(true);
    outcomes.push("paid");
    break;
  }
  time.mockRestore();
  return outcomes;
}

it("does not sign the payout from a bet the node cannot see yet, and pays it once the node can", async () => {
  // The incident: the bet is in a finalized block (FUNDED <= finalized), the proposed head runs
  // nine blocks ahead and the node's view (finalized - 2) is still before the bet.
  const f = await dealer("finalized");
  try {
    const outcomes = await payAsHeadsMove(f, [
      { finalized: FUNDED + 1, latest: FUNDED + 9 },
      // The node sees the bet from finalized FUNDED + 2; the wallet keeps two blocks more.
      { finalized: FUNDED + 3, latest: FUNDED + 12 },
      { finalized: FUNDED + 5, latest: FUNDED + 14 },
    ]);
    // Dated by the finalized block that shows it, not by the proposed head.
    expect(outcomes).toEqual([FUNDED + 1 + 4, FUNDED + 1 + 4, "paid"]);
    expect(f.journal.list().filter((row) => !row.cancelled)).toHaveLength(1);
  } finally {
    await f.runtime.stop();
    await f.journal.Close();
  }
});

it("money that arrived after the finalized head waits from the newest block, and is paid after", async () => {
  // finalized < FUNDED <= latest: the node cannot even be asked about the bet's block by number.
  const f = await dealer("finalized");
  try {
    const outcomes = await payAsHeadsMove(f, [
      { finalized: FUNDED - 3, latest: FUNDED + 2 },
      { finalized: FUNDED + 1, latest: FUNDED + 6 },
      { finalized: FUNDED + 3, latest: FUNDED + 8 },
      { finalized: FUNDED + 6, latest: FUNDED + 9 },
    ]);
    expect(outcomes).toEqual([
      FUNDED + 2 + 4,
      FUNDED + 2 + 4,
      FUNDED + 2 + 4,
      "paid",
    ]);
  } finally {
    await f.runtime.stop();
    await f.journal.Close();
  }
});

it("a lagging replica that answers no number above its finalized block still lists the coin", async () => {
  const f = await dealer("finalized");
  try {
    f.node.replica.lagging = true;
    Object.assign(f.node.heads, { finalized: FUNDED + 1, latest: FUNDED + 9 });
    await f.runtime.refresh();
    expect(f.runtime.coinListSync.isDirty(f.stealth)).toBe(false);
    expect(f.coinList.latestOf(f.stealth)).toMatchObject({
      state: "unspent",
      nonce: 0,
      valueWei: BET,
      spendableFromBlock: FUNDED + 1 + 4,
    });
    for (const call of f.node.provider.getBalance.mock.calls) {
      const tag = call[1];
      if (typeof tag === "number")
        expect(tag).toBeLessThanOrEqual(f.node.heads.finalized);
    }
    expect(f.runtime.coinListSync.assertFundingObserved()).toBeUndefined();
  } finally {
    await f.runtime.stop();
    await f.journal.Close();
  }
});

for (const [name, breakReads] of [
  [
    "every numbered read fails (a timeout, a 5xx)",
    (node: ReturnType<typeof monadNode>) => {
      node.replica.failing = true;
    },
  ],
  [
    "the answering replica's finalized block is below head - 4",
    (node: ReturnType<typeof monadNode>) => {
      node.replica.finalized = node.heads.finalized - 5;
    },
  ],
] as const)
  it(`money whose settled read fails is not spendable at once: ${name}`, async () => {
    const f = await dealer("finalized");
    try {
      breakReads(f.node);
      const outcomes = await payAsHeadsMove(f, [
        { finalized: FUNDED + 1, latest: FUNDED + 9 },
        { finalized: FUNDED + 6, latest: FUNDED + 12 },
        { finalized: FUNDED + 12, latest: FUNDED + 14 },
        { finalized: FUNDED + 13, latest: FUNDED + 15 },
      ]);
      // Unknown is not settled: dated by the newest block when it was read, and kept there
      // (re-reading the same coin does not push it further out).
      expect(outcomes).toEqual([
        FUNDED + 9 + 4,
        FUNDED + 9 + 4,
        FUNDED + 9 + 4,
        "paid",
      ]);
    } finally {
      await f.runtime.stop();
      await f.journal.Close();
    }
  });

it("an account whose earlier nonce cannot be read dates its last transfer by the newest block", async () => {
  // The account's transfer was mined in block FUNDED + 5, after the finalized head (FUNDED + 3)
  // the wallet counts on; the read of its nonce at head - spacing fails.
  const spent = FUNDED + 5;
  const f = await dealer("finalized", FUNDED, spent);
  try {
    f.node.replica.failing = true;
    Object.assign(f.node.heads, { finalized: FUNDED + 3, latest: FUNDED + 9 });
    await f.runtime.refresh();
    const coin = f.coinList.latestOf(f.stealth)!;
    expect(coin).toMatchObject({ state: "unspent", nonce: 1 });
    expect(coin.lastSpentInBlock).toBeGreaterThanOrEqual(spent);
  } finally {
    await f.runtime.stop();
    await f.journal.Close();
  }
});

it("the finalized head is read again only when the newest block moved, and at most every 500 ms", async () => {
  const { provider, heads } = monadNode("0x");
  let clock = 0;
  const read = spendRuleHeadReader(provider, "finalized", { now: () => clock });
  await expect(read()).resolves.toBe(heads.finalized);
  heads.finalized += 1;
  clock += 1_000;
  // The newest block has not moved: the last answer, with no block read.
  await expect(read()).resolves.toBe(heads.finalized - 1);
  heads.latest += 1;
  clock += 100;
  await expect(read()).resolves.toBe(heads.finalized);
  heads.latest += 1;
  heads.finalized += 1;
  clock += 100;
  // Moved, but within 500 ms of the last block read.
  await expect(read()).resolves.toBe(heads.finalized - 1);
  clock += 2_000;
  await expect(read()).resolves.toBe(heads.finalized);
  expect(provider.getBlock).toHaveBeenCalledTimes(3);
  // A lagging replica's lower answer never moves the head back.
  heads.finalized -= 2;
  heads.latest += 1;
  clock += 3_000;
  await expect(read()).resolves.toBe(heads.finalized + 2);
  // Elsewhere: eth_blockNumber every time.
  const plain = spendRuleHeadReader(provider, undefined);
  await expect(plain()).resolves.toBe(heads.latest);
});

it("the quiet window after an account's own transfer is counted on the finalized head", async () => {
  // The account's last transfer was mined in block 500; the proposed head is 509, so counted on
  // it the window (3 blocks) is over. The finalized head is 499 and the nonce there is still 0:
  // the transfer counts as one the node holds until the finalized head passes 503.
  const account = new Wallet("0x" + "44".repeat(32)).address;
  const heads = { latest: 509, finalized: 499 };
  const provider = {
    getBlockNumber: async () => heads.latest,
    getBlock: async () => ({ number: heads.finalized }),
    getTransactionCount: async (_address: string, tag: number | string) =>
      tag === "pending" ||
      tag === "latest" ||
      (typeof tag === "number" && tag >= 500)
        ? 1
        : 0,
  } as unknown as Provider;
  let done = false;
  const wait = waitForSpendSpacing(provider, account, SPACING, {
    spendRuleHead: "finalized",
  }).then(() => {
    done = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 900));
  expect(done).toBe(false);
  heads.finalized = 502;
  await new Promise((resolve) => setTimeout(resolve, 900));
  expect(done).toBe(false);
  heads.finalized = 503;
  await wait;
  expect(done).toBe(true);
  // Counted on the proposed head (the networks without `spendRuleHead`), it would not wait.
  heads.finalized = 499;
  await expect(
    Promise.race([
      waitForSpendSpacing(provider, account, SPACING).then(() => "returned"),
      new Promise((resolve) => setTimeout(() => resolve("waited"), 300)),
    ])
  ).resolves.toBe("returned");
});

it("a node whose finalized block stops moving fails the send with that reason, instead of waiting forever", async () => {
  // Solonet after its execution process was restarted (2026-10-27): `finalized` stayed at one
  // block while eth_blockNumber went on.
  const f = await dealer("finalized");
  let clock = Date.now();
  const time = jest.spyOn(Date, "now").mockImplementation(() => clock);
  try {
    Object.assign(f.node.heads, { finalized: FUNDED + 1, latest: FUNDED + 9 });
    await f.runtime.refresh();
    const early = await f.pay("payout").catch((error) => error);
    expect(early).toBeInstanceOf(EvmTransactionSetInsufficientFundsError);
    // The finalized tag freezes while the chain goes on past the limit.
    f.node.heads.latest = FUNDED + 1 + MAX_FINALIZED_LAG_BLOCKS + 1;
    clock += 3_000;
    const waited = await f.runtime.blockWatcher
      .until(early.spendableFromBlock)
      .catch((error) => error);
    expect(waited).toBeInstanceOf(FinalizedHeadUnavailableError);
    expect(waited.message).toMatch(/stopped reporting final blocks/);
    await f.runtime.refresh();
    const refused = await f.pay("payout-again").catch((error) => error);
    expect(refused).toBeInstanceOf(FinalizedHeadUnavailableError);
    // The app shows "the network is busy" for this, not a generic failure.
    expect(describeWalletFailure(refused).retry).toBe("transient");
    expect(
      f.journal.list().filter((row) => row.members.some((m) => m.signed))
    ).toHaveLength(0);
    // The node reports final blocks again: the payout goes out, and the node admits it.
    f.node.heads.finalized = f.node.heads.latest - 2;
    clock += 3_000;
    await f.runtime.refresh();
    const set = await f.pay("payout-later");
    for (const tx of [...set.bundle, ...set.otherTransactions])
      expect(f.node.admits(tx.rawTransaction)).toBe(true);
  } finally {
    time.mockRestore();
    await f.runtime.stop();
    await f.journal.Close();
  }
});

it("counted from the proposed head, the same coin is signed at once into bytes the node refuses", async () => {
  // What every Monad network did before `spendRuleHead`: the bet looks nine blocks old.
  const f = await dealer(undefined);
  try {
    // As in the incident, the node answers the read at the proposed head - 4: a block it voted on.
    f.node.replica.voted = true;
    await f.runtime.refresh();
    const set = await f.pay("payout");
    const payout = [...set.bundle, ...set.otherTransactions]
      .map((tx) => tx.rawTransaction)
      .find((raw) => Transaction.from(raw).to === RECIPIENT)!;
    expect(Transaction.from(payout).from!.toLowerCase()).toBe(f.stealth);
    expect(f.node.admits(payout)).toBe(false);
  } finally {
    await f.runtime.stop();
    await f.journal.Close();
  }
});
