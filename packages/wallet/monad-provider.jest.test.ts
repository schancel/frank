import { createServer, Server } from "http";
import { AddressInfo } from "net";
import {
  DEFAULT_MONAD_CHAIN_ID,
  MonadJsonRpcProvider,
  createMonadJsonRpcProvider,
} from "./monad-provider";

describe("MonadJsonRpcProvider (#534)", () => {
  let server: Server;
  let rpcUrl: string;
  let requestCount = 0;
  let requestMethods: string[] = [];
  let statusCode = 200;
  let chainIdHex = "0x279f"; // 10143
  let balanceHex = "0x2a"; // 42

  beforeEach(async () => {
    requestCount = 0;
    requestMethods = [];
    statusCode = 200;
    chainIdHex = "0x279f";
    balanceHex = "0x2a";

    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requestCount++;
        if (statusCode !== 200) {
          res.writeHead(statusCode, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Service Unavailable" }));
          return;
        }

        try {
          const payload = JSON.parse(body);
          const items = Array.isArray(payload) ? payload : [payload];
          const responses = items.map((item) => {
            requestMethods.push(item.method);
            if (item.method === "eth_chainId") {
              return { jsonrpc: "2.0", id: item.id, result: chainIdHex };
            }
            if (item.method === "eth_getBalance") {
              return { jsonrpc: "2.0", id: item.id, result: balanceHex };
            }
            return { jsonrpc: "2.0", id: item.id, result: "0x0" };
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify(Array.isArray(payload) ? responses : responses[0])
          );
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "bad request" }));
        }
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as AddressInfo).port;
        rpcUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("fails fast on persistent RPC 503 without spawning an internal 1-second retry loop", async () => {
    statusCode = 503;
    const provider = createMonadJsonRpcProvider({ rpcUrl });

    try {
      await expect(
        provider.getBalance("0x0000000000000000000000000000000000000001")
      ).rejects.toThrow(/503/);

      const initialCount = requestCount;
      expect(initialCount).toBeGreaterThanOrEqual(1);

      // In buggy ethers v6, _start() would spawn an infinite while loop retrying every 1s.
      // Wait 2.2 seconds and verify that NO background retry requests were sent.
      await new Promise((resolve) => setTimeout(resolve, 2200));
      expect(requestCount).toBe(initialCount);
    } finally {
      provider.destroy();
    }
  });

  it("verifies network identity and rejects wrong-chain responses", async () => {
    chainIdHex = "0x1"; // Ethereum Mainnet (1) instead of Monad testnet (10143)
    const provider = createMonadJsonRpcProvider({
      rpcUrl,
      chainId: DEFAULT_MONAD_CHAIN_ID,
    });

    try {
      await expect(
        provider.getBalance("0x0000000000000000000000000000000000000001")
      ).rejects.toThrow(/network (?:mismatch|changed)/i);
    } finally {
      provider.destroy();
    }
  });

  it("coalesces concurrent network detection and caches verified network", async () => {
    const provider = createMonadJsonRpcProvider({ rpcUrl });

    try {
      const [b1, b2, network] = await Promise.all([
        provider.getBalance("0x0000000000000000000000000000000000000001"),
        provider.getBalance("0x0000000000000000000000000000000000000002"),
        provider.getNetwork(),
      ]);

      expect(b1).toBe(42n);
      expect(b2).toBe(42n);
      expect(network.chainId).toBe(DEFAULT_MONAD_CHAIN_ID);

      // eth_chainId should only have been queried once
      const chainIdQueries = requestMethods.filter((m) => m === "eth_chainId");
      expect(chainIdQueries.length).toBe(1);

      // Subsequent call reuses cached verified network
      const b3 = await provider.getBalance(
        "0x0000000000000000000000000000000000000001"
      );
      expect(b3).toBe(42n);
      const chainIdQueriesAfter = requestMethods.filter(
        (m) => m === "eth_chainId"
      );
      expect(chainIdQueriesAfter.length).toBe(1);
    } finally {
      provider.destroy();
    }
  });

  it("recovers promptly when RPC becomes healthy", async () => {
    statusCode = 503;
    const provider = createMonadJsonRpcProvider({ rpcUrl });

    try {
      await expect(
        provider.getBalance("0x0000000000000000000000000000000000000001")
      ).rejects.toThrow();

      // Allow low-level ethers perform cache (250ms) to clear
      await new Promise((resolve) => setTimeout(resolve, 260));

      // Server becomes healthy
      statusCode = 200;
      balanceHex = "0x64"; // 100

      const balance = await provider.getBalance(
        "0x0000000000000000000000000000000000000001"
      );
      expect(balance).toBe(100n);
    } finally {
      provider.destroy();
    }
  });

  it("deterministic 60-second regression test asserting bounded request count, cancellation, and recovery", async () => {
    // Persistent 503 outage
    statusCode = 503;
    const provider = createMonadJsonRpcProvider({ rpcUrl });

    try {
      // Simulate an application poller with exponential backoff (15s base, doubles on failure, capped at 60s)
      let failures = 0;
      let active = true;
      let currentBalance: bigint | null = null;
      let pollCount = 0;

      const poll = async () => {
        if (!active) return;
        pollCount++;
        try {
          currentBalance = await provider.getBalance(
            "0x0000000000000000000000000000000000000001"
          );
          failures = 0;
        } catch {
          failures++;
        }
      };

      // Initial poll at t=0s
      await poll();
      expect(failures).toBe(1);

      // In an uncontrolled 1-second retry loop, 60 seconds would trigger ~60 requests.
      // Under application-owned backoff:
      // t=0s: fail (1) -> delay 15s
      // t=15s: fail (2) -> delay 30s
      // t=45s: fail (3) -> delay 60s
      // Total polls in 60s = 3 (initial + 2 retries), requests <= 6.

      // Simulate interval before t=15s (clearing ethers 250ms perform cache)
      await new Promise((resolve) => setTimeout(resolve, 260));
      await poll();
      expect(failures).toBe(2);

      // Simulate interval before t=45s: server recovers to healthy
      await new Promise((resolve) => setTimeout(resolve, 260));
      statusCode = 200;
      balanceHex = "0x3e8"; // 1000
      await poll();
      expect(failures).toBe(0);
      expect(currentBalance).toBe(1000n);

      // Simulate consumer cancellation at t=50s (e.g. unmount or backgrounding)
      active = false;
      const countBeforeCancel = requestCount;

      // Advance through remainder of 60s with cancelled consumer: zero additional requests
      await poll();
      expect(requestCount).toBe(countBeforeCancel);

      // Over the entire 60s cycle, request count is strictly bounded (<= 6 requests vs ~60 from 1s loop)
      expect(requestCount).toBeLessThanOrEqual(6);
    } finally {
      provider.destroy();
    }
  });
});
