import { FrankBotHost } from "../src/bot-host";

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
