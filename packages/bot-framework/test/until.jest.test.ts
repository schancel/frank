import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { performance } from "perf_hooks";
import { LevelBotStateStore } from "../src/state-store";
import { until } from "./helpers/until";

describe("handler progress wait", () => {
  it("allows delayed native-store progress even when immediate turns run quickly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "frank-until-"));
    const store = await LevelBotStateStore.open(dir);
    // Reproduce an iteration budget outrunning I/O without relying on machine speed.
    // Only the old helper uses immediate; timers and the native store stay real.
    const immediate = jest.spyOn(global, "setImmediate").mockImplementation(
      ((callback: () => void) => {
        queueMicrotask(callback);
        return {} as NodeJS.Immediate;
      }) as typeof setImmediate
    );
    let committed = false;
    const write = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await store.durableBatch([{ type: "put", key: "started", value: "yes" }]);
      committed = true;
    })();
    try {
      await until(() => committed);
      expect(await store.get("started")).toBe("yes");
    } finally {
      immediate.mockRestore();
      await write;
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns immediately when the condition is already true", async () => {
    const timer = jest.spyOn(global, "setTimeout");
    try {
      await until(() => true);
      expect(timer).not.toHaveBeenCalled();
    } finally {
      timer.mockRestore();
    }
  });

  it("rejects a stuck condition at a finite elapsed deadline", async () => {
    const start = performance.now();
    await expect(until(() => false, 25)).rejects.toThrow("condition was never met");
    expect(performance.now() - start).toBeGreaterThanOrEqual(25);
  }, 1000);

  it("propagates predicate errors without treating them as pending", async () => {
    const error = new Error("handler state is unreadable");
    await expect(
      until(() => {
        throw error;
      })
    ).rejects.toBe(error);
  });
});
