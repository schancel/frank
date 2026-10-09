/**
 * Unit tests for `monad-hd-keyring.ts` and `monad-account-pool.ts`, against a mocked ethers
 * `Provider` (for the fan-out funding scenarios' nonce/gas reads) and a mocked `MonadTxSubmitter`.
 *
 * NOT CURRENTLY RUN: same pre-existing gap `monad-account-tx.jest.test.ts` documents — this repo's
 * `jest.config.js`/`package.json` reference `jest`, but `jest` (and `ts-jest`, `@types/jest`, and
 * in fact the whole `@quasar/quasar-app-extension-testing-unit-jest` set of packages
 * `jest.config.js` assumes — `vue-jest`, `jest-serializer-vue`, `jest-transform-stub`, ... — none
 * of it) are not actually installed, confirmed again for this ticket by `ls node_modules/.bin/jest`
 * finding nothing after a clean `yarn install`. Fixing that properly means running the Quasar CLI's
 * `quasar ext add @quasar/testing-unit-jest` (or manually adding the whole package set) and
 * touching `app/package.json` — both out of this ticket's file-ownership scope (edits restricted to
 * `app/src/cashweb/wallet/`). This file follows `jest.config.js`'s own `testMatch` convention
 * (`src/**\/*.jest.(spec|test).ts`) so it will be picked up automatically, unmodified, the moment
 * that infra is fixed (tracked as a real follow-up per `PLAN.md`'s relaxed-timeline note, not a
 * stretch goal). Until then:
 *   - `describe`/`it`/`expect`/`jest` below are untyped/unrun; same `env: { jest: true }`
 *     eslint carve-out `monad-account-tx.jest.test.ts` relies on applies here.
 *   - Every scenario here is also exercised for real, right now, without jest, by
 *     `monad-account-pool.livecheck.ts` in this same directory (run via `tsc`+`node`) — see that
 *     file's header for how to run it; it was run for this handoff and all assertions passed.
 */
import { JsonRpcProvider, Transaction, Wallet } from "ethers";

import { MonadHdKeyring, subAccountPath } from "./monad-hd-keyring";
import {
  CAPACITY_CACHE_TTL_MS,
  DEFAULT_TOPUP_BUFFER_SIZE,
  fanOutFundSubAccounts,
  MonadSubAccountPool,
} from "./monad-account-pool";
import { SubAccountLeaseManager } from "./monad-account-lease";
import { MonadAccountTxSigner, MonadTxSubmitter } from "./monad-account-tx";
import { LevelSubAccountPoolStore } from "./storage/level-sub-account-pool-store";
import {
  InMemorySubAccountPoolStore,
  SubAccountPoolStore,
  SubAccountRecord,
} from "./storage/sub-account-pool-storage";

const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";
const CHAIN_ID = 10143; // Monad testnet's chain ID; only a realistic stand-in here.

function makeStubProvider(
  perform: (req: { method: string }) => Promise<unknown>
) {
  const provider = new JsonRpcProvider("http://127.0.0.1:1", CHAIN_ID, {
    staticNetwork: true,
    cacheTimeout: -1,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (provider as any)._perform = perform;
  return provider;
}

function makeMockHttpClient(): jest.Mocked<MonadTxSubmitter> {
  return {
    submitRawTransaction: jest.fn(
      async (rawTxHex: string) => Transaction.from(rawTxHex).hash
    ),
    getTransactionReceipt: jest.fn(),
  };
}

describe("MonadHdKeyring", () => {
  it("derives deterministically from a snapshotted byte domain root", () => {
    const root = new Uint8Array(32).fill(0x21);
    const first = MonadHdKeyring.fromDomainRoot({
      purpose: "evm-wallet",
      bytes: root,
    }).deriveSubAccount(0);
    root.fill(0xff);
    const second = MonadHdKeyring.fromDomainRoot({
      purpose: "evm-wallet",
      bytes: new Uint8Array(32).fill(0x21),
    }).deriveSubAccount(0);
    expect(first).toEqual(second);
  });

  it("rejects domain roots outside the BIP-32 seed boundary", () => {
    expect(() =>
      MonadHdKeyring.fromDomainRoot({
        purpose: "evm-wallet",
        bytes: new Uint8Array(15),
      })
    ).toThrow(/16 to 64 bytes/);
    expect(() =>
      MonadHdKeyring.fromDomainRoot({
        purpose: "evm-wallet",
        bytes: new Uint8Array(65),
      })
    ).toThrow(/16 to 64 bytes/);
  });

  it("rejects a domain root allocated to another purpose at runtime", () => {
    expect(() =>
      MonadHdKeyring.fromDomainRoot({
        purpose: "identity-authentication",
        bytes: new Uint8Array(32),
      } as unknown as Parameters<typeof MonadHdKeyring.fromDomainRoot>[0])
    ).toThrow(/evm-wallet.*domain root/);
  });

  it("derives the same address/private key from the same mnemonic + index (deterministic)", () => {
    const a = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC).deriveSubAccount(0);
    const b = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC).deriveSubAccount(0);
    expect(a.address).toBe(b.address);
    expect(a.privateKey).toBe(b.privateKey);
  });

  it("derives different keypairs for different indices from the same mnemonic", () => {
    const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);
    const a0 = keyring.deriveSubAccount(0);
    const a1 = keyring.deriveSubAccount(1);
    expect(a0.address).not.toBe(a1.address);
    expect(a0.privateKey).not.toBe(a1.privateKey);
  });

  it("builds the expected BIP-44 path for a given index", () => {
    expect(subAccountPath(0)).toBe("m/44'/60'/0'/0/0");
    expect(subAccountPath(7)).toBe("m/44'/60'/0'/0/7");
  });

  it("rejects a negative or non-integer index", () => {
    const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);
    expect(() => keyring.deriveSubAccount(-1)).toThrow();
    expect(() => keyring.deriveSubAccount(1.5)).toThrow();
  });

  it("generate() produces a fresh, valid mnemonic that round-trips through fromMnemonic", () => {
    const { keyring, mnemonic } = MonadHdKeyring.generate();
    expect(mnemonic.split(" ")).toHaveLength(12);
    const rebuilt = MonadHdKeyring.fromMnemonic(mnemonic);
    expect(keyring.deriveSubAccount(0).address).toBe(
      rebuilt.deriveSubAccount(0).address
    );
  });

  it("rejects an invalid mnemonic", () => {
    expect(() => MonadHdKeyring.fromMnemonic("not a real mnemonic")).toThrow(
      /invalid.*mnemonic/i
    );
  });
});

describe("MonadSubAccountPool", () => {
  describe("ensureSize", () => {
    it('derives and persists sub-accounts as "available" up to the requested size', () => {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);
      const pool = new MonadSubAccountPool({ keyring });
      const records = pool.ensureSize(3);

      expect(records).toHaveLength(3);
      expect(records.map((r) => r.index)).toEqual([0, 1, 2]);
      expect(records.every((r) => r.status === "available")).toBe(true);
      expect(records[1].address).toBe(keyring.deriveSubAccount(1).address);
    });

    it("is idempotent: re-calling with the same size does not reset existing status", () => {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);
      const pool = new MonadSubAccountPool({ keyring });
      pool.ensureSize(2);
      pool.setStatus(0, "in-use");
      pool.setStatus(1, "retired");

      pool.ensureSize(2);

      expect(pool.getRecord(0)?.status).toBe("in-use");
      expect(pool.getRecord(1)?.status).toBe("retired");
    });

    it('growing the pool leaves existing records untouched and adds new "available" ones', () => {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);
      const pool = new MonadSubAccountPool({ keyring });
      pool.ensureSize(2);
      pool.setStatus(0, "in-use");

      const records = pool.ensureSize(4);

      expect(records).toHaveLength(4);
      expect(pool.getRecord(0)?.status).toBe("in-use");
      expect(pool.getRecord(3)?.status).toBe("available");
    });

    it("rejects a negative size", () => {
      const pool = new MonadSubAccountPool({
        keyring: MonadHdKeyring.fromMnemonic(TEST_MNEMONIC),
      });
      expect(() => pool.ensureSize(-1)).toThrow();
    });
  });

  describe("selectForStamp (per-stamp rotation)", () => {
    it("round-robins over available accounts, skipping in-use and retired ones", () => {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);
      const pool = new MonadSubAccountPool({ keyring });
      pool.ensureSize(4);
      pool.setStatus(1, "in-use");
      pool.setStatus(2, "retired");
      // Available: 0, 3

      const selections = Array.from(
        { length: 5 },
        () => pool.selectForStamp()?.index
      );

      expect(selections).toEqual([0, 3, 0, 3, 0]);
    });

    it("never mutates the selected record’s status", () => {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);
      const pool = new MonadSubAccountPool({ keyring });
      pool.ensureSize(2);

      pool.selectForStamp();

      expect(pool.records().every((r) => r.status === "available")).toBe(true);
    });

    it("returns undefined when no account is available", () => {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);
      const pool = new MonadSubAccountPool({ keyring });
      pool.ensureSize(2);
      pool.setStatus(0, "retired");
      pool.setStatus(1, "retired");

      expect(pool.selectForStamp()).toBeUndefined();
    });

    it("returns undefined for an empty pool", () => {
      const pool = new MonadSubAccountPool({
        keyring: MonadHdKeyring.fromMnemonic(TEST_MNEMONIC),
      });
      expect(pool.selectForStamp()).toBeUndefined();
    });

    it("resumes rotation after the previously-selected index rather than restarting at 0", () => {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);
      const pool = new MonadSubAccountPool({ keyring });
      pool.ensureSize(3);

      expect(pool.selectForStamp()?.index).toBe(0);
      expect(pool.selectForStamp()?.index).toBe(1);
      // Newly retiring index 2 after it's already been passed shouldn't affect 0/1 rotation order.
      pool.setStatus(2, "retired");
      expect(pool.selectForStamp()?.index).toBe(0);
    });
  });

  describe("getSigner", () => {
    it("returns a MonadAccountTxSigner for the re-derived private key at that index", () => {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);
      const pool = new MonadSubAccountPool({ keyring });
      pool.ensureSize(1);

      const provider = makeStubProvider(async () => {
        throw new Error("no chain reads expected");
      });
      const signer = pool.getSigner(0, {
        provider,
        httpClient: makeMockHttpClient(),
      });

      expect(signer.address.toLowerCase()).toBe(
        keyring.deriveSubAccount(0).address.toLowerCase()
      );
    });

    it("throws for an index the pool was never sized to include", () => {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);
      const pool = new MonadSubAccountPool({ keyring });
      pool.ensureSize(1);

      expect(() =>
        pool.getSigner(5, {
          provider: makeStubProvider(async () => {
            throw new Error("unused");
          }),
          httpClient: makeMockHttpClient(),
        })
      ).toThrow(/No sub-account at index 5/);
    });
  });

  describe("setStatus", () => {
    it("throws for an unknown index", () => {
      const pool = new MonadSubAccountPool({
        keyring: MonadHdKeyring.fromMnemonic(TEST_MNEMONIC),
      });
      pool.ensureSize(1);
      expect(() => pool.setStatus(9, "retired")).toThrow(
        /No sub-account at index 9/
      );
    });
  });

  describe("prepareStampInventory", () => {
    function setupPreparation(
      store: SubAccountPoolStore = new InMemorySubAccountPoolStore()
    ) {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);
      const pool = new MonadSubAccountPool({ keyring, store });
      pool.ensureUnfundedSize(3);
      const balances = new Map<string, bigint>();
      const childNonces = new Map<string, number>();
      let nonce = 0;
      const httpClient = makeMockHttpClient();
      httpClient.submitRawTransaction.mockImplementation(async (rawTx) => {
        const transaction = Transaction.from(rawTx);
        balances.set(
          transaction.to!.toLowerCase(),
          (balances.get(transaction.to!.toLowerCase()) ?? 0n) +
            transaction.value
        );
        return transaction.hash;
      });
      httpClient.getTransactionReceipt.mockImplementation(async (txHash) => ({
        txHash,
        blockNumber: 1,
        blockHash: "0x" + "00".repeat(32),
        status: "success",
        gasUsed: 21_000n,
        effectiveGasPrice: 1n,
        logs: [],
      }));
      const mainWallet = Wallet.createRandom();
      balances.set(mainWallet.address.toLowerCase(), 1_000_000n);
      const provider = makeStubProvider(async (request) => {
        if (request.method === "getTransactionCount") {
          const address = (
            request as unknown as { address: string; blockTag?: string }
          ).address.toLowerCase();
          return address === mainWallet.address.toLowerCase()
            ? nonce++
            : (request as unknown as { blockTag?: string }).blockTag ===
              "pending"
            ? childNonces.get(address) ?? 0
            : 0;
        }
        if (request.method === "getBalance") {
          const address = (request as unknown as { address: string }).address;
          return balances.get(address.toLowerCase()) ?? 0n;
        }
        throw new Error(`unexpected _perform: ${request.method}`);
      });
      const mainAccountSigner = new MonadAccountTxSigner({
        privateKey: mainWallet.privateKey,
        provider,
        httpClient,
      });
      return {
        balances,
        childNonces,
        httpClient,
        mainAccountSigner,
        pool,
        provider,
        store,
        mainAddress: mainWallet.address,
      };
    }

    it("does not move funds on derivation, then prepares unequal receipt-confirmed accounts on Send", async () => {
      const { httpClient, mainAccountSigner, pool, provider } =
        setupPreparation();
      expect(httpClient.submitRawTransaction).not.toHaveBeenCalled();

      const progress: string[] = [];
      const result = await pool.prepareStampInventory({
        mainAccountSigner,
        provider,
        stampValueWei: 1_000n,
        gasReserveWei: 10n,
        fundingOverrides: {
          gasLimit: 21_000n,
          maxFeePerGas: 1n,
          maxPriorityFeePerGas: 1n,
          chainId: BigInt(CHAIN_ID),
        },
        receipt: { maxAttempts: 0 },
        onProgress: (event) => progress.push(event.stage),
      });

      expect(result.selectedAccountCount).toBe(2);
      expect(result.fundingTxHashes).toHaveLength(2);
      expect(httpClient.submitRawTransaction).toHaveBeenCalledTimes(2);
      expect(
        pool.records().filter((record) => record.status === "available")
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ index: 0 }),
          expect.objectContaining({ index: 1 }),
        ])
      );
      expect(await provider.getBalance(pool.getRecord(0)!.address)).toBe(385n);
      expect(await provider.getBalance(pool.getRecord(1)!.address)).toBe(635n);
      expect(progress[0]).toBe("checking");
      expect(progress[progress.length - 1]).toBe("ready");
    });

    it("estimates ordinary UI funding from the main account when gasLimit is not overridden", async () => {
      const { mainAccountSigner, mainAddress, pool, provider } =
        setupPreparation();
      const estimateGas = jest
        .spyOn(provider, "estimateGas")
        .mockResolvedValue(21_000n);

      const result = await pool.prepareStampInventory({
        mainAccountSigner,
        provider,
        stampValueWei: 1_000n,
        gasReserveWei: 10n,
        fundingOverrides: {
          maxFeePerGas: 1n,
          maxPriorityFeePerGas: 1n,
          chainId: BigInt(CHAIN_ID),
        },
        receipt: { maxAttempts: 0 },
      });

      expect(result.selectedAccountCount).toBe(2);
      expect(estimateGas).toHaveBeenCalled();
      expect(estimateGas.mock.calls[0][0]).toEqual(
        expect.objectContaining({ from: mainAddress })
      );
    });

    it("retires a used legacy available address even when it still has spendable balance", async () => {
      const {
        balances,
        childNonces,
        httpClient,
        mainAccountSigner,
        pool,
        provider,
      } = setupPreparation();
      pool.setStatus(0, "available");
      balances.set(pool.getRecord(0)!.address.toLowerCase(), 1_000n);
      childNonces.set(pool.getRecord(0)!.address.toLowerCase(), 1);

      await pool.prepareStampInventory({
        mainAccountSigner,
        provider,
        stampValueWei: 1_000n,
        gasReserveWei: 10n,
        fundingOverrides: {
          gasLimit: 21_000n,
          maxFeePerGas: 1n,
          maxPriorityFeePerGas: 1n,
          chainId: BigInt(CHAIN_ID),
        },
        receipt: { maxAttempts: 0 },
      });

      expect(pool.getRecord(0)?.status).toBe("retired");
      const fundedDestinations = httpClient.submitRawTransaction.mock.calls.map(
        ([raw]) => Transaction.from(raw).to!.toLowerCase()
      );
      expect(fundedDestinations).not.toContain(
        pool.getRecord(0)!.address.toLowerCase()
      );
    });

    it("funds one real account for the one-wei fallback instead of reporting an empty pool ready", async () => {
      const { httpClient, mainAccountSigner, pool, provider } =
        setupPreparation();

      const result = await pool.prepareStampInventory({
        mainAccountSigner,
        provider,
        stampValueWei: 1n,
        gasReserveWei: 10n,
        fundingOverrides: {
          gasLimit: 21_000n,
          maxFeePerGas: 1n,
          maxPriorityFeePerGas: 1n,
          chainId: BigInt(CHAIN_ID),
        },
        receipt: { maxAttempts: 0 },
      });

      expect(result.selectedAccountCount).toBe(1);
      expect(httpClient.submitRawTransaction).toHaveBeenCalledTimes(1);
    });

    it("fails before broadcasting when the complete preferred funding set is unaffordable", async () => {
      const {
        balances,
        httpClient,
        mainAccountSigner,
        mainAddress,
        pool,
        provider,
      } = setupPreparation();
      // Preferred set: (375 + 10) + (625 + 10) of value, plus two 21,000-gas
      // funding transfers at a 1-wei fee cap = 43,020 wei total.
      balances.set(mainAddress.toLowerCase(), 22_009n);

      await expect(
        pool.prepareStampInventory({
          mainAccountSigner,
          provider,
          stampValueWei: 1_000n,
          gasReserveWei: 10n,
          fundingOverrides: {
            gasLimit: 21_000n,
            maxFeePerGas: 1n,
            maxPriorityFeePerGas: 1n,
            chainId: BigInt(CHAIN_ID),
          },
          receipt: { maxAttempts: 0 },
        })
      ).rejects.toThrow(/need up to 22010 wei, have 22009 wei/);

      expect(httpClient.submitRawTransaction).not.toHaveBeenCalled();
      expect(
        pool.records().every((record) => record.status === "unfunded")
      ).toBe(true);
    });

    it("falls back to one funded account when one is affordable but the preferred two are not", async () => {
      const {
        balances,
        httpClient,
        mainAccountSigner,
        mainAddress,
        pool,
        provider,
      } = setupPreparation();
      balances.set(mainAddress.toLowerCase(), 22_010n);

      const result = await pool.prepareStampInventory({
        mainAccountSigner,
        provider,
        stampValueWei: 1_000n,
        gasReserveWei: 10n,
        fundingOverrides: {
          gasLimit: 21_000n,
          maxFeePerGas: 1n,
          maxPriorityFeePerGas: 1n,
          chainId: BigInt(CHAIN_ID),
        },
        receipt: { maxAttempts: 0 },
      });

      expect(result.selectedAccountCount).toBe(1);
      expect(httpClient.submitRawTransaction).toHaveBeenCalledTimes(1);
      const funded = Transaction.from(
        httpClient.submitRawTransaction.mock.calls[0][0]
      );
      expect(funded.value).toBe(1_010n);
    });

    it("serializes concurrent preparations so main-account nonces remain distinct", async () => {
      const { httpClient, mainAccountSigner, pool, provider } =
        setupPreparation();
      await Promise.all([
        pool.prepareStampInventory({
          mainAccountSigner,
          provider,
          stampValueWei: 1_000n,
          gasReserveWei: 10n,
          fundingOverrides: {
            gasLimit: 21_000n,
            maxFeePerGas: 1n,
            maxPriorityFeePerGas: 1n,
            chainId: BigInt(CHAIN_ID),
          },
          receipt: { maxAttempts: 0 },
        }),
        pool.prepareStampInventory({
          mainAccountSigner,
          provider,
          stampValueWei: 1_000n,
          gasReserveWei: 10n,
          fundingOverrides: {
            gasLimit: 21_000n,
            maxFeePerGas: 1n,
            maxPriorityFeePerGas: 1n,
            chainId: BigInt(CHAIN_ID),
          },
          receipt: { maxAttempts: 0 },
        }),
      ]);

      const nonces = httpClient.submitRawTransaction.mock.calls.map(
        ([raw]) => Transaction.from(raw).nonce
      );
      expect(nonces).toEqual([0, 1]);
    });

    it("resubmits the exact durable funding transaction after restart and funds only the missing capacity", async () => {
      const { balances, httpClient, mainAccountSigner, pool, provider, store } =
        setupPreparation();
      const first = pool.getRecord(0)!;
      const signed = await mainAccountSigner.buildAndSignTransfer(
        first.address,
        385n,
        {
          gasLimit: 21_000n,
          maxFeePerGas: 1n,
          maxPriorityFeePerGas: 1n,
          chainId: BigInt(CHAIN_ID),
        }
      );
      store.put({
        ...first,
        status: "funding",
        fundingAttempt: {
          rawTx: signed.rawTx,
          txHash: signed.txHash,
        },
      });
      const broadcasted = new Set<string>();
      httpClient.submitRawTransaction.mockImplementation(async (rawTx) => {
        const transaction = Transaction.from(rawTx);
        broadcasted.add(transaction.hash);
        balances.set(transaction.to!.toLowerCase(), transaction.value);
        return transaction.hash;
      });
      httpClient.getTransactionReceipt.mockImplementation(async (txHash) =>
        broadcasted.has(txHash)
          ? {
              txHash,
              blockNumber: 1,
              blockHash: "0x" + "00".repeat(32),
              status: "success",
              gasUsed: 21_000n,
              effectiveGasPrice: 1n,
              logs: [],
            }
          : undefined
      );

      const restarted = new MonadSubAccountPool({
        keyring: MonadHdKeyring.fromMnemonic(TEST_MNEMONIC),
        store,
      });
      const result = await restarted.prepareStampInventory({
        mainAccountSigner,
        provider,
        stampValueWei: 1_000n,
        gasReserveWei: 10n,
        fundingOverrides: {
          gasLimit: 21_000n,
          maxFeePerGas: 1n,
          maxPriorityFeePerGas: 1n,
          chainId: BigInt(CHAIN_ID),
        },
        receipt: { intervalMs: 0, maxAttempts: 1 },
      });

      expect(httpClient.submitRawTransaction).toHaveBeenCalledWith(
        signed.rawTx
      );
      expect(result.fundingTxHashes[0]).toBe(signed.txHash);
      expect(result.fundingTxHashes).toHaveLength(2);
      const fundedValues = httpClient.submitRawTransaction.mock.calls.map(
        ([raw]) => Transaction.from(raw).value
      );
      expect(fundedValues).toEqual([385n, 635n]);
      expect(restarted.getRecord(0)?.status).toBe("available");
      expect(restarted.getRecord(0)?.fundingAttempt).toBeUndefined();
    });

    describe("a funding row whose durable write failed (Issue #1307)", () => {
      const fundingOverrides = {
        gasLimit: 21_000n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
        chainId: BigInt(CHAIN_ID),
      };

      /** A real Level store whose disk writes can be made to fail, as a full or failing disk
       * would. `durable` lists the funding bytes of every write that actually reached disk. */
      async function openFailableStore(dir: string) {
        const store = new LevelSubAccountPoolStore(dir);
        await store.Open();
        type Batch = (
          operations: ReadonlyArray<{ value?: string }>,
          options: unknown
        ) => Promise<unknown>;
        const db = (store as unknown as { openedDb: { batch: Batch } })
          .openedDb;
        const writeToDisk = db.batch.bind(db);
        const control = { failWrites: false };
        const events: string[] = [];
        db.batch = async (operations, options) => {
          if (control.failWrites) throw new Error("simulated storage failure");
          const result = await writeToDisk(operations, options);
          for (const { value } of operations) {
            if (value?.includes('"status":"funding"')) {
              events.push(`durable:${JSON.parse(value).fundingAttempt.rawTx}`);
            }
          }
          return result;
        };
        return { control, events, store };
      }

      async function withStorageDir(run: (dir: string) => Promise<void>) {
        const os = await import("os");
        const path = await import("path");
        const fs = await import("fs");
        const dir = fs.mkdtempSync(
          path.join(os.tmpdir(), "sub-account-pool-funding-resume-")
        );
        try {
          await run(dir);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }

      /** Opens the pool on a failable store and runs one preparation whose `funding` write
       * fails: nothing is submitted, but the row still reads `funding` in memory. */
      async function recordFundingRowThatNeverReachedDisk(dir: string) {
        const failable = await openFailableStore(dir);
        const fixture = setupPreparation(failable.store);
        await fixture.pool.flush();
        const broadcasted = new Set<string>();
        fixture.httpClient.getTransactionReceipt.mockImplementation(
          async (txHash) =>
            broadcasted.has(txHash)
              ? {
                  txHash,
                  blockNumber: 1,
                  blockHash: "0x" + "00".repeat(32),
                  status: "success",
                  gasUsed: 21_000n,
                  effectiveGasPrice: 1n,
                  logs: [],
                }
              : undefined
        );
        const prepare = (pool: MonadSubAccountPool) =>
          pool.prepareStampInventory({
            mainAccountSigner: fixture.mainAccountSigner,
            provider: fixture.provider,
            stampValueWei: 1_000n,
            gasReserveWei: 10n,
            fundingOverrides,
            receipt: { intervalMs: 0, maxAttempts: 1 },
          });

        failable.control.failWrites = true;
        await expect(prepare(fixture.pool)).rejects.toThrow(
          "simulated storage failure"
        );
        expect(fixture.httpClient.submitRawTransaction).not.toHaveBeenCalled();
        const undurable = fixture.pool.getRecord(0)!;
        expect(undurable.status).toBe("funding");
        const recordedRawTx = undurable.fundingAttempt!.rawTx;
        expect(failable.events).toEqual([]);
        return { ...failable, ...fixture, broadcasted, prepare, recordedRawTx };
      }

      it("submits nothing on resume while the row still cannot be written", async () => {
        await withStorageDir(async (dir) => {
          const { httpClient, pool, prepare, store } =
            await recordFundingRowThatNeverReachedDisk(dir);

          await expect(prepare(pool)).rejects.toThrow(
            "simulated storage failure"
          );

          expect(httpClient.submitRawTransaction).not.toHaveBeenCalled();
          expect(pool.getRecord(0)?.status).toBe("funding");
          await store.Close();

          const reopened = new LevelSubAccountPoolStore(dir);
          await reopened.Open();
          expect(reopened.getByIndex(0)?.status).toBe("unfunded");
          await reopened.Close();
        });
      });

      it("writes the row durably before resubmitting the same bytes exactly once", async () => {
        await withStorageDir(async (dir) => {
          const {
            balances,
            broadcasted,
            control,
            events,
            httpClient,
            mainAccountSigner,
            pool,
            prepare,
            provider,
            recordedRawTx,
            store,
          } = await recordFundingRowThatNeverReachedDisk(dir);
          const childAddress = pool.getRecord(0)!.address;

          // Storage recovers, then the process dies right after the broadcast: no write made
          // after the resubmission reaches disk.
          control.failWrites = false;
          httpClient.submitRawTransaction.mockImplementation(async (rawTx) => {
            const transaction = Transaction.from(rawTx);
            events.push(`submit:${rawTx}`);
            broadcasted.add(transaction.hash!);
            balances.set(transaction.to!.toLowerCase(), transaction.value);
            control.failWrites = true;
            return transaction.hash!;
          });
          await expect(prepare(pool)).rejects.toThrow(
            "simulated storage failure"
          );

          expect(events).toEqual([
            `durable:${recordedRawTx}`,
            `submit:${recordedRawTx}`,
          ]);
          await store.Close();

          const reopened = new LevelSubAccountPoolStore(dir);
          await reopened.Open();
          expect(reopened.getByIndex(0)).toEqual({
            index: 0,
            address: childAddress,
            status: "funding",
            fundingAttempt: {
              rawTx: recordedRawTx,
              txHash: Transaction.from(recordedRawTx).hash,
            },
          });

          // The restarted wallet finishes the recorded transfer instead of funding the child again.
          httpClient.submitRawTransaction.mockImplementation(async (rawTx) => {
            const transaction = Transaction.from(rawTx);
            broadcasted.add(transaction.hash!);
            balances.set(transaction.to!.toLowerCase(), transaction.value);
            return transaction.hash!;
          });
          const restarted = new MonadSubAccountPool({
            keyring: MonadHdKeyring.fromMnemonic(TEST_MNEMONIC),
            store: reopened,
          });
          const result = await restarted.prepareStampInventory({
            mainAccountSigner,
            provider,
            stampValueWei: 1_000n,
            gasReserveWei: 10n,
            fundingOverrides,
            receipt: { intervalMs: 0, maxAttempts: 1 },
          });

          expect(result.fundingTxHashes[0]).toBe(
            Transaction.from(recordedRawTx).hash
          );
          expect(restarted.getRecord(0)?.status).toBe("available");
          const transfersToChild = httpClient.submitRawTransaction.mock.calls
            .map(([rawTx]) => rawTx)
            .filter(
              (rawTx) =>
                Transaction.from(rawTx).to!.toLowerCase() ===
                childAddress.toLowerCase()
            );
          expect(transfersToChild).toEqual([recordedRawTx]);
          await reopened.Close();
        });
      });
    });

    it("keeps a replaced funding attempt in funding when the child balance cannot be read (Issue #1307)", async () => {
      const { balances, httpClient, mainAccountSigner, pool, provider, store } =
        setupPreparation();
      const first = pool.getRecord(0)!;
      const signed = await mainAccountSigner.buildAndSignTransfer(
        first.address,
        385n,
        {
          gasLimit: 21_000n,
          maxFeePerGas: 1n,
          maxPriorityFeePerGas: 1n,
          chainId: BigInt(CHAIN_ID),
        }
      );
      const fundingRow: SubAccountRecord = {
        ...first,
        status: "funding",
        fundingAttempt: { rawTx: signed.rawTx, txHash: signed.txHash },
      };
      store.put(fundingRow);
      // The transfer was mined (the main-account nonce moved past it), but the receipt lags on
      // the receipt backend and the balance read fails on the other one.
      httpClient.submitRawTransaction.mockImplementation(async (rawTx) => {
        if (rawTx === signed.rawTx) throw new Error("nonce too low");
        const transaction = Transaction.from(rawTx);
        balances.set(transaction.to!.toLowerCase(), transaction.value);
        return transaction.hash!;
      });
      jest
        .spyOn(mainAccountSigner, "getStatus")
        .mockImplementation(async (txHash) =>
          txHash === signed.txHash ? "pending" : "confirmed"
        );
      jest.spyOn(mainAccountSigner, "getTransactionCount").mockResolvedValue(5n);
      jest
        .spyOn(mainAccountSigner, "getBalance")
        .mockRejectedValue(new Error("simulated balance read failure"));

      await pool.prepareStampInventory({
        mainAccountSigner,
        provider,
        stampValueWei: 1_000n,
        gasReserveWei: 10n,
        fundingOverrides: {
          gasLimit: 21_000n,
          maxFeePerGas: 1n,
          maxPriorityFeePerGas: 1n,
          chainId: BigInt(CHAIN_ID),
        },
        receipt: { intervalMs: 0, maxAttempts: 1 },
      });

      expect(pool.getRecord(0)).toEqual(fundingRow);
    });
  });

  describe("prepareBurnAccount (ticket #273: one funded account per topic burn)", () => {
    const FUNDING = {
      gasLimit: 21_000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      chainId: BigInt(CHAIN_ID),
    };

    function setupBurn() {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);
      const store = new InMemorySubAccountPoolStore();
      const pool = new MonadSubAccountPool({ keyring, store });
      pool.ensureUnfundedSize(3);
      const balances = new Map<string, bigint>();
      let mainNonce = 0;
      const httpClient = makeMockHttpClient();
      httpClient.submitRawTransaction.mockImplementation(async (rawTx) => {
        const tx = Transaction.from(rawTx);
        balances.set(
          tx.to!.toLowerCase(),
          (balances.get(tx.to!.toLowerCase()) ?? 0n) + tx.value
        );
        return tx.hash;
      });
      httpClient.getTransactionReceipt.mockImplementation(async (txHash) => ({
        txHash,
        blockNumber: 1,
        blockHash: "0x" + "00".repeat(32),
        status: "success",
        gasUsed: 21_000n,
        effectiveGasPrice: 1n,
        logs: [],
      }));
      const mainWallet = Wallet.createRandom();
      balances.set(mainWallet.address.toLowerCase(), 1_000_000n);
      const provider = makeStubProvider(async (request) => {
        const address = (
          (request as unknown as { address?: string }).address ?? ""
        ).toLowerCase();
        if (request.method === "getTransactionCount") {
          return address === mainWallet.address.toLowerCase() ? mainNonce++ : 0;
        }
        if (request.method === "getBalance") return balances.get(address) ?? 0n;
        throw new Error(`unexpected _perform: ${request.method}`);
      });
      const mainAccountSigner = new MonadAccountTxSigner({
        privateKey: mainWallet.privateKey,
        provider,
        httpClient,
      });
      const prepare = (burnValueWei = 1_000n) =>
        pool.prepareBurnAccount({
          mainAccountSigner,
          provider,
          burnValueWei,
          gasReserveWei: 10n,
          fundingOverrides: FUNDING,
          receipt: { maxAttempts: 0 },
        });
      return { balances, httpClient, pool, prepare, store, mainAccountSigner };
    }

    it("funds exactly one account with burn value + fee reserve and reports progress", async () => {
      const { httpClient, pool, prepare } = setupBurn();
      const result = await prepare();

      expect(httpClient.submitRawTransaction).toHaveBeenCalledTimes(1);
      expect(
        Transaction.from(httpClient.submitRawTransaction.mock.calls[0][0]).value
      ).toBe(1_010n);
      expect(pool.getRecord(result.index)?.status).toBe("available");
      expect(result.fundingTxHashes).toHaveLength(1);
    });

    it("a second preparation for the same burn reuses the funded account instead of funding another", async () => {
      const { httpClient, prepare } = setupBurn();
      const first = await prepare();
      const second = await prepare();

      expect(second.index).toBe(first.index);
      expect(httpClient.submitRawTransaction).toHaveBeenCalledTimes(1);
    });

    it("does not burn from a larger account (direct-message inventory): it funds a right-sized one", async () => {
      const { balances, httpClient, pool, prepare } = setupBurn();
      // A 5/8-of-a-stamp DM account, already receipt-confirmed and available.
      const big = pool.getRecord(0)!;
      pool.setStatus(big.index, "available");
      balances.set(big.address.toLowerCase(), 10_000n);

      const result = await prepare(1_000n);

      expect(result.index).not.toBe(big.index);
      expect(httpClient.submitRawTransaction).toHaveBeenCalledTimes(1);
      expect(pool.getRecord(big.index)?.status).toBe("available");
    });

    it("does not burn from an account that cannot cover the burn: it funds a new one", async () => {
      const { balances, httpClient, pool, prepare } = setupBurn();
      const small = pool.getRecord(0)!;
      pool.setStatus(small.index, "available");
      // 400 wei of capacity (410 balance - 10 reserve) cannot burn 1_000.
      balances.set(small.address.toLowerCase(), 410n);

      const result = await prepare(1_000n);

      expect(result.index).not.toBe(small.index);
      expect(httpClient.submitRawTransaction).toHaveBeenCalledTimes(1);
    });

    it("rejects an unaffordable burn before signing or moving anything", async () => {
      const { httpClient, pool, prepare } = setupBurn();

      await expect(prepare(5_000_000n)).rejects.toThrow(
        /Insufficient main account balance/
      );
      expect(httpClient.submitRawTransaction).not.toHaveBeenCalled();
      expect(pool.records().every((r) => r.status === "unfunded")).toBe(true);
    });

    it("rejects a non-positive burn value", async () => {
      const { prepare } = setupBurn();
      await expect(prepare(0n)).rejects.toThrow(
        /burnValueWei must be positive/
      );
    });
  });

  describe("topUpPool (ticket #34: indefinite growth + look-ahead funding buffer)", () => {
    async function makeSigner(nonceStart = 0) {
      const httpClient = makeMockHttpClient();
      httpClient.getTransactionReceipt.mockImplementation(async (txHash) => ({
        txHash,
        blockNumber: 1,
        blockHash: "0x" + "00".repeat(32),
        status: "success",
        gasUsed: 21_000n,
        effectiveGasPrice: 1n,
        logs: [],
      }));
      let nonce = nonceStart;
      const provider = makeStubProvider(async (req) => {
        if (req.method === "getTransactionCount")
          return `0x${(nonce++).toString(16)}`;
        if (req.method === "estimateGas") return "0x5208";
        throw new Error(`unexpected _perform: ${req.method}`);
      });
      return new MonadAccountTxSigner({
        privateKey: Wallet.createRandom().privateKey,
        provider,
        httpClient,
      });
    }

    it("derives and funds fresh indices beyond whatever ensureSize was first called with", async () => {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);
      const pool = new MonadSubAccountPool({ keyring });
      pool.ensureSize(2); // indices 0, 1 -- the "fixed initial size" a caller might start with

      const mainAccountSigner = await makeSigner();
      const results = await pool.topUpPool({
        mainAccountSigner,
        burnValue: 100n,
        gasReserve: 20n,
        bufferSize: 3,
        overrides: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
      });

      // ensureSize(2) already left 0 and 1 'available', so topping up to a buffer of 3 only needs
      // one fresh index -- 2, never re-deriving 0 or 1.
      expect(results.map((r) => r.index)).toEqual([2]);
      expect(pool.getRecord(2)?.status).toBe("available");
      expect(pool.getRecord(2)?.address).toBe(
        keyring.deriveSubAccount(2).address
      );
      expect(pool.records().map((r) => r.index)).toEqual([0, 1, 2]);
    });

    it("does nothing (funds nothing) when the buffer is already full", async () => {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);
      const pool = new MonadSubAccountPool({ keyring });
      pool.ensureSize(5);

      const mainAccountSigner = await makeSigner();
      const results = await pool.topUpPool({
        mainAccountSigner,
        burnValue: 1n,
        gasReserve: 1n,
        bufferSize: 3,
      });

      expect(results).toEqual([]);
      expect(pool.records()).toHaveLength(5); // unchanged, nothing new derived
    });

    it('only counts currently-"available" records toward the buffer -- in-use/spent/retired ones do not count, and growth continues past them (never reuses their indices)', async () => {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);
      const pool = new MonadSubAccountPool({ keyring });
      pool.ensureSize(2);
      pool.setStatus(0, "in-use");
      pool.setStatus(1, "spent");
      // 0 available records currently -- both existing indices are used up.

      const mainAccountSigner = await makeSigner();
      const results = await pool.topUpPool({
        mainAccountSigner,
        burnValue: 1n,
        gasReserve: 1n,
        bufferSize: 2,
        overrides: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
      });

      // Growth resumes at index 2 (one past the highest known index), never re-touching 0 or 1.
      expect(results.map((r) => r.index)).toEqual([2, 3]);
      expect(pool.getRecord(2)?.status).toBe("available");
      expect(pool.getRecord(3)?.status).toBe("available");
      expect(pool.getRecord(0)?.status).toBe("in-use"); // untouched
      expect(pool.getRecord(1)?.status).toBe("spent"); // untouched
    });

    it("uses DEFAULT_TOPUP_BUFFER_SIZE when bufferSize is omitted", async () => {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);
      const pool = new MonadSubAccountPool({ keyring });
      // Empty pool -- deficit is the whole default buffer.
      const mainAccountSigner = await makeSigner();
      const results = await pool.topUpPool({
        mainAccountSigner,
        burnValue: 1n,
        gasReserve: 1n,
        overrides: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
      });

      expect(results).toHaveLength(DEFAULT_TOPUP_BUFFER_SIZE);
      expect(results.map((r) => r.index)).toEqual(
        Array.from({ length: DEFAULT_TOPUP_BUFFER_SIZE }, (_, i) => i)
      );
    });

    it("freshly-funded accounts feed straight into selectForStamp once persisted", async () => {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);
      const pool = new MonadSubAccountPool({ keyring });
      expect(pool.selectForStamp()).toBeUndefined(); // nothing derived yet

      const mainAccountSigner = await makeSigner();
      await pool.topUpPool({
        mainAccountSigner,
        burnValue: 1n,
        gasReserve: 1n,
        bufferSize: 2,
        overrides: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
      });

      expect(pool.selectForStamp()?.index).toBe(0);
    });

    it("does not make a submitted top-up eligible before its receipt succeeds", async () => {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);
      const pool = new MonadSubAccountPool({ keyring });
      const httpClient = makeMockHttpClient();
      const provider = makeStubProvider(async (req) => {
        if (req.method === "getTransactionCount") return "0x0";
        if (req.method === "estimateGas") return "0x5208";
        throw new Error(`unexpected _perform: ${req.method}`);
      });
      const mainAccountSigner = new MonadAccountTxSigner({
        privateKey: Wallet.createRandom().privateKey,
        provider,
        httpClient,
      });

      await expect(
        pool.topUpPool({
          mainAccountSigner,
          burnValue: 1n,
          gasReserve: 1n,
          bufferSize: 1,
          overrides: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
          receipt: { maxAttempts: 0 },
        })
      ).rejects.toThrow(/still pending/);

      expect(pool.getRecord(0)?.status).toBe("funding");
      expect(pool.selectForStamp()).toBeUndefined();
    });

    it("persists exact retry state when a later top-up submission fails", async () => {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);
      const pool = new MonadSubAccountPool({ keyring });

      const httpClient = makeMockHttpClient();
      let nonce = 0;
      let call = 0;
      const provider = makeStubProvider(async (req) => {
        if (req.method === "getTransactionCount")
          return `0x${(nonce++).toString(16)}`;
        if (req.method === "estimateGas") return "0x5208";
        throw new Error(`unexpected _perform: ${req.method}`);
      });
      const flakySigner = new MonadAccountTxSigner({
        privateKey: Wallet.createRandom().privateKey,
        provider,
        httpClient,
      });
      // Fail the second submitted transaction only -- the first must still be durably recorded.
      httpClient.submitRawTransaction.mockImplementation(
        async (rawTxHex: string) => {
          call++;
          if (call === 2) throw new Error("simulated relay failure");
          return Transaction.from(rawTxHex).hash;
        }
      );
      httpClient.getTransactionReceipt.mockImplementation(async (txHash) => ({
        txHash,
        blockNumber: 1,
        blockHash: "0x" + "00".repeat(32),
        status: "success",
        gasUsed: 21_000n,
        effectiveGasPrice: 1n,
        logs: [],
      }));

      await expect(
        pool.topUpPool({
          mainAccountSigner: flakySigner,
          burnValue: 1n,
          gasReserve: 1n,
          bufferSize: 2,
          overrides: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
        })
      ).rejects.toThrow("simulated relay failure");

      // Index 0's funding succeeded before the throw -- it must be recorded as available.
      expect(pool.getRecord(0)?.status).toBe("available");
      // Index 1's exact signed transaction was persisted before its submit failed. A retry resumes
      // that raw transaction rather than deriving or funding another child.
      expect(pool.getRecord(1)?.status).toBe("funding");
      expect(pool.getRecord(1)?.fundingAttempt?.rawTx).toBeDefined();
    });

    describe("a recorded attempt with no receipt (Issue #1307)", () => {
      type Read<T> = () => Promise<T>;

      /** One `funding` row whose transfer the node will not accept again, observed once
       * (`maxAttempts: 0`): the first receipt read finds nothing, then the given reads run. */
      async function observeReplacedAttempt(reads: {
        mainNonce: Read<bigint>;
        childBalance: Read<bigint>;
        receiptReread: Read<"pending" | "confirmed" | "failed">;
      }) {
        const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);
        const store = new InMemorySubAccountPoolStore();
        const pool = new MonadSubAccountPool({ keyring, store });
        const [child] = pool.ensureUnfundedSize(1);
        const mainAccountSigner = await makeSigner();
        const signed = await mainAccountSigner.buildAndSignTransfer(
          child.address,
          2n,
          { gasLimit: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }
        );
        const fundingRow: SubAccountRecord = {
          ...child,
          status: "funding",
          fundingAttempt: { rawTx: signed.rawTx, txHash: signed.txHash },
        };
        store.put(fundingRow);
        const submitRaw = jest
          .spyOn(mainAccountSigner, "submitRaw")
          .mockRejectedValue(new Error("nonce too low"));
        jest
          .spyOn(mainAccountSigner, "getStatus")
          .mockResolvedValueOnce("pending")
          .mockImplementation(reads.receiptReread);
        jest
          .spyOn(mainAccountSigner, "getTransactionCount")
          .mockImplementation(reads.mainNonce);
        jest
          .spyOn(mainAccountSigner, "getBalance")
          .mockImplementation(reads.childBalance);

        const outcome = await pool
          .topUpPool({
            mainAccountSigner,
            burnValue: 1n,
            gasReserve: 1n,
            bufferSize: 1,
            receipt: { maxAttempts: 0 },
          })
          .then(
            () => "resolved",
            (error: Error) => error.message
          );
        // Only the recorded bytes were ever offered to the node: no second child was funded.
        expect(submitRaw.mock.calls).toEqual([[signed.rawTx, signed.txHash]]);
        return { fundingRow, outcome, record: pool.getRecord(0) };
      }

      const advanced: Read<bigint> = async () => 5n;
      const empty: Read<bigint> = async () => 0n;
      const absent: Read<"pending"> = async () => "pending";
      const failing: Read<never> = async () => {
        throw new Error("simulated read failure");
      };

      it("stays funding when the nonce advanced but the balance read fails", async () => {
        const { fundingRow, outcome, record } = await observeReplacedAttempt({
          mainNonce: advanced,
          childBalance: failing,
          receiptReread: absent,
        });
        expect(record).toEqual(fundingRow);
        expect(outcome).toMatch(/still pending/);
      });

      it("stays funding when the nonce read fails", async () => {
        const { fundingRow, outcome, record } = await observeReplacedAttempt({
          mainNonce: failing,
          childBalance: empty,
          receiptReread: absent,
        });
        expect(record).toEqual(fundingRow);
        expect(outcome).toMatch(/still pending/);
      });

      it("stays funding when the receipt cannot be read again", async () => {
        const { fundingRow, outcome, record } = await observeReplacedAttempt({
          mainNonce: advanced,
          childBalance: empty,
          receiptReread: failing,
        });
        expect(record).toEqual(fundingRow);
        expect(outcome).toBe("simulated read failure");
      });

      it("becomes available when the receipt has arrived by the re-read", async () => {
        const { outcome, record } = await observeReplacedAttempt({
          mainNonce: advanced,
          childBalance: empty,
          receiptReread: async () => "confirmed",
        });
        expect(record?.status).toBe("available");
        expect(record?.fundingAttempt).toBeUndefined();
        expect(outcome).toBe("resolved");
      });

      it("is retired when the nonce advanced, the balance is zero and the receipt is still absent", async () => {
        const { outcome, record } = await observeReplacedAttempt({
          mainNonce: advanced,
          childBalance: empty,
          receiptReread: absent,
        });
        expect(record?.status).toBe("retired");
        expect(record?.fundingAttempt).toBeUndefined();
        expect(outcome).toMatch(/superceded by a later nonce/);
      });

      it("becomes available when the child holds a balance", async () => {
        const { outcome, record } = await observeReplacedAttempt({
          mainNonce: failing,
          childBalance: async () => 2n,
          receiptReread: absent,
        });
        expect(record?.status).toBe("available");
        expect(record?.fundingAttempt).toBeUndefined();
        expect(outcome).toBe("resolved");
      });
    });
  });
});

describe("fanOutFundSubAccounts", () => {
  async function makeMainAccountSigner(nonceStart = 0) {
    let nonce = nonceStart;
    const httpClient = makeMockHttpClient();
    const provider = makeStubProvider(async (req) => {
      if (req.method === "getTransactionCount")
        return `0x${(nonce++).toString(16)}`;
      if (req.method === "estimateGas") return "0x5208";
      throw new Error(`unexpected _perform: ${req.method}`);
    });
    const signer = new MonadAccountTxSigner({
      privateKey: Wallet.createRandom().privateKey,
      provider,
      httpClient,
    });
    return { signer, httpClient };
  }

  it("funds each target with burnValue + gasReserve, kept separate as explicit parameters", async () => {
    const { signer } = await makeMainAccountSigner();
    const targets = [
      { index: 0, address: "0x000000000000000000000000000000000000dea0" },
      { index: 1, address: "0x000000000000000000000000000000000000dea1" },
    ];
    const burnValue = 1_000_000_000_000_000n;
    const gasReserve = 250_000_000_000_000n;

    const results = await fanOutFundSubAccounts({
      mainAccountSigner: signer,
      targets,
      burnValue,
      gasReserve,
      overrides: {
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      },
    });

    expect(results).toHaveLength(2);
    for (const [i, result] of results.entries()) {
      expect(result.address).toBe(targets[i].address);
      expect(result.fundedValue).toBe(burnValue + gasReserve);
      expect(result.signedTx.value).toBe(burnValue + gasReserve);
      expect(result.signedTx.to.toLowerCase()).toBe(
        targets[i].address.toLowerCase()
      );
    }
  });

  it("uses distinct, sequential nonces across the fan-out (no racing the same main account)", async () => {
    const { signer } = await makeMainAccountSigner(5);
    const targets = [
      { index: 0, address: "0x000000000000000000000000000000000000dea0" },
      { index: 1, address: "0x000000000000000000000000000000000000dea1" },
      { index: 2, address: "0x000000000000000000000000000000000000dea2" },
    ];

    const results = await fanOutFundSubAccounts({
      mainAccountSigner: signer,
      targets,
      burnValue: 1n,
      gasReserve: 1n,
      overrides: {
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
      },
    });

    expect(results.map((r) => r.signedTx.nonce)).toEqual([5, 6, 7]);
  });

  it("submits every built transaction through the main account signer", async () => {
    const { signer, httpClient } = await makeMainAccountSigner();
    const targets = [
      { index: 0, address: "0x000000000000000000000000000000000000dea0" },
    ];

    await fanOutFundSubAccounts({
      mainAccountSigner: signer,
      targets,
      burnValue: 10n,
      gasReserve: 5n,
      overrides: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
    });

    expect(httpClient.submitRawTransaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["burnValue", { burnValue: -1n, gasReserve: 0n }],
    ["gasReserve", { burnValue: 0n, gasReserve: -1n }],
  ])("rejects a negative %s", async (_label, amounts) => {
    const { signer } = await makeMainAccountSigner();
    await expect(
      fanOutFundSubAccounts({
        mainAccountSigner: signer,
        targets: [
          { index: 0, address: "0x000000000000000000000000000000000000dea0" },
        ],
        ...amounts,
      })
    ).rejects.toThrow(/must be >= 0/);
  });

  it("funds zero targets without error when given an empty list", async () => {
    const { signer } = await makeMainAccountSigner();
    const results = await fanOutFundSubAccounts({
      mainAccountSigner: signer,
      targets: [],
      burnValue: 1n,
      gasReserve: 1n,
    });
    expect(results).toEqual([]);
  });
});

describe("MonadSubAccountPool.fundAll", () => {
  it('funds only the "available" records by default, using fanOutFundSubAccounts under the hood', async () => {
    const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);
    const pool = new MonadSubAccountPool({ keyring });
    pool.ensureSize(3);
    pool.setStatus(1, "in-use");

    let nonce = 0;
    const httpClient = makeMockHttpClient();
    const provider = makeStubProvider(async (req) => {
      if (req.method === "getTransactionCount")
        return `0x${(nonce++).toString(16)}`;
      if (req.method === "estimateGas") return "0x5208";
      throw new Error(`unexpected _perform: ${req.method}`);
    });
    const mainAccountSigner = new MonadAccountTxSigner({
      privateKey: Wallet.createRandom().privateKey,
      provider,
      httpClient,
    });

    const results = await pool.fundAll({
      mainAccountSigner,
      burnValue: 100n,
      gasReserve: 20n,
      overrides: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
    });

    expect(results.map((r) => r.index)).toEqual([0, 2]); // index 1 is in-use, skipped
    expect(results.every((r) => r.fundedValue === 120n)).toBe(true);
  });
});

describe("InMemorySubAccountPoolStore / LevelSubAccountPoolStore", () => {
  it("InMemorySubAccountPoolStore returns records sorted by index", () => {
    const store = new InMemorySubAccountPoolStore();
    store.put({ index: 2, address: "0xabc", status: "available" });
    store.put({ index: 0, address: "0xdef", status: "available" });
    expect(store.getAll().map((r) => r.index)).toEqual([0, 2]);
  });

  it("LevelSubAccountPoolStore persists pool state across a simulated app restart", async () => {
    const os = await import("os");
    const path = await import("path");
    const fs = await import("fs");
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "sub-account-pool-test-")
    );
    try {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);

      const storeA = new LevelSubAccountPoolStore(dir);
      await storeA.Open();
      const poolA = new MonadSubAccountPool({ keyring, store: storeA });
      poolA.ensureSize(2);
      poolA.setStatus(1, "in-use");
      await storeA.Close();

      const storeB = new LevelSubAccountPoolStore(dir);
      await storeB.Open();
      const poolB = new MonadSubAccountPool({ keyring, store: storeB });

      expect(poolB.records()).toHaveLength(2);
      expect(poolB.getRecord(1)?.status).toBe("in-use");
      expect(poolB.getRecord(0)?.address).toBe(
        keyring.deriveSubAccount(0).address
      );
      await storeB.Close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("MonadSubAccountPool.processSyncTransaction (Ticket #1115)", () => {
    it("records spend checkpoint and marks status spent when matching spent input address", () => {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);
      const pool = new MonadSubAccountPool({ keyring });
      pool.ensureSize(3);

      const addr0 = keyring.deriveSubAccount(0).address;
      const addr1 = keyring.deriveSubAccount(1).address;

      expect(pool.getRecord(0)?.status).toBe("available");
      expect(pool.getRecord(0)?.lifecycle?.spend).toBeUndefined();

      const res = pool.processSyncTransaction({
        direction: "out",
        txHash: "0xdeadbeef",
        spentInputs: [
          {
            address: addr0.toLowerCase(),
            valueWei: "5000000000000",
          },
        ],
      });

      expect(res.affectedIndices).toEqual([0]);
      expect(pool.getRecord(0)?.status).toBe("spent");
      expect(pool.getRecord(0)?.lifecycle?.spend?.txHash).toBe("0xdeadbeef");

      // Record 1 should remain untouched
      expect(pool.getRecord(1)?.status).toBe("available");
      expect(pool.getRecord(1)?.lifecycle?.spend).toBeUndefined();
    });
  });

  describe("fundedCapacities and capacity caching (Issue #1179)", () => {
    function setupCapacitiesTest() {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);
      const store = new InMemorySubAccountPoolStore();
      const pool = new MonadSubAccountPool({ keyring, store });
      const balances = new Map<string, bigint>();
      const provider = makeStubProvider(async (request) => {
        if (request.method === "getBalance") {
          const address = (request as unknown as { address: string }).address;
          return balances.get(address.toLowerCase()) ?? 0n;
        }
        throw new Error(`unexpected _perform: ${request.method}`);
      });
      return { balances, keyring, pool, provider, store };
    }

    it("queries candidate sub-account balances concurrently in bounded chunks of 6 via Promise.all", async () => {
      const { balances, pool, provider } = setupCapacitiesTest();
      // Create 8 available sub-accounts
      pool.ensureSize(8);
      for (let i = 0; i < 8; i++) {
        const record = pool.getRecord(i)!;
        balances.set(record.address.toLowerCase(), 10_000n);
      }

      let activeQueries = 0;
      let maxConcurrentQueries = 0;
      const getBalanceSpy = jest
        .spyOn(provider, "getBalance")
        .mockImplementation(async (addr: any) => {
          activeQueries++;
          maxConcurrentQueries = Math.max(maxConcurrentQueries, activeQueries);
          await new Promise((resolve) => setTimeout(resolve, 20));
          activeQueries--;
          return balances.get(String(addr).toLowerCase()) ?? 0n;
        });

      const gasReserveWei = 1_000n;
      const accounts = await pool.fundedCapacities(provider, gasReserveWei);

      expect(accounts).toHaveLength(8);
      expect(getBalanceSpy).toHaveBeenCalledTimes(8);
      // Parallel execution in chunks of 6 ensures concurrency > 1 and <= 6
      expect(maxConcurrentQueries).toBeGreaterThan(1);
      expect(maxConcurrentQueries).toBeLessThanOrEqual(6);

      for (let i = 0; i < 8; i++) {
        expect(accounts[i].index).toBe(i);
        expect(accounts[i].capacityWei).toBe(9_000n);
      }
    });

    it("cached capacities avoid redundant RPC queries within the 30s TTL", async () => {
      const { balances, pool, provider } = setupCapacitiesTest();
      pool.ensureSize(4);
      for (let i = 0; i < 4; i++) {
        balances.set(pool.getRecord(i)!.address.toLowerCase(), 5_000n);
      }

      const getBalanceSpy = jest.spyOn(provider, "getBalance");
      getBalanceSpy.mockClear();

      // Initial call queries RPC and populates capacity cache
      const initial = await pool.fundedCapacities(provider, 500n);
      expect(initial).toHaveLength(4);
      expect(getBalanceSpy).toHaveBeenCalledTimes(4);
      expect(initial[0].capacityWei).toBe(4_500n);

      // Second call within 30s TTL hits the cache with zero RPC roundtrips
      getBalanceSpy.mockClear();
      const cached = await pool.fundedCapacities(provider, 500n);
      expect(cached).toHaveLength(4);
      expect(getBalanceSpy).not.toHaveBeenCalled();
      expect(cached[0].capacityWei).toBe(4_500n);

      // Advance time beyond 30s TTL
      const baseNow = Date.now();
      const nowSpy = jest
        .spyOn(Date, "now")
        .mockReturnValue(baseNow + CAPACITY_CACHE_TTL_MS + 1_000);

      try {
        // Third call after TTL expiration re-queries the provider
        const refreshed = await pool.fundedCapacities(provider, 500n);
        expect(refreshed).toHaveLength(4);
        expect(getBalanceSpy).toHaveBeenCalledTimes(4);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("invalidates or updates capacity cache on spend, lease, and balance updates", async () => {
      const { balances, pool, provider } = setupCapacitiesTest();
      pool.ensureSize(3);
      for (let i = 0; i < 3; i++) {
        balances.set(pool.getRecord(i)!.address.toLowerCase(), 10_000n);
      }

      await pool.fundedCapacities(provider, 1_000n);
      expect(pool.capacityCache.has(0)).toBe(true);
      expect(pool.capacityCache.has(1)).toBe(true);
      expect(pool.capacityCache.has(2)).toBe(true);

      // Lease account 0 -> 'in-use' should invalidate cache entry
      pool.setStatus(0, "in-use");
      expect(pool.capacityCache.has(0)).toBe(false);
      expect(pool.capacityCache.has(1)).toBe(true);

      // Spend account 1 -> 'spent' should invalidate cache entry
      pool.setStatus(1, "spent");
      expect(pool.capacityCache.has(1)).toBe(false);

      // recordSpendTransaction should invalidate cache entry
      pool.updateCapacityCache(2, 5_000n);
      expect(pool.capacityCache.has(2)).toBe(true);
      pool.recordSpendTransaction(2, {
        rawTx: "0x12",
        txHash: "0x34",
        valueWei: "5000",
      });
      expect(pool.capacityCache.has(2)).toBe(false);
    });
  });

  describe("ensureMinimumAvailableCapacity (proactive warming, Issue #1179)", () => {
    function setupWarmingTest() {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);
      const store = new InMemorySubAccountPoolStore();
      const pool = new MonadSubAccountPool({ keyring, store });
      const balances = new Map<string, bigint>();
      let nonce = 0;
      const httpClient = makeMockHttpClient();
      httpClient.submitRawTransaction.mockImplementation(async (rawTx) => {
        const transaction = Transaction.from(rawTx);
        balances.set(
          transaction.to!.toLowerCase(),
          (balances.get(transaction.to!.toLowerCase()) ?? 0n) +
            transaction.value
        );
        return transaction.hash;
      });
      httpClient.getTransactionReceipt.mockImplementation(async (txHash) => ({
        txHash,
        blockNumber: 1,
        blockHash: "0x" + "00".repeat(32),
        status: "success",
        gasUsed: 21_000n,
        effectiveGasPrice: 1n,
        logs: [],
      }));
      const mainWallet = Wallet.createRandom();
      balances.set(mainWallet.address.toLowerCase(), 1_000_000n);
      const provider = makeStubProvider(async (request) => {
        if (request.method === "getTransactionCount") {
          const address = (
            request as unknown as { address: string; blockTag?: string }
          ).address.toLowerCase();
          return address === mainWallet.address.toLowerCase() ? nonce++ : 0;
        }
        if (request.method === "getBalance") {
          const address = (request as unknown as { address: string }).address;
          return balances.get(address.toLowerCase()) ?? 0n;
        }
        if (request.method === "estimateGas") {
          return "0x5208";
        }
        throw new Error(`unexpected _perform: ${request.method}`);
      });
      const mainAccountSigner = new MonadAccountTxSigner({
        privateKey: mainWallet.privateKey,
        provider,
        httpClient,
      });
      const defaultOverrides = {
        gasLimit: 21_000n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
        chainId: BigInt(CHAIN_ID),
      };
      return {
        balances,
        httpClient,
        mainAccountSigner,
        pool,
        provider,
        store,
        mainAddress: mainWallet.address,
        defaultOverrides,
      };
    }

    it("detects depleted pool capacity and replenishes in the background without throwing or blocking", async () => {
      const {
        balances,
        defaultOverrides,
        httpClient,
        mainAccountSigner,
        pool,
        provider,
      } = setupWarmingTest();

      // Start with 0 available sub-accounts in the pool
      expect(
        pool.records().filter((r) => r.status === "available").length
      ).toBe(0);

      const warmingPromise = pool.ensureMinimumAvailableCapacity({
        mainAccountSigner,
        provider,
        minCount: 2,
        stampValueWei: 1_000n,
        overrides: defaultOverrides,
      });

      // Non-blocking: returns a promise immediately without throwing
      expect(typeof warmingPromise.then).toBe("function");

      await warmingPromise;

      // Pool should now have at least 2 available funded sub-accounts
      const available = pool.records().filter((r) => r.status === "available");
      expect(available.length).toBeGreaterThanOrEqual(2);
      expect(httpClient.submitRawTransaction).toHaveBeenCalledTimes(2);

      // The new accounts should have their capacities cached
      expect(pool.capacityCache.get(available[0].index)?.capacityWei).toBe(
        1_000n
      );
      expect(pool.capacityCache.get(available[1].index)?.capacityWei).toBe(
        1_000n
      );
    });

    it("does not schedule funding when pool already has sufficient available capacity", async () => {
      const { balances, httpClient, mainAccountSigner, pool, provider } =
        setupWarmingTest();
      pool.ensureSize(2);
      balances.set(pool.getRecord(0)!.address.toLowerCase(), 22_000n);
      balances.set(pool.getRecord(1)!.address.toLowerCase(), 22_000n);

      await pool.ensureMinimumAvailableCapacity({
        mainAccountSigner,
        provider,
        minCount: 2,
        stampValueWei: 1_000n,
      });

      expect(httpClient.submitRawTransaction).not.toHaveBeenCalled();
    });

    it("swallows funding errors in background without throwing or unhandled rejections", async () => {
      const { mainAccountSigner, pool, provider } = setupWarmingTest();

      jest
        .spyOn(mainAccountSigner, "buildAndSignTransfer")
        .mockRejectedValue(new Error("Simulated network failure"));

      await expect(
        pool.ensureMinimumAvailableCapacity({
          mainAccountSigner,
          provider,
          minCount: 2,
          stampValueWei: 1_000n,
        })
      ).resolves.not.toThrow();
    });

    it("triggers proactive warming when lease is released", async () => {
      const {
        balances,
        defaultOverrides,
        httpClient,
        mainAccountSigner,
        pool,
        provider,
      } = setupWarmingTest();
      pool.ensureSize(2);
      balances.set(pool.getRecord(0)!.address.toLowerCase(), 22_000n);
      balances.set(pool.getRecord(1)!.address.toLowerCase(), 22_000n);

      pool.configureProactiveWarming({
        mainAccountSigner,
        provider,
        minCount: 2,
        stampValueWei: 1_000n,
        overrides: defaultOverrides,
      });

      const leaseManager = new SubAccountLeaseManager(pool);
      const handle = leaseManager.acquireForIndex(0);
      expect(pool.getRecord(0)?.status).toBe("in-use");

      // Releasing lease moves account 0 to spent, leaving only 1 available (< minCount 2)
      leaseManager.releaseLease(handle, "confirmed");
      expect(pool.getRecord(0)?.status).toBe("spent");

      // Awaiting the warming ensures background replenishment completes
      await pool.ensureMinimumAvailableCapacity();

      const available = pool.records().filter((r) => r.status === "available");
      expect(available.length).toBe(2);
      expect(httpClient.submitRawTransaction).toHaveBeenCalled();
    });

    it("detects superceded funding attempts, retires them, and allows preparation to succeed (Issue #1189)", async () => {
      const {
        balances,
        defaultOverrides,
        httpClient,
        mainAccountSigner,
        pool,
        provider,
        store,
      } = setupWarmingTest();
      pool.ensureSize(2);

      // Subaccount 0 is in 'funding' state with a stale raw transaction whose nonce is 0
      const mainWallet = new Wallet(Wallet.createRandom().privateKey, provider);
      const staleTx = await mainWallet.signTransaction({
        to: pool.getRecord(0)!.address,
        value: 10_000n,
        nonce: 0,
        gasLimit: 21_000n,
        gasPrice: 1_000_000_000n,
        chainId: CHAIN_ID,
      });
      const staleHash = Transaction.from(staleTx).hash;

      store.put({
        index: 0,
        address: pool.getRecord(0)!.address,
        status: "funding",
        fundingAttempt: {
          rawTx: staleTx,
          txHash: staleHash!,
        },
      });

      // The node rejects resubmitting the stale tx
      httpClient.submitRawTransaction.mockImplementation(async (rawTx) => {
        if (rawTx === staleTx) {
          throw new Error("An existing transaction had higher priority");
        }
        const transaction = Transaction.from(rawTx);
        balances.set(
          transaction.to!.toLowerCase(),
          (balances.get(transaction.to!.toLowerCase()) ?? 0n) +
            transaction.value
        );
        return transaction.hash;
      });

      // The main signer on-chain nonce is now 5 (> 0), so nonce 0 is superceded
      jest
        .spyOn(mainAccountSigner, "getTransactionCount")
        .mockResolvedValue(5n);
      // getStatus returns 'pending' for the stale evicted tx, and 'confirmed' for fresh txs
      jest
        .spyOn(mainAccountSigner, "getStatus")
        .mockImplementation(async (h) =>
          h === staleHash ? "pending" : "confirmed"
        );
      // Balance on sub-account 0 is 0
      balances.set(pool.getRecord(0)!.address.toLowerCase(), 0n);

      // Preparing inventory must NOT hang or throw; it recovers sub-account 0 by retiring it
      const result = await pool.prepareStampInventory({
        mainAccountSigner,
        provider,
        stampValueWei: 1_000n,
        gasReserveWei: 10n,
        fundingOverrides: defaultOverrides,
        receipt: { maxAttempts: 1, intervalMs: 1 },
      });

      expect(result.selectedAccountCount).toBeGreaterThanOrEqual(1);
      expect(pool.getRecord(0)?.status).toBe("retired");
    });
  });
});
