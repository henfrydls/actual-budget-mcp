import { z } from 'zod';
import type { McpServerLike } from './read-sync.js';

/**
 * Keep telling a client that a tool takes no arguments it did not ask for
 * (#280).
 *
 * Until zod 4, every tool's JSON Schema carried `additionalProperties:
 * false`. Nothing here declared it: it was what the converter the SDK used
 * for zod 3 emitted by default, and zod 4's own `toJSONSchema` does not.
 * Losing it is not a safety change, because the server never enforced it
 * and still does not, but it is a change to what a client is told, and that
 * line is the one that tells a model not to invent an argument.
 *
 * So it is emitted on purpose now, and what the server does with an unknown
 * argument is exactly what it did: zod strips it and the call goes through.
 * `.strict()` would have put the line back by making the server refuse that
 * call, which is a different server.
 *
 * ## Why it is done here and not in each tool
 *
 * Forty-four call sites pass a plain shape, `{ month: z.string() }`, and the
 * SDK turns that into an object itself. Metadata lives on the object, not on
 * the shape, so the object has to be built before the SDK sees it. That is
 * one line here against forty-four there, and the forty-four would each be a
 * place to forget it.
 *
 * `registerTool` rather than `tool`, because `tool` guesses which overload
 * it was called with by looking at its arguments and does not recognise a
 * built object in the position where a shape goes. A server that has no
 * `registerTool`, which is every stub in the tests that counts registrations,
 * gets the call it understands and no hint, which is what those tests are
 * about anyway.
 *
 * An empty shape is left alone. A tool that takes no arguments had no
 * `additionalProperties` before this either, and adding one would be a new
 * difference rather than the end of an old one.
 */
/**
 * The two ways in, as this needs them.
 *
 * `registerTool`'s real signature is generic over the schema it is given,
 * and nothing here can satisfy that from a value typed as "some shape".
 * What is checked at runtime, just below, is more than the type would be:
 * that there is a function to call and a shape worth building.
 */
type Registrar = McpServerLike & {
  registerTool?: (...args: never[]) => unknown;
};

/** Whether this is the plain `{ name: schema }` a tool passes. */
function isShape(value: unknown): value is Record<string, z.ZodTypeAny> {
  if (typeof value !== 'object' || value === null) return false;
  const entries = Object.values(value as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every(
    (entry) => typeof entry === 'object' && entry !== null && 'parse' in (entry as object),
  );
}

export function withSchemaHint<T extends Registrar>(server: T): T {
  const wrapped = Object.create(server) as T;
  const originalTool = server.tool.bind(server) as (...args: unknown[]) => unknown;
  const register = server.registerTool?.bind(server) as
    | ((name: string, config: Record<string, unknown>, handler: unknown) => unknown)
    | undefined;

  (wrapped as { tool: unknown }).tool = (...args: unknown[]) => {
    const [name, description, shape, annotations, handler] = args;
    if (
      register === undefined ||
      typeof name !== 'string' ||
      typeof description !== 'string' ||
      !isShape(shape) ||
      typeof handler !== 'function'
    ) {
      return originalTool(...args);
    }

    return register(
      name,
      {
        description,
        inputSchema: z.object(shape).meta({ additionalProperties: false }),
        annotations,
      },
      handler,
    );
  };

  return wrapped;
}
