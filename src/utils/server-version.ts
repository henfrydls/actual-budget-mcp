import { actualApiVersion } from './version.js';

/**
 * The Actual server's version against this server's Actual library (#229).
 *
 * Opening a budget runs any migration the library has and the file does not,
 * and the next sync pushes the result. So a 26.10 library against a 26.9
 * server takes the budget somewhere the user's own 26.9 app can no longer
 * follow: measured, 59 migrations become 60, and a 26.9 client downloading
 * from scratch then fails the way #139 did. The other direction is #139
 * itself: a budget already migrated past this library.
 *
 * It says so and opens anyway, in both directions, and that is deliberate.
 * Actual's minor **is the month**: 26.10, 26.11, 26.12. A server that
 * updates itself is a minor ahead of this library from the day Actual
 * releases until the day this server follows, and refusing on that would
 * leave every deployment without a budget for those days, by default, every
 * month. Actual's own apps migrate in exactly this situation; what is
 * missing is not a refusal, it is being told.
 *
 * The wording lives here because two callers say it: the process that opens
 * a budget, on stderr, and `list_budgets`, in a reply, for a deployment with
 * workers where the caller is the one who can act on it.
 */
export type VersionCheck =
  | { kind: 'match'; server: string; library: string }
  | { kind: 'mismatch'; server: string; library: string; serverIs: 'behind' | 'ahead' }
  | { kind: 'unreadable'; library: string };

function numbers(version: string): [number, number] {
  const [major, minor] = version.split('.').map(Number);
  return [major, minor];
}

/**
 * What the two versions say about each other.
 *
 * A version that cannot be read and one that cannot be parsed are the same
 * thing: nothing was learned about the server. Only major and minor are
 * compared, because Actual releases month.minor and the migrations come with
 * those; a patch has never carried one.
 */
export function checkVersions(
  serverVersion: string | undefined,
  library: string = actualApiVersion(),
): VersionCheck {
  const [serverMajor, serverMinor] = serverVersion ? numbers(serverVersion) : [NaN, NaN];
  const [libraryMajor, libraryMinor] = numbers(library);

  if (
    serverVersion === undefined ||
    ![serverMajor, serverMinor, libraryMajor, libraryMinor].every(Number.isFinite)
  ) {
    return { kind: 'unreadable', library };
  }

  if (serverMajor === libraryMajor && serverMinor === libraryMinor) {
    return { kind: 'match', server: serverVersion, library };
  }

  const behind =
    serverMajor < libraryMajor || (serverMajor === libraryMajor && serverMinor < libraryMinor);
  return { kind: 'mismatch', server: serverVersion, library, serverIs: behind ? 'behind' : 'ahead' };
}

/**
 * What to say on stderr, or nothing when there is nothing to say.
 *
 * The unreadable case is included: a server that is down, one behind a proxy
 * that hides `/info`, and one old enough to have no `/info` all answer the
 * same way, so the line says the check did not happen rather than inventing
 * a verdict from it.
 */
export function versionSentence(check: VersionCheck): string | undefined {
  if (check.kind === 'match') return undefined;

  if (check.kind === 'unreadable') {
    return (
      `your Actual server did not report a version, so it could not be checked against this ` +
      `server's Actual library (${check.library}). A server that is down, one behind a proxy ` +
      'that hides /info, and one old enough to have no /info answer the same way here, so ' +
      'this is not a reason to stop: opening the budget anyway.'
    );
  }

  const shared =
    `your Actual server is ${check.server} and this server's Actual library is ` +
    `${check.library}. `;

  return check.serverIs === 'behind'
    ? shared +
        'Opening your budget here migrates it to the newer format and the next sync uploads ' +
        `that, after which an Actual app still on ${check.server} can no longer open it. ` +
        "Actual's own apps do this too when they update. Update your Actual server and apps " +
        'to match, or stop this server now.'
    : shared +
        'Your server is ahead, so your budget may already carry migrations this library does ' +
        'not have: a tool can fail with a message about a file rather than about a version, ' +
        'and what is read is whatever this library understands of it. Update this server, ' +
        'which follows the Actual releases.';
}

/**
 * The same thing in one line, for a reply rather than a log.
 *
 * `list_budgets` is where a deployment with workers can say it to the person
 * who can act on it: the front end holds no budget, so nobody is reading its
 * stderr at the moment a budget is opened in a child process.
 */
export function versionNote(check: VersionCheck): string | undefined {
  // Only a mismatch. A reply is not a log: "the check did not happen" is
  // worth a line on stderr, where the operator is, and is noise in front of
  // somebody who asked which budgets there are.
  if (check.kind !== 'mismatch') return undefined;
  return check.serverIs === 'behind'
    ? `Your Actual server is ${check.server} and this server's Actual library is ${check.library}: opening a budget here migrates it past your server, and the next sync uploads that.`
    : `Your Actual server is ${check.server} and this server's Actual library is ${check.library}: your budgets may carry migrations this library does not have.`;
}
