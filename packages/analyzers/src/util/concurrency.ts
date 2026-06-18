/**
 * Minimal bounded-concurrency limiter (a tiny p-limit equivalent — no dependency). Returns
 * a function that schedules async tasks so at most `concurrency` run at once; excess tasks
 * queue and start as slots free. Used to bound the per-file parse loop (Guard 2) so a huge
 * repo can't spawn thousands of concurrent reads/parses.
 */
export function createLimiter(concurrency: number): <T>(task: () => Promise<T>) => Promise<T> {
  const limit = Math.max(1, Math.floor(concurrency));
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (active >= limit || queue.length === 0) return;
    active++;
    const run = queue.shift()!;
    run();
  };

  return function schedule<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        task().then(
          (value) => {
            active--;
            next();
            resolve(value);
          },
          (error) => {
            active--;
            next();
            reject(error);
          },
        );
      };
      queue.push(run);
      next();
    });
  };
}

/**
 * Race a promise against a timeout. Resolves `{ timedOut: false, value }` if `work` settles
 * first, or `{ timedOut: true }` after `ms`. The timer is always cleared. NOTE: this bounds
 * ASYNC stalls (a slow read / async parse step); a CPU-bound synchronous hang (e.g.
 * catastrophic regex backtracking) cannot be preempted on a single thread — worker-thread
 * isolation is the P7 escalation for that. `ms <= 0` disables the timeout.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  if (ms <= 0) return { timedOut: false, value: await work };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    return await Promise.race([work.then((value) => ({ timedOut: false as const, value })), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
