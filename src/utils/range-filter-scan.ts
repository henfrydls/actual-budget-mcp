import ts from 'typescript';

/**
 * Find a query filter that puts two range bounds in one object.
 *
 * AQL applies the **first** key it finds and ignores the rest, with no error.
 * Measured against the engine on five consecutive days, the 23rd to the 27th:
 *
 *   { date: { $gte: 24th, $lte: 26th } }   24 25 26 **27**
 *   { date: { $lte: 26th, $gte: 24th } }   23 24 25 26
 *   $and of the two                        24 25 26
 *
 * So which half of the range disappears depends on the order someone happened
 * to type the keys in, and it is not special to dates: `$gt` with `$lt` on an
 * amount behaves the same way. Both forms read perfectly well, which is why
 * this has shipped twice: a duplicate check caught by a test before release,
 * and `reconcile_account`, where rows dated after the cutoff were offered as
 * explanations for a difference for four releases (#179).
 *
 * ## Why this parses instead of searching the text
 *
 * The pair can be written across two lines, with a comment between the keys,
 * with the keys quoted, or with a key spelled `['$gte']`. A search for the two
 * names near each other misses all of those and reports that all is well,
 * which is how the guard in `unsettled-reads.ts` was defeated twice before it
 * was given a parser.
 *
 * ## What it does not see, stated rather than discovered
 *
 * An object built up in a variable and then spread into a filter, a key whose
 * name is computed from something other than a literal, and bounds passed
 * through a helper of someone's own. None of those are in `src` today.
 */
const RANGE_OPS = new Set(['$gt', '$gte', '$lt', '$lte']);

/** The name of a property, where it is written plainly enough to read. */
function nameOf(property: ts.ObjectLiteralElementLike): string | undefined {
  const name = property.name;
  if (!name) return undefined;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  // `['$gte']` and the backtick form are the same key written longer.
  if (ts.isComputedPropertyName(name)) {
    const inner = name.expression;
    if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
  }
  return undefined;
}

/** The 1-based lines holding an object literal with two or more range keys. */
export function findTwoBoundRanges(source: string, fileName = 'file.ts'): number[] {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const keys = node.properties
        .map(nameOf)
        .filter((key): key is string => key !== undefined)
        .filter((key) => RANGE_OPS.has(key));
      if (keys.length > 1) {
        lines.push(parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return lines;
}
