/**
 * The rule a daemon started by the screen ends on (030): nothing needs it once a client has
 * been and gone and no run is left. `q` with nothing running therefore takes the daemon with
 * the screen, and `q` with runs in flight leaves them to finish.
 *
 * **A daemon no client has reached yet is needed**, whatever else is true of it. The screen
 * starts one and *then* waits for it to answer, so a client is always on its way; without this
 * term a run the daemon took from the queue and finished in those first milliseconds would read
 * as "nothing needs me" and the screen would find its own daemon gone.
 *
 * Here rather than inside `main.ts` because `main.ts` is an entry file that no test can import.
 * The counts it is given are `main.ts`'s own, and what it does with them is observed through a
 * spawned daemon in `server/process.test.ts`.
 */
export function nothingNeedsTheDaemon(counts: {
  /** Clients connected right now. */
  clients: number;
  /** Clients that have connected since this daemon started; zero means none ever has. */
  clientsEver: number;
  /** Runs in flight right now. */
  runs: number;
}): boolean {
  return counts.clientsEver > 0 && counts.clients === 0 && counts.runs === 0;
}
