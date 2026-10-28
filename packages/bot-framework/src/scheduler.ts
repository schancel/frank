import type {
  BotContext,
  BotScheduleDefinition,
} from "./types";

interface RegisteredSchedule {
  botId: string;
  definition: BotScheduleDefinition;
  context: BotContext;
}

/**
 * Checks whether a single cron field expression matches a numeric value.
 * Supports: '*', number, comma-separated '1,2', range '1-5', step '*\/5' or '1-10/2'.
 */
export function matchCronField(field: string, value: number): boolean {
  if (field === "*") return true;

  const parts = field.split(",");
  for (const part of parts) {
    if (part.includes("/")) {
      const [rangePart, stepPart] = part.split("/");
      const step = parseInt(stepPart, 10);
      if (isNaN(step) || step <= 0) continue;

      if (rangePart === "*") {
        if (value % step === 0) return true;
      } else if (rangePart.includes("-")) {
        const [startStr, endStr] = rangePart.split("-");
        const start = parseInt(startStr, 10);
        const end = parseInt(endStr, 10);
        if (value >= start && value <= end && (value - start) % step === 0) {
          return true;
        }
      }
    } else if (part.includes("-")) {
      const [startStr, endStr] = part.split("-");
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (value >= start && value <= end) return true;
    } else {
      const exact = parseInt(part, 10);
      if (exact === value) return true;
    }
  }

  return false;
}

/**
 * Parses a standard 5-part cron expression: minute hour day-of-month month day-of-week
 */
export function isCronDue(cronExpr: string, date: Date): boolean {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const [minExpr, hourExpr, domExpr, monthExpr, dowExpr] = parts;

  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const dom = date.getUTCDate();
  const month = date.getUTCMonth() + 1; // 1-12
  const dow = date.getUTCDay(); // 0-6 (Sun-Sat)

  return (
    matchCronField(minExpr, minute) &&
    matchCronField(hourExpr, hour) &&
    matchCronField(domExpr, dom) &&
    matchCronField(monthExpr, month) &&
    matchCronField(dowExpr, dow)
  );
}

export class BotScheduler {
  private readonly schedules: RegisteredSchedule[] = [];
  private timer?: NodeJS.Timeout;
  /** The check in progress, if any: `stop` waits for it. */
  private checking?: Promise<number>;
  private stopped = false;

  register(
    botId: string,
    definition: BotScheduleDefinition,
    context: BotContext
  ): void {
    this.schedules.push({ botId, definition, context });
  }

  getRegisteredCount(): number {
    return this.schedules.length;
  }

  start(checkIntervalMs = 5000): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      // A check that fails (its state store unreadable) is reported, never left unhandled: the
      // next tick checks again.
      this.checkAndRunDue().catch((err) =>
        console.error("[bot-scheduler] Scheduled events could not be checked:", err)
      );
    }, checkIntervalMs);
    this.timer.unref();
  }

  /**
   * Stops the schedule: no check starts after this, a check in progress runs no further event,
   * and the returned promise resolves once that check (and the event it is running) is done. So
   * the caller may close the bots' state stores once it resolves: nothing reads them after.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.checking?.catch(() => undefined);
  }

  checkAndRunDue(nowMs = Date.now()): Promise<number> {
    if (this.stopped || this.checking) return Promise.resolve(0);
    const check = this.runDue(nowMs).finally(() => {
      this.checking = undefined;
    });
    this.checking = check;
    return check;
  }

  private async runDue(nowMs: number): Promise<number> {
    let executedCount = 0;
    const date = new Date(nowMs);

    for (const item of this.schedules) {
      if (this.stopped) break;
      const { botId, definition, context } = item;
      const key = `schedule:last_run:${definition.id}`;
      const lastRunRaw = await context.state.get(key);
      const lastRunMs = lastRunRaw ? parseInt(lastRunRaw, 10) : 0;

      let isDue = false;

      if (definition.intervalMs !== undefined && definition.intervalMs > 0) {
        if (lastRunMs === 0) {
          // First time seeing this schedule
          if (definition.runOnStartup) {
            isDue = true;
          } else {
            // Start countdown from now
            await context.state.put(key, String(nowMs));
          }
        } else if (nowMs - lastRunMs >= definition.intervalMs) {
          isDue = true;
        }
      } else if (definition.cron) {
        // Cron: must match expression and have not run in the same UTC minute
        const hasRunThisMinute =
          lastRunMs > 0 && Math.floor(nowMs / 60000) === Math.floor(lastRunMs / 60000);

        if (!hasRunThisMinute && isCronDue(definition.cron, date)) {
          isDue = true;
        }
      }

      if (isDue && !this.stopped) {
        executedCount++;
        // Persist timestamp before handler execution to prevent duplicate triggers on crash
        await context.state.put(key, String(nowMs));

        try {
          console.log(
            `[bot-scheduler] Running scheduled event "${definition.id}" for bot "${botId}"`
          );
          await definition.handler(context);
        } catch (err) {
          console.error(
            `[bot-scheduler] Error in scheduled event "${definition.id}" for bot "${botId}":`,
            err
          );
        }
      }
    }

    return executedCount;
  }
}
