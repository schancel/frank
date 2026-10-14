import { performance } from "perf_hooks";

/** Wait for a running handler without treating event-loop turns as an I/O deadline. */
export const until = async (condition: () => boolean, timeoutMs = 2000) => {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() >= deadline)
      throw new Error("condition was never met");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
