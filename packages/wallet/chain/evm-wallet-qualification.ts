import type { EvmChainConfig } from "./evm-chain-config";
import {
  verifyEvmWalletRpcIdentity,
  type EvmIdentityRpc,
} from "./evm-rpc-identity";

/** One owner, one physical qualification. Expiry ends waits, not transport ownership. */
export class EvmWalletQualification {
  private closed = false;
  private pending?: { result: Promise<void>; revoke: () => void };

  constructor(
    private readonly config: EvmChainConfig,
    private readonly provider: EvmIdentityRpc,
    private readonly waitMs: number
  ) {}

  qualify(): Promise<void> {
    if (this.closed)
      return Promise.reject(new Error("EVM identity owner is closed"));
    if (this.pending) return this.pending.result;
    let active = true;
    const deadline = Date.now() + this.waitMs;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const refuse = (message: string) => {
      active = false;
      reject(new Error(message));
    };
    const timer = setTimeout(
      () => refuse("EVM identity qualification timed out"),
      this.waitMs
    );
    const pending = {
      result,
      revoke: () => {
        clearTimeout(timer);
        refuse("EVM identity owner is closed");
      },
    };
    this.pending = pending;
    const requireCurrent = () => {
      if (this.closed || !active)
        throw new Error("EVM identity qualification is no longer current");
      if (Date.now() >= deadline) {
        refuse("EVM identity qualification timed out");
        throw new Error("EVM identity qualification timed out");
      }
    };
    // Retain the physical operation after a logical timeout. Its lifecycle guard prevents
    // another RPC step, while later callers receive the same refusal until it settles.
    void verifyEvmWalletRpcIdentity(
      this.config,
      this.provider,
      this.config.operatorCheckpoint,
      requireCurrent
    )
      .then(
        () => {
          if (this.pending === pending) this.pending = undefined;
          if (active) resolve();
        },
        (error) => {
          if (this.pending === pending) this.pending = undefined;
          if (active) reject(error);
        }
      )
      .finally(() => {
        active = false;
        clearTimeout(timer);
        if (this.pending === pending) this.pending = undefined;
      });
    return result;
  }

  close(): void {
    this.closed = true;
    this.pending?.revoke();
  }
}
