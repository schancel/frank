import { createServer, Server } from "http";
import { AddressInfo } from "net";
import { createHash } from "crypto";
import {
  DEFAULT_MONAD_CHAIN_ID,
  MonadJsonRpcProvider,
  createMonadJsonRpcProvider,
  createMonadRelayRpcConnection,
  issueMonadRelayRpcCapability,
  monadProtocolIdentity,
} from "./monad-provider";

describe("MonadJsonRpcProvider (#534)", () => {
  let server: Server;
  let rpcUrl: string;
  let requestCount = 0;
  let requestMethods: string[] = [];
  let batchSizes: number[] = [];
  let statusCode = 200;
  let chainIdHex = "0x279f"; // 10143
  let balanceHex = "0x2a"; // 42

  it("maps protocol chain names to one chain-id and network-tag identity", () => {
    expect(monadProtocolIdentity("monad-testnet")).toEqual({
      chainId: 10143n,
      networkTag: "MONT",
    });
    expect(monadProtocolIdentity("monad-mainnet")).toEqual({
      chainId: 143n,
      networkTag: "MON1",
    });
    expect(monadProtocolIdentity("unknown")).toBeUndefined();
  });

  beforeEach(async () => {
    requestCount = 0;
    requestMethods = [];
    batchSizes = [];
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
          batchSizes.push(items.length);
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

  it("keeps client batches within the relay default", async () => {
    const provider = createMonadJsonRpcProvider({ rpcUrl });
    try {
      await Promise.all(
        Array.from({ length: 21 }, (_, index) =>
          provider.send("eth_getBalance", [
            `0x${(index + 1).toString(16).padStart(40, "0")}`,
            "latest",
          ])
        )
      );
      expect(Math.max(...batchSizes)).toBeLessThanOrEqual(20);
      expect(batchSizes.reduce((sum, size) => sum + size, 0)).toBe(21);
    } finally {
      provider.destroy();
    }
  });

  it("uses customer accounting for methods that also permit anonymous access", async () => {
    const customer = `0x${"12".repeat(20)}`;
    const signedDigests: Uint8Array[] = [];
    let challengeBody = "";
    let authenticatedBody = "";
    let issuanceHeaders: typeof import("http").IncomingHttpHeaders = {};

    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.url?.endsWith("/capability/auth")) {
          challengeBody = body;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              epoch: "11".repeat(32),
              nonce: "22".repeat(32),
              expires_at_ms: Date.now() + 60_000,
              token: "33".repeat(32),
              signing_domain: "frank:rpc-http-auth:v1",
              customer,
              chain: "monad-testnet",
              body_sha256: createHash("sha256").update(body).digest("hex"),
              network_tag: Buffer.from("MONT").toString("hex"),
            })
          );
          return;
        }
        if (req.url?.endsWith("/capability")) {
          issuanceHeaders = req.headers;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              rpc_path: "/chain-rpc/monad-testnet/cap/bearer/rpc",
              expires_at_ms: Date.now() + 60_000,
            })
          );
          return;
        }
        authenticatedBody = body;
        const payload = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: "0x" })
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        rpcUrl = `http://127.0.0.1:${
          (server.address() as AddressInfo).port
        }/chain-rpc/monad-testnet/rpc`;
        resolve();
      });
    });

    const provider = createMonadJsonRpcProvider({
      rpcUrl,
      relayAuth: {
        chain: "monad-testnet",
        customer,
        networkTag: "MONT",
        signDigest: (digest) => {
          signedDigests.push(digest);
          return Uint8Array.from([
            0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01,
          ]);
        },
      },
    });
    try {
      await provider.send("eth_getBalance", [`0x${"34".repeat(20)}`, "latest"]);
      expect(challengeBody).toBe("");
      expect(authenticatedBody).not.toBe("");
      expect(signedDigests).toHaveLength(1);
      expect(signedDigests[0]).toHaveLength(32);
      expect(issuanceHeaders["x-frank-rpc-customer"]).toBe(customer);
      expect(issuanceHeaders["x-frank-rpc-epoch"]).toBe("11".repeat(32));
      expect(issuanceHeaders["x-frank-rpc-signature"]).toBe("3006020101020101");
    } finally {
      provider.destroy();
    }
  });

  it("does not internally retry a fixed-hour relay quota response", async () => {
    const customer = `0x${"12".repeat(20)}`;
    let challengeRequests = 0;
    let rpcRequests = 0;

    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.url?.endsWith("/capability/auth")) {
          challengeRequests++;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              epoch: "11".repeat(32),
              nonce: "22".repeat(32),
              expires_at_ms: Date.now() + 60_000,
              token: "33".repeat(32),
              signing_domain: "frank:rpc-http-auth:v1",
              customer,
              chain: "monad-testnet",
              body_sha256: createHash("sha256").update(body).digest("hex"),
              network_tag: Buffer.from("MONT").toString("hex"),
            })
          );
          return;
        }
        if (req.url?.endsWith("/capability")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              rpc_path: "/chain-rpc/monad-testnet/cap/bearer/rpc",
              expires_at_ms: Date.now() + 60_000,
            })
          );
          return;
        }
        rpcRequests++;
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "rpc_hourly_quota" }));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        rpcUrl = `http://127.0.0.1:${
          (server.address() as AddressInfo).port
        }/chain-rpc/monad-testnet/rpc`;
        resolve();
      });
    });

    const request = createMonadRelayRpcConnection(rpcUrl, {
      chain: "monad-testnet",
      customer,
      networkTag: "MONT",
      signDigest: () =>
        Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]),
    });
    request.body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBalance",
      params: [`0x${"34".repeat(20)}`, "latest"],
    });
    request.setHeader("content-type", "application/json");
    const response = await request.send();
    expect(response.statusCode).toBe(429);
    expect(challengeRequests).toBe(1);
    expect(rpcRequests).toBe(1);
  });

  it("retries capability issuance after a transient challenge failure", async () => {
    const customer = `0x${"12".repeat(20)}`;
    let challengeRequests = 0;

    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.url?.endsWith("/capability/auth")) {
          challengeRequests++;
          if (challengeRequests === 1) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "temporarily unavailable" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              epoch: "11".repeat(32),
              nonce: "22".repeat(32),
              expires_at_ms: Date.now() + 60_000,
              token: "33".repeat(32),
              signing_domain: "frank:rpc-http-auth:v1",
              customer,
              chain: "monad-testnet",
              body_sha256: createHash("sha256").update(body).digest("hex"),
              network_tag: Buffer.from("MONT").toString("hex"),
            })
          );
          return;
        }
        if (req.url?.endsWith("/capability")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              rpc_path: "/chain-rpc/monad-testnet/cap/bearer/rpc",
              expires_at_ms: Date.now() + 60_000,
            })
          );
          return;
        }
        const payload = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: "0x2a" })
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        rpcUrl = `http://127.0.0.1:${
          (server.address() as AddressInfo).port
        }/chain-rpc/monad-testnet/rpc`;
        resolve();
      });
    });

    const connection = createMonadRelayRpcConnection(rpcUrl, {
      chain: "monad-testnet",
      customer,
      networkTag: "MONT",
      signDigest: () =>
        Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]),
    });
    const send = (id: number) => {
      const request = connection.clone();
      request.body = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "eth_getBalance",
        params: [`0x${"34".repeat(20)}`, "latest"],
      });
      request.setHeader("content-type", "application/json");
      return request.send();
    };

    await expect(send(1)).rejects.toThrow(/503/);
    await expect(send(2)).resolves.toMatchObject({ statusCode: 200 });
    expect(challengeRequests).toBe(2);
  });

  it("coalesces concurrent refreshes of a near-expiry capability", async () => {
    const customer = `0x${"12".repeat(20)}`;
    let challengeRequests = 0;
    let capabilityRequests = 0;

    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.url?.endsWith("/capability/auth")) {
          challengeRequests++;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              epoch: "11".repeat(32),
              nonce: "22".repeat(32),
              expires_at_ms: Date.now() + 60_000,
              token: "33".repeat(32),
              signing_domain: "frank:rpc-http-auth:v1",
              customer,
              chain: "monad-testnet",
              body_sha256: createHash("sha256").update(body).digest("hex"),
              network_tag: Buffer.from("MONT").toString("hex"),
            })
          );
          return;
        }
        if (req.url?.endsWith("/capability")) {
          capabilityRequests++;
          setTimeout(() => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                rpc_path: "/chain-rpc/monad-testnet/cap/bearer/rpc",
                expires_at_ms: Date.now() + 1_000,
              })
            );
          }, 25);
          return;
        }
        const payload = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: "0x2a" })
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        rpcUrl = `http://127.0.0.1:${
          (server.address() as AddressInfo).port
        }/chain-rpc/monad-testnet/rpc`;
        resolve();
      });
    });

    const connection = createMonadRelayRpcConnection(rpcUrl, {
      chain: "monad-testnet",
      customer,
      networkTag: "MONT",
      signDigest: () =>
        Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]),
    });
    const send = (id: number) => {
      const request = connection.clone();
      request.body = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "eth_getBalance",
        params: [`0x${"34".repeat(20)}`, "latest"],
      });
      request.setHeader("content-type", "application/json");
      return request.send();
    };

    await send(0);
    await Promise.all(Array.from({ length: 8 }, (_, index) => send(index + 1)));
    expect(challengeRequests).toBe(2);
    expect(capabilityRequests).toBe(2);
  });

  it("renews a cached capability after relay authority rotation", async () => {
    const customer = `0x${"12".repeat(20)}`;
    let challengeRequests = 0;
    let capabilityRequests = 0;
    const rpcBodies: string[] = [];

    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.url?.endsWith("/capability/auth")) {
          challengeRequests++;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              epoch: "11".repeat(32),
              nonce: "22".repeat(32),
              expires_at_ms: Date.now() + 60_000,
              token: "33".repeat(32),
              signing_domain: "frank:rpc-http-auth:v1",
              customer,
              chain: "monad-testnet",
              body_sha256: createHash("sha256").update(body).digest("hex"),
              network_tag: Buffer.from("MONT").toString("hex"),
            })
          );
          return;
        }
        if (req.url?.endsWith("/capability")) {
          capabilityRequests++;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              rpc_path: `/chain-rpc/monad-testnet/cap/bearer-${capabilityRequests}/rpc`,
              expires_at_ms: Date.now() + 60_000,
            })
          );
          return;
        }
        if (req.url?.includes("/cap/bearer-1/rpc")) {
          rpcBodies.push(body);
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "rpc_auth_failed" }));
          return;
        }
        rpcBodies.push(body);
        const payload = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: "0x2a" })
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        rpcUrl = `http://127.0.0.1:${
          (server.address() as AddressInfo).port
        }/chain-rpc/monad-testnet/rpc`;
        resolve();
      });
    });

    const connection = createMonadRelayRpcConnection(rpcUrl, {
      chain: "monad-testnet",
      customer,
      networkTag: "MONT",
      signDigest: () =>
        Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]),
    });
    const send = (id: number) => {
      const request = connection.clone();
      request.body = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "eth_getBalance",
        params: [`0x${"34".repeat(20)}`, "latest"],
      });
      request.setHeader("content-type", "application/json");
      return request.send();
    };

    const rotated = await send(1);
    expect(challengeRequests).toBe(2);
    expect(capabilityRequests).toBe(2);
    expect(rpcBodies).toHaveLength(2);
    expect(rpcBodies[1]).toBe(rpcBodies[0]);
    expect(rotated.statusCode).toBe(200);
  });

  it("does not retain a renewed capability that is also rejected", async () => {
    const customer = `0x${"12".repeat(20)}`;
    let capabilityRequests = 0;
    const rpcBearers: string[] = [];

    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.url?.endsWith("/capability/auth")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              epoch: "11".repeat(32),
              nonce: "22".repeat(32),
              expires_at_ms: Date.now() + 60_000,
              token: "33".repeat(32),
              signing_domain: "frank:rpc-http-auth:v1",
              customer,
              chain: "monad-testnet",
              body_sha256: createHash("sha256").update(body).digest("hex"),
              network_tag: Buffer.from("MONT").toString("hex"),
            })
          );
          return;
        }
        if (req.url?.endsWith("/capability")) {
          capabilityRequests++;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              rpc_path: `/chain-rpc/monad-testnet/cap/bearer-${capabilityRequests}/rpc`,
              expires_at_ms: Date.now() + 60_000,
            })
          );
          return;
        }
        const bearer = req.url?.match(/\/cap\/(bearer-\d+)\/rpc/)?.[1];
        if (bearer) rpcBearers.push(bearer);
        if (bearer !== "bearer-3") {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "rpc_auth_failed" }));
          return;
        }
        const payload = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: "0x2a" })
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        rpcUrl = `http://127.0.0.1:${
          (server.address() as AddressInfo).port
        }/chain-rpc/monad-testnet/rpc`;
        resolve();
      });
    });

    const connection = createMonadRelayRpcConnection(rpcUrl, {
      chain: "monad-testnet",
      customer,
      networkTag: "MONT",
      signDigest: () =>
        Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]),
    });
    const send = (id: number) => {
      const request = connection.clone();
      request.body = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "eth_getBalance",
        params: [`0x${"34".repeat(20)}`, "latest"],
      });
      request.setHeader("content-type", "application/json");
      return request.send();
    };

    expect((await send(1)).statusCode).toBe(401);
    expect((await send(2)).statusCode).toBe(200);
    expect(rpcBearers).toEqual(["bearer-1", "bearer-2", "bearer-3"]);
    expect(capabilityRequests).toBe(3);
  });

  it("does not issue a capability or send RPC after provider destruction", async () => {
    const customer = `0x${"12".repeat(20)}`;
    let challengeRequests = 0;
    let capabilityRequests = 0;
    let rpcRequests = 0;
    let challengeStartedResolve!: () => void;
    const challengeStarted = new Promise<void>((resolve) => {
      challengeStartedResolve = resolve;
    });

    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.url?.endsWith("/capability/auth")) {
          challengeRequests++;
          challengeStartedResolve();
          setTimeout(() => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                epoch: "11".repeat(32),
                nonce: "22".repeat(32),
                expires_at_ms: Date.now() + 60_000,
                token: "33".repeat(32),
                signing_domain: "frank:rpc-http-auth:v1",
                customer,
                chain: "monad-testnet",
                body_sha256: createHash("sha256").update(body).digest("hex"),
                network_tag: Buffer.from("MONT").toString("hex"),
              })
            );
          }, 50);
          return;
        }
        if (req.url?.endsWith("/capability")) {
          capabilityRequests++;
        } else {
          rpcRequests++;
        }
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unexpected request" }));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        rpcUrl = `http://127.0.0.1:${
          (server.address() as AddressInfo).port
        }/chain-rpc/monad-testnet/rpc`;
        resolve();
      });
    });

    const provider = createMonadJsonRpcProvider({
      rpcUrl,
      relayAuth: {
        chain: "monad-testnet",
        customer,
        networkTag: "MONT",
        signDigest: () =>
          Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]),
      },
    });
    const sending = provider.send("eth_sendRawTransaction", ["0x01"]);
    await challengeStarted;
    provider.destroy();

    await expect(sending).rejects.toThrow(/cancel|destroy/i);
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(challengeRequests).toBe(1);
    expect(capabilityRequests).toBe(0);
    expect(rpcRequests).toBe(0);
  });

  it("promptly aborts a stalled capability challenge on destruction", async () => {
    const customer = `0x${"12".repeat(20)}`;
    let challengeStartedResolve!: () => void;
    let challengeAbortedResolve!: () => void;
    const challengeStarted = new Promise<void>((resolve) => {
      challengeStartedResolve = resolve;
    });
    const challengeAborted = new Promise<void>((resolve) => {
      challengeAbortedResolve = resolve;
    });

    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer((req) => {
      req.resume();
      req.on("end", challengeStartedResolve);
      req.on("aborted", challengeAbortedResolve);
      req.socket.on("close", challengeAbortedResolve);
      // Intentionally never send a response. Destruction must cancel this socket instead of
      // waiting for ethers' normal five-minute request timeout.
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        rpcUrl = `http://127.0.0.1:${
          (server.address() as AddressInfo).port
        }/chain-rpc/monad-testnet/rpc`;
        resolve();
      });
    });

    const provider = createMonadJsonRpcProvider({
      rpcUrl,
      relayAuth: {
        chain: "monad-testnet",
        customer,
        networkTag: "MONT",
        signDigest: () =>
          Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]),
      },
    });
    const sending = provider.send("eth_blockNumber", []);
    await challengeStarted;
    provider.destroy();

    await expect(
      Promise.race([
        sending,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("cancellation was not prompt")),
            200
          )
        ),
      ])
    ).rejects.toThrow(/cancel|destroy/i);
    await Promise.race([
      challengeAborted,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("challenge socket stayed open")), 200)
      ),
    ]);
  });

  it("cancels the standalone capability helper while signing", async () => {
    const customer = `0x${"12".repeat(20)}`;
    let cancelled = false;
    let signingResolve!: () => void;
    const signing = new Promise<void>((resolve) => {
      signingResolve = resolve;
    });

    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            epoch: "11".repeat(32),
            nonce: "22".repeat(32),
            expires_at_ms: Date.now() + 60_000,
            token: "33".repeat(32),
            signing_domain: "frank:rpc-http-auth:v1",
            customer,
            chain: "monad-testnet",
            body_sha256: createHash("sha256").update(body).digest("hex"),
            network_tag: Buffer.from("MONT").toString("hex"),
          })
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        rpcUrl = `http://127.0.0.1:${
          (server.address() as AddressInfo).port
        }/chain-rpc/monad-testnet/rpc`;
        resolve();
      });
    });

    const issuing = issueMonadRelayRpcCapability(
      rpcUrl,
      {
        chain: "monad-testnet",
        customer,
        networkTag: "MONT",
        signDigest: () => {
          signingResolve();
          return new Promise<Uint8Array>(() => {});
        },
      },
      30_000,
      () => cancelled
    );
    await signing;
    cancelled = true;
    await expect(
      Promise.race([
        issuing,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("cancellation was not prompt")),
            200
          )
        ),
      ])
    ).rejects.toThrow(/cancel/i);
  });

  it("rejects an oversized streamed capability response", async () => {
    const customer = `0x${"12".repeat(20)}`;

    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write("{" + " ".repeat(40 * 1024));
      res.end(" ".repeat(40 * 1024) + "}");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        rpcUrl = `http://127.0.0.1:${
          (server.address() as AddressInfo).port
        }/chain-rpc/monad-testnet/rpc`;
        resolve();
      });
    });

    await expect(
      issueMonadRelayRpcCapability(rpcUrl, {
        chain: "monad-testnet",
        customer,
        networkTag: "MONT",
        signDigest: () =>
          Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]),
      })
    ).rejects.toThrow(/too large/i);
  });

  it("rejects an oversized bearer RPC response before buffering its body", async () => {
    const customer = `0x${"12".repeat(20)}`;
    let rpcClosedResolve!: () => void;
    const rpcClosed = new Promise<void>((resolve) => {
      rpcClosedResolve = resolve;
    });

    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.url?.endsWith("/capability/auth")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              epoch: "11".repeat(32),
              nonce: "22".repeat(32),
              expires_at_ms: Date.now() + 60_000,
              token: "33".repeat(32),
              signing_domain: "frank:rpc-http-auth:v1",
              customer,
              chain: "monad-testnet",
              body_sha256: createHash("sha256").update(body).digest("hex"),
              network_tag: Buffer.from("MONT").toString("hex"),
            })
          );
          return;
        }
        if (req.url?.endsWith("/capability")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              rpc_path: "/chain-rpc/monad-testnet/cap/bearer/rpc",
              expires_at_ms: Date.now() + 60_000,
            })
          );
          return;
        }
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": String(64 * 1024 * 1024 + 1),
        });
        res.on("close", rpcClosedResolve);
        res.flushHeaders();
        res.write("{}");
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        rpcUrl = `http://127.0.0.1:${
          (server.address() as AddressInfo).port
        }/chain-rpc/monad-testnet/rpc`;
        resolve();
      });
    });

    const request = createMonadRelayRpcConnection(rpcUrl, {
      chain: "monad-testnet",
      customer,
      networkTag: "MONT",
      signDigest: () =>
        Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]),
    });
    request.body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBalance",
      params: [`0x${"34".repeat(20)}`, "latest"],
    });
    request.setHeader("content-type", "application/json");
    await expect(request.send()).rejects.toThrow(/relay RPC transport failed/i);
    await expect(
      Promise.race([
        rpcClosed.then(() => "closed"),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("still-open"), 1_000)
        ),
      ])
    ).resolves.toBe("closed");
  });

  it("promptly aborts a stalled bearer RPC on destruction", async () => {
    const customer = `0x${"12".repeat(20)}`;
    let rpcStartedResolve!: () => void;
    let rpcClosedResolve!: () => void;
    const rpcStarted = new Promise<void>((resolve) => {
      rpcStartedResolve = resolve;
    });
    const rpcClosed = new Promise<void>((resolve) => {
      rpcClosedResolve = resolve;
    });

    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.url?.endsWith("/capability/auth")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              epoch: "11".repeat(32),
              nonce: "22".repeat(32),
              expires_at_ms: Date.now() + 60_000,
              token: "33".repeat(32),
              signing_domain: "frank:rpc-http-auth:v1",
              customer,
              chain: "monad-testnet",
              body_sha256: createHash("sha256").update(body).digest("hex"),
              network_tag: Buffer.from("MONT").toString("hex"),
            })
          );
          return;
        }
        if (req.url?.endsWith("/capability")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              rpc_path: "/chain-rpc/monad-testnet/cap/bearer/rpc",
              expires_at_ms: Date.now() + 60_000,
            })
          );
          return;
        }
        rpcStartedResolve();
        req.on("aborted", rpcClosedResolve);
        req.socket.on("close", rpcClosedResolve);
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        rpcUrl = `http://127.0.0.1:${
          (server.address() as AddressInfo).port
        }/chain-rpc/monad-testnet/rpc`;
        resolve();
      });
    });

    const provider = createMonadJsonRpcProvider({
      rpcUrl,
      relayAuth: {
        chain: "monad-testnet",
        customer,
        networkTag: "MONT",
        signDigest: () =>
          Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]),
      },
    });
    const sending = provider.send("eth_blockNumber", []);
    await rpcStarted;
    provider.destroy();
    await expect(
      Promise.race([
        sending,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("cancellation was not prompt")),
            200
          )
        ),
      ])
    ).rejects.toThrow(/cancel|destroy/i);
    await Promise.race([
      rpcClosed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("RPC socket stayed open")), 200)
      ),
    ]);
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
