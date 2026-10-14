import { LevelBotStateStore } from "../src/state-store";

export function checkpoint(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Events may arrive before the test starts waiting; every next() consumes one actual event. */
export function eventQueue(): {
  publish: () => void;
  next: () => Promise<void>;
} {
  let queued = 0;
  const waiters: Array<() => void> = [];
  return {
    publish() {
      const waiter = waiters.shift();
      if (waiter) waiter();
      else queued++;
    },
    next() {
      if (queued) {
        queued--;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
  };
}

/** Hold publication of one real sync journal write's completion, without replacing its I/O. */
export function holdStartedCompletion(): {
  entered: Promise<void>;
  release: () => void;
  restore: () => void;
} {
  const entered = checkpoint();
  const released = checkpoint();
  let selected = false;
  const original = LevelBotStateStore.prototype.durableBatch;
  const observer = jest
    .spyOn(LevelBotStateStore.prototype, "durableBatch")
    .mockImplementation(async function (this: LevelBotStateStore, operations) {
      await original.call(this, operations);
      if (
        !selected &&
        operations.some((operation) => {
          if (operation.type !== "put") return false;
          try {
            return (
              (JSON.parse(operation.value) as { phase?: unknown }).phase ===
              "started"
            );
          } catch {
            return false;
          }
        })
      ) {
        selected = true;
        entered.resolve();
        await released.promise;
      }
    });
  return {
    entered: entered.promise,
    release: released.resolve,
    restore() {
      released.resolve();
      observer.mockRestore();
    },
  };
}
