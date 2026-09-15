import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWake, WAKE_BACKOFF_MS } from "./useWake";

/**
 * THE TWO PROPERTIES THAT MATTER, and they pull in opposite directions:
 *   1. it fires ON MOUNT, so a real visitor is what wakes a sleeping backend — not a cron job,
 *      which would burn the free tier's monthly instance-hours and get the service SUSPENDED;
 *   2. it STOPS once /health answers, because a wake that keeps going is that cron job again,
 *      relocated into the browser.
 *
 * Asserted against the REAL backoff schedule rather than a copy, so shortening the schedule cannot
 * silently make these tests describe something the app no longer does.
 *
 * NO `waitFor` ANYWHERE. Testing Library's `waitFor` polls on real timers; under `vi.useFakeTimers`
 * its clock never advances and every assertion hangs until the test times out — which is how the
 * first version of this file failed. Under fake timers the hook is fully deterministic, so
 * advancing the clock inside `act` and asserting directly is both simpler and stricter.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Advance past attempt `index`'s scheduled delay and flush the promises it awaits. */
async function tick(index: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync((WAKE_BACKOFF_MS[index] ?? 0) + 10);
  });
}

function wake(fetchImpl: ReturnType<typeof vi.fn>) {
  return renderHook(() =>
    useWake({ fetchImpl: fetchImpl as unknown as typeof fetch, baseUrl: "http://api.test" }),
  );
}

describe("useWake — a visitor wakes the backend; nothing on a schedule does", () => {
  it("fires exactly ONE request, to /health, when the backend answers", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const { result } = wake(fetchImpl);

    expect(result.current.status).toBe("waking");
    await tick(0);

    expect(result.current.status).toBe("ready");
    expect(result.current.reachable).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://api.test/health");
  });

  it("STOPS after /health responds — an idle open tab sends nothing further", async () => {
    // This is the entire difference between a wake and a pinger. A schedule that kept firing would
    // generate ~4,300 requests a month per open tab against a free instance-hour budget.
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    wake(fetchImpl);

    await tick(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a cold start, because the FIRST request during one usually fails", async () => {
    // A container that is still booting drops the connection. Giving up on attempt one would report
    // OFFLINE for a service twenty seconds from ready.
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error("ECONNREFUSED");
      return new Response("{}", { status: 200 });
    });
    const { result } = wake(fetchImpl);

    await tick(0);
    expect(result.current.status).toBe("waking");
    await tick(1);
    await tick(2);

    expect(result.current.status).toBe("ready");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("gives up as OFFLINE once the schedule is exhausted, rather than retrying forever", async () => {
    // On a free tier a persistent failure usually means the monthly instance-hour cap was reached,
    // and no amount of retrying fixes that. An honest terminal state beats an eternal spinner.
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const { result } = wake(fetchImpl);

    for (let i = 0; i < WAKE_BACKOFF_MS.length; i++) await tick(i);

    expect(result.current.status).toBe("offline");
    expect(result.current.reachable).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(WAKE_BACKOFF_MS.length);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(WAKE_BACKOFF_MS.length);
  });

  it("treats a non-2xx as REACHABLE — the process is up and routing, which is the question asked", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 }));
    const { result } = wake(fetchImpl);
    await tick(0);
    expect(result.current.status).toBe("ready");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does nothing at all when disabled", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    renderHook(() => useWake({ fetchImpl: fetchImpl as unknown as typeof fetch, enabled: false }));
    for (let i = 0; i < WAKE_BACKOFF_MS.length; i++) await tick(i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("cancels its pending schedule on unmount", async () => {
    // A hook that kept waking after its component left would be a leak with a bill attached.
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const { unmount } = wake(fetchImpl);
    await tick(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 1000);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
