import { defineConfig } from 'vitest/config';

/**
 * Two kinds of test, two budgets of time.
 *
 * There was no config at all, so everything ran against vitest's 5-second
 * default — including the integration tests, which start a real Actual engine
 * and build a budget per case. On a loaded CI runner the first of those took
 * 5094 ms and turned the build red, having passed the eight runs before it.
 *
 * An intermittent red is worse than a broken build: it teaches people to rerun
 * without looking, and the day the red means something nobody believes it. The
 * cause was not a slow test — locally these run in 48 to 249 ms each, with no
 * leak between them — it was a limit written for unit tests being applied to
 * something that boots a database.
 *
 * So the limit belongs here, once, as a property of the kind of test, rather
 * than as a number each new integration test has to remember to pass. Unit
 * tests keep the tight default, where a five-second test really is a hang.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['**/node_modules/**', 'src/**/integration/**'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['src/**/integration/**/*.test.ts'],
          exclude: ['**/node_modules/**'],
          // Generous on purpose: the cost is only paid when something is
          // genuinely stuck, and the alternative is a flaky red.
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
