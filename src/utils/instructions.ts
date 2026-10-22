/**
 * What a client is told about this server when it connects (#222).
 *
 * The protocol has a place for it and this server left it empty, so
 * everything a caller needed to know about how the tools fit together had to
 * be inferred from 41 descriptions, or found out by getting it wrong once.
 *
 * It is short on purpose. It is sent on every connection, in the same breath
 * as the tool list this issue is about shortening, so it earns its place only
 * by saying what the descriptions cannot say one at a time: the conventions
 * that hold across all of them.
 *
 * Every line is something the server actually does, and each is checked by a
 * test somewhere else in this repository rather than being a promise written
 * here. The line about an ambiguous name was not, until #222: the message
 * named the matches without their ids, so there was nothing to choose from.
 */
/**
 * The conventions, as the mode in force makes them true.
 *
 * Read-only hides every write tool, so a paragraph about what a delete
 * previews and when a duplicate is refused describes tools the client
 * cannot see. The lines that survive are the ones about reading and about
 * how anything is named.
 */
export function serverInstructions(options: { readOnly: boolean } = { readOnly: false }): string {
  const lines = [
    "This server reads and writes one Actual Budget file through the user's own Actual server.",
    "A read pulls the server's changes first, so figures are current.",
    '',
    'Conventions that hold across the tools:',
    '',
    '- Amounts are written the way a person says them: 25.50, not 2550.',
    '- Months are YYYY-MM, or natural language like "last month".',
    '- Accounts, categories and payees take a name or an id. An ambiguous name is',
    '  refused, with the ids to choose from, rather than guessed.',
  ];

  if (options.readOnly) {
    lines[0] =
      "This server reads one Actual Budget file through the user's own Actual server. It is " +
      'running read-only: nothing here changes the budget.';
    return lines.join('\n');
  }

  return [
    ...lines,
    '- Deleting previews first: the tool answers with what would be lost and does',
    '  nothing until the same call is repeated with confirm: true. A tool that',
    '  found its target by name also wants the name typed back.',
    '- Creating a transaction checks for one that is already there and refuses a',
    '  likely duplicate until allow_duplicate: true says it is really a second one.',
    '- Moving budgeted money between categories creates no transaction: it changes',
    '  what is assigned, not what was spent.',
  ].join('\n');
}
