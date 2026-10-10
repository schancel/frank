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
import { JsonRpcProvider, Signature, Transaction, Wallet } from "ethers";

import { MonadHdKeyring, subAccountPath } from "./monad-hd-keyring";
import {
  CAPACITY_CACHE_TTL_MS,
  DEFAULT_TOPUP_BUFFER_SIZE,
  FUND_AHEAD_RECEIPT_POLL_MS,
  FUND_AHEAD_RECEIPT_WAIT_MS,
  MonadSubAccountPool,
  SubAccountSpendRefusedError,
} from "./monad-account-pool";
import { selectStampAccounts } from "./monad-stamp-account-selection";
import { MonadChangeKeyring } from "./monad-change-keyring";
import { applyWalletSyncItem } from "./sync-dispatcher";
import { WalletSyncItemRejectedError } from "@frank/cashweb/sync-dispatcher";
import { MonadChangePool } from "./monad-change-pool";
import { validateMonadWalletState } from "./storage/monad-wallet-state-validator";
import {
  NoAvailableSubAccountError,
  SubAccountLeaseManager,
} from "./monad-account-lease";
import { EvmNativeOperationJournal } from "./storage/evm-native-operation-journal";
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

    // #1235 Q4. `fundStampInventoryAhead` does not exist on main 8c656f32, so every test in this
    // block fails there for that reason unless it says it is a pin.
    describe("fundStampInventoryAhead: the next message's accounts, through the recorded path (#1235 Q4)", () => {
      const fundingOverrides = {
        gasLimit: 21_000n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
        chainId: BigInt(CHAIN_ID),
      };
      // A funding transfer here may cost 21,000 wei (the overrides above), so the reserve is
      // larger than that: a transfer moves more than it can cost.
      const RESERVE = 30_000n;
      const STAMP = 1_000n;
      const MAX_VALUE = STAMP + 2n * RESERVE;
      type Fixture = ReturnType<typeof setupPreparation>;
      const ahead = (
        f: Pick<Fixture, "mainAccountSigner" | "provider">,
        pool: MonadSubAccountPool,
        extra: Partial<
          Parameters<MonadSubAccountPool["fundStampInventoryAhead"]>[0]
        > = {}
      ) =>
        pool.fundStampInventoryAhead({
          mainAccountSigner: f.mainAccountSigner,
          provider: f.provider,
          stampValueWei: STAMP,
          gasReserveWei: RESERVE,
          maxValueWei: MAX_VALUE,
          fundingOverrides,
          receipt: { intervalMs: 0, maxAttempts: 1 },
          ...extra,
        });
      const submitted = (f: Fixture) =>
        f.httpClient.submitRawTransaction.mock.calls.map(([raw]) =>
          Transaction.from(raw)
        );
      const receiptOnceBroadcast = (f: Fixture, broadcasted: Set<string>) =>
        f.httpClient.getTransactionReceipt.mockImplementation(async (txHash) =>
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
      const statuses = (pool: MonadSubAccountPool) =>
        pool.records().map((record) => record.status);

      it("funds exactly the 3/8 + 5/8 pair one message needs; a send's own preparation then submits nothing, and a repeat funds nothing", async () => {
        const f = setupPreparation();
        const result = await ahead(f, f.pool);

        expect(result.fundingTxHashes).toHaveLength(2);
        expect(submitted(f).map((tx) => tx.value)).toEqual([
          375n + RESERVE,
          625n + RESERVE,
        ]);
        expect(statuses(f.pool)).toEqual(["available", "available", "unfunded"]);

        // What a send does next, with nothing left to fund.
        const prepared = await f.pool.prepareStampInventory({
          mainAccountSigner: f.mainAccountSigner,
          provider: f.provider,
          stampValueWei: STAMP,
          gasReserveWei: RESERVE,
          fundingOverrides,
          receipt: { intervalMs: 0, maxAttempts: 1 },
        });
        expect(prepared).toEqual({
          fundingTxHashes: [],
          selectedAccountCount: 2,
        });
        expect((await ahead(f, f.pool)).fundingTxHashes).toEqual([]);
        expect(f.httpClient.submitRawTransaction).toHaveBeenCalledTimes(2);
      });

      it("two passes started together, and one racing a send's preparation, fund one pair at distinct nonces", async () => {
        const f = setupPreparation();
        const results = await Promise.all([
          ahead(f, f.pool),
          ahead(f, f.pool),
          f.pool.prepareStampInventory({
            mainAccountSigner: f.mainAccountSigner,
            provider: f.provider,
            stampValueWei: STAMP,
            gasReserveWei: RESERVE,
            fundingOverrides,
            receipt: { intervalMs: 0, maxAttempts: 1 },
          }),
        ]);

        expect(results.map((r) => r.fundingTxHashes.length)).toEqual([2, 0, 0]);
        const transfers = submitted(f);
        expect(transfers).toHaveLength(2);
        expect(new Set(transfers.map((tx) => tx.nonce)).size).toBe(2);
        expect(new Set(transfers.map((tx) => tx.to)).size).toBe(2);
      });

      it("refuses a plan over its value limit before anything is signed", async () => {
        const f = setupPreparation();
        const sign = jest.spyOn(f.mainAccountSigner, "buildAndSignTransfer");
        const before = structuredClone(f.pool.records());

        await expect(
          ahead(f, f.pool, { maxValueWei: MAX_VALUE - 1n })
        ).rejects.toMatchObject({
          name: "FundAheadRefusedError",
          code: "over-bound",
        });

        expect(sign).not.toHaveBeenCalled();
        expect(f.httpClient.submitRawTransaction).not.toHaveBeenCalled();
        expect(f.pool.records()).toEqual(before);
      });

      it("never signs more than two transfers in one pass, whatever is missing", async () => {
        const f = setupPreparation();
        const sign = jest.spyOn(f.mainAccountSigner, "buildAndSignTransfer");
        await ahead(f, f.pool, { maxValueWei: 10n ** 18n });
        expect(sign).toHaveBeenCalledTimes(2);
        await ahead(f, f.pool, { maxValueWei: 10n ** 18n });
        expect(sign).toHaveBeenCalledTimes(2);
      });

      it("refuses a transfer whose fee could exceed the value it moves: signed, then discarded, never written or submitted", async () => {
        const f = setupPreparation();
        const put = jest.spyOn(f.store, "put");
        // 375 + 10 wei moved for up to 21,000 wei of fee.
        await expect(
          ahead(f, f.pool, { gasReserveWei: 10n, maxValueWei: MAX_VALUE })
        ).rejects.toMatchObject({
          name: "FundAheadRefusedError",
          code: "uneconomic",
        });

        expect(f.httpClient.submitRawTransaction).not.toHaveBeenCalled();
        expect(statuses(f.pool)).toEqual(["unfunded", "unfunded", "unfunded"]);
        expect(
          put.mock.calls.filter(([record]) => record.status === "funding")
        ).toEqual([]);
        // Pin: the same transfer inside a send is the sender's own decision and still goes out.
        await f.pool.prepareStampInventory({
          mainAccountSigner: f.mainAccountSigner,
          provider: f.provider,
          stampValueWei: STAMP,
          gasReserveWei: 10n,
          fundingOverrides,
          receipt: { intervalMs: 0, maxAttempts: 1 },
        });
        expect(f.httpClient.submitRawTransaction).toHaveBeenCalledTimes(2);
      });

      it("never funds or counts an account another operation holds", async () => {
        const f = setupPreparation();
        // Row 0: reserved by a native send (unfunded, so it would be the first funding target).
        // Row 1: leased by a pending message and holding the whole stamp value.
        const reserved = new Set([0]);
        f.pool.attachSpendReservation((index) => reserved.has(index));
        f.pool.setStatus(1, "in-use");
        f.balances.set(f.pool.getRecord(1)!.address.toLowerCase(), 10n ** 9n);
        const held = structuredClone([f.pool.getRecord(0), f.pool.getRecord(1)]);

        const result = await ahead(f, f.pool);

        expect(result.fundingTxHashes).toHaveLength(2);
        const targets = submitted(f).map((tx) => tx.to!.toLowerCase());
        expect(targets).toEqual([
          f.pool.getRecord(2)!.address.toLowerCase(),
          f.pool.getRecord(3)!.address.toLowerCase(),
        ]);
        expect([f.pool.getRecord(0), f.pool.getRecord(1)]).toEqual(held);

        // A funded row that becomes reserved stops counting: what is left no longer covers.
        const covered = () =>
          f.pool.hasStampInventory({
            provider: f.provider,
            stampValueWei: STAMP,
            feeReserveWei: RESERVE,
          });
        expect(await covered()).toBe(true);
        reserved.add(2);
        expect(await covered()).toBe(false);
      });

      it("looks once at an earlier transfer that has no receipt, offers the same bytes again, and funds nothing on top of it", async () => {
        const f = setupPreparation();
        const broadcasted = new Set<string>();
        receiptOnceBroadcast(f, broadcasted);
        // The node accepts the bytes and does not mine them.
        f.httpClient.submitRawTransaction.mockImplementation(async (rawTx) =>
          Transaction.from(rawTx).hash!
        );
        jest
          .spyOn(f.mainAccountSigner, "getTransactionCount")
          .mockResolvedValue(0n);
        const sleep = jest.fn(async () => undefined);
        const sign = jest.spyOn(f.mainAccountSigner, "buildAndSignTransfer");

        // The pass that records it: no receipt within its own wait.
        await expect(
          ahead(f, f.pool, { receipt: { maxAttempts: 2, sleep } })
        ).rejects.toThrow("still pending");
        const row = f.pool.getRecord(0)!;
        expect(row.status).toBe("funding");
        expect(sign).toHaveBeenCalledTimes(1);

        sleep.mockClear();
        f.httpClient.getTransactionReceipt.mockClear();
        await expect(
          ahead(f, f.pool, { receipt: { maxAttempts: 240, sleep } })
        ).rejects.toMatchObject({ code: "unresolved-funding" });

        // One look, no polling, the recorded bytes again, and no second signature.
        expect(f.httpClient.getTransactionReceipt).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
        expect(sign).toHaveBeenCalledTimes(1);
        expect(submitted(f).map((tx) => tx.serialized)).toEqual([
          row.fundingAttempt!.rawTx,
          row.fundingAttempt!.rawTx,
        ]);
        expect(f.pool.getRecord(0)).toEqual(row);
        expect(statuses(f.pool)).toEqual(["funding", "unfunded", "unfunded"]);

        // Once it is mined, the next pass takes it and funds only the other account.
        broadcasted.add(row.fundingAttempt!.txHash);
        f.balances.set(row.address.toLowerCase(), 375n + RESERVE);
        f.httpClient.submitRawTransaction.mockImplementation(async (rawTx) => {
          const transaction = Transaction.from(rawTx);
          broadcasted.add(transaction.hash!);
          f.balances.set(transaction.to!.toLowerCase(), transaction.value);
          return transaction.hash!;
        });
        const finished = await ahead(f, f.pool);
        expect(finished.fundingTxHashes).toEqual([
          row.fundingAttempt!.txHash,
          expect.any(String),
        ]);
        expect(sign).toHaveBeenCalledTimes(2);
        expect(statuses(f.pool)).toEqual(["available", "available", "unfunded"]);
      });

      // Review of a03ea904. There the pass settled for ONE account holding the whole stamp when
      // the main account could not pay for the pair, and the send's check then asked for two:
      // every send after it failed with "Insufficient main account balance", with the stamp
      // parked. The tests of this block fail on a03ea904 unless they say they are a pin.
      describe("only as a pair, and one covering account is ready (review of a03ea904)", () => {
        const S = 1_000_000n;
        const R = 100_000n;
        const FEE = 21_000n; // one funding transfer at the overrides above
        const ONE_ACCOUNT = S + R + FEE; // what a send's last resort costs
        const PAIR = S + 2n * R + 2n * FEE;
        /** A fixture whose chain debits the sender, so the main balance is what is left. */
        function wallet(mainBalance: bigint) {
          const f = setupPreparation();
          const main = f.mainAddress.toLowerCase();
          f.balances.set(main, mainBalance);
          f.httpClient.submitRawTransaction.mockImplementation(async (rawTx) => {
            const tx = Transaction.from(rawTx);
            const to = tx.to!.toLowerCase();
            f.balances.set(to, (f.balances.get(to) ?? 0n) + tx.value);
            f.balances.set(
              main,
              (f.balances.get(main) ?? 0n) -
                tx.value -
                tx.gasLimit * tx.maxFeePerGas!
            );
            return tx.hash!;
          });
          const passAhead = () =>
            ahead(f, f.pool, {
              stampValueWei: S,
              gasReserveWei: R,
              maxValueWei: S + 2n * R,
            });
          /** What a send does: prepare, then pay from whatever covers the stamp. */
          const send = async () => {
            const prepared = await f.pool.prepareStampInventory({
              mainAccountSigner: f.mainAccountSigner,
              provider: f.provider,
              stampValueWei: S,
              gasReserveWei: R,
              fundingOverrides,
              receipt: { intervalMs: 0, maxAttempts: 1 },
            });
            const payable = await f.pool.hasStampInventory({
              provider: f.provider,
              stampValueWei: S,
              feeReserveWei: R,
            });
            return { prepared, payable };
          };
          return { ...f, main, passAhead, send };
        }

        it("a main account that can pay for one account but not the pair: the pass funds nothing, and the send funds its one account exactly as without a pass", async () => {
          const w = wallet(PAIR - 1n);
          const sign = jest.spyOn(w.mainAccountSigner, "buildAndSignTransfer");

          await expect(w.passAhead()).rejects.toMatchObject({
            name: "FundAheadRefusedError",
            code: "insufficient-funds",
          });
          expect(sign).not.toHaveBeenCalled();
          expect(w.httpClient.submitRawTransaction).not.toHaveBeenCalled();
          expect(w.balances.get(w.main)).toBe(PAIR - 1n);
          expect(statuses(w.pool)).toEqual(["unfunded", "unfunded", "unfunded"]);

          const sent = await w.send();
          expect(sent.prepared.fundingTxHashes).toHaveLength(1);
          expect(sent.prepared.selectedAccountCount).toBe(1);
          expect(sent.payable).toBe(true);
          expect(submitted(w).map((tx) => tx.value)).toEqual([S + R]);
        });

        // The same trap without any pass, and on main before this stage too: a send funds one
        // whole-stamp account, fails later for another reason, and is retried.
        it("a send retried after it funded one whole-stamp account is ready: no top-up is asked of an empty main account", async () => {
          const w = wallet(ONE_ACCOUNT);
          const first = await w.send();
          expect(first.prepared.fundingTxHashes).toHaveLength(1);
          expect(w.balances.get(w.main)).toBe(0n);

          const retry = await w.send();

          expect(retry.prepared).toEqual({
            fundingTxHashes: [],
            selectedAccountCount: 1,
          });
          expect(retry.payable).toBe(true);
          expect(w.httpClient.submitRawTransaction).toHaveBeenCalledTimes(1);
          // And a pass sees the same thing: nothing to fund.
          expect((await w.passAhead()).fundingTxHashes).toEqual([]);
          expect(w.httpClient.submitRawTransaction).toHaveBeenCalledTimes(1);
        });

        it("over main balances from nothing to three stamps: no balance at which a send succeeds without a pass and fails after one", async () => {
          const balances: bigint[] = [];
          for (let b = 0n; b <= 3n * S; b += S / 100n) balances.push(b);
          for (const edge of [ONE_ACCOUNT, PAIR])
            balances.push(edge - 1n, edge, edge + 1n);
          const outcome = async (balance: bigint, withPass: boolean) => {
            const w = wallet(balance);
            let funded = 0;
            if (withPass)
              funded = await w.passAhead().then(
                (result) => result.fundingTxHashes.length,
                () => 0
              );
            const ok = await w.send().then(
              (sent) => sent.payable,
              () => false
            );
            return { ok, funded };
          };
          const tally = { both: 0, neither: 0, brokenByPass: [] as bigint[], pairs: 0 };
          for (const balance of balances) {
            const without = await outcome(balance, false);
            const withPass = await outcome(balance, true);
            if (without.ok && !withPass.ok) tally.brokenByPass.push(balance);
            if (without.ok && withPass.ok) tally.both++;
            if (!without.ok && !withPass.ok) tally.neither++;
            if (withPass.funded === 2) tally.pairs++;
            // The thresholds themselves: one account from ONE_ACCOUNT, the pair from PAIR.
            expect(without.ok).toBe(balance >= ONE_ACCOUNT);
            expect(withPass.funded).toBe(balance >= PAIR ? 2 : 0);
          }
          expect(tally.brokenByPass).toEqual([]);
          expect(tally.both + tally.neither).toBe(balances.length);
          // The sweep crossed both regimes and the window between them.
          expect(tally.neither).toBeGreaterThan(100);
          expect(tally.pairs).toBeGreaterThan(100);
          expect(tally.both - tally.pairs).toBeGreaterThan(5);
        }, 120_000);

        it("an unresolved transfer is found before any fee is quoted", async () => {
          const f = setupPreparation();
          const broadcasted = new Set<string>();
          receiptOnceBroadcast(f, broadcasted);
          f.httpClient.submitRawTransaction.mockImplementation(async (rawTx) =>
            Transaction.from(rawTx).hash!
          );
          jest
            .spyOn(f.mainAccountSigner, "getTransactionCount")
            .mockResolvedValue(0n);
          await expect(ahead(f, f.pool)).rejects.toThrow("still pending");
          const quote = jest.fn(async () => RESERVE);

          await expect(
            ahead(f, f.pool, { gasReserveWei: quote })
          ).rejects.toMatchObject({ code: "unresolved-funding" });

          expect(quote).not.toHaveBeenCalled();
          // Pin: with nothing unresolved the same function is asked once.
          const clean = setupPreparation();
          await ahead(clean, clean.pool, { gasReserveWei: quote });
          expect(quote).toHaveBeenCalledTimes(1);
        });

        it("waits FUND_AHEAD_RECEIPT_WAIT_MS for its own receipt, not a minute, and leaves the row funding", async () => {
          const f = setupPreparation();
          f.httpClient.submitRawTransaction.mockImplementation(async (rawTx) =>
            Transaction.from(rawTx).hash!
          );
          f.httpClient.getTransactionReceipt.mockResolvedValue(undefined);
          jest
            .spyOn(f.mainAccountSigner, "getTransactionCount")
            .mockResolvedValue(0n);
          jest.useFakeTimers({
            doNotFake: ["nextTick", "setImmediate", "queueMicrotask"],
          });
          try {
            let ended: string | undefined;
            void pool_fundAheadWithDefaultWait(f).then(
              () => (ended = "resolved"),
              (error) => (ended = String(error))
            );
            // The wait itself is under the bound; the reads after it need a few more turns.
            let waitedMs = 0;
            for (; ended === undefined && waitedMs < 60_000; waitedMs += 50)
              await jest.advanceTimersByTimeAsync(50);
            expect(ended).toContain("still pending");
            expect(waitedMs).toBeLessThanOrEqual(FUND_AHEAD_RECEIPT_WAIT_MS);
          } finally {
            jest.useRealTimers();
          }
          expect(
            FUND_AHEAD_RECEIPT_WAIT_MS / FUND_AHEAD_RECEIPT_POLL_MS
          ).toBe(12);
          // One look after the submit, then twelve polls: far from the 240 a send allows.
          expect(f.httpClient.getTransactionReceipt).toHaveBeenCalledTimes(13);
          expect(f.httpClient.submitRawTransaction).toHaveBeenCalledTimes(1);
          expect(statuses(f.pool)).toEqual(["funding", "unfunded", "unfunded"]);
        });
        function pool_fundAheadWithDefaultWait(f: Fixture) {
          return f.pool.fundStampInventoryAhead({
            mainAccountSigner: f.mainAccountSigner,
            provider: f.provider,
            stampValueWei: STAMP,
            gasReserveWei: RESERVE,
            maxValueWei: MAX_VALUE,
            fundingOverrides,
          });
        }
      });

      describe("stopped part way, with a real store closed and reopened", () => {
        /** A real Level store. `control.dead` makes every later disk write fail, as if the
         * process had stopped; `events` lists what reached disk and what was submitted. */
        async function openStore(dir: string) {
          const store = new LevelSubAccountPoolStore(dir);
          await store.Open();
          type Batch = (
            operations: ReadonlyArray<{ value?: string }>,
            options: unknown
          ) => Promise<unknown>;
          const db = (store as unknown as { openedDb: { batch: Batch } })
            .openedDb;
          const writeToDisk = db.batch.bind(db);
          const control = { dead: false };
          const events: string[] = [];
          db.batch = async (operations, options) => {
            if (control.dead) throw new Error("simulated stop");
            const result = await writeToDisk(operations, options);
            for (const { value } of operations) {
              if (value?.includes('"status":"funding"')) {
                events.push(
                  `durable:${JSON.parse(value).fundingAttempt.rawTx}`
                );
              }
            }
            return result;
          };
          return { control, events, store };
        }
        async function withDir(run: (dir: string) => Promise<void>) {
          const os = await import("os");
          const path = await import("path");
          const fs = await import("fs");
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fund-ahead-"));
          try {
            await run(dir);
          } finally {
            fs.rmSync(dir, { recursive: true, force: true });
          }
        }
        /** The pool of a new process over the same directory. */
        async function reopen(dir: string) {
          const store = new LevelSubAccountPoolStore(dir);
          await store.Open();
          return {
            store,
            pool: new MonadSubAccountPool({
              keyring: MonadHdKeyring.fromMnemonic(TEST_MNEMONIC),
              store,
            }),
          };
        }
        /** Opens the fixture on a real store with a chain that mines what it is given. */
        async function start(dir: string) {
          const opened = await openStore(dir);
          const f = setupPreparation(opened.store);
          await f.pool.flush();
          const broadcasted = new Set<string>();
          receiptOnceBroadcast(f, broadcasted);
          const mine = async (rawTx: string) => {
            const transaction = Transaction.from(rawTx);
            opened.events.push(`submit:${rawTx}`);
            broadcasted.add(transaction.hash!);
            f.balances.set(transaction.to!.toLowerCase(), transaction.value);
            return transaction.hash!;
          };
          f.httpClient.submitRawTransaction.mockImplementation(mine);
          return { ...opened, f, broadcasted, mine };
        }
        const transfersTo = (f: Fixture, address: string) =>
          submitted(f)
            .filter((tx) => tx.to!.toLowerCase() === address.toLowerCase())
            .map((tx) => tx.serialized);
        const expectOnePairNothingTwice = (f: Fixture, pool: MonadSubAccountPool) => {
          const funded = pool
            .records()
            .filter((record) => record.status === "available");
          expect(funded).toHaveLength(2);
          for (const record of funded)
            expect(new Set(transfersTo(f, record.address)).size).toBe(1);
          expect(new Set(submitted(f).map((tx) => tx.hash)).size).toBe(2);
        };

        it("the row is durable as funding, with the exact bytes, before the first submit", async () => {
          await withDir(async (dir) => {
            const s = await start(dir);
            await ahead(s.f, s.f.pool);
            const [first, second] = submitted(s.f).map((tx) => tx.serialized);
            expect(s.events).toEqual([
              `durable:${first}`,
              `submit:${first}`,
              `durable:${second}`,
              `submit:${second}`,
            ]);
            await s.store.Close();
          });
        });

        it("stopped after the transfer is recorded and before it is submitted: the next pass submits those bytes and signs nothing else for that account", async () => {
          await withDir(async (dir) => {
            const s = await start(dir);
            s.f.httpClient.submitRawTransaction.mockImplementation(async () => {
              s.control.dead = true;
              throw new Error("simulated stop before the submit left");
            });
            await expect(ahead(s.f, s.f.pool)).rejects.toThrow("simulated stop");
            const recorded = s.events[0]!.replace("durable:", "");
            expect(s.events).toEqual([`durable:${recorded}`]);
            await s.store.Close();

            const next = await reopen(dir);
            const row = next.pool.getRecord(0)!;
            expect(row.status).toBe("funding");
            expect(row.fundingAttempt!.rawTx).toBe(recorded);
            s.f.httpClient.submitRawTransaction.mockClear();
            s.f.httpClient.submitRawTransaction.mockImplementation(s.mine);
            const sign = jest.spyOn(
              s.f.mainAccountSigner,
              "buildAndSignTransfer"
            );

            const result = await ahead(s.f, next.pool);

            expect(result.fundingTxHashes[0]).toBe(row.fundingAttempt!.txHash);
            expect(transfersTo(s.f, row.address)).toEqual([recorded]);
            expect(sign.mock.calls.map(([to]) => to)).toEqual([
              next.pool.getRecord(1)!.address,
            ]);
            expectOnePairNothingTwice(s.f, next.pool);
            await next.store.Close();
          });
        });

        it("stopped after the submit and before the receipt: the next pass reads the receipt and submits nothing for that account", async () => {
          await withDir(async (dir) => {
            const s = await start(dir);
            s.f.httpClient.submitRawTransaction.mockImplementation(
              async (rawTx) => {
                const hash = await s.mine(rawTx);
                s.control.dead = true;
                return hash;
              }
            );
            // The receipt read is the first thing after the submit: the process is gone by then.
            s.f.httpClient.getTransactionReceipt.mockRejectedValue(
              new Error("simulated stop before the receipt")
            );
            await expect(ahead(s.f, s.f.pool)).rejects.toThrow("simulated stop");
            const recorded = s.events[0]!.replace("durable:", "");
            expect(s.events).toEqual([
              `durable:${recorded}`,
              `submit:${recorded}`,
            ]);
            await s.store.Close();

            const next = await reopen(dir);
            const row = next.pool.getRecord(0)!;
            expect(row.status).toBe("funding");
            receiptOnceBroadcast(s.f, s.broadcasted);
            s.f.httpClient.submitRawTransaction.mockImplementation(s.mine);

            const result = await ahead(s.f, next.pool);

            expect(result.fundingTxHashes[0]).toBe(row.fundingAttempt!.txHash);
            // Still the one submit made before the stop.
            expect(transfersTo(s.f, row.address)).toEqual([recorded]);
            expectOnePairNothingTwice(s.f, next.pool);
            await next.store.Close();
          });
        });

        it("stopped after the receipt and before the row is marked available: the row is still funding on disk and the next pass marks it, with no transfer", async () => {
          await withDir(async (dir) => {
            const s = await start(dir);
            // The receipt is read (and is a success); the write that follows never lands.
            s.f.httpClient.getTransactionReceipt.mockImplementation(
              async (txHash) => {
                s.control.dead = true;
                return {
                  txHash,
                  blockNumber: 1,
                  blockHash: "0x" + "00".repeat(32),
                  status: "success" as const,
                  gasUsed: 21_000n,
                  effectiveGasPrice: 1n,
                  logs: [],
                };
              }
            );
            await expect(ahead(s.f, s.f.pool)).rejects.toThrow("simulated stop");
            const recorded = s.events[0]!.replace("durable:", "");
            // In memory the dead process believed the account available; disk does not.
            expect(s.f.pool.getRecord(0)!.status).toBe("available");
            await s.store.Close();

            const next = await reopen(dir);
            const row = next.pool.getRecord(0)!;
            expect(row).toEqual({
              index: 0,
              address: row.address,
              status: "funding",
              fundingAttempt: {
                rawTx: recorded,
                txHash: Transaction.from(recorded).hash,
              },
            });
            receiptOnceBroadcast(s.f, s.broadcasted);

            const result = await ahead(s.f, next.pool);

            expect(result.fundingTxHashes[0]).toBe(row.fundingAttempt!.txHash);
            expect(transfersTo(s.f, row.address)).toEqual([recorded]);
            expectOnePairNothingTwice(s.f, next.pool);
            await next.store.Close();
          });
        });

        it("stopped while a second pass is waiting behind the first: the next pass finishes the first one's transfer and nothing is funded twice", async () => {
          await withDir(async (dir) => {
            const s = await start(dir);
            let entered!: () => void;
            const inSubmit = new Promise<void>((resolve) => (entered = resolve));
            let stop!: () => void;
            const stopped = new Promise<void>((resolve) => (stop = resolve));
            s.f.httpClient.submitRawTransaction.mockImplementation(async () => {
              entered();
              await stopped;
              s.control.dead = true;
              throw new Error("simulated stop during the submit");
            });
            const first = ahead(s.f, s.f.pool).then(
              () => "resolved",
              (error) => String(error)
            );
            const second = ahead(s.f, s.f.pool).then(
              () => "resolved",
              (error) => String(error)
            );
            await inSubmit;
            // The second pass is queued behind the first and has done nothing.
            expect(s.events).toHaveLength(1);
            stop();
            expect(await first).toContain("simulated stop");
            // It then runs against a dead store: it cannot make the row durable again, so it
            // offers nothing to the network, and funds nothing on top of the unresolved row.
            expect(await second).toContain("unresolved-funding");
            expect(s.f.httpClient.submitRawTransaction).toHaveBeenCalledTimes(1);
            const recorded = s.events[0]!.replace("durable:", "");
            expect(s.events).toEqual([`durable:${recorded}`]);
            await s.store.Close();

            const next = await reopen(dir);
            const row = next.pool.getRecord(0)!;
            expect(row.fundingAttempt!.rawTx).toBe(recorded);
            s.f.httpClient.submitRawTransaction.mockClear();
            s.f.httpClient.submitRawTransaction.mockImplementation(s.mine);

            await Promise.all([ahead(s.f, next.pool), ahead(s.f, next.pool)]);

            expect(transfersTo(s.f, row.address)).toEqual([recorded]);
            expectOnePairNothingTwice(s.f, next.pool);
            await next.store.Close();
          });
        });
      });
    });

    describe("hasStampInventory: what a send may skip funding for (#1235 Q4)", () => {
      const STAMP = 1_000n;
      function inventory(balances: bigint[]) {
        const f = setupPreparation();
        balances.forEach((balance, index) => {
          f.pool.setStatus(index, "available");
          f.balances.set(f.pool.getRecord(index)!.address.toLowerCase(), balance);
        });
        const ready = (
          feeReserveWei: bigint,
          extra: { heldIndices?: ReadonlySet<number>; maxCacheAgeMs?: number } = {}
        ) =>
          f.pool.hasStampInventory({
            provider: f.provider,
            stampValueWei: STAMP,
            feeReserveWei,
            ...extra,
          });
        return { ...f, ready };
      }

      it("is true for the funded pair and answers for the reserve it is asked about", async () => {
        const f = inventory([375n + 100n, 625n + 100n]);
        expect(await f.ready(100n)).toBe(true);
        // The same accounts at a higher fee no longer cover the stamp. On main the send's check
        // used one fixed reserve and passed them on to a payment that then could not be built.
        expect(await f.ready(101n)).toBe(false);
      });

      it("is false for two accounts that cannot cover the value between them (main counted them as ready)", async () => {
        const f = inventory([375n, 375n]);
        expect(await f.ready(0n)).toBe(false);
      });

      // Review of a03ea904, which asked for two accounts here: a wallet that held one account
      // with the whole stamp was sent to fund a top-up. Fails there (false).
      it("is true for ONE account that covers the value and its own fee, which is what the payment intent accepts", async () => {
        const f = inventory([1_000n + 100n]);
        expect(await f.ready(100n)).toBe(true);
        expect(await f.ready(101n)).toBe(false);
      });

      it("does not count an account a message holds", async () => {
        const f = inventory([375n, 625n, 0n]);
        expect(await f.ready(0n)).toBe(true);
        expect(await f.ready(0n, { heldIndices: new Set([1]) })).toBe(false);
      });

      it("reads each balance once: a later ask with no age limit makes no request", async () => {
        const f = inventory([375n, 625n]);
        const read = jest.spyOn(f.provider, "getBalance");
        expect(await f.ready(0n, { maxCacheAgeMs: Infinity })).toBe(true);
        expect(read).toHaveBeenCalledTimes(2);
        const later = jest
          .spyOn(Date, "now")
          .mockReturnValue(Date.now() + 10 * CAPACITY_CACHE_TTL_MS);
        try {
          expect(await f.ready(0n, { maxCacheAgeMs: Infinity })).toBe(true);
          expect(read).toHaveBeenCalledTimes(2);
          // Positive control: with the ordinary age limit the same ask reads again.
          expect(await f.ready(0n)).toBe(true);
          expect(read).toHaveBeenCalledTimes(4);
        } finally {
          later.mockRestore();
        }
      });
    });

    // Pin, and the reason funding ahead covers ONE message: the send's selection is greedy over
    // every funded account, so pairs funded for several messages are not spent pair by pair.
    it("pin: two funded pairs do not serve two messages (the first takes three accounts and strands part of one)", () => {
      const pair = (base: number) => [
        { index: base, address: `a${base}`, capacityWei: 375n },
        { index: base + 1, address: `a${base + 1}`, capacityWei: 625n },
      ];
      const first = selectStampAccounts({
        amountWei: 1_000n,
        accounts: [...pair(0), ...pair(2)],
      });
      expect(first.map((account) => account.index).sort()).toEqual([0, 1, 2]);
      expect(
        first.reduce(
          (stranded, account) =>
            stranded + account.capacityWei - account.paymentValueWei,
          0n
        )
      ).toBe(375n);
      expect(() =>
        selectStampAccounts({
          amountWei: 1_000n,
          accounts: [{ index: 3, address: "a3", capacityWei: 625n }],
        })
      ).toThrow("Insufficient stamp-account capacity");
      // One pair, one message, nothing stranded.
      const one = selectStampAccounts({ amountWei: 1_000n, accounts: pair(0) });
      expect(one.map((account) => account.paymentValueWei)).toEqual([375n, 625n]);
    });
  });

  describe("claim: the one place an account becomes held by an operation", () => {
    function funded(count: number, balanceWei = 1_100n) {
      const pool = new MonadSubAccountPool({
        keyring: MonadHdKeyring.fromMnemonic(TEST_MNEMONIC),
        store: new InMemorySubAccountPoolStore(),
      });
      for (const row of pool.ensureSize(count))
        pool.capacityCache.set(row.index, {
          capacityWei: balanceWei,
          checkedAtMs: Date.now(),
          balanceWei,
        });
      return pool;
    }

    it("twenty payments claiming in the same tick, from three wallets sharing the pool, take twenty different accounts; the next gets none", () => {
      const pool = funded(20);
      const taken = Array.from({ length: 20 }, (_, n) =>
        pool.claimStampAccounts(`wallet-${n % 3}:frank-dm:${n}`, 1_000n, 100n)
      );
      const indexes = taken.flatMap((selection) =>
        selection!.map((account) => account.index)
      );
      expect(indexes).toHaveLength(20);
      expect(new Set(indexes).size).toBe(20);
      for (const [n, selection] of taken.entries())
        expect(pool.claimedBy(selection![0].index)).toBe(
          `wallet-${n % 3}:frank-dm:${n}`
        );
      expect(
        pool.claimStampAccounts("wallet-0:frank-dm:20", 1_000n, 100n)
      ).toBeUndefined();
      // Nothing is claimed by a payment the free accounts could not cover.
      expect(pool.claimsOf("wallet-0:frank-dm:20")).toEqual([]);
    });

    it("a released claim is free at once; a restored claim holds and refuses a second holder", () => {
      const pool = funded(1);
      const [first] = pool.claimStampAccounts("a:1", 1_000n, 100n)!;
      expect(pool.claimStampAccounts("a:2", 1_000n, 100n)).toBeUndefined();
      pool.releaseClaim("a:1");
      expect(pool.claimedBy(first.index)).toBeUndefined();
      pool.restoreClaim("a:3", [first.index]);
      expect(pool.claimStampAccounts("a:2", 1_000n, 100n)).toBeUndefined();
      expect(() => pool.restoreClaim("a:4", [first.index])).toThrow(
        /claimed by a:3 and by a:4/
      );
      // Its own holder may take it again (a retry of the same operation).
      expect(pool.claimStampAccounts("a:3", 1_000n, 100n)).toHaveLength(1);
    });

    it("never offers an account a native send's journal reserves, and never takes one it was not offered", () => {
      const pool = funded(2);
      pool.attachSpendReservation((index) => index === 0);
      expect(pool.isSpendReserved(0, "a:1")).toBe(true);
      const [only] = pool.claimStampAccounts("a:1", 1_000n, 100n)!;
      expect(only.index).toBe(1);
      expect(() => pool.claim("a:2", () => [1])).toThrow(
        /only take accounts it was offered/
      );
      expect(pool.claimedBy(1)).toBe("a:1");
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
      return {
        balances,
        httpClient,
        pool,
        prepare,
        provider,
        store,
        mainAccountSigner,
      };
    }

    it("is claimed for its operation from before its funding: a message built meanwhile is never given it, and only its own operation leases it", async () => {
      const { pool, provider, mainAccountSigner } = setupBurn();
      const holder = "wallet-a:topic:1";
      const burn = await pool.prepareBurnAccount({
        mainAccountSigner,
        provider,
        burnValueWei: 1_000n,
        gasReserveWei: 10n,
        fundingOverrides: FUNDING,
        receipt: { maxAttempts: 0 },
        claimFor: holder,
      });
      expect(pool.getRecord(burn.index)?.status).toBe("available");
      expect(pool.claimedBy(burn.index)).toBe(holder);

      // A message that this account could pay for does not get it.
      await pool.fundedCapacities(provider, 10n, { fromBalance: true });
      expect(
        pool.claimStampAccounts("wallet-a:frank-dm:1", 500n, 10n)
      ).toBeUndefined();
      // A second burn of the same size funds its own account instead of reusing this one.
      const other = await pool.prepareBurnAccount({
        mainAccountSigner,
        provider,
        burnValueWei: 1_000n,
        gasReserveWei: 10n,
        fundingOverrides: FUNDING,
        receipt: { maxAttempts: 0 },
        claimFor: "wallet-b:topic:2",
      });
      expect(other.index).not.toBe(burn.index);

      const leases = new SubAccountLeaseManager(pool);
      expect(() => leases.acquireForIndex(burn.index)).toThrow(
        /held by another operation/
      );
      expect(() =>
        leases.acquireForIndex(burn.index, "wallet-b:topic:2")
      ).toThrow(/held by another operation/);
      const lease = leases.acquireForIndex(burn.index, holder);
      // The lease's own row status holds the account from here; the claim has done its work.
      expect(pool.getRecord(lease.index)?.status).toBe("in-use");
      expect(pool.claimedBy(lease.index)).toBeUndefined();
    });

    it("a burn preparation that fails leaves nothing claimed", async () => {
      const { balances, pool, provider, mainAccountSigner } = setupBurn();
      balances.set(mainAccountSigner.address.toLowerCase(), 0n);
      await expect(
        pool.prepareBurnAccount({
          mainAccountSigner,
          provider,
          burnValueWei: 1_000n,
          gasReserveWei: 10n,
          fundingOverrides: FUNDING,
          receipt: { maxAttempts: 0 },
          claimFor: "wallet-a:topic:1",
        })
      ).rejects.toThrow(/Insufficient main account balance/);
      expect(pool.claimsOf("wallet-a:topic:1")).toEqual([]);
    });

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
    const FEE_WEI = 21_000n;
    const recipient = "0x" + "12".repeat(20);

    function setupSpendTest(store: SubAccountPoolStore = new InMemorySubAccountPoolStore()) {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);
      const pool = new MonadSubAccountPool({ keyring, store });
      pool.ensureSize(3);
      const putMany = jest.spyOn(store, "putMany");
      const put = jest.spyOn(store, "put");
      const writes = () => put.mock.calls.length + putMany.mock.calls.length;
      return { keyring, pool, store, writes };
    }

    async function signSpend(
      keyring: MonadHdKeyring,
      index: number,
      fields: { value?: bigint; nonce?: number } = {}
    ) {
      const rawTx = await new Wallet(
        keyring.deriveSubAccount(index).privateKey
      ).signTransaction({
        type: 2,
        chainId: CHAIN_ID,
        nonce: fields.nonce ?? 0,
        to: recipient,
        value: fields.value ?? 5_000n,
        gasLimit: 21_000n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
      });
      const transaction = Transaction.from(rawTx);
      return { rawTx, txHash: transaction.hash as string, transaction };
    }

    /** The item `EvmLegacyConsolidator.applySync` emits: no raw bytes, value plus actual fee. */
    function consolidatorItem(
      address: string,
      spend: { txHash: string; transaction: Transaction }
    ) {
      return {
        type: "wallet-sync" as const,
        direction: "out" as const,
        chainIdentifier: "monad-testnet",
        txHash: spend.txHash,
        spentInputs: [
          {
            address: address.toLowerCase(),
            nonce: spend.transaction.nonce,
            valueWei: (spend.transaction.value + FEE_WEI).toString(),
          },
        ],
        createdOutputs: [
          {
            address: spend.transaction.to as string,
            valueWei: spend.transaction.value.toString(),
          },
        ],
        timestamp: 1,
      };
    }

    function walletStateOf(
      pool: MonadSubAccountPool,
      keyring: MonadHdKeyring
    ): Parameters<typeof validateMonadWalletState>[0] {
      const changeKeyring = MonadChangeKeyring.fromMnemonic(TEST_MNEMONIC);
      return {
        pool,
        changePool: new MonadChangePool({ keyring: changeKeyring }),
        subKeyring: keyring,
        changeKeyring,
      };
    }

    /** A trivial applier for these tests: resolves the row the transaction's signer owns, commits
     * through the one writer and flushes in the same turn as the put. Composition's real applier
     * (the next stage) also checks the chain and runs under the admission. */
    function attachCommitApplier(pool: MonadSubAccountPool) {
      const applier = jest.fn(async (rawTx: string, _chainIdentifier: string) => {
        const signer = Transaction.from(rawTx).from;
        const row = pool
          .records()
          .find((record) => record.address === signer);
        if (row === undefined) return { kind: "no-pool-row" as const };
        const outcome = pool.commitSpend(row.index, rawTx);
        const flushed = pool.flush(); // no await between the put and the flush call
        await flushed;
        return outcome === "no-row"
          ? { kind: "no-pool-row" as const }
          : { kind: outcome, poolIndex: row.index };
      });
      pool.attachSpendApplier(applier);
      return applier;
    }

    type SyncItem = Parameters<MonadSubAccountPool["processSyncTransaction"]>[0];

    /** The rejection of `pool.processSyncTransaction(item)`, or "not refused". */
    async function refusalOf(pool: MonadSubAccountPool, item: unknown) {
      let outcome: unknown;
      try {
        outcome = pool.processSyncTransaction(item as SyncItem);
      } catch (error) {
        // A synchronous throw is never the adapter's contract: every refusal is a rejection.
        return { synchronous: error };
      }
      return Promise.resolve(outcome).then(
        () => "not refused" as const,
        (error: unknown) => error
      );
    }

    // Before #1313 this test expected `affectedIndices` [0], status `spent` and a checkpoint with
    // only the item's hash: a spend record without its signed transaction. #1313 made the item a
    // silent no-op, and the test then asserted `res.affectedIndices` equal to [] read synchronously
    // from a plain return value. That assertion encoded "a refused item is not an error to the
    // caller": the consolidator's item was reported exactly like an applied one. Fails on the base
    // because nothing is rejected.
    it("rejects the consolidator's item without raw bytes, naming the missing transaction, after dropping the capacity entry", async () => {
      const { keyring, pool, writes } = setupSpendTest();
      const applier = attachCommitApplier(pool);
      const addr0 = keyring.deriveSubAccount(0).address;
      const before = pool.records();
      pool.capacityCache.set(0, { capacityWei: 9n, checkedAtMs: Date.now() });
      pool.capacityCache.set(1, { capacityWei: 9n, checkedAtMs: Date.now() });
      const written = writes();

      const refusal = await refusalOf(
        pool,
        consolidatorItem(addr0, await signSpend(keyring, 0))
      );

      expect(refusal).toBeInstanceOf(SubAccountSpendRefusedError);
      expect(refusal).toMatchObject({ code: "missing-transaction", index: 0 });
      expect((refusal as Error).message).toMatch(/no signed transaction \(rawTx\)/);
      expect(applier).not.toHaveBeenCalled();
      expect(writes()).toBe(written);
      expect(pool.records()).toEqual(before);
      expect(pool.getRecord(0)?.status).toBe("available");
      expect(pool.getRecord(0)?.lifecycle?.spend).toBeUndefined();
      expect(pool.capacityCache.has(0)).toBe(false);

      // Record 1 should remain untouched
      expect(pool.getRecord(1)?.status).toBe("available");
      expect(pool.getRecord(1)?.lifecycle?.spend).toBeUndefined();
      expect(pool.capacityCache.has(1)).toBe(true);
      expect(() =>
        validateMonadWalletState(walletStateOf(pool, keyring))
      ).not.toThrow();
    });

    // THE KEY RULE of #1235 Stage 0b. On the base this fails: the complete item commits row 0 as
    // `spent` with one putMany, on a pool nothing has composed, with no chain check at all.
    it("refuses a complete item on a pool with no applier: nothing written, typed rejection, capacity entry dropped", async () => {
      const os = await import("os");
      const path = await import("path");
      const fs = await import("fs");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frank-1235-no-applier-"));
      const levelStore = new LevelSubAccountPoolStore(dir);
      await levelStore.Open();
      try {
        const { keyring, pool, writes } = setupSpendTest(levelStore);
        await pool.flush();
        const putMany = jest.spyOn(levelStore, "putMany");
        const addr0 = keyring.deriveSubAccount(0).address;
        const spend = await signSpend(keyring, 0);
        pool.capacityCache.set(0, { capacityWei: 9n, checkedAtMs: Date.now() });
        const before = pool.records();
        putMany.mockClear();
        const written = writes();

        const refusal = await refusalOf(pool, {
          ...consolidatorItem(addr0, spend),
          rawTx: spend.rawTx,
        });

        expect(refusal).toBeInstanceOf(SubAccountSpendRefusedError);
        expect(refusal).toMatchObject({ code: "no-applier", index: 0 });
        await pool.flush();
        expect(putMany).not.toHaveBeenCalled();
        expect(writes()).toBe(written);
        expect(pool.records()).toEqual(before);
        expect(pool.getRecord(0)).toEqual({
          index: 0,
          address: addr0,
          status: "available",
        });
        expect(pool.capacityCache.has(0)).toBe(false);
      } finally {
        await levelStore.Close().catch(() => undefined);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    // The same refusal is what the caller awaiting the dispatcher sees, and a chain-mismatched
    // item never reaches the pool. On the base the first commits and resolves; the second is
    // dispatched to the pool, which commits it.
    it("at the dispatcher: the pool's refusal reaches the awaiting caller, and a chain mismatch does not mutate the pool", async () => {
      const { keyring, pool, writes } = setupSpendTest();
      const addr0 = keyring.deriveSubAccount(0).address;
      const spend = await signSpend(keyring, 0);
      const wallet = { chainIdentifier: "monad-testnet", pool };
      const complete = { ...consolidatorItem(addr0, spend), rawTx: spend.rawTx };
      const before = pool.records();
      const written = writes();

      const dispatched = async (item: unknown) => {
        try {
          await applyWalletSyncItem(wallet, item as never);
        } catch (error) {
          return error;
        }
        return "not refused";
      };
      const refused = await dispatched(complete);
      expect(refused).toBeInstanceOf(SubAccountSpendRefusedError);
      expect(refused).toMatchObject({ code: "no-applier" });

      // With an applier that would commit, another chain's item is stopped before the pool.
      const applier = attachCommitApplier(pool);
      for (const chainIdentifier of ["ethereum-sepolia", "evm", undefined]) {
        const mismatch = await dispatched({ ...complete, chainIdentifier });
        expect(mismatch).toBeInstanceOf(WalletSyncItemRejectedError);
      }
      expect(applier).not.toHaveBeenCalled();
      expect(writes()).toBe(written);
      expect(pool.records()).toEqual(before);
    });

    // With an applier the adapter routes to it and reports what it committed. Before #1235 Stage
    // 0b this test called the adapter synchronously on a pool with no applier and expected the
    // commit; that route is the defect (see the test above). The row, the single put and the
    // reopen expectations are unchanged. The explicit `pool.flush()` before close is gone on
    // purpose: the awaited adapter must already have made the row durable.
    it("with an applier attached, records the complete signed transaction and spent in one put, from the transaction's own fields, durably", async () => {
      const os = await import("os");
      const path = await import("path");
      const fs = await import("fs");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frank-1235-spend-"));
      const levelStore = new LevelSubAccountPoolStore(dir);
      await levelStore.Open();
      let reopened: LevelSubAccountPoolStore | undefined;
      try {
        const { keyring, pool, writes } = setupSpendTest(levelStore);
        await pool.flush();
        const applier = attachCommitApplier(pool);
        const putMany = jest.spyOn(levelStore, "putMany");
        const addr0 = keyring.deriveSubAccount(0).address;
        const spend = await signSpend(keyring, 0);
        pool.capacityCache.set(0, { capacityWei: 9n, checkedAtMs: Date.now() });
        putMany.mockClear();
        const written = writes();

        const item = { ...consolidatorItem(addr0, spend), rawTx: spend.rawTx };
        expect(item.spentInputs[0].valueWei).toBe("26000");
        const res = await pool.processSyncTransaction(item);

        const expectedRow = {
          index: 0,
          address: addr0,
          status: "spent",
          lifecycle: {
            spend: { rawTx: spend.rawTx, txHash: spend.txHash, valueWei: "5000" },
          },
        };
        expect(res.affectedIndices).toEqual([0]);
        expect(applier).toHaveBeenCalledTimes(1);
        expect(applier).toHaveBeenCalledWith(spend.rawTx, "monad-testnet");
        expect(putMany).toHaveBeenCalledTimes(1);
        expect(putMany).toHaveBeenCalledWith([expectedRow]);
        expect(writes() - written).toBe(2); // the one `put` and its `putMany`
        expect(pool.getRecord(0)).toEqual(expectedRow);
        expect(pool.capacityCache.has(0)).toBe(false);
        expect(() =>
          validateMonadWalletState(walletStateOf(pool, keyring))
        ).not.toThrow();

        // Repeating the same item is a no-op.
        putMany.mockClear();
        expect(
          (await pool.processSyncTransaction(item)).affectedIndices
        ).toEqual([]);
        expect(putMany).not.toHaveBeenCalled();

        await levelStore.Close();
        reopened = new LevelSubAccountPoolStore(dir);
        await reopened.Open();
        const poolB = new MonadSubAccountPool({ keyring, store: reopened });
        expect(poolB.getRecord(0)).toEqual(expectedRow);
        expect(poolB.getRecord(1)).toEqual({
          index: 1,
          address: keyring.deriveSubAccount(1).address,
          status: "available",
        });
        expect(() =>
          validateMonadWalletState(walletStateOf(poolB, keyring))
        ).not.toThrow();
      } finally {
        await (reopened ?? levelStore).Close().catch(() => undefined);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("hands the applier's own rejection to the caller, and takes one applier only", async () => {
      const { keyring, pool, writes } = setupSpendTest();
      const addr0 = keyring.deriveSubAccount(0).address;
      const spend = await signSpend(keyring, 0);
      const failure = new Error("admission refused");
      const applier = jest.fn().mockRejectedValue(failure);
      pool.attachSpendApplier(applier);
      expect(() => pool.attachSpendApplier(applier)).toThrow(
        "Sub-account pool already has a spend applier"
      );
      const written = writes();

      expect(
        await refusalOf(pool, {
          ...consolidatorItem(addr0, spend),
          rawTx: spend.rawTx,
        })
      ).toBe(failure);
      expect(applier).toHaveBeenCalledWith(spend.rawTx, "monad-testnet");
      expect(writes()).toBe(written);

      // What the applier reports decides the affected index; only a commit is one.
      applier.mockResolvedValueOnce({ kind: "already-applied", poolIndex: 0 });
      applier.mockResolvedValueOnce({ kind: "no-pool-row" });
      for (let i = 0; i < 2; i++) {
        expect(
          await pool.processSyncTransaction({
            ...consolidatorItem(addr0, spend),
            rawTx: spend.rawTx,
          })
        ).toEqual({ affectedIndices: [] });
      }
    });

    it("marks an unfunded row and keeps a hand-built funding checkpoint beside the spend", async () => {
      const store = new InMemorySubAccountPoolStore();
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);
      const pool = new MonadSubAccountPool({ keyring, store });
      attachCommitApplier(pool);
      pool.ensureUnfundedSize(1);
      pool.ensureSize(2);
      // Hand-built: no production path writes `lifecycle.funding`.
      const fundingRaw = await new Wallet(
        keyring.deriveSubAccount(2).privateKey
      ).signTransaction({
        type: 2,
        chainId: CHAIN_ID,
        nonce: 0,
        to: keyring.deriveSubAccount(1).address,
        value: 7n,
        gasLimit: 21_000n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
      });
      const fundingCheckpoint = {
        rawTx: fundingRaw,
        txHash: Transaction.from(fundingRaw).hash as string,
        valueWei: "7",
      };
      pool.recordFundingTransaction(1, fundingCheckpoint);

      for (const index of [0, 1]) {
        const spend = await signSpend(keyring, index);
        const address = keyring.deriveSubAccount(index).address;
        expect(
          (
            await pool.processSyncTransaction({
              ...consolidatorItem(address, spend),
              rawTx: spend.rawTx,
            })
          ).affectedIndices
        ).toEqual([index]);
        expect(pool.getRecord(index)).toEqual({
          index,
          address,
          status: "spent",
          lifecycle: {
            ...(index === 1 ? { funding: fundingCheckpoint } : {}),
            spend: { rawTx: spend.rawTx, txHash: spend.txHash, valueWei: "5000" },
          },
        });
      }
      expect(() =>
        validateMonadWalletState(walletStateOf(pool, keyring))
      ).not.toThrow();
    });

    // Check 1. An incoming item and a `payment-transfer` never spend a pool account: they resolve
    // having changed nothing, with or without an applier, whatever bytes they carry. The incoming
    // case pins the rule (the base returns the same, synchronously). The `payment-transfer` case
    // fails on the base: the base ignores the item's kind and commits the row.
    it.each([
      ["an incoming wallet-sync item", { direction: "in" }],
      ["an outgoing payment-transfer item", { type: "payment-transfer" }],
      ["an incoming payment-transfer item", { type: "payment-transfer", direction: "in" }],
    ])("is a no-op for %s, with and without an applier", async (_label, kind) => {
      const { keyring, pool, writes } = setupSpendTest();
      const addr0 = keyring.deriveSubAccount(0).address;
      const spend = await signSpend(keyring, 0);
      const before = pool.records();
      pool.capacityCache.set(0, { capacityWei: 9n, checkedAtMs: Date.now() });
      const written = writes();
      const complete = { ...consolidatorItem(addr0, spend), rawTx: spend.rawTx, ...kind };
      const withoutBytes = { ...consolidatorItem(addr0, spend), ...kind };

      for (const item of [complete, withoutBytes]) {
        expect(await pool.processSyncTransaction(item as SyncItem)).toEqual({
          affectedIndices: [],
        });
      }
      const applier = attachCommitApplier(pool);
      for (const item of [complete, withoutBytes]) {
        expect(await pool.processSyncTransaction(item as SyncItem)).toEqual({
          affectedIndices: [],
        });
      }

      expect(applier).not.toHaveBeenCalled();
      expect(writes()).toBe(written);
      expect(pool.records()).toEqual(before);
      expect(pool.capacityCache.has(0)).toBe(true);
    });

    // An item with no transaction that names no row of this pool is the consolidator's item for a
    // send from the main account: not the pool's to refuse. Pins the boundary of the rejection
    // above; the base resolves the same way. A composed test relies on it
    // (`snapshots sendLegacy authorization before the public wallet queue`).
    it("is a no-op for an item without raw bytes that names no row of this pool", async () => {
      const { keyring, pool, writes } = setupSpendTest();
      const applier = attachCommitApplier(pool);
      const outside = await signSpend(keyring, 7);
      pool.capacityCache.set(0, { capacityWei: 9n, checkedAtMs: Date.now() });
      const written = writes();

      for (const item of [
        consolidatorItem(keyring.deriveSubAccount(7).address, outside),
        { ...consolidatorItem("0x" + "34".repeat(20), outside), spentInputs: [] },
      ]) {
        expect(await pool.processSyncTransaction(item)).toEqual({
          affectedIndices: [],
        });
      }
      expect(applier).not.toHaveBeenCalled();
      expect(writes()).toBe(written);
      expect(pool.capacityCache.has(0)).toBe(true);
    });

    // Check 6: a transaction no live row signed spends no pool account. Not a rejection.
    it("is a no-op for a consistent item whose signer is not a live row of this pool", async () => {
      const { keyring, pool, writes } = setupSpendTest();
      const applier = attachCommitApplier(pool);
      const outside = await signSpend(keyring, 7);
      const written = writes();

      expect(
        await pool.processSyncTransaction({
          ...consolidatorItem(keyring.deriveSubAccount(7).address, outside),
          rawTx: outside.rawTx,
        })
      ).toEqual({ affectedIndices: [] });

      expect(applier).not.toHaveBeenCalled();
      expect(writes()).toBe(written);
      expect(pool.getRecord(7)).toBeUndefined();
    });

    /** Bytes that parse and carry a signature, but whose signature recovers to no public key. */
    function unrecoverable(spend: { transaction: Transaction }) {
      const transaction = spend.transaction.clone();
      transaction.signature = Signature.from({
        r: "0x" + "5".padStart(64, "0"),
        s: "0x" + "1".padStart(64, "0"),
        yParity: 0,
      });
      const rawTx = transaction.serialized;
      const parsed = Transaction.from(rawTx);
      expect(() => parsed.from).toThrow();
      return { rawTx, txHash: parsed.hash as string };
    }

    // Before #1235 Stage 0b this table was "writes nothing and does not throw for %s" and asserted
    // `res.affectedIndices` equal to [] for every row: the refusal was caught inside the adapter
    // and the caller was told nothing. Each row is now a typed rejection with an applier attached
    // (so it is the adapter or the writer refusing, not the missing applier), and the applier is
    // never reached with bytes the adapter can see are wrong. Fails on the base for every row:
    // nothing is rejected. "unrecoverable signature" also fails on the base as an UNTYPED throw
    // out of `classifySpend`.
    it.each([
      ["another sender", "inconsistent-item"],
      ["hash mismatch", "inconsistent-item"],
      ["missing hash", "inconsistent-item"],
      ["malformed bytes", "invalid-transaction"],
      ["empty bytes", "invalid-transaction"],
      ["unsigned bytes", "invalid-transaction"],
      ["non-canonical bytes", "invalid-transaction"],
      ["oversize bytes", "invalid-transaction"],
      ["non-string bytes", "invalid-transaction"],
      ["unrecoverable signature", "invalid-transaction"],
      ["null bytes", "missing-transaction"],
      ["no chain identifier", "inconsistent-item"],
    ])("rejects %s with a typed refusal and writes nothing", async (kind, code) => {
      const { keyring, pool, writes } = setupSpendTest();
      const applier = attachCommitApplier(pool);
      const addr0 = keyring.deriveSubAccount(0).address;
      const own = await signSpend(keyring, 0);
      const other = await signSpend(keyring, 1);
      const broken = unrecoverable(own);
      const base = consolidatorItem(addr0, own);
      const item: Record<string, unknown> =
        kind === "another sender"
          ? { ...base, txHash: other.txHash, rawTx: other.rawTx }
          : kind === "hash mismatch"
          ? { ...base, txHash: other.txHash, rawTx: own.rawTx }
          : kind === "missing hash"
          ? { ...base, txHash: undefined, rawTx: own.rawTx }
          : kind === "malformed bytes"
          ? { ...base, rawTx: "0x1234" }
          : kind === "empty bytes"
          ? { ...base, rawTx: "" }
          : kind === "unsigned bytes"
          ? { ...base, rawTx: own.transaction.unsignedSerialized }
          : kind === "non-canonical bytes"
          ? { ...base, rawTx: "0x" + own.rawTx.slice(2).toUpperCase() }
          : kind === "oversize bytes"
          ? { ...base, rawTx: own.rawTx + "00".repeat(64 * 1024) }
          : kind === "non-string bytes"
          ? { ...base, rawTx: { toString: () => own.rawTx } }
          : kind === "unrecoverable signature"
          ? { ...base, txHash: broken.txHash, rawTx: broken.rawTx }
          : kind === "null bytes"
          ? { ...base, rawTx: null }
          : { ...base, rawTx: own.rawTx, chainIdentifier: undefined };
      const before = pool.records();
      pool.capacityCache.set(0, { capacityWei: 9n, checkedAtMs: Date.now() });
      const written = writes();

      const refusal = await refusalOf(pool, item);

      expect(refusal).toBeInstanceOf(SubAccountSpendRefusedError);
      expect(refusal).toMatchObject({ code });
      expect(applier).not.toHaveBeenCalled();
      expect(writes()).toBe(written);
      expect(pool.records()).toEqual(before);
      expect(pool.capacityCache.has(0)).toBe(false);
    });

    // Check 7. Before #1235 Stage 0b this test was "does not throw for an item whose spent inputs
    // are malformed" and asserted that `[null]`, `[{}]`, `[{ address: 7 }]` and a string each
    // returned `{ affectedIndices: [] }`: the item's own account of the spend was never compared
    // with the transaction, and a malformed one was indistinguishable from an applied one. Those
    // four shapes are kept below and now reject. On the base every row here fails: the complete
    // item commits (or, for the shapes that name no row, resolves) and nothing is rejected.
    it.each<[string, (item: ReturnType<typeof consolidatorItem>) => unknown]>([
      ["no spent input", (item) => ({ ...item, spentInputs: [] })],
      ["spentInputs absent", (item) => ({ ...item, spentInputs: undefined })],
      ["a null spent input", (item) => ({ ...item, spentInputs: [null] })],
      ["a spent input with no address", (item) => ({ ...item, spentInputs: [{}] })],
      ["a spent input with a numeric address", (item) => ({ ...item, spentInputs: [{ address: 7 }] })],
      ["spentInputs that is a string", (item) => ({ ...item, spentInputs: "0xabc" })],
      ["two spent inputs", (item) => ({ ...item, spentInputs: [item.spentInputs[0], item.spentInputs[0]] })],
      ["a spent input for another address", (item) => ({ ...item, spentInputs: [{ ...item.spentInputs[0], address: "0x" + "34".repeat(20) }] })],
      ["a spent input for another pool row", (item) => ({ ...item, spentInputs: [{ ...item.spentInputs[0], address: "ROW1" }] })],
      ["the wrong nonce", (item) => ({ ...item, spentInputs: [{ ...item.spentInputs[0], nonce: 1 }] })],
      ["a debit below the transaction value", (item) => ({ ...item, spentInputs: [{ ...item.spentInputs[0], valueWei: "4999" }] })],
      ["a debit above value plus the maximum fee", (item) => ({ ...item, spentInputs: [{ ...item.spentInputs[0], valueWei: "26001" }] })],
      ["a debit that is not a decimal amount", (item) => ({ ...item, spentInputs: [{ ...item.spentInputs[0], valueWei: "0x1388" }] })],
      ["a created output to another address", (item) => ({ ...item, createdOutputs: [{ ...item.createdOutputs[0], address: "0x" + "34".repeat(20) }] })],
      ["a created output for another value", (item) => ({ ...item, createdOutputs: [{ ...item.createdOutputs[0], valueWei: "26000" }] })],
      ["a created output with no value", (item) => ({ ...item, createdOutputs: [{ address: item.createdOutputs[0].address }] })],
      ["two created outputs", (item) => ({ ...item, createdOutputs: [item.createdOutputs[0], item.createdOutputs[0]] })],
      ["no created output where the field is present", (item) => ({ ...item, createdOutputs: [] })],
    ])("rejects a complete item with %s, nothing written", async (_label, mutate) => {
      const { keyring, pool, writes } = setupSpendTest();
      const applier = attachCommitApplier(pool);
      const addr0 = keyring.deriveSubAccount(0).address;
      const spend = await signSpend(keyring, 0);
      const mutated = JSON.parse(
        JSON.stringify(
          mutate({ ...consolidatorItem(addr0, spend), rawTx: spend.rawTx } as never)
        ).replace("ROW1", keyring.deriveSubAccount(1).address)
      );
      const before = pool.records();
      pool.capacityCache.set(0, { capacityWei: 9n, checkedAtMs: Date.now() });
      const written = writes();

      const refusal = await refusalOf(pool, mutated);

      expect(refusal).toBeInstanceOf(SubAccountSpendRefusedError);
      expect(refusal).toMatchObject({ code: "inconsistent-item", index: 0 });
      expect(applier).not.toHaveBeenCalled();
      expect(writes()).toBe(written);
      expect(pool.records()).toEqual(before);
      expect(pool.capacityCache.has(0)).toBe(false);
    });

    // The other side of check 7: what the emitter may legitimately say is accepted, so the bound
    // is the contract's and not merely "equal to what this fixture sends".
    it.each<[string, (item: ReturnType<typeof consolidatorItem>) => unknown]>([
      ["a debit equal to the transaction value", (item) => ({ ...item, spentInputs: [{ ...item.spentInputs[0], valueWei: "5000" }] })],
      ["a debit equal to value plus the maximum fee", (item) => ({ ...item, spentInputs: [{ ...item.spentInputs[0], valueWei: "26000" }] })],
      ["no nonce and no debit", (item) => ({ ...item, spentInputs: [{ address: item.spentInputs[0].address }] })],
      ["no createdOutputs", (item) => ({ ...item, createdOutputs: undefined })],
      ["a checksummed input address", (item) => ({ ...item, spentInputs: [{ ...item.spentInputs[0], address: "CHECKSUM0" }] })],
    ])("accepts a complete item with %s", async (_label, mutate) => {
      const { keyring, pool } = setupSpendTest();
      const applier = attachCommitApplier(pool);
      const addr0 = keyring.deriveSubAccount(0).address;
      const spend = await signSpend(keyring, 0);
      const mutated = JSON.parse(
        JSON.stringify(
          mutate({ ...consolidatorItem(addr0, spend), rawTx: spend.rawTx } as never)
        ).replace("CHECKSUM0", addr0)
      );

      expect(await pool.processSyncTransaction(mutated)).toEqual({
        affectedIndices: [0],
      });
      expect(applier).toHaveBeenCalledTimes(1);
      expect(pool.getRecord(0)?.status).toBe("spent");
    });

    // Before #1235 Stage 0b every row of this table asserted `res.affectedIndices` equal to [] with
    // no error: a row another owner or another transaction holds was reported like a success. A
    // held row is now a typed `held` rejection out of the one writer; only the identical
    // checkpoint is a quiet repeat. Fails on the base for the five held rows: nothing is rejected.
    it.each([
      ["in-use", "held"],
      ["retired", "held"],
      ["funding", "held"],
      ["spent without a checkpoint", "held"],
      ["spent with another checkpoint", "held"],
      ["spent with the identical checkpoint", undefined],
    ])("leaves a row that is %s unchanged for a complete item", async (state, code) => {
      const { keyring, pool, store, writes } = setupSpendTest();
      attachCommitApplier(pool);
      const addr0 = keyring.deriveSubAccount(0).address;
      const spend = await signSpend(keyring, 0);
      if (state === "in-use" || state === "retired") pool.setStatus(0, state);
      else if (state === "funding") {
        // Hand-built: the funding path needs a main-account signer this fixture does not have.
        const attempt = await signSpend(keyring, 2);
        store.put({
          index: 0,
          address: addr0,
          status: "funding",
          fundingAttempt: { rawTx: attempt.rawTx, txHash: attempt.txHash },
        });
      } else if (state === "spent without a checkpoint") {
        pool.setStatus(0, "spent");
      } else if (state === "spent with another checkpoint") {
        const earlier = await signSpend(keyring, 0, { nonce: 1, value: 1n });
        expect(pool.commitSpend(0, earlier.rawTx)).toBe("committed");
      } else {
        expect(pool.commitSpend(0, spend.rawTx)).toBe("committed");
      }
      const before = pool.records();
      const written = writes();

      const refusal = await refusalOf(pool, {
        ...consolidatorItem(addr0, spend),
        rawTx: spend.rawTx,
      });

      if (code === undefined) expect(refusal).toBe("not refused");
      else {
        expect(refusal).toBeInstanceOf(SubAccountSpendRefusedError);
        expect(refusal).toMatchObject({ code, index: 0 });
      }
      expect(writes()).toBe(written);
      expect(pool.records()).toEqual(before);
    });

    // Before Stage 0b the item without raw bytes was asserted to return `{ affectedIndices: [] }`;
    // it is refused now. What the test protects is unchanged: the committed row is not touched.
    it("never re-malforms a committed row when the item without raw bytes arrives afterwards", async () => {
      const { keyring, pool, writes } = setupSpendTest();
      const addr0 = keyring.deriveSubAccount(0).address;
      const spend = await signSpend(keyring, 0);
      expect(pool.commitSpend(0, spend.rawTx)).toBe("committed");
      const committed = pool.getRecord(0);
      const written = writes();

      expect(
        await refusalOf(pool, consolidatorItem(addr0, spend))
      ).toMatchObject({ code: "missing-transaction", index: 0 });

      expect(writes()).toBe(written);
      expect(pool.getRecord(0)).toEqual(committed);
      expect(committed?.lifecycle?.spend?.rawTx).toBe(spend.rawTx);
      expect(() =>
        validateMonadWalletState(walletStateOf(pool, keyring))
      ).not.toThrow();
    });

    it("lets the complete transaction commit after the item without raw bytes was refused first", async () => {
      const { keyring, pool, writes } = setupSpendTest();
      const addr0 = keyring.deriveSubAccount(0).address;
      const spend = await signSpend(keyring, 0);
      const written = writes();
      expect(
        await refusalOf(pool, consolidatorItem(addr0, spend))
      ).toMatchObject({ code: "missing-transaction" });
      expect(writes()).toBe(written);

      expect(pool.commitSpend(0, spend.rawTx)).toBe("committed");
      expect(pool.getRecord(0)).toEqual({
        index: 0,
        address: addr0,
        status: "spent",
        lifecycle: {
          spend: { rawTx: spend.rawTx, txHash: spend.txHash, valueWei: "5000" },
        },
      });
      expect(pool.commitSpend(0, spend.rawTx)).toBe("already-applied");
      expect(() =>
        validateMonadWalletState(walletStateOf(pool, keyring))
      ).not.toThrow();
    });

    // The Stage 0a review's finding. On the base `commitSpend` throws ethers' own error here
    // ("Cannot find square root"): reading the sender sat outside the try.
    it("commitSpend refuses bytes whose signature does not recover with a typed error", async () => {
      const { keyring, pool, writes } = setupSpendTest();
      const broken = unrecoverable(await signSpend(keyring, 0));
      const before = pool.records();
      const written = writes();
      let thrown: unknown;
      try {
        pool.commitSpend(0, broken.rawTx);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(SubAccountSpendRefusedError);
      expect(thrown).toMatchObject({ code: "invalid-transaction", index: 0 });
      expect(writes()).toBe(written);
      expect(pool.records()).toEqual(before);
    });

    it("commitSpend refuses without writing, and creates no row", async () => {
      const { keyring, pool, store, writes } = setupSpendTest();
      const own = await signSpend(keyring, 0);
      const other = await signSpend(keyring, 1);
      pool.setStatus(2, "in-use");
      const before = pool.records();
      const written = writes();
      const refused = (index: number, rawTx: string) => {
        try {
          pool.commitSpend(index, rawTx);
        } catch (error) {
          expect(error).toBeInstanceOf(SubAccountSpendRefusedError);
          return (error as SubAccountSpendRefusedError).code;
        }
        return "not refused";
      };

      expect(refused(0, "")).toBe("invalid-transaction");
      expect(refused(0, "0x1234")).toBe("invalid-transaction");
      expect(refused(0, own.transaction.unsignedSerialized)).toBe(
        "invalid-transaction"
      );
      expect(refused(0, "0x" + own.rawTx.slice(2).toUpperCase())).toBe(
        "invalid-transaction"
      );
      expect(refused(-1, own.rawTx)).toBe("invalid-transaction");
      expect(refused(0, other.rawTx)).toBe("sender-mismatch");
      expect(refused(2, (await signSpend(keyring, 2)).rawTx)).toBe("held");
      // Index 7 is derivable but the pool has no row for it: reported, never created.
      expect(pool.commitSpend(7, (await signSpend(keyring, 7)).rawTx)).toBe(
        "no-row"
      );
      expect(pool.getRecord(7)).toBeUndefined();
      // A row whose stored address is not its derivation is refused although the bytes are valid.
      store.put({
        index: 1,
        address: keyring.deriveSubAccount(0).address,
        status: "available",
      });
      const afterHandBuilt = writes();
      expect(refused(1, other.rawTx)).toBe("sender-mismatch");
      expect(writes()).toBe(afterHandBuilt);
      expect(afterHandBuilt - written).toBe(1);
      expect(pool.getRecord(0)).toEqual(before[0]);
      expect(pool.getRecord(2)).toEqual(before[2]);
    });

    it.each([0, 1, 2])(
      "commitSpend accepts a type %i transaction the validator accepts",
      async (type) => {
        const { keyring, pool } = setupSpendTest();
        const wallet = new Wallet(keyring.deriveSubAccount(0).privateKey);
        const rawTx = await wallet.signTransaction({
          type,
          chainId: CHAIN_ID,
          nonce: 0,
          to: recipient,
          value: 3n,
          gasLimit: 21_000n,
          ...(type === 2
            ? { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }
            : { gasPrice: 1n }),
        });
        expect(Transaction.from(rawTx).type).toBe(type);
        expect(pool.commitSpend(0, rawTx)).toBe("committed");
        expect(pool.getRecord(0)?.lifecycle?.spend?.valueWei).toBe("3");
        expect(() =>
          validateMonadWalletState(walletStateOf(pool, keyring))
        ).not.toThrow();
      }
    );

    // #1235 Stage 1, from the review of Stage 0b. An item whose spent input names a row of this
    // pool, carrying a valid transaction some OTHER key signed. On main 72631f36 this resolves as
    // a quiet no-op (check 6 returns before check 7), although the same item without bytes is
    // refused: fails there with "not refused".
    it("rejects an item that names a pool row but carries a transaction a non-pool key signed", async () => {
      const { keyring, pool, writes } = setupSpendTest();
      const applier = attachCommitApplier(pool);
      const addr0 = keyring.deriveSubAccount(0).address;
      const outsider = await signSpend(keyring, 7);
      expect(pool.getRecord(7)).toBeUndefined();
      const before = pool.records();
      pool.capacityCache.set(0, { capacityWei: 9n, checkedAtMs: Date.now() });
      const written = writes();

      const refusal = await refusalOf(pool, {
        ...consolidatorItem(addr0, outsider),
        rawTx: outsider.rawTx,
      });

      expect(refusal).toBeInstanceOf(SubAccountSpendRefusedError);
      expect(refusal).toMatchObject({ code: "inconsistent-item", index: 0 });
      expect(applier).not.toHaveBeenCalled();
      expect(writes()).toBe(written);
      expect(pool.records()).toEqual(before);
      expect(pool.capacityCache.has(0)).toBe(false);
      // Naming two rows of the pool is no better.
      expect(
        await refusalOf(pool, {
          ...consolidatorItem(addr0, outsider),
          rawTx: outsider.rawTx,
          spentInputs: [
            { address: addr0 },
            { address: keyring.deriveSubAccount(1).address },
          ],
        })
      ).toMatchObject({ code: "inconsistent-item", index: undefined });
      expect(writes()).toBe(written);
    });

    // Pin, from the review of Stage 0b: the debit upper bound (check 7) was exercised for type 2
    // only. A legacy or access-list transaction has no `maxFeePerGas`; its bound is the gas price.
    it.each([0, 1, 2])(
      "pin: a type %i item is accepted with a debit of value plus its maximum fee and rejected one wei above",
      async (type) => {
        const { keyring, pool, writes } = setupSpendTest();
        const applier = attachCommitApplier(pool);
        const addr0 = keyring.deriveSubAccount(0).address;
        const rawTx = await new Wallet(
          keyring.deriveSubAccount(0).privateKey
        ).signTransaction({
          type,
          chainId: CHAIN_ID,
          nonce: 0,
          to: recipient,
          value: 5_000n,
          gasLimit: 21_000n,
          ...(type === 2
            ? { maxFeePerGas: 3n, maxPriorityFeePerGas: 1n }
            : { gasPrice: 3n }),
        });
        const transaction = Transaction.from(rawTx);
        expect(transaction.type).toBe(type);
        const item = (valueWei: string) => ({
          ...consolidatorItem(addr0, {
            txHash: transaction.hash as string,
            transaction,
          }),
          rawTx,
          spentInputs: [{ address: addr0, nonce: 0, valueWei }],
        });
        const written = writes();
        // 5000 + 21000 * 3
        expect(await refusalOf(pool, item("68001"))).toMatchObject({
          code: "inconsistent-item",
          index: 0,
        });
        expect(await refusalOf(pool, item("4999"))).toMatchObject({
          code: "inconsistent-item",
        });
        expect(applier).not.toHaveBeenCalled();
        expect(writes()).toBe(written);
        expect(await pool.processSyncTransaction(item("68000"))).toEqual({
          affectedIndices: [0],
        });
        expect(pool.getRecord(0)?.lifecycle?.spend?.valueWei).toBe("5000");
      }
    );

    // #1235 Stage 1: the read-only form the input admission asks before it writes. Fails on main
    // 72631f36: `classifySpendOutcome` does not exist (the classification is private).
    it("classifySpendOutcome answers what commitSpend would do, and writes nothing", async () => {
      const { keyring, pool, writes } = setupSpendTest();
      const own = await signSpend(keyring, 0);
      pool.setStatus(2, "in-use");
      const before = pool.records();
      pool.capacityCache.set(0, { capacityWei: 9n, checkedAtMs: Date.now() });
      const written = writes();
      const refused = (index: number, rawTx: string) => {
        try {
          return pool.classifySpendOutcome(index, rawTx);
        } catch (error) {
          expect(error).toBeInstanceOf(SubAccountSpendRefusedError);
          return (error as SubAccountSpendRefusedError).code;
        }
      };

      expect(pool.classifySpendOutcome(0, own.rawTx)).toBe("committed");
      expect(pool.classifySpendOutcome(0, own.rawTx)).toBe("committed");
      expect(refused(7, (await signSpend(keyring, 7)).rawTx)).toBe("no-row");
      expect(refused(0, "0x1234")).toBe("invalid-transaction");
      expect(refused(1, own.rawTx)).toBe("sender-mismatch");
      expect(refused(2, (await signSpend(keyring, 2)).rawTx)).toBe("held");
      expect(writes()).toBe(written);
      expect(pool.records()).toEqual(before);
      expect(pool.capacityCache.has(0)).toBe(true);

      expect(pool.commitSpend(0, own.rawTx)).toBe("committed");
      expect(pool.classifySpendOutcome(0, own.rawTx)).toBe("already-applied");
      expect(refused(0, (await signSpend(keyring, 0, { value: 6n })).rawTx)).toBe(
        "held"
      );
    });

    // Pin: the applier is handed the item's own chain identifier, verbatim. The pool cannot judge
    // it; the applier (the admission's chain binding) does.
    it("pin: hands the applier the item's chain identifier exactly as the item states it", async () => {
      const { keyring, pool } = setupSpendTest();
      const applier = jest.fn(async () => ({ kind: "no-pool-row" as const }));
      pool.attachSpendApplier(applier);
      const spend = await signSpend(keyring, 0);
      for (const chainIdentifier of ["ethereum-sepolia", "Monad-Testnet", "evm"]) {
        await pool.processSyncTransaction({
          ...consolidatorItem(keyring.deriveSubAccount(0).address, spend),
          rawTx: spend.rawTx,
          chainIdentifier,
        });
        expect(applier).toHaveBeenLastCalledWith(spend.rawTx, chainIdentifier);
      }
      expect(pool.getRecord(0)?.status).toBe("available");
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

  describe("a superseded funding attempt (Issue #1189)", () => {
    function setupSupersededTest() {
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


    it("detects superceded funding attempts, retires them, and allows preparation to succeed (Issue #1189)", async () => {
      const {
        balances,
        defaultOverrides,
        httpClient,
        mainAccountSigner,
        pool,
        provider,
        store,
      } = setupSupersededTest();
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

/**
 * #1235 Stage R. The predicate is the real native operation journal's `referencesSpendIndex`, as
 * composition attaches it. Rows are hand-built here (`ensureUnfundedSize` / `setStatus` with a
 * stubbed balance); the composed suites cover production-funded rows.
 */
describe("spend reservation: a sub-account a native member spends from (#1235)", () => {
  const FUNDING = {
    gasLimit: 21_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    chainId: BigInt(CHAIN_ID),
  };
  const RECIPIENT = "0x" + "42".repeat(20);
  const journals: EvmNativeOperationJournal[] = [];
  afterEach(async () => {
    for (const journal of journals.splice(0)) await journal.Close();
  });

  async function setup() {
    const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC);
    const pool = new MonadSubAccountPool({ keyring });
    pool.ensureUnfundedSize(3);
    const balances = new Map<string, bigint>();
    let mainNonce = 0;
    const httpClient = makeMockHttpClient();
    httpClient.submitRawTransaction.mockImplementation(async (rawTx) => {
      const tx = Transaction.from(rawTx);
      const to = tx.to!.toLowerCase();
      balances.set(to, (balances.get(to) ?? 0n) + tx.value);
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
    const balanceReads: string[] = [];
    const provider = makeStubProvider(async (request) => {
      const address = (
        (request as unknown as { address?: string }).address ?? ""
      ).toLowerCase();
      if (request.method === "getTransactionCount") {
        return address === mainWallet.address.toLowerCase() ? mainNonce++ : 0;
      }
      if (request.method === "getBalance") {
        balanceReads.push(address);
        return balances.get(address) ?? 0n;
      }
      throw new Error(`unexpected _perform: ${request.method}`);
    });
    const mainAccountSigner = new MonadAccountTxSigner({
      privateKey: mainWallet.privateKey,
      provider,
      httpClient,
    });
    const journal = new EvmNativeOperationJournal({
      binding: {
        chainIdentifier: "monad-testnet",
        nativeChainId: String(CHAIN_ID),
        publicTuple: "pool-reservation-test",
      },
      testOnlyEphemeral: true,
    });
    await journal.Open();
    journals.push(journal);
    const address = (index: number) =>
      pool.getRecord(index)!.address.toLowerCase();
    /** Journals one native member spending from pool row `index`, as a native send does. */
    const nativeSpend = (index: number) =>
      journal.prepare({
        kind: "native",
        recipient: RECIPIENT,
        intendedValueWei: "1",
        members: [
          {
            source: { kind: "spend", address: address(index), index },
            unsignedTransaction: Transaction.from({
              type: 2,
              chainId: CHAIN_ID,
              nonce: 0,
              to: RECIPIENT,
              value: 1n,
              gasLimit: 21_000n,
              maxFeePerGas: 1n,
              maxPriorityFeePerGas: 1n,
            }).unsignedSerialized,
            dependencies: [],
          },
        ],
      });
    /** Hand-built funded row: `available` with exactly one 1_000 wei burn of capacity. */
    const handFund = (index: number) => {
      pool.setStatus(index, "available");
      balances.set(address(index), 1_010n);
    };
    const attach = () =>
      pool.attachSpendReservation((index) =>
        journal.referencesSpendIndex(index)
      );
    const prepareBurn = () =>
      pool.prepareBurnAccount({
        mainAccountSigner,
        provider,
        burnValueWei: 1_000n,
        gasReserveWei: 10n,
        fundingOverrides: FUNDING,
        receipt: { maxAttempts: 0 },
      });
    const prepareStamp = (stampValueWei = 1_000n) =>
      pool.prepareStampInventory({
        mainAccountSigner,
        provider,
        stampValueWei,
        gasReserveWei: 10n,
        fundingOverrides: FUNDING,
        receipt: { maxAttempts: 0 },
      });
    const fundedTargets = () =>
      httpClient.submitRawTransaction.mock.calls.map(([raw]) =>
        Transaction.from(raw).to!.toLowerCase()
      );
    const statuses = () => pool.records().map((record) => record.status);
    return {
      address,
      attach,
      balanceReads,
      fundedTargets,
      handFund,
      journal,
      keyring,
      nativeSpend,
      pool,
      prepareBurn,
      prepareStamp,
      provider,
      statuses,
    };
  }

  it("with no reservation attached, a row a native member references is offered, leased, reused and funded exactly as before", async () => {
    const funded = await setup();
    funded.handFund(0);
    await funded.nativeSpend(0);
    expect(funded.pool.isSpendReserved(0)).toBe(false);
    expect(
      await funded.pool.fundedCapacities(funded.provider, 10n)
    ).toEqual([
      { index: 0, address: funded.pool.getRecord(0)!.address, capacityWei: 1_000n },
    ]);
    expect(funded.pool.selectForStamp()?.index).toBe(0);
    expect((await funded.prepareBurn()).index).toBe(0);
    expect(funded.fundedTargets()).toEqual([]);

    const unfunded = await setup();
    await unfunded.nativeSpend(0);
    expect((await unfunded.prepareBurn()).index).toBe(0);
    expect(unfunded.fundedTargets()).toEqual([unfunded.address(0)]);
    const stamp = await setup();
    await stamp.nativeSpend(0);
    await stamp.prepareStamp();
    expect(stamp.fundedTargets()).toEqual([stamp.address(0), stamp.address(1)]);
  });

  it("refuses a second reservation", async () => {
    const f = await setup();
    f.attach();
    expect(() => f.attach()).toThrow("already has a spend reservation");
  });

  it("does not offer, lease or reuse a hand-built funded row a native member references, and still uses an unreferenced one", async () => {
    const f = await setup();
    f.handFund(0);
    f.handFund(1);
    await f.nativeSpend(0);
    f.attach();

    expect(await f.pool.fundedCapacities(f.provider, 10n)).toEqual([
      { index: 1, address: f.pool.getRecord(1)!.address, capacityWei: 1_000n },
    ]);
    // The reserved row is skipped before any balance read, not read and then dropped.
    expect(f.balanceReads).toEqual([f.address(1)]);
    expect([1, 2, 3].map(() => f.pool.selectForStamp()?.index)).toEqual([
      1, 1, 1,
    ]);
    // A burn reuses the unreferenced funded row and funds nothing.
    expect((await f.prepareBurn()).index).toBe(1);
    expect(f.fundedTargets()).toEqual([]);

    const leases = new SubAccountLeaseManager(f.pool);
    expect(leases.acquireLease().index).toBe(1);
    // Only the reserved row is left `available`: lease selection reports none, as for an empty pool.
    expect(f.pool.selectForStamp()).toBeUndefined();
    expect(() => leases.acquireLease()).toThrow(NoAvailableSubAccountError);
    expect(f.statuses()).toEqual(["available", "in-use", "unfunded"]);
  });

  it("does not choose an unfunded row a native member references as an on-demand funding target", async () => {
    const burn = await setup();
    await burn.nativeSpend(0);
    burn.attach();
    expect((await burn.prepareBurn()).index).toBe(1);
    expect(burn.fundedTargets()).toEqual([burn.address(1)]);
    expect(burn.statuses()).toEqual(["unfunded", "available", "unfunded"]);

    const stamp = await setup();
    await stamp.nativeSpend(0);
    stamp.attach();
    await stamp.prepareStamp();
    expect(stamp.fundedTargets()).toEqual([stamp.address(1), stamp.address(2)]);
    expect(stamp.statuses()).toEqual(["unfunded", "available", "available"]);
  });

  it("a cancelled unsigned plan releases its row; a signed member keeps it, also once reverted", async () => {
    const f = await setup();
    f.attach();
    const cancelled = await f.nativeSpend(0);
    const kept = await f.nativeSpend(1);
    expect([0, 1, 2].map((i) => f.pool.isSpendReserved(i))).toEqual([
      true,
      true,
      false,
    ]);
    await f.journal.cancelUnsigned(cancelled.operationId);
    expect(f.pool.isSpendReserved(0)).toBe(false);

    const raw = await new Wallet(
      f.keyring.deriveSubAccount(1).privateKey
    ).signTransaction(Transaction.from(kept.members[0]!.unsignedTransaction));
    const signed = await f.journal.checkpointSigned(kept.operationId, 0, raw);
    await expect(f.journal.cancelUnsigned(kept.operationId)).rejects.toThrow(
      "conflict"
    );
    expect(f.pool.isSpendReserved(1)).toBe(true);
    await f.journal.recordObservation(
      f.journal.beginCapture(kept.operationId, 0),
      {
        state: "included-revert",
        transactionHash: signed.members[0]!.signed!.transactionHash,
        blockHash: "0x" + "ab".repeat(32),
        blockNumber: 1,
        transactionIndex: 0,
        feeWei: "21000",
      },
      null
    );
    expect(f.journal.list()[1]!.members[0]!.observation.state).toBe(
      "included-revert"
    );
    expect(f.pool.isSpendReserved(1)).toBe(true);

    // The released row is the next funding target again; the reverted member's row is not.
    expect((await f.prepareBurn()).index).toBe(0);
    // A stamp of twice the burn account's capacity: one account that covers a stamp is ready
    // as it is, so only a larger one makes the preparation choose a second funding target.
    await f.prepareStamp(2_000n);
    expect(f.fundedTargets()).toEqual([f.address(0), f.address(2)]);
    expect(f.statuses().slice(0, 3)).toEqual([
      "available",
      "unfunded",
      "available",
    ]);
  });

  it("when every existing row is reserved, a burn and a stamp still prepare by funding freshly derived accounts", async () => {
    const f = await setup();
    f.handFund(0);
    f.handFund(1);
    for (const index of [0, 1, 2]) await f.nativeSpend(index);
    f.attach();

    expect(await f.pool.fundedCapacities(f.provider, 10n)).toEqual([]);
    expect(f.pool.selectForStamp()).toBeUndefined();
    const burn = await f.prepareBurn();
    expect(burn.index).toBe(3);
    const stamp = await f.prepareStamp(2_000n);
    expect(stamp.selectedAccountCount).toBeGreaterThanOrEqual(1);
    // Every funding transfer went to an account derived after the reserved ones.
    expect(f.fundedTargets().length).toBeGreaterThanOrEqual(2);
    for (const target of f.fundedTargets())
      expect([0, 1, 2].map(f.address)).not.toContain(target);
    expect(f.statuses().slice(0, 3)).toEqual([
      "available",
      "available",
      "unfunded",
    ]);
    expect(
      f.pool
        .records()
        .slice(3)
        .every((record) => record.status === "available")
    ).toBe(true);
  });
});
