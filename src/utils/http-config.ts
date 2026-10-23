import { readEnv } from './env.js';
import { isReadOnly } from './mode.js';
import { MIN_TOKEN_LENGTH } from './http-auth.js';

/**
 * What an HTTP server needs before it will start (#228).
 *
 * stdio stays the default. Setting `ACTUAL_HTTP_PORT` is what asks for HTTP,
 * because a port is the one thing an HTTP server cannot be given a sensible
 * default for, and everything else is checked only once it is set.
 *
 * The checks refuse rather than warn. An unrecognised `ACTUAL_TOOLSET` starts
 * the server anyway, because the worst case there is a longer tool list; the
 * worst case here is a budget on a network with no credential in front of it,
 * and a server that came up looks exactly like one that is safe.
 */
export interface HttpConfig {
  port: number;
  host: string;
  /** Host headers to accept, for a server not on loopback. */
  allowedHosts?: string[];
  /** The credential for the read path. */
  readToken: string;
  /** The credential for the write path, if there is one. */
  writeToken?: string;
}

export const READ_PATH = '/mcp';
export const WRITE_PATH = '/mcp-write';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/** The other variables, so a port that never arrived is not served in silence. */
const OTHER_HTTP_VARS = [
  'ACTUAL_HTTP_TOKEN',
  'ACTUAL_HTTP_WRITE_TOKEN',
  'ACTUAL_HTTP_HOST',
  'ACTUAL_HTTP_ALLOW_REMOTE',
  'ACTUAL_HTTP_ALLOWED_HOSTS',
];

/**
 * An IPv6 address as `listen` wants it.
 *
 * `[::1]` is how a URL writes it and how people copy it, and it is not an
 * address: `listen` cannot resolve it, and the server comes up bound to
 * nothing. The brackets belong to the URL.
 */
function bareHost(host: string): string {
  const match = /^\[(.+)\]$/.exec(host);
  return match === null ? host : match[1];
}

/**
 * The HTTP variables set while no port was.
 *
 * An empty `ACTUAL_HTTP_PORT`, or a host that left the placeholder in,
 * reads as "not asked for" and the server starts on stdio. That is the
 * right answer for someone who set nothing, and the wrong one for someone
 * who filled in a token and a host and is waiting for a port to answer.
 */
export function httpHalfConfigured(): string[] {
  if (httpRequested()) return [];
  return OTHER_HTTP_VARS.filter((name) => readEnv(name) !== undefined);
}

/** Whether this process was asked for HTTP at all. */
export function httpRequested(): boolean {
  return readEnv('ACTUAL_HTTP_PORT') !== undefined;
}

function truthy(name: string): boolean {
  const raw = readEnv(name)?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * What is wrong with a token, if anything.
 *
 * Length, and one thing that is not length: thirty-two of the same
 * character is thirty-two characters and no secret at all. It is what
 * somebody types to get past the length check while they are trying
 * something out, and what then stays there.
 */
function tokenProblems(name: string, token: string): string[] {
  const problems: string[] = [];
  if (token.length < MIN_TOKEN_LENGTH) {
    problems.push(
      `${name} is ${token.length} characters, and this server wants at least ` +
        `${MIN_TOKEN_LENGTH}`,
    );
  }
  if (new Set(token).size === 1) {
    problems.push(`${name} is one character repeated, which is not a secret`);
  }
  return problems;
}

/**
 * The configuration, or every reason it is not usable.
 *
 * Every reason, not the first: a deployment that has to be corrected one
 * line at a time, with a restart between each, is how an operator ends up
 * guessing.
 */
export function readHttpConfig(): { config?: HttpConfig; problems: string[] } {
  const problems: string[] = [];

  const rawPort = readEnv('ACTUAL_HTTP_PORT')?.trim() ?? '';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`ACTUAL_HTTP_PORT is "${rawPort}", which is not a port between 1 and 65535`);
  }

  const host = bareHost(readEnv('ACTUAL_HTTP_HOST')?.trim() ?? '127.0.0.1');
  const allowRemote = truthy('ACTUAL_HTTP_ALLOW_REMOTE');
  const allowedHosts = readEnv('ACTUAL_HTTP_ALLOWED_HOSTS')
    ?.split(',')
    .map((h) => h.trim())
    .filter((h) => h !== '');

  if (!LOOPBACK.has(host)) {
    if (!allowRemote) {
      problems.push(
        `ACTUAL_HTTP_HOST is "${host}", which is reachable from outside this machine. ` +
          'This server does not terminate TLS, so the token travels in the clear unless ' +
          'something in front of it does. Set ACTUAL_HTTP_ALLOW_REMOTE=1 to say that is ' +
          'what you meant',
      );
    }
    if (allowedHosts === undefined || allowedHosts.length === 0) {
      // Off loopback the SDK's automatic protection does not apply, and
      // without a list every Host header is accepted: measured, a request
      // for `evil.example` was answered 200. The list is what makes the
      // protection the specification asks for exist at all here.
      problems.push(
        'ACTUAL_HTTP_ALLOWED_HOSTS is not set, and this server is not on loopback. ' +
          'List the names and addresses it should answer to, comma separated, or a page ' +
          'in a browser can reach it through any name that resolves here',
      );
    }
  }

  const readToken = readEnv('ACTUAL_HTTP_TOKEN');
  for (const [name, token] of [['ACTUAL_HTTP_TOKEN', readToken]] as const) {
    if (token === undefined) {
      problems.push(`${name} is not set, and HTTP mode will not start without one`);
    } else {
      problems.push(...tokenProblems(name, token));
    }
  }

  const writeToken = readEnv('ACTUAL_HTTP_WRITE_TOKEN');
  if (writeToken !== undefined) {
    if (isReadOnly()) {
      problems.push(
        'ACTUAL_HTTP_WRITE_TOKEN is set and ACTUAL_READ_ONLY is on. There are no write ' +
          'tools to reach, so one of the two is not what you meant',
      );
    }
    problems.push(...tokenProblems('ACTUAL_HTTP_WRITE_TOKEN', writeToken));
    if (writeToken === readToken) {
      problems.push(
        'ACTUAL_HTTP_WRITE_TOKEN is the same as ACTUAL_HTTP_TOKEN, so the read path and ' +
          'the write path are one credential and the split means nothing',
      );
    }
  }

  if (problems.length > 0) return { problems };
  return {
    config: { port, host, allowedHosts, readToken: readToken as string, writeToken },
    problems: [],
  };
}
