import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

/**
 * How long the release waits for the two things it cannot hurry (#199).
 *
 * The step that publishes to the MCP registry waits for two races it does not
 * control: the container image, built by a workflow running alongside this
 * one, and npm, which answers "your package is being processed" and serves
 * the new version some minutes later.
 *
 * It is a file GitHub runs and nothing here executes, so it is the kind of
 * thing that stops being true quietly. 0.10.6 is what that cost: one loop was
 * shared between both waits, ten attempts thirty seconds apart, so the pair
 * had five minutes between them. npm took about seven, every attempt failed,
 * and the job had to be re-run by hand once npm caught up.
 *
 * The numbers are read out of the script rather than trusted, because the
 * point of the fix is the size of the budgets and nothing else in the suite
 * would notice them shrinking.
 */
describe('what the release waits for', () => {
  const workflow = parse(readFileSync('.github/workflows/publish.yml', 'utf8')) as {
    jobs: Record<string, { steps: Array<{ name?: string; run?: string; 'timeout-minutes'?: number }> }>;
  };
  const step = workflow.jobs.registry.steps.find(
    (one) => one.name === 'Publish to the MCP registry',
  );

  /** Every `for attempt in $(seq 1 N)` loop, with the sleep inside it. */
  function loops(script: string): Array<{ attempts: number; sleep: number; body: string }> {
    // The indentation is whatever YAML left after folding the block, so the
    // end of the loop is matched by shape rather than by column.
    return [...script.matchAll(/for attempt in \$\(seq 1 (\d+)\); do([\s\S]*?)^\s*done$/gm)].map(
      (match) => ({
        attempts: Number(match[1]),
        sleep: Number(/\bsleep (\d+)/.exec(match[2])?.[1] ?? 0),
        body: match[2],
      }),
    );
  }

  it('waits for the image and for npm on separate budgets', () => {
    // One loop for both is what made npm's wait depend on how long the image
    // took, which is the whole of #199.
    expect(step, 'the step that publishes to the registry').toBeDefined();
    const found = loops(step!.run!);
    expect(found, 'one loop for the image and one for npm').toHaveLength(2);

    const [image, npm] = found;
    expect(image.body, 'the image is waited for first').toContain('image_exists');
    expect(npm.body, 'and npm is what the publish retries are for').toContain(
      'mcp-publisher publish',
    );
    expect(image.body).not.toContain('mcp-publisher publish');
  });

  it('gives npm at least ten minutes, which is what 0.10.6 needed', () => {
    const [image, npm] = loops(step!.run!);

    expect((npm.attempts * npm.sleep) / 60).toBeGreaterThanOrEqual(10);
    expect((image.attempts * image.sleep) / 60).toBeGreaterThanOrEqual(5);
  });

  it('is allowed to run for longer than it can wait', () => {
    // A timeout shorter than the two budgets would cut the wait short from
    // the outside and read as a different failure.
    const [image, npm] = loops(step!.run!);
    const waiting = (image.attempts * image.sleep + npm.attempts * npm.sleep) / 60;

    expect(step!['timeout-minutes']).toBeGreaterThan(waiting);
  });

  it('says which of the two it gave up on', () => {
    // The remedies are different: a missing image usually means that workflow
    // failed, and a slow npm means wait and re-run. One message for both sent
    // the reader to the wrong one half the time.
    const script = step!.run!;
    expect(script).toContain('ghcr has no ${VERSION} tag after five minutes');
    expect(script).toContain('waiting for npm');
  });
});
