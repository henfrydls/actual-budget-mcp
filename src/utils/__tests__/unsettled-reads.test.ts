import { describe, it, expect } from 'vitest';
import { findUnsettledReads } from '../unsettled-reads.js';

/**
 * The guard against getting this wrong, guarded.
 *
 * Its first version was a regex loop written inline in a test file, with no
 * cover of its own: four separate ways of neutralising it left the suite green,
 * including removing the comment handling that the pull request presented as
 * its lesson. An audit then got past it seven ways and made it cry wolf three.
 * All ten are below, because a guard nobody checks is the thing it exists to
 * prevent.
 */

const OFFENDING = `
  it('writes then reads', async () => {
    await api.deleteTransaction(id);
    const rows = await api.runQuery(q);
  });
`;

describe('findUnsettledReads: the offence it is for', () => {
  it('finds a read straight after a delete', () => {
    expect(findUnsettledReads(OFFENDING)).toEqual([{ line: 3, readLine: 4 }]);
  });

  it('finds one after an update too', () => {
    const src = `
      it('x', async () => {
        await api.updateTransaction(id, { notes: 'a' });
        const rows = await api.getTransactions(acct, a, b);
      });
    `;
    expect(findUnsettledReads(src)).toHaveLength(1);
  });

  it('finds a write that hides behind a helper', () => {
    // `updatePreservingChildAmount` reaches `api.updateTransaction`, and a real
    // test uses it: it was missing from the first list.
    const src = `
      it('x', async () => {
        await updatePreservingChildAmount(id, { category: c });
        const rows = await api.runQuery(q);
      });
    `;
    expect(findUnsettledReads(src)).toHaveLength(1);
  });

  it('finds a write and a read on one line', () => {
    // The first version started its window at the next line and could not see
    // this at all.
    const src = `
      it('x', async () => {
        await api.deleteTransaction(id); const n = (await api.runQuery(q)).data.length;
      });
    `;
    expect(findUnsettledReads(src)).toHaveLength(1);
  });
});

describe('findUnsettledReads: prose and strings are not code', () => {
  const decoys: Array<[string, string]> = [
    ['a block comment calling a settler', '/* we used to await api.loadBudget(id) here */'],
    ['a JSDoc calling a settler', '/** @example await api.loadBudget(id) */'],
    ['a line comment calling a settler', '// await api.loadBudget(budgetId);'],
    ['a string containing a call', "const why = 'call setTimeout(fn, 0) first';"],
    ['a variable named like a settler', 'const loadBudget = 1;'],
  ];

  for (const [name, decoy] of decoys) {
    it(`is not satisfied by ${name}`, () => {
      const src = `
        it('x', async () => {
          await api.deleteTransaction(id);
          ${decoy}
          const rows = await api.runQuery(q);
        });
      `;
      expect(findUnsettledReads(src)).toHaveLength(1);
    });
  }

  it('is not satisfied by a URL sitting on the read line', () => {
    // On the same line as the read, which is where it defeated the scanner:
    // truncating at `//` swallowed the call that followed it. An earlier
    // fixture put the URL on its own line, where truncating cost nothing, so
    // it proved nothing.
    const src = `
      it('x', async () => {
        await api.deleteTransaction(id);
        const u = 'https://example.test'; const rows = await api.runQuery(q);
      });
    `;
    expect(findUnsettledReads(src)).toHaveLength(1);
  });
});

describe('findUnsettledReads: what it must not complain about', () => {
  it('accepts a real settler between the two', () => {
    const src = `
      it('x', async () => {
        await api.deleteTransaction(id);
        await api.loadBudget(budgetId);
        const rows = await api.runQuery(q);
      });
    `;
    expect(findUnsettledReads(src)).toEqual([]);
  });

  it('accepts sleep(0) from node:timers/promises', () => {
    // A correct macrotask wait that the first version reported as an offence.
    const src = `
      it('x', async () => {
        await api.deleteTransaction(id);
        await sleep(0);
        const rows = await api.runQuery(q);
      });
    `;
    expect(findUnsettledReads(src)).toEqual([]);
  });

  it('accepts a preview, which writes nothing', () => {
    // `deleteTransactionGuarded` without `confirm` only previews.
    const src = `
      it('x', async () => {
        const r = await deleteTransactionGuarded({ transaction_id: id });
        const rows = await api.runQuery(q);
      });
    `;
    expect(findUnsettledReads(src)).toEqual([]);
  });

  it('does not pair a write in one test with a read in the next', () => {
    // Measured as a false positive: the window ran past the end of the case.
    const src = `
      it('one', async () => {
        await api.deleteTransaction(id);
        expect(r.deleted).toBe(true);
      });

      it('two', async () => {
        const rows = await api.runQuery(q);
      });
    `;
    expect(findUnsettledReads(src)).toEqual([]);
  });

  it('leaves a read alone when nothing was written', () => {
    expect(findUnsettledReads(`it('x', async () => { const r = await api.runQuery(q); });`)).toEqual([]);
  });
});

describe('findUnsettledReads: what defeated the hand-written scanner', () => {
  it('is not derailed by an apostrophe inside a regex literal', () => {
    // This exact shape is live in the repository. The scanner took the
    // apostrophe as the start of a string and read the rest of the file
    // inside out: real code blanked, string contents emitted, the read
    // invisible. It reported nothing and said nothing.
    const src = `
      it('x', async () => {
        await expect(p).rejects.toThrow(/after this server's today/s);
        await api.deleteTransaction(id);
        const rows = await api.getTransactions(acct, a, b);
      });
    `;
    expect(findUnsettledReads(src)).toHaveLength(1);
  });

  it('is not derailed by a division that looks like a regex', () => {
    const src = `
      it('x', async () => {
        const ratio = total / count / 2;
        await api.deleteTransaction(id);
        const rows = await api.runQuery(q);
      });
    `;
    expect(findUnsettledReads(src)).toHaveLength(1);
  });

  it('does not treat a .test() call as the start of a new case', () => {
    // `CASE_BOUNDARY` matched `.test(`, so any regex assertion between the
    // write and the read aborted the scan. The pattern is in two files here.
    const src = `
      it('x', async () => {
        await api.deleteTransaction(id);
        expect(/x/.test('y')).toBe(false);
        const rows = await api.runQuery(q);
      });
    `;
    expect(findUnsettledReads(src)).toHaveLength(1);
  });

  it('sees a read more than a dozen lines after the write', () => {
    const filler = Array.from({ length: 20 }, (_, i) => `        const v${i} = ${i};`).join('\n');
    const src = `
      it('x', async () => {
        await api.deleteTransaction(id);
${filler}
        const rows = await api.runQuery(q);
      });
    `;
    expect(findUnsettledReads(src)).toHaveLength(1);
  });

  it('sees a call split across lines by a formatter', () => {
    const src = `
      it('x', async () => {
        await api.deleteTransaction(
          id,
        );
        const rows = await api.runQuery(q);
      });
    `;
    expect(findUnsettledReads(src)).toHaveLength(1);
  });

  it('sees a read reached through computed access', () => {
    const src = `
      it('x', async () => {
        await api['deleteTransaction'](id);
        const rows = await api.runQuery(q);
      });
    `;
    expect(findUnsettledReads(src)).toHaveLength(1);
  });

  it('sees a read inside a template literal', () => {
    const src = `
      it('x', async () => {
        await api.deleteTransaction(id);
        console.error(\`n=\${(await api.runQuery(q)).data.length}\`);
      });
    `;
    expect(findUnsettledReads(src)).toHaveLength(1);
  });

  it('does not accept a settler that is only declared', () => {
    // Matching the shape of the call rather than its execution: this one never
    // runs at all.
    const src = `
      it('x', async () => {
        await api.deleteTransaction(id);
        const wait = () => setTimeout(noop, 0);
        const rows = await api.runQuery(q);
      });
    `;
    expect(findUnsettledReads(src)).toHaveLength(1);
  });

  it('does not accept a settler that is not awaited', () => {
    const src = `
      it('x', async () => {
        await api.deleteTransaction(id);
        sleep(0);
        const rows = await api.runQuery(q);
      });
    `;
    expect(findUnsettledReads(src)).toHaveLength(1);
  });

  it('does not accept a settler inside a helper that is never called', () => {
    // The await sits directly over the call, inside a function nobody
    // invokes. A rule that looks for any await above the call finds that one
    // first and stops; the boundary has to be noticed before the await.
    const src = `
      it('x', async () => {
        await api.deleteTransaction(id);
        const wait = async () => { await sleep(0); };
        const rows = await api.runQuery(q);
      });
    `;
    expect(findUnsettledReads(src)).toHaveLength(1);
  });

  it('does not accept a settler handed to something else that is awaited', () => {
    // `await expect(doThing(() => sleep(0)))` awaits the assertion, not the
    // sleep, and the callback may never run.
    const src = `
      it('x', async () => {
        await api.deleteTransaction(id);
        await expect(doThing(() => sleep(0))).resolves.toBe(1);
        const rows = await api.runQuery(q);
      });
    `;
    expect(findUnsettledReads(src)).toHaveLength(1);
  });

  it('sees a read deferred into a then callback, in the right order', () => {
    // Walking a call's arguments before the call itself read this as a read
    // before a write, which is backwards and let the shape through.
    const src = `
      it('x', async () => {
        await api.deleteTransaction(id).then(() => api.runQuery(q));
      });
    `;
    expect(findUnsettledReads(src)).toHaveLength(1);
  });

  it('still sees a read that is an argument to something else', () => {
    // The case the arguments-first order existed for, which source order
    // has to keep working.
    const src = `
      it('x', async () => {
        await api.deleteTransaction(id);
        expect((await api.runQuery(q)).data).toEqual([]);
      });
    `;
    expect(findUnsettledReads(src)).toHaveLength(1);
  });

  it('accepts the awaited-promise idiom the codebase actually uses', () => {
    // `setTimeout` sits inside a callback inside the awaited expression. A
    // first attempt at the await rule stopped at the nearest function
    // boundary and rejected exactly this.
    const src = `
      it('x', async () => {
        await api.deleteTransaction(id);
        await new Promise((r) => setTimeout(r, 0));
        const rows = await api.runQuery(q);
      });
    `;
    expect(findUnsettledReads(src)).toEqual([]);
  });

  it('accepts a settler awaited through Promise.all, which really does wait', () => {
    // Pinned because it is the legitimate half of a limit. This and
    // `await register(sleep(0))`, which does not wait, are the same shape, so
    // accepting one means accepting the other. The limit is declared rather
    // than chased: separating them needs to know what the function does.
    const src = `
      it('x', async () => {
        await api.deleteTransaction(id);
        await Promise.all([sleep(0)]);
        const rows = await api.runQuery(q);
      });
    `;
    expect(findUnsettledReads(src)).toEqual([]);
  });

  it('accepts an engine call as a settler, as the mechanism says it should', () => {
    // The header says any engine call closes the window. The scanner flagged
    // `await api.sync()` between a write and a read, contradicting it.
    const src = `
      it('x', async () => {
        await api.deleteTransaction(id);
        await api.sync();
        const rows = await api.runQuery(q);
      });
    `;
    expect(findUnsettledReads(src)).toEqual([]);
  });

  it('accepts a preview whose argument object is nested', () => {
    const src = `
      it('x', async () => {
        await deleteTransactionGuarded({ transaction_id: id, opts: { a: 1 } });
        const rows = await api.runQuery(q);
      });
    `;
    expect(findUnsettledReads(src)).toEqual([]);
  });
});
