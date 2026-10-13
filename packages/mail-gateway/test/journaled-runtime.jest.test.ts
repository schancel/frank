import { JournaledMailRuntime } from '../src/host/journaled-runtime';
import type { JournaledInboundSend } from '../src/relay/journaled-inbound-send';
import type { JournaledFrankMailbox } from '../src/relay/journaled-frank-mailbox';
import type { JournaledOutboundWorker } from '../src/mta/journaled-outbound-worker';
import type { ResendOutboundReconciler } from '../src/mta/resend-outbound-reconciler';

describe('journaled mail host recovery', () => {
  it('keeps later independent delivery work moving after one wallet item fails and pages its scan', async () => {
    const releaseHeld = jest.fn(async () => ({ released: 0, errors: [], nextAfter: undefined }));
    const recover = jest.fn(async (_limit: number, after: number) => ({
      attempted: 1, delivered: 0, pending: 0, held: 0,
      errors: after === 0 ? [{ slotId: 1, kind: 'RetryableError' }] : [],
      nextAfterSlotId: after === 0 ? 1 : 0,
    }));
    const pollOnce = jest.fn(async () => ({ processed: 1, cursorMs: 1000 }));
    const dispatchDue = jest.fn(async () => ({ sent: 1, uncertain: 0 }));
    const reconcile = jest.fn(async () => ({ confirmed: 0, unresolved: 0, pages: 0 }));
    const runtime = new JournaledMailRuntime({
      inbound: { releaseHeld, recover } as unknown as JournaledInboundSend,
      frankMailbox: { pollOnce } as unknown as JournaledFrankMailbox,
      outbound: { dispatchDue } as unknown as JournaledOutboundWorker,
      outboundReconciler: { reconcile } as unknown as ResendOutboundReconciler,
      now: () => 1000,
    });

    await expect(runtime.runOnce()).rejects.toThrow('Frank send recovery items: 1');
    expect(pollOnce).toHaveBeenCalledTimes(1);
    expect(dispatchDue).toHaveBeenCalledWith(1000, 100);
    await runtime.runOnce();
    expect(recover).toHaveBeenNthCalledWith(2, 100, 1);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('continues SMTP and provider reconciliation after a mailbox fetch fails', async () => {
    const dispatchDue = jest.fn(async () => ({ sent: 1, uncertain: 0 }));
    const reconcile = jest.fn(async () => ({ confirmed: 0, unresolved: 0, pages: 0 }));
    const runtime = new JournaledMailRuntime({
      inbound: {
        releaseHeld: async () => ({ released: 0, errors: [], nextAfter: undefined }),
        recover: async () => ({ attempted: 0, delivered: 0, pending: 0, held: 0, errors: [], nextAfterSlotId: 0 }),
      } as unknown as JournaledInboundSend,
      frankMailbox: { pollOnce: async () => { throw new Error('relay unavailable'); } } as unknown as JournaledFrankMailbox,
      outbound: { dispatchDue } as unknown as JournaledOutboundWorker,
      outboundReconciler: { reconcile } as unknown as ResendOutboundReconciler,
    });
    await expect(runtime.runOnce()).rejects.toThrow('Frank mailbox: relay unavailable');
    expect(dispatchDue).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});
