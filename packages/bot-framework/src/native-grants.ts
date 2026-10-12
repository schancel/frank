import { getAddress } from "ethers";
import type { NativeWalletHandle } from "@frank/wallet/chain/chain-wallet";
import type { EvmNativeOperation } from "@frank/wallet/storage/evm-native-operation-journal";
import { LevelBotStateStore } from "./state-store";

export interface NativeGrantRequest {
  to: string;
  valueWei: bigint;
  minReserveWei: bigint;
}
export interface NativeGrantResult {
  state: "low" | "pending" | "submitted" | "confirmed" | "failed";
  already: boolean;
  txHash?: string;
}
export interface NativeGrantCapability {
  grant(request: NativeGrantRequest): Promise<NativeGrantResult>;
  resume(): Promise<void>;
}
interface GrantIntent {
  version: 1;
  chainIdentifier: string;
  walletAddress: string;
  recipient: string;
  valueWei: string;
  minReserveWei: string;
  previousOperationIds: string[];
  operationId: string | null;
}

/** Owns once-per-recipient authorization only. The wallet owns every transaction, input claim,
 * signed byte and inclusion observation. This store must be retained with that wallet's state. */
export class NativeGrants implements NativeGrantCapability {
  private readonly active = new Map<string, Promise<NativeGrantResult>>();

  constructor(
    private readonly state: LevelBotStateStore,
    private readonly wallet: NativeWalletHandle
  ) {
    if (
      wallet.family !== "evm" ||
      !wallet.getNativeOperations ||
      !wallet.resumeNativeOperation
    )
      throw new Error(
        "Faucet requires a wallet with durable native operations"
      );
  }

  private rows(): readonly EvmNativeOperation[] {
    return this.wallet.getNativeOperations!();
  }

  private parse(raw: string): GrantIntent {
    let row: GrantIntent;
    try {
      row = JSON.parse(raw) as GrantIntent;
    } catch {
      throw new Error(
        "Invalid faucet grant intent; preserve state for recovery"
      );
    }
    if (
      !row ||
      row.version !== 1 ||
      row.chainIdentifier !== this.wallet.chainIdentifier ||
      row.walletAddress !==
        getAddress(this.wallet.identity.address.raw).toLowerCase() ||
      typeof row.recipient !== "string" ||
      getAddress(row.recipient).toLowerCase() !== row.recipient ||
      typeof row.valueWei !== "string" ||
      !/^[1-9][0-9]*$/.test(row.valueWei) ||
      typeof row.minReserveWei !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(row.minReserveWei) ||
      !Array.isArray(row.previousOperationIds) ||
      row.previousOperationIds.some((id) => typeof id !== "string") ||
      (row.operationId !== null && typeof row.operationId !== "string")
    )
      throw new Error(
        "Invalid or foreign faucet grant intent; preserve state for recovery"
      );
    return row;
  }

  private matches(
    intent: Pick<GrantIntent, "chainIdentifier" | "recipient" | "valueWei">,
    row: EvmNativeOperation
  ): boolean {
    return (
      row.binding.chainIdentifier === intent.chainIdentifier &&
      row.kind === "native" &&
      row.recipient.toLowerCase() === intent.recipient &&
      row.intendedValueWei === intent.valueWei
    );
  }

  private async save(key: string, intent: GrantIntent): Promise<void> {
    await this.state.durableBatch([
      { type: "put", key, value: JSON.stringify(intent) },
    ]);
  }

  grant(request: NativeGrantRequest): Promise<NativeGrantResult> {
    const recipient = getAddress(request.to).toLowerCase();
    request = { ...request, to: recipient };
    if (request.valueWei <= 0n || request.minReserveWei < 0n)
      return Promise.reject(new Error("Invalid faucet amount or reserve"));
    const running = this.active.get(recipient);
    // Still check immutable authorization when two callers use the same recipient at once.
    const run = (
      running ? running.catch(() => undefined) : Promise.resolve()
    ).then(() => this.run(recipient, request));
    this.active.set(recipient, run);
    void run
      .finally(() => {
        if (this.active.get(recipient) === run) this.active.delete(recipient);
      })
      .catch(() => undefined);
    return run;
  }

  private result(row: EvmNativeOperation, already: boolean): NativeGrantResult {
    const member = row.members[row.members.length - 1];
    const txHash = member?.signed?.transactionHash;
    const state =
      row.cancelled ||
      row.members.some((m) => m.observation.state === "included-revert")
        ? "failed"
        : row.members.every((m) => m.observation.state === "included-success")
        ? "confirmed"
        : row.members.every((m) => m.exposed)
        ? "submitted"
        : "pending";
    return { state, already, ...(txHash ? { txHash } : {}) };
  }

  private async run(
    recipient: string,
    request: NativeGrantRequest
  ): Promise<NativeGrantResult> {
    const key = `grant:${recipient}`;
    const raw = await this.state.get(key);
    let intent: GrantIntent;
    const already = raw !== undefined;
    if (raw !== undefined) {
      intent = this.parse(raw);
      if (
        intent.recipient !== recipient ||
        intent.valueWei !== request.valueWei.toString() ||
        intent.minReserveWei !== request.minReserveWei.toString()
      )
        throw new Error(
          "Faucet grant authorization changed; original intent retained"
        );
    } else {
      // This preserves the existing reserve policy. It is NOT a fee ceiling: deployment with
      // funded grants remains gated on wallet enforcement of reserve plus maximum fees.
      if (
        (await this.wallet.getBalance()) <
        request.valueWei + request.minReserveWei
      )
        return { state: "low", already: false };
      intent = {
        version: 1,
        chainIdentifier: this.wallet.chainIdentifier,
        walletAddress: getAddress(
          this.wallet.identity.address.raw
        ).toLowerCase(),
        recipient,
        valueWei: request.valueWei.toString(),
        minReserveWei: request.minReserveWei.toString(),
        previousOperationIds: this.rows()
          .filter((row) =>
            this.matches(
              {
                chainIdentifier: this.wallet.chainIdentifier,
                recipient,
                valueWei: request.valueWei.toString(),
              },
              row
            )
          )
          .map((row) => row.operationId),
        operationId: null,
      };
      await this.save(key, intent);
    }

    // The wallet may have signed just before a crash, before our callback could bind its ID.
    // Never assume an absent business binding means nothing was constructed or submitted.
    let operation =
      intent.operationId === null
        ? undefined
        : this.rows().find((row) => row.operationId === intent.operationId);
    if (intent.operationId !== null && !operation)
      throw new Error(
        "Faucet wallet operation missing; preserve state for recovery"
      );
    if (intent.operationId === null) {
      const candidates = this.rows().filter(
        (row) =>
          !intent.previousOperationIds.includes(row.operationId) &&
          this.matches(intent, row)
      );
      if (candidates.length > 1)
        throw new Error(
          "Ambiguous faucet wallet operations; preserve state for recovery"
        );
      operation = candidates[0];
      if (operation) {
        intent.operationId = operation.operationId;
        await this.save(key, intent);
      }
    }
    if (operation && !this.matches(intent, operation))
      throw new Error(
        "Faucet wallet operation does not match its authorization"
      );
    if (
      operation &&
      (operation.cancelled ||
        operation.members.some(
          (m) => m.observation.state === "included-revert"
        ) ||
        operation.members.every(
          (m) => m.observation.state === "included-success"
        ))
    )
      return this.result(operation, already);

    let bindingPersisted = intent.operationId !== null;
    try {
      if (operation) {
        await this.wallet.resumeNativeOperation!(operation.operationId);
      } else {
        await this.wallet.sendNative({
          recipient: { raw: recipient },
          value: request.valueWei,
          onSigned: async (signed) => {
            const candidates = this.rows().filter(
              (row) =>
                !intent.previousOperationIds.includes(row.operationId) &&
                this.matches(intent, row) &&
                row.members[row.members.length - 1]?.signed?.transactionHash ===
                  signed.txHash
            );
            if (candidates.length !== 1)
              throw new Error(
                "Faucet signed operation cannot be uniquely bound"
              );
            intent.operationId = candidates[0]!.operationId;
            await this.save(key, intent); // Awaited by the wallet BEFORE external exposure.
            bindingPersisted = true;
          },
        });
      }
    } catch (error) {
      // Unknown submission is still the ORIGINAL operation. Persist failures stay visible;
      // a later invocation adopts/resumes that row without signing a replacement payment.
      if (!bindingPersisted || intent.operationId === null) throw error;
      const current = this.rows().find(
        (row) => row.operationId === intent.operationId
      );
      if (!current || !this.matches(intent, current)) throw error;
      const result = this.result(current, already);
      return result.state === "failed"
        ? result
        : { ...result, state: "pending" };
    }
    const current = this.rows().find(
      (row) => row.operationId === intent.operationId
    );
    if (!current || !this.matches(intent, current))
      throw new Error("Faucet wallet operation disappeared after submission");
    return this.result(current, already);
  }

  async resume(): Promise<void> {
    const entries = await this.state.readEntries("grant:", 2049);
    if (entries.length > 2048)
      throw new Error("Faucet recovery scan capacity exceeded");
    const failures: unknown[] = [];
    for (const [key, raw] of entries) {
      try {
        const intent = this.parse(raw);
        if (key !== `grant:${intent.recipient}`)
          throw new Error("Faucet grant key mismatch");
        await this.grant({
          to: intent.recipient,
          valueWei: BigInt(intent.valueWei),
          minReserveWei: BigInt(intent.minReserveWei),
        });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Some faucet grants could not be recovered"
      );
  }
}
