import net from 'node:net';

/**
 * Is anything listening on the server's address right now?
 *
 * ## Why this exists and why it is not `ensureConnection`
 *
 * Two different problems fail the same way from inside this server: the sync
 * state is broken, or the Actual desktop app is closed so its server on port
 * 5007 is not running. `repair_sync` is the reflex for both and can only fix
 * the first (#89).
 *
 * The obvious check is to call `ensureConnection` again and see. It does not
 * work, twice over. It returns early once connected — `if (initialized) return`
 * — so after a successful start it never touches the network again, which is
 * exactly the case that matters: the app was open, you used it, then you quit
 * it. And when it does run, an out-of-sync budget makes it throw too, so its
 * failure does not separate the two causes anyway.
 *
 * So this asks the only question that distinguishes them, and asks it of the
 * network rather than of any cached state: is there something on that port.
 *
 * ## Why a socket rather than an HTTP request
 *
 * "Is anyone there" is a connection question, and a connection answers it
 * without needing a route that exists, a status code worth interpreting, or a
 * body. A 404 and a 500 both mean something is listening, which is all this
 * needs to know; deciding whether the answer was a *good* one is the repair's
 * job, and it will report its own failure.
 *
 * ## The timeout is the point, not a detail
 *
 * A server that accepts a connection and never answers is a different failure
 * from one that is absent (#99), and a probe with no deadline does not separate
 * those either: it waits as long as the hung server does. The default is three
 * seconds, which is long for a machine talking to itself or to its own network
 * — where an Actual server lives — and short enough that a person gets an
 * answer rather than a pause.
 */
/**
 * The host and port to knock on, or nothing if the URL is not one.
 *
 * Separate so it can be checked without a socket. `new URL('http://x').port` is
 * the empty string and `Number('')` is 0, so without the protocol fallback
 * every URL written without a port would be probed on port 0 and reported
 * missing.
 */
export function probeTarget(serverURL: string): { host: string; port: number } | null {
  let target: URL;
  try {
    target = new URL(serverURL);
  } catch {
    return null;
  }
  return {
    host: target.hostname,
    port: Number(target.port) || (target.protocol === 'https:' ? 443 : 80),
  };
}

/**
 * Three answers, because a boolean had to carry two different meanings.
 *
 * It returned `true` both for "something is listening" and for "this is not an
 * address I can knock on", and the caller could only act on one of them. An
 * audit found what that costs: `http://127.0.0.1:99999` is rejected by
 * `new URL` for the port being out of range, so the probe said `true` and a
 * repair ran against a URL nothing could ever connect to — a state change made
 * on a guess, which is the thing the check was added to stop.
 *
 * A malformed URL still must not be reported as unreachable. It is a
 * configuration problem and deserves its own sentence, not the one about
 * opening the desktop app.
 */
export type ServerProbe = 'answering' | 'not-answering' | 'unusable-url';

export async function probeServer(
  serverURL: string,
  timeoutMs = 3000,
): Promise<ServerProbe> {
  const target = probeTarget(serverURL);
  if (!target) return 'unusable-url';

  const { host, port } = target;

  return await new Promise<ServerProbe>((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (result: ServerProbe) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish('answering'));
    socket.once('timeout', () => finish('not-answering'));
    socket.once('error', () => finish('not-answering'));
    socket.connect(port, host);
  });
}
