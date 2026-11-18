import { PublicKey } from "@solana/web3.js";
import { ethers } from "ethers";
import {
  deriveSwapSecret,
  decodeHtlcLock,
  encodeHtlcLock,
  encodeHtlcRefund,
  encodeHtlcWithdraw,
  evmHtlcInterface,
  htlcLockId,
  HTLC_NATIVE_TOKEN,
  decodeSolanaHtlcLockState,
  buildSolanaSwapLockInstruction,
  buildSolanaSwapWithdrawInstruction,
  buildSolanaSwapRefundInstruction,
  evaluateSwapStepPhase,
  resolveHtlcContract,
  toBytes32Hex,
} from "./swap-escrow";
import type {
  EvmHtlcTerms,
  SwapLockRecord,
  SwapLockStatus,
} from "./swap-escrow";
import GenericHTLCArtifact from "@frank/contracts/artifacts/GenericHTLC.json";
import { SOLANA_GENERIC_HTLC_PROGRAM_ID } from "./solana-game-escrow";
import { PROTOCOL_CHAINS } from "./chain/chains-registry";

describe("swap-escrow service & calldata builders", () => {

  it("derives deterministic preimage and hashlock", () => {
    const swapId = "swap-12345-abcde";
    const seed = new Uint8Array(32).fill(7);
    const secret1 = deriveSwapSecret({ swapId, seed });
    const secret2 = deriveSwapSecret({ swapId, seed });
    // Another seed gives another secret: the swapId alone does not determine it.
    expect(
      deriveSwapSecret({ swapId, seed: new Uint8Array(32).fill(8) }).preimageHex
    ).not.toBe(secret1.preimageHex);

    expect(secret1.preimage.length).toBe(32);
    expect(secret1.hashLock.length).toBe(32);
    expect(secret1.preimageHex).toBe(secret2.preimageHex);
    expect(secret1.hashLockHex).toBe(secret2.hashLockHex);

    // Verify sha256(preimage) === hashLock
    const manualHash = ethers.sha256(secret1.preimage);
    expect(manualHash).toBe(secret1.hashLockHex);
  });

  it("refuses to derive a swap secret without a real seed", () => {
    const swapId = "swap-12345-abcde";
    const derive = deriveSwapSecret as (params: {
      swapId: string;
      seed?: Uint8Array;
    }) => unknown;
    expect(() => derive({ swapId })).toThrow("needs a 32-byte secret seed");
    expect(() => derive({ swapId, seed: new Uint8Array(16).fill(1) })).toThrow(
      "needs a 32-byte secret seed"
    );
    expect(() => derive({ swapId, seed: new Uint8Array(32) })).toThrow(
      "refuses an all-zero seed"
    );
  });

  it("normalizes lockIds and hashes into 32-byte hex buffers", () => {
    const hash32 = "0x" + "aa".repeat(32);
    expect(toBytes32Hex(hash32)).toBe(hash32);

    const shortStr = "swap-id";
    const normalized = toBytes32Hex(shortStr);
    expect(normalized.startsWith("0x")).toBe(true);
    expect(normalized.length).toBe(66);
  });

  it("resolves the HTLC of a network from the registry, and refuses instead of defaulting", () => {
    for (const id of ["monad-testnet", "monad-mainnet", "ethereum-sepolia"]) {
      const htlc = PROTOCOL_CHAINS[id].contracts?.htlc;
      if (htlc) {
        expect(resolveHtlcContract(id)).toEqual({
          family: "evm",
          contractAddress: htlc,
        });
      } else {
        expect(() => resolveHtlcContract(id)).toThrow(
          `GenericHTLC is not deployed on ${id}`
        );
      }
    }

    // An unknown identifier is not treated as an EVM chain.
    expect(() => resolveHtlcContract("nonexistent")).toThrow(
      'Unknown chain identifier "nonexistent"'
    );
    expect(() => resolveHtlcContract("evm")).toThrow(
      'Unknown chain identifier "evm"'
    );
    expect(() => resolveHtlcContract("xec-mainnet")).toThrow(
      "HTLC swaps are not supported on xec-mainnet"
    );

    // Solana still resolves to a placeholder program id; no program is deployed.
    const solanaConfig = resolveHtlcContract("solana-testnet");
    expect(solanaConfig.family).toBe("solana");
    expect(solanaConfig.contractAddress).toBe(SOLANA_GENERIC_HTLC_PROGRAM_ID);
  });

  describe("GenericHTLC v2 (EVM)", () => {
    const htlc = "0x9999999999999999999999999999999999999999";
    const sender = "0x3333333333333333333333333333333333333333";
    const terms: EvmHtlcTerms = {
      recipient: "0x1111111111111111111111111111111111111111",
      refundAddress: "0x2222222222222222222222222222222222222222",
      token: HTLC_NATIVE_TOKEN,
      amount: ethers.parseEther("2.5"),
      hashLock: ethers.sha256("0x" + "44".repeat(32)),
      expiresAt: 1_800_000_000n,
    };
    const compiled = new ethers.Interface(GenericHTLCArtifact.abi);

    it("declares exactly the functions and events of the compiled contract", () => {
      // Input names are documentation; the selector fixes the input types. What a call
      // returns, field by field, must match too.
      const fn = (fragment: ethers.FunctionFragment) => ({
        signature: fragment.format("sighash"),
        stateMutability: fragment.stateMutability,
        outputs: fragment.outputs.map((output) => output.format("full")),
      });
      const functions = (i: ethers.Interface) => {
        const out: ReturnType<typeof fn>[] = [];
        i.forEachFunction((fragment) => out.push(fn(fragment)));
        return out.sort((a, b) => a.signature.localeCompare(b.signature));
      };
      const events = (i: ethers.Interface) => {
        const out: string[] = [];
        i.forEachEvent((fragment) => out.push(fragment.format("full")));
        return out.sort();
      };
      expect(functions(evmHtlcInterface)).toEqual(functions(compiled));
      expect(events(evmHtlcInterface)).toEqual(events(compiled));
    });

    it("computes the lock id the contract's lockIdOf gives", () => {
      const id = htlcLockId(sender, terms);
      expect(id).toBe(
        ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["address", "address", "address", "address", "uint256", "bytes32", "uint64"],
            [sender, terms.recipient, terms.refundAddress, terms.token, terms.amount, terms.hashLock, terms.expiresAt]
          )
        )
      );
      // Every term and the sender are part of it.
      const other = "0x4444444444444444444444444444444444444444";
      for (const changed of [
        htlcLockId(other, terms),
        htlcLockId(sender, { ...terms, recipient: other }),
        htlcLockId(sender, { ...terms, refundAddress: other }),
        htlcLockId(sender, { ...terms, token: other }),
        htlcLockId(sender, { ...terms, amount: terms.amount + 1n }),
        htlcLockId(sender, { ...terms, hashLock: "0x" + "55".repeat(32) }),
        htlcLockId(sender, { ...terms, expiresAt: terms.expiresAt + 1n }),
      ]) {
        expect(changed).not.toBe(id);
      }
    });

    it("encodes lock, withdraw and refund for the v2 ABI", () => {
      const lockTx = encodeHtlcLock(htlc, terms);
      expect(lockTx.to).toBe(ethers.getAddress(htlc));
      expect(lockTx.value).toBe(terms.amount);
      const lock = compiled.parseTransaction({ data: lockTx.data, value: lockTx.value });
      expect(lock?.signature).toBe("lock(address,address,address,uint256,bytes32,uint64)");
      expect([...lock!.args]).toEqual([
        terms.recipient,
        terms.refundAddress,
        terms.token,
        terms.amount,
        terms.hashLock,
        terms.expiresAt,
      ]);

      // A token lock carries no value.
      const token = "0x7777777777777777777777777777777777777777";
      expect(encodeHtlcLock(htlc, { ...terms, token }).value).toBe(0n);

      const lockId = htlcLockId(sender, terms);
      const preimage = "0x" + "44".repeat(32);
      const withdraw = compiled.parseTransaction({
        data: encodeHtlcWithdraw(htlc, lockId, preimage).data,
      });
      expect(withdraw?.signature).toBe("withdraw(bytes32,bytes32)");
      expect([...withdraw!.args]).toEqual([lockId, preimage]);
      expect(encodeHtlcWithdraw(htlc, ethers.getBytes(lockId), ethers.getBytes(preimage)).data).toBe(
        encodeHtlcWithdraw(htlc, lockId, preimage).data
      );

      const refund = compiled.parseTransaction({ data: encodeHtlcRefund(htlc, lockId).data });
      expect(refund?.signature).toBe("refund(bytes32)");
      expect([...refund!.args]).toEqual([lockId]);
    });

    it("refuses terms and values the contract would refuse, or that are not what they claim", () => {
      const bad: [Partial<EvmHtlcTerms>, RegExp][] = [
        [{ recipient: ethers.ZeroAddress }, /recipient must not be the zero address/],
        [{ refundAddress: ethers.ZeroAddress }, /refund address must not be the zero address/],
        [{ refundAddress: undefined }, /refund address must be a 20-byte address/],
        [{ refundAddress: terms.recipient.toUpperCase().replace("0X", "0x") }, /must not be its recipient/],
        [{ recipient: "0x1234" }, /recipient must be a 20-byte address/],
        [{ amount: 0n }, /amount must be a positive bigint/],
        [{ amount: 1 as unknown as bigint }, /amount must be a positive bigint/],
        [{ expiresAt: 0n }, /expiresAt must be a positive uint64/],
        [{ expiresAt: 1n << 64n }, /expiresAt must be a positive uint64/],
        [{ expiresAt: 1_800_000_000 as unknown as bigint }, /expiresAt must be a positive uint64/],
        [{ hashLock: "0x" + "33".repeat(31) }, /hash lock must be exactly 32 bytes/],
        [{ hashLock: "33".repeat(32) }, /hash lock must be exactly 32 bytes/],
        [{ hashLock: "swap-id" }, /hash lock must be exactly 32 bytes/],
      ];
      for (const [change, message] of bad) {
        expect(() => encodeHtlcLock(htlc, { ...terms, ...change })).toThrow(message);
        expect(() => htlcLockId(sender, { ...terms, ...change })).toThrow(message);
      }
      expect(() => encodeHtlcLock("0x99", terms)).toThrow(/contract must be a 20-byte address/);
      expect(() => htlcLockId(ethers.ZeroAddress, terms)).toThrow(/sender must not be the zero/);

      const lockId = htlcLockId(sender, terms);
      // The preimage is exactly 32 bytes; nothing is hashed or padded into shape.
      for (const preimage of ["0x" + "44".repeat(31), "0x" + "44".repeat(33), "secret", new Uint8Array(31)]) {
        expect(() => encodeHtlcWithdraw(htlc, lockId, preimage)).toThrow(/preimage must be exactly 32 bytes/);
      }
      expect(() => encodeHtlcWithdraw(htlc, "swap-1", "0x" + "44".repeat(32))).toThrow(
        /lock id must be exactly 32 bytes/
      );
      expect(() => encodeHtlcRefund(htlc, new Uint8Array(33))).toThrow(/lock id must be exactly 32 bytes/);
    });

    it("decodes what locks(lockId) returns, as the compiled contract encodes it", () => {
      const lockId = htlcLockId(sender, terms);
      const encode = (state: number, preimage = ethers.ZeroHash, from = sender) =>
        compiled.encodeFunctionResult("locks", [
          from,
          terms.recipient,
          terms.refundAddress,
          terms.token,
          terms.hashLock,
          terms.amount,
          terms.expiresAt,
          state,
          preimage,
        ]);
      const base = {
        lockId,
        sender,
        recipient: terms.recipient,
        refundAddress: terms.refundAddress,
        token: terms.token,
        amount: terms.amount,
        hashLock: terms.hashLock,
        expiresAt: terms.expiresAt,
      };
      expect(decodeHtlcLock(lockId, encode(1))).toEqual({ ...base, state: "open", preimage: null });
      const preimage = "0x" + "44".repeat(32);
      expect(decodeHtlcLock(lockId, encode(2, preimage))).toEqual({ ...base, state: "withdrawn", preimage });
      expect(decodeHtlcLock(lockId, encode(3))).toEqual({ ...base, state: "refunded", preimage: null });

      const none = compiled.encodeFunctionResult("locks", [
        ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress,
        ethers.ZeroHash, 0n, 0n, 0, ethers.ZeroHash,
      ]);
      expect(decodeHtlcLock(lockId, none)).toBeNull();
      expect(() => decodeHtlcLock(lockId, encode(4))).toThrow(/unknown state 4/);
      // A lock recorded under another sender is not this id: not GenericHTLC v2's answer.
      expect(() =>
        decodeHtlcLock(lockId, encode(1, ethers.ZeroHash, "0x5555555555555555555555555555555555555555"))
      ).toThrow(/does not match its recorded terms/);
    });
  });
  it("builds and decodes Solana generic-htlc instructions and binary state", async () => {
    const sender = new PublicKey(new Uint8Array(32).fill(1));
    const recipient = new PublicKey(new Uint8Array(32).fill(2));
    const lockId = new Uint8Array(32).fill(7);
    const hashLock = new Uint8Array(32).fill(8);
    const preimage = new Uint8Array(32).fill(9);

    // 1. Build Solana Lock
    const lockIx = await buildSolanaSwapLockInstruction({
      sender,
      recipient,
      lockId,
      hashLock,
      amountLamports: 1_000_000_000n,
      durationSeconds: 3600,
    });
    expect(lockIx.programId.toBase58()).toBe(SOLANA_GENERIC_HTLC_PROGRAM_ID);
    expect(lockIx.data[0]).toBe(0); // Lock tag

    // 2. Build Solana Withdraw
    const withdrawIx = await buildSolanaSwapWithdrawInstruction({
      caller: recipient,
      recipient,
      lockId,
      preimage,
    });
    expect(withdrawIx.data[0]).toBe(1); // Withdraw tag

    // 3. Build Solana Refund
    const refundIx = await buildSolanaSwapRefundInstruction({
      caller: sender,
      lockId,
    });
    expect(refundIx.data[0]).toBe(4); // Refund tag

    // 4. Decode binary Solana state
    const rawBuffer = new Uint8Array(180);
    rawBuffer[0] = 1; // is_initialized = true
    rawBuffer.set(lockId, 1);
    rawBuffer.set(sender.toBytes(), 33);
    rawBuffer.set(recipient.toBytes(), 65);
    rawBuffer.set(sender.toBytes(), 97); // refund
    rawBuffer.set(hashLock, 129);

    const view = new DataView(rawBuffer.buffer);
    view.setBigUint64(161, 1_000_000_000n, true); // amount
    view.setBigInt64(169, 1_800_000_000n, true); // expires_at
    rawBuffer[177] = 0; // withdrawn
    rawBuffer[178] = 0; // refunded

    const solanaLock = decodeSolanaHtlcLockState({
      lockId,
      accountData: rawBuffer,
      currentTimestampSec: 1_700_000_000,
    });
    expect(solanaLock).not.toBeNull();
    expect(solanaLock?.status).toBe("locked");
    expect(solanaLock?.amount).toBe(1_000_000_000n);
    expect(solanaLock?.recipient).toBe(recipient.toBase58());
  });

  it("evaluates lifecycle steps across cross-chain legs", () => {
    const mockLegA: SwapLockRecord = {
      lockId: "0x1",
      sender: "0xAlice",
      recipient: "0xBob",
      refundAddress: "0xAlice",
      hashLock: "0xHash",
      amount: 100n,
      expiresAt: 2_000_000_000,
      withdrawn: false,
      refunded: false,
      isExpired: false,
      status: "locked",
    };

    const mockLegB: SwapLockRecord = {
      lockId: "0x1",
      sender: "0xBob",
      recipient: "0xAlice",
      refundAddress: "0xBob",
      hashLock: "0xHash",
      amount: 50n,
      expiresAt: 1_900_000_000,
      withdrawn: false,
      refunded: false,
      isExpired: false,
      status: "locked",
    };

    // Phase 1: Maker needs to lock Leg A
    const p1 = evaluateSwapStepPhase({
      isMaker: true,
      offerStatus: "pending",
      legALock: null,
      legBLock: null,
    });
    expect(p1.phase).toBe("maker_lock_needed");
    expect(p1.canLock).toBe(true);
    expect(p1.canClaim).toBe(false);

    // Phase 2: Maker locked, Taker needs to lock Leg B
    const p2Maker = evaluateSwapStepPhase({
      isMaker: true,
      offerStatus: "accepted",
      legALock: mockLegA,
      legBLock: null,
    });
    expect(p2Maker.phase).toBe("taker_lock_needed");
    expect(p2Maker.canLock).toBe(false);

    const p2Taker = evaluateSwapStepPhase({
      isMaker: false,
      offerStatus: "accepted",
      legALock: mockLegA,
      legBLock: null,
    });
    expect(p2Taker.phase).toBe("taker_lock_needed");
    expect(p2Taker.canLock).toBe(true);

    // Phase 3: Both locked -> Maker claims Leg B
    const p3Maker = evaluateSwapStepPhase({
      isMaker: true,
      offerStatus: "accepted",
      legALock: mockLegA,
      legBLock: mockLegB,
    });
    expect(p3Maker.phase).toBe("ready_to_claim");
    expect(p3Maker.canClaim).toBe(true);

    // Phase 4: Preimage revealed -> Taker claims Leg A
    const p4Taker = evaluateSwapStepPhase({
      isMaker: false,
      offerStatus: "accepted",
      legALock: mockLegA,
      legBLock: { ...mockLegB, status: "withdrawn", withdrawn: true },
    });
    expect(p4Taker.phase).toBe("preimage_revealed");
    expect(p4Taker.canClaim).toBe(true);

    // Phase 5: Both settled
    const p5 = evaluateSwapStepPhase({
      isMaker: true,
      offerStatus: "settled",
      legALock: { ...mockLegA, status: "withdrawn", withdrawn: true },
      legBLock: { ...mockLegB, status: "withdrawn", withdrawn: true },
    });
    expect(p5.phase).toBe("settled");

    // Phase 6: Expired refund
    const p6 = evaluateSwapStepPhase({
      isMaker: true,
      offerStatus: "accepted",
      legALock: { ...mockLegA, status: "expired", isExpired: true },
      legBLock: null,
    });
    expect(p6.phase).toBe("expired_refundable");
    expect(p6.canRefund).toBe(true);
  });
});

describe("evaluateSwapStepPhase: each party's claim and refund", () => {
  const lock = (status: SwapLockStatus | null): SwapLockRecord | null =>
    status === null
      ? null
      : {
          lockId: "0x1",
          sender: "0xSender",
          recipient: "0xRecipient",
          refundAddress: "0xSender",
          hashLock: "0xHash",
          amount: 1n,
          expiresAt: 2_000_000_000,
          withdrawn: status === "withdrawn",
          refunded: status === "refunded",
          isExpired: status === "expired",
          status,
        };
  type Row = [
    who: "maker" | "taker",
    legA: SwapLockStatus | null,
    legB: SwapLockStatus | null,
    offer: "pending" | "accepted" | "settled" | "cancelled" | "expired",
    preimageRevealed: boolean,
    expected: { canClaim: boolean; canRefund: boolean; phase: string }
  ];
  const yes = (phase: string, canClaim: boolean, canRefund: boolean) => ({
    phase,
    canClaim,
    canRefund,
  });

  // Each party's own leg: A for the maker, B for the taker. GenericHTLC lets a lock be
  // withdrawn only while `locked` and refunded only once `expired`.
  const rows: Row[] = [
    // The maker's refund of A, whatever happened to B or the offer.
    [
      "maker",
      "expired",
      null,
      "accepted",
      false,
      yes("expired_refundable", false, true),
    ],
    [
      "maker",
      "expired",
      "unfunded",
      "accepted",
      false,
      yes("expired_refundable", false, true),
    ],
    [
      "maker",
      "expired",
      "refunded",
      "accepted",
      false,
      yes("expired_refundable", false, true),
    ],
    [
      "maker",
      "expired",
      "expired",
      "accepted",
      false,
      yes("expired_refundable", false, true),
    ],
    [
      "maker",
      "expired",
      "withdrawn",
      "accepted",
      false,
      yes("expired_refundable", false, true),
    ],
    [
      "maker",
      "expired",
      null,
      "cancelled",
      false,
      yes("expired_refundable", false, true),
    ],
    [
      "maker",
      "expired",
      "refunded",
      "cancelled",
      false,
      yes("expired_refundable", false, true),
    ],
    [
      "maker",
      "expired",
      null,
      "expired",
      false,
      yes("expired_refundable", false, true),
    ],
    // The maker's claim of B while it is open.
    [
      "maker",
      "locked",
      "locked",
      "accepted",
      false,
      yes("ready_to_claim", true, false),
    ],
    [
      "maker",
      "locked",
      "locked",
      "cancelled",
      false,
      yes("ready_to_claim", true, false),
    ],
    [
      "maker",
      "withdrawn",
      "locked",
      "accepted",
      false,
      yes("ready_to_claim", true, false),
    ],
    // A expired with B still open: the taker can no longer claim A, so taking B as well would
    // take both legs. The maker refunds A.
    [
      "maker",
      "expired",
      "locked",
      "accepted",
      false,
      yes("expired_refundable", false, true),
    ],
    // No claim for the maker of a B it cannot take, or once it took it.
    [
      "maker",
      "locked",
      "expired",
      "accepted",
      false,
      yes("offer_pending", false, false),
    ],
    [
      "maker",
      "locked",
      "withdrawn",
      "accepted",
      false,
      yes("preimage_revealed", false, false),
    ],
    [
      "maker",
      "refunded",
      "locked",
      "accepted",
      false,
      yes("refunded", false, false),
    ],
    [
      "maker",
      null,
      "locked",
      "accepted",
      false,
      yes("maker_lock_needed", false, false),
    ],
    [
      "maker",
      "withdrawn",
      "withdrawn",
      "settled",
      false,
      yes("settled", false, false),
    ],
    [
      "maker",
      "locked",
      null,
      "accepted",
      false,
      yes("taker_lock_needed", false, false),
    ],
    // The taker's refund of B, whatever happened to A or the offer.
    [
      "taker",
      null,
      "expired",
      "accepted",
      false,
      yes("expired_refundable", false, true),
    ],
    [
      "taker",
      "locked",
      "expired",
      "accepted",
      false,
      yes("expired_refundable", false, true),
    ],
    [
      "taker",
      "expired",
      "expired",
      "accepted",
      false,
      yes("expired_refundable", false, true),
    ],
    [
      "taker",
      "refunded",
      "expired",
      "accepted",
      false,
      yes("expired_refundable", false, true),
    ],
    [
      "taker",
      "locked",
      "expired",
      "cancelled",
      false,
      yes("expired_refundable", false, true),
    ],
    // The taker's claim of A once the preimage is known.
    [
      "taker",
      "locked",
      "withdrawn",
      "accepted",
      false,
      yes("preimage_revealed", true, false),
    ],
    [
      "taker",
      "locked",
      "locked",
      "accepted",
      true,
      yes("preimage_revealed", true, false),
    ],
    [
      "taker",
      "locked",
      "withdrawn",
      "cancelled",
      false,
      yes("preimage_revealed", true, false),
    ],
    // Both at once: the preimage is known while B expired.
    [
      "taker",
      "locked",
      "expired",
      "accepted",
      true,
      yes("preimage_revealed", true, true),
    ],
    // No claim without the preimage, or of an A that can no longer be withdrawn.
    [
      "taker",
      "locked",
      "locked",
      "accepted",
      false,
      yes("ready_to_claim", false, false),
    ],
    [
      "taker",
      "expired",
      "withdrawn",
      "accepted",
      false,
      yes("offer_pending", false, false),
    ],
    [
      "taker",
      "refunded",
      "refunded",
      "accepted",
      false,
      yes("refunded", false, false),
    ],
    [
      "taker",
      "locked",
      null,
      "accepted",
      false,
      yes("taker_lock_needed", false, false),
    ],
    [
      "taker",
      "withdrawn",
      "withdrawn",
      "settled",
      false,
      yes("settled", false, false),
    ],
  ];

  it.each(rows)(
    "%s with A %s, B %s, offer %s, preimage revealed %s",
    (who, legA, legB, offerStatus, preimageRevealed, expected) => {
      const result = evaluateSwapStepPhase({
        isMaker: who === "maker",
        offerStatus,
        legALock: lock(legA),
        legBLock: lock(legB),
        preimageRevealed,
      });
      expect({
        phase: result.phase,
        canClaim: result.canClaim,
        canRefund: result.canRefund,
      }).toEqual(expected);
      // The taker claims with the revealed preimage; the maker already holds it.
      expect(result.claimPreimageRequired).toBe(
        result.canClaim && who === "taker"
      );
    }
  );

  it("offers a refund in every state where the party's own lock has expired", () => {
    const statuses: (SwapLockStatus | null)[] = [
      null,
      "unfunded",
      "locked",
      "withdrawn",
      "refunded",
      "expired",
    ];
    const offers = [
      "pending",
      "accepted",
      "settled",
      "cancelled",
      "expired",
    ] as const;
    for (const isMaker of [true, false])
      for (const other of statuses)
        for (const offerStatus of offers)
          for (const preimageRevealed of [false, true]) {
            const result = evaluateSwapStepPhase({
              isMaker,
              offerStatus,
              legALock: lock(isMaker ? "expired" : other),
              legBLock: lock(isMaker ? other : "expired"),
              preimageRevealed,
            });
            expect({
              isMaker,
              other,
              offerStatus,
              canRefund: result.canRefund,
            }).toEqual({
              isMaker,
              other,
              offerStatus,
              canRefund: true,
            });
          }
  });
});
