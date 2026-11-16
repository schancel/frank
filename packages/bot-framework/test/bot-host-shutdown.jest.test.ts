import { FrankBotHost } from "../src/bot-host";
import * as identity from "@frank/wallet/evm-identity";
import { admitBotProfile } from "../src/bot-profile-admission";
import { DirectoryManager } from "../src/directory-manager";
import { startBotNegotiationRecovery } from "../src/negotiation-recovery";
import type { FrankBotDefinition } from "../src/types";

jest.mock("@frank/wallet/evm-identity", () => ({
  ...jest.requireActual("@frank/wallet/evm-identity"),
  fetchMonadProfilesSince: jest.fn(),
  decodeProfileBytes: jest.fn(),
}));
jest.mock("../src/bot-profile-admission", () => ({ admitBotProfile: jest.fn() }));
jest.mock("../src/directory-manager", () => ({ DirectoryManager: { create: jest.fn() } }));
jest.mock("../src/relay-profile-manager", () => ({
  RelayProfileManager: { registerProfile: jest.fn(async () => undefined) },
}));
jest.mock("../src/negotiation-recovery", () => ({ startBotNegotiationRecovery: jest.fn() }));
jest.mock("@frank/wallet/bip32-domain-root", () => ({
  bip32MasterFromDomainRoot: () => ({
    derivePath: () => ({ privateKey: new Uint8Array(32) }),
  }),
}));
jest.mock("@frank/wallet/chain/evm-chain", () => ({
  ...jest.requireActual("@frank/wallet/chain/evm-chain"),
  installCanonicalDirectory: () => jest.fn(),
}));
jest.mock("@frank/wallet/chain/canonical-dm", () => ({
  ...jest.requireActual("@frank/wallet/chain/canonical-dm"),
  installMessageItemRegistry: () => jest.fn(),
}));

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

// Exercise public shutdown with synthetic owned resources. No custody, stores, providers,
// timers or services are opened; registration and financial behavior are outside this test.
function fixture() {
  const bot = () => ({
    negotiation: { stop: jest.fn<unknown, []>(() => undefined) },
    operations: { close: jest.fn<unknown, []>(() => undefined) },
    definition: { onStop: jest.fn<unknown, [unknown]>(() => undefined) },
    context: {},
    uninstallDirectory: jest.fn<unknown, []>(() => undefined),
    directory: { close: jest.fn<unknown, []>(() => undefined) },
    state: { close: jest.fn<unknown, []>(() => undefined) },
    wallet: { close: jest.fn<unknown, []>(() => undefined) },
    tasks: new Set<Promise<unknown>>(),
    pollWaiters: new Set<() => void>(),
    polling: undefined as Promise<unknown> | undefined,
    mailboxRead: undefined as Promise<unknown> | undefined,
  });
  const first = bot();
  const second = bot();
  const instances = new Map([["first", first], ["second", second]]);
  const scheduler = { stop: jest.fn<unknown, []>(() => undefined) };
  const host: FrankBotHost = Object.assign(Object.create(FrankBotHost.prototype), {
    running: true,
    closing: false,
    stopController: new AbortController(),
    scheduler,
    instances,
    registrations: new Set<Promise<void>>(),
  });
  const closes = (instance: typeof first) => [
    instance.negotiation.stop, instance.operations.close, instance.definition.onStop,
    instance.uninstallDirectory, instance.directory.close, instance.state.close,
    instance.wallet.close,
  ];
  return { host, scheduler, instances, first, second, closes };
}

it("reports early synchronous and late asynchronous teardown failures after every resource is attempted", async () => {
  const { host, scheduler, first, second, instances, closes } = fixture();
  const early = new Error("scheduler teardown failed");
  const late = new Error("wallet store close failed");
  const entered = deferred();
  const gate = deferred();
  scheduler.stop.mockImplementation(() => { throw early; });
  first.wallet.close.mockImplementation(() => Promise.reject(late));
  second.state.close.mockImplementation(() => {
    entered.resolve();
    return gate.promise;
  });
  const request = host.waitUntilStopped();
  let finished = false;
  const stopping = host.stop();
  const outcome = stopping.catch(error => {
    finished = true;
    return error as AggregateError;
  });
  expect(host.stop()).toBe(stopping);
  await request; // Request notification still precedes teardown completion.
  await entered.promise;
  expect(finished).toBe(false);
  gate.resolve();
  const failure = await outcome;
  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError)) throw new Error("Expected teardown failure");
  expect(failure.errors.map((error: Error) => error.cause)).toEqual([early, late]);
  expect(failure.errors.map((error: Error) => error.message)).toEqual([
    expect.stringContaining("scheduler.stop"), expect.stringContaining("first: wallet.close"),
  ]);
  expect(instances.size).toBe(0);
  for (const close of [...closes(first), ...closes(second), scheduler.stop])
    expect(close).toHaveBeenCalledTimes(1);
  expect(host.stop()).toBe(stopping);
  await expect(host.stop()).rejects.toBe(failure);
});

it.each([
  "negotiation", "operations", "onStop", "uninstallDirectory", "directory", "state", "wallet",
] as const)("a synchronous %s failure does not skip later hooks or sibling cleanup", async stage => {
  const { host, first, second, closes } = fixture();
  const failure = new Error(`${stage} failed`);
  const action = stage === "onStop" ? first.definition.onStop
    : stage === "uninstallDirectory" ? first.uninstallDirectory
    : stage === "negotiation" ? first.negotiation.stop : first[stage].close;
  action.mockImplementation(() => { throw failure; });
  const result = await host.stop().catch(error => error as AggregateError);
  expect(result).toBeInstanceOf(AggregateError);
  if (!(result instanceof AggregateError)) throw new Error("Expected teardown failure");
  expect(result.errors.map((error: Error) => error.cause)).toEqual([failure]);
  for (const close of [...closes(first), ...closes(second)])
    expect(close).toHaveBeenCalledTimes(1);
});

it("drains existing polls and tasks before closing without relabeling their failures as teardown errors", async () => {
  const { host, first, closes } = fixture();
  const poll = deferred();
  const task = deferred();
  const interrupted = new Error("ordinary request aborted");
  interrupted.name = "AbortError";
  first.polling = poll.promise.then(() => { throw interrupted; });
  // The normal owners already observe these ordinary errors; stop only drains them.
  void first.polling.catch(() => undefined);
  first.mailboxRead = Promise.reject(new Error("ordinary network failure"));
  void first.mailboxRead.catch(() => undefined);
  const work = task.promise.then(() => { throw new Error("ordinary message failure"); });
  first.tasks.add(work);
  void work.then(() => first.tasks.delete(work), () => first.tasks.delete(work));
  const drained = deferred();
  first.negotiation.stop.mockImplementation(() => { drained.resolve(); });
  const stopping = host.stop();
  await drained.promise;
  for (const close of closes(first).slice(1)) expect(close).not.toHaveBeenCalled();
  poll.resolve();
  await first.polling.catch(() => undefined);
  for (const close of closes(first).slice(1)) expect(close).not.toHaveBeenCalled();
  task.resolve();
  await expect(stopping).resolves.toBeUndefined();
  for (const close of closes(first)) expect(close).toHaveBeenCalledTimes(1);
  await expect(host.stop()).resolves.toBeUndefined();
  for (const close of closes(first)) expect(close).toHaveBeenCalledTimes(1);
});

it("stopping a host without resources remains a successful no-op", async () => {
  const { host, scheduler, instances } = fixture();
  instances.clear();
  Object.assign(host, { running: false });
  await expect(host.stop()).resolves.toBeUndefined();
  expect(scheduler.stop).not.toHaveBeenCalled();
});

it("the shipped host signal listener reports teardown failure after cleanup and exits unsuccessfully", async () => {
  const { host, scheduler, first, second } = fixture();
  const gate = deferred();
  const entered = deferred();
  first.wallet.close.mockImplementation(() => Promise.reject(new Error("store close failed")));
  second.wallet.close.mockImplementation(() => { entered.resolve(); return gate.promise; });
  Object.assign(host, {
    running: false,
    options: { watchRegistrations: false, unrefTimers: true, pollIntervalMs: 1000 },
  });
  Object.assign(scheduler, { start: jest.fn() });
  jest.useFakeTimers();
  const once = jest.spyOn(process, "once").mockImplementation(() => process);
  const exit = jest.spyOn(process, "exit").mockImplementation(() => undefined as never);
  const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
  const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await host.start();
    const listener = once.mock.calls.find(([event]) => event === "SIGTERM")?.[1];
    if (!listener) throw new Error("Missing shutdown listener");
    const stopped = listener();
    await entered.promise;
    expect(exit).not.toHaveBeenCalled();
    gate.resolve();
    await stopped;
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Shutdown failed"), expect.any(AggregateError));
    expect(exit.mock.calls).toEqual([[1]]);
  } finally {
    gate.resolve();
    await host.stop().catch(() => undefined);
    once.mockRestore();
    exit.mockRestore();
    log.mockRestore();
    error.mockRestore();
    jest.useRealTimers();
  }
});


// These cases run the real host lifecycle with synthetic dependencies only. Profile decoding
// is stubbed at its authenticated-result seam; no custody, physical store or RPC is opened.
describe("registration work belongs to public host shutdown", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(process, "once").mockImplementation(() => process);
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.mocked(identity.fetchMonadProfilesSince).mockReset();
    jest.mocked(identity.decodeProfileBytes).mockReturnValue({ timestampMs: 10 } as ReturnType<typeof identity.decodeProfileBytes>);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  function registrationFixture() {
    const f = fixture();
    Object.assign(f.host, {
      running: false,
      registrationListeners: new Set(),
      lastRegistrationPollMs: 0,
      options: {
        watchRegistrations: true, unrefTimers: true, pollIntervalMs: 1000,
        relayBaseUrl: "https://inert.example", networkTag: "MONT",
        createMessageItemRegistry: () => ({}),
      },
      saveRegistrationCursor: jest.fn(),
      pollAllBots: jest.fn(async () => undefined),
    });
    Object.assign(f.scheduler, { start: jest.fn() });
    return f;
  }

  it.each(["fetch", "state", "delay", "callback", "callback failure", "listener"] as const)(
    "drains an admitted registration held at %s before closing resources",
    async stage => {
      const { host, first, closes } = registrationFixture();
      const entered = deferred();
      const gate = deferred();
      const callback = jest.fn(async () => {
        expect(first.state.close).not.toHaveBeenCalled();
        if (stage === "callback" || stage === "callback failure") {
          entered.resolve(); await gate.promise;
          if (stage === "callback failure") throw new Error("ordinary greeting failure");
        }
      });
      const listener = jest.fn(async () => {
        expect(first.state.close).not.toHaveBeenCalled();
        if (stage === "listener") { entered.resolve(); await gate.promise; }
      });
      Object.assign(first.definition, { id: "greeting", onNewUser: callback });
      Object.assign(first, { loopGuard: { shouldDrop: () => false } });
      const get = jest.fn(async () => {
        expect(first.state.close).not.toHaveBeenCalled();
        if (stage === "state") { entered.resolve(); await gate.promise; }
        return undefined;
      });
      const put = jest.fn(async () => {
        expect(first.state.close).not.toHaveBeenCalled();
        if (stage === "delay") entered.resolve();
      });
      const del = jest.fn(async () => {
        expect(first.state.close).not.toHaveBeenCalled();
      });
      Object.assign(first.state, { get, put, del });
      Object.assign(host, { registrationListeners: new Set([listener]) });
      jest.mocked(identity.fetchMonadProfilesSince).mockImplementation(async () => {
        if (stage === "fetch") { entered.resolve(); await gate.promise; }
        return [{ address: "synthetic-user", rawBytes: new Uint8Array() }] as Awaited<ReturnType<typeof identity.fetchMonadProfilesSince>>;
      });
      try {
        await host.start();
        // Move the synthetic greeting delay only when it is not the checkpoint under test.
        if (stage === "callback" || stage === "callback failure" || stage === "listener")
          await jest.advanceTimersByTimeAsync(5000);
        await entered.promise;
        await jest.advanceTimersByTimeAsync(0);
        let stopped = false;
        const stopping = host.stop().then(() => { stopped = true; });
        await jest.advanceTimersByTimeAsync(0);
        expect(stopped).toBe(false);
        for (const close of closes(first).slice(1)) expect(close).not.toHaveBeenCalled();
        gate.resolve();
        await jest.advanceTimersByTimeAsync(5000);
        await stopping;
        expect(callback).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(get).toHaveBeenCalledTimes(1);
        expect(put).toHaveBeenCalledTimes(1);
        expect(del).toHaveBeenCalledTimes(stage === "callback failure" ? 1 : 0);
        for (const close of closes(first)) expect(close).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(10000);
        expect(identity.fetchMonadProfilesSince).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledTimes(1);
      } finally {
        gate.resolve();
        await jest.advanceTimersByTimeAsync(5000);
        await host.stop();
      }
    }
  );

  it("joins overlapping registration ticks and fences a queued tick after closing", async () => {
    const { host, first } = registrationFixture();
    Object.assign(first.definition, { onNewUser: jest.fn() });
    const gate = deferred();
    jest.mocked(identity.fetchMonadProfilesSince).mockImplementation(async () => {
      await gate.promise;
      return [];
    });
    // Capture the existing timer callback so a tick already queued before clearInterval can
    // be delivered after closing without invoking a private poll method in the assertion.
    const interval = jest.spyOn(global, "setInterval");
    try {
      await host.start();
      await jest.advanceTimersByTimeAsync(15000);
      expect(identity.fetchMonadProfilesSince).toHaveBeenCalledTimes(1);
      const tick = interval.mock.calls.find(([, ms]) => ms === 5000)?.[0];
      if (typeof tick !== "function") throw new Error("Missing registration timer");
      const stopping = host.stop();
      tick();
      expect(identity.fetchMonadProfilesSince).toHaveBeenCalledTimes(1);
      gate.resolve();
      await stopping;
      tick();
      expect(identity.fetchMonadProfilesSince).toHaveBeenCalledTimes(1);
    } finally {
      gate.resolve();
      await host.stop();
    }
  });

  it.each([
    { stage: "before attachment", fails: false },
    { stage: "onStart", fails: false },
    { stage: "onStart", fails: true },
  ])(
    "drains register held at $stage (startup failure=$fails) before closing and rejects late registration",
    async ({ stage, fails }) => {
      const { host, first, instances } = registrationFixture();
      instances.clear();
      const entered = deferred();
      const gate = deferred();
      const address = "0x1111111111111111111111111111111111111111";
      const compressedPubKey = new Uint8Array([1]);
      const state = {
        get: jest.fn(async () => undefined), sublevel: jest.fn(() => ({})),
        close: jest.fn(async () => undefined),
      };
      const operations = {
        owner: { address, subject: "01", chainIdentifier: "monad-testnet" },
        close: jest.fn(async () => undefined),
      };
      const wallet = {
        identity: { address: { raw: address }, compressedPubKey },
        close: jest.fn(async () => undefined),
      };
      const directory = {
        network: "monad-testnet", rawDirectory: {},
        publishWithRetry: jest.fn(async () => undefined), startHeartbeat: jest.fn(),
        close: jest.fn(async () => undefined),
      };
      jest.mocked(admitBotProfile).mockImplementation(async () => {
        if (stage === "before attachment") { entered.resolve(); await gate.promise; }
        return { botStateDir: "inert", state, operations, roots: {} } as unknown as Awaited<ReturnType<typeof admitBotProfile>>;
      });
      jest.mocked(DirectoryManager.create).mockReturnValue(directory as unknown as ReturnType<typeof DirectoryManager.create>);
      jest.mocked(startBotNegotiationRecovery).mockReturnValue(first.negotiation as unknown as ReturnType<typeof startBotNegotiationRecovery>);
      Object.assign(host, {
        chain: {
          chainIdentifier: "monad-testnet", unit: "TEST", toDisplayAmount: String,
          fromDisplayAmount: BigInt, createWallet: jest.fn(async () => wallet),
        },
        fundBot: jest.fn(async () => undefined),
      });
      const startupFailure = new Error("ordinary startup failure");
      const definition: FrankBotDefinition = {
        id: "registered", getProfile: () => ({ name: "Synthetic", bot: true }),
        onMessage: async () => undefined,
        onStart: async () => {
          expect(state.close).not.toHaveBeenCalled();
          if (stage === "onStart") { entered.resolve(); await gate.promise; }
          expect(wallet.close).not.toHaveBeenCalled();
          if (fails) throw startupFailure;
        },
      };
      const registration = host.register(definition);
      const outcome = registration.then(() => undefined, error => error);
      try {
        await entered.promise;
        let stopped = false;
        const stopping = host.stop().then(() => { stopped = true; });
        await jest.advanceTimersByTimeAsync(0);
        expect(stopped).toBe(false);
        expect(state.close).not.toHaveBeenCalled();
        expect(wallet.close).not.toHaveBeenCalled();
        await expect(host.register({ ...definition, id: "late" })).rejects.toThrow("closed");
        gate.resolve();
        expect(await outcome).toBe(fails ? startupFailure : undefined);
        await expect(stopping).resolves.toBeUndefined();
        expect(instances.size).toBe(0);
        for (const close of [operations.close, directory.close, state.close, wallet.close])
          expect(close).toHaveBeenCalledTimes(1);
      } finally {
        gate.resolve();
        await registration.catch(() => undefined);
        await host.stop();
      }
    }
  );
});
