/**
 * A queue that runs work one at a time, in call order, within this process.
 *
 * Added for #121, where two budget deltas racing each other each read before
 * either wrote and the second overwrote the first: two of +1,000.00 against an
 * empty category left 1,000.00. Anything that reads, decides, and then writes
 * has that shape.
 *
 * What keeps the queue moving after a failure is the `catch`: what is stored is
 * always a promise that settled successfully, so the next piece of work runs
 * even if the last one threw. It also stops a rejection sitting on a promise
 * nobody awaits, which surfaces as an unhandled rejection — something this
 * server installs a process guard for (#39). The caller still gets its own
 * error, from the promise it is handed.
 *
 * Each caller makes its own queue. Sharing one would serialise operations that
 * do not compete for anything, which is slower for no reason; what they need is
 * to not race *themselves*.
 *
 * Between processes this does nothing, and cannot: that is #111.
 */
export function makeQueue(): <T>(work: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();

  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work);
    tail = next.catch(() => undefined);
    return next;
  };
}
