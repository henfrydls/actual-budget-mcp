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

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Whether this process was asked for HTTP at all. */
export function httpRequested(): boolean {
  return readEnv('ACTUAL_HTTP_PORT') !== undefined;
}

function truthy(name: string): boolean {
  const raw = readEnv(name)?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
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

  const host = readEnv('ACTUAL_HTTP_HOST')?.trim() ?? '127.0.0.1';
  const allowRemote = truthy('ACTUAL_HTTP_ALLOW_REMOTE');
  if (!LOOPBACK.has(host) && !allowRemote) {
    problems.push(
      `ACTUAL_HTTP_HOST is "${host}", which is reachable from outside this machine. ` +
        'This server does not terminate TLS, so the token travels in the clear unless ' +
        'something in front of it does. Set ACTUAL_HTTP_ALLOW_REMOTE=1 to say that is ' +
        'what you meant',
    );
  }

  const allowedHosts = readEnv('ACTUAL_HTTP_ALLOWED_HOSTS')
    ?.split(',')
    .map((h) => h.trim())
    .filter((h) => h !== '');

  const readToken = readEnv('ACTUAL_HTTP_TOKEN');
  if (readToken === undefined) {
    problems.push('ACTUAL_HTTP_TOKEN is not set, and HTTP mode will not start without one');
  } else if (readToken.length < MIN_TOKEN_LENGTH) {
    problems.push(
      `ACTUAL_HTTP_TOKEN is ${readToken.length} characters, and this server wants at ` +
        `least ${MIN_TOKEN_LENGTH}`,
    );
  }

  const writeToken = readEnv('ACTUAL_HTTP_WRITE_TOKEN');
  if (writeToken !== undefined) {
    if (isReadOnly()) {
      problems.push(
        'ACTUAL_HTTP_WRITE_TOKEN is set and ACTUAL_READ_ONLY is on. There are no write ' +
          'tools to reach, so one of the two is not what you meant',
      );
    }
    if (writeToken.length < MIN_TOKEN_LENGTH) {
      problems.push(
        `ACTUAL_HTTP_WRITE_TOKEN is ${writeToken.length} characters, and this server wants ` +
          `at least ${MIN_TOKEN_LENGTH}`,
      );
    }
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
