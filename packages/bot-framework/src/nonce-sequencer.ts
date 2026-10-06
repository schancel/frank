import type { JsonRpcProvider, Wallet } from "ethers";

/**
 * Thread-safe serial execution of EVM transactions from a shared funding wallet.
 * Ensures nonces are monotonic, un-collided, and self-recovering upon broadcast errors.
 */
export class EVMNonceSequencer {
  private queue: Promise<unknown> = Promise.resolve();
  private nextNonce: number | undefined;
  private readonly provider: JsonRpcProvider;
  private readonly address: string;

  constructor(provider: JsonRpcProvider, address: string) {
    this.provider = provider;
    this.address = address;
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async withNonce<T>(task: (nonce: number) => Promise<T>): Promise<T> {
    return this.runExclusive(async () => {
      if (this.nextNonce === undefined) {
        this.nextNonce = await this.provider.getTransactionCount(
          this.address,
          "pending"
        );
      }
      const assignedNonce = this.nextNonce;
      try {
        const result = await task(assignedNonce);
        this.nextNonce = assignedNonce + 1;
        return result;
      } catch (error) {
        // If an error occurs (such as nonce already used or rejected), invalidate cached nonce
        // so subsequent attempts re-query the provider's authoritative count.
        this.nextNonce = undefined;
        throw error;
      }
    });
  }

  resetNonce(): void {
    this.nextNonce = undefined;
  }
}
