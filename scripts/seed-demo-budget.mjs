/**
 * Builds the fake budget used for the README demo.
 *
 * It only ever calls runImport(), which creates a NEW budget file on the
 * server. It never downloads or opens an existing one, so it cannot touch
 * real data — the worst it can do is leave an extra file called "Demo Budget"
 * in your Actual file list, which you can delete from the UI.
 *
 * Usage:
 *   ACTUAL_SERVER_URL=http://localhost:5006 ACTUAL_PASSWORD=... \
 *     node scripts/seed-demo-budget.mjs
 */
import * as api from '@actual-app/api';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const serverURL = process.env.ACTUAL_SERVER_URL;
const password = process.env.ACTUAL_PASSWORD;
if (!serverURL || !password) {
  console.error('Set ACTUAL_SERVER_URL and ACTUAL_PASSWORD.');
  process.exit(1);
}

const BUDGET_NAME = process.env.DEMO_BUDGET_NAME || 'Demo Budget';
const MONTHS = ['2026-06', '2026-07', '2026-08'];

// Deterministic PRNG: the same demo budget every run, so a re-recorded GIF
// shows the same numbers as the one before it.
let seed = 20260830;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const between = (min, max) => Math.round((min + rand() * (max - min)) * 100);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const day = (month, d) => `${month}-${String(d).padStart(2, '0')}`;

const GROCERS = ['Whole Foods', 'Trader Joe\'s', 'Safeway', 'Costco'];
const RESTAURANTS = ['Blue Bottle', 'Thai Basil', 'Pizzeria Delfina', 'Sweetgreen', 'Taqueria Cancun'];
const GAS = ['Shell', 'Chevron'];

async function main() {
  await api.init({ dataDir: mkdtempSync(join(tmpdir(), 'demo-budget-')), serverURL, password });

  await api.runImport(BUDGET_NAME, async () => {
    const checking = await api.createAccount({ name: 'Checking', type: 'checking' }, 284000);
    const savings = await api.createAccount({ name: 'Savings', type: 'savings' }, 1250000);
    const card = await api.createAccount({ name: 'Credit Card', type: 'credit' }, -43200);

    const groups = {};
    const cat = {};
    for (const [groupName, names] of Object.entries({
      'Fixed Costs': ['Rent', 'Utilities', 'Internet', 'Phone'],
      Everyday: ['Groceries', 'Restaurants', 'Transport'],
      Fun: ['Streaming', 'Hobbies'],
    })) {
      groups[groupName] = await api.createCategoryGroup({ name: groupName });
      for (const name of names) {
        cat[name] = await api.createCategory({ name, group_id: groups[groupName] });
      }
    }

    const checkingTxns = [];
    const cardTxns = [];

    for (const month of MONTHS) {
      checkingTxns.push(
        { date: day(month, 1), amount: 160000, payee_name: 'Northwind Systems', notes: 'Payroll', cleared: true },
        { date: day(month, 15), amount: 160000, payee_name: 'Northwind Systems', notes: 'Payroll', cleared: true },
        { date: day(month, 1), amount: -120000, payee_name: 'Sunset Property Mgmt', category: cat.Rent, cleared: true },
        { date: day(month, 4), amount: -between(70, 110), payee_name: 'City Power & Water', category: cat.Utilities, cleared: true },
        { date: day(month, 6), amount: -6500, payee_name: 'Comcast', category: cat.Internet, cleared: true },
        { date: day(month, 9), amount: -4500, payee_name: 'Mint Mobile', category: cat.Phone, cleared: true },
      );

      for (let i = 0; i < 5; i++) {
        cardTxns.push({
          date: day(month, 3 + i * 5), amount: -between(38, 145),
          payee_name: pick(GROCERS), category: cat.Groceries, cleared: true,
        });
      }
      for (let i = 0; i < 4; i++) {
        cardTxns.push({
          date: day(month, 5 + i * 6), amount: -between(12, 68),
          payee_name: pick(RESTAURANTS), category: cat.Restaurants, cleared: true,
        });
      }
      for (let i = 0; i < 2; i++) {
        cardTxns.push({
          date: day(month, 8 + i * 12), amount: -between(42, 71),
          payee_name: pick(GAS), category: cat.Transport, cleared: true,
        });
      }
      cardTxns.push(
        { date: day(month, 12), amount: -1599, payee_name: 'Netflix', category: cat.Streaming, cleared: true },
        { date: day(month, 12), amount: -1099, payee_name: 'Spotify', category: cat.Streaming, cleared: true },
        { date: day(month, 21), amount: -between(20, 95), payee_name: 'Guitar Center', category: cat.Hobbies, cleared: true },
      );
    }

    await api.addTransactions(checking, checkingTxns, { learnCategories: false, runTransfers: false });
    await api.addTransactions(card, cardTxns, { learnCategories: false, runTransfers: false });

    // Budgeted amounts sit a little under real spending in Everyday, so
    // "am I over budget?" has an honest answer to find.
    const budgeted = {
      Rent: 120000, Utilities: 9000, Internet: 6500, Phone: 4500,
      Groceries: 45000, Restaurants: 12000, Transport: 11000,
      Streaming: 2700, Hobbies: 6000,
    };
    for (const month of MONTHS) {
      for (const [name, value] of Object.entries(budgeted)) {
        await api.setBudgetAmount(month, cat[name], value);
      }
    }

    console.log(`accounts: checking=${checking} savings=${savings} card=${card}`);
    console.log(`transactions: ${checkingTxns.length + cardTxns.length}`);
  });

  const files = await api.getBudgets();
  const demo = files.find((f) => f.name === BUDGET_NAME);
  console.log('\nBudget file:', JSON.stringify(demo, null, 2));
  // downloadBudget() wants the groupId, which is what Actual's settings page
  // calls the Sync ID. cloudFileId is a different id on the same object and
  // fails with a "not found" that reads like a wrong id rather than a wrong field.
  console.log(`\nACTUAL_BUDGET_ID=${demo?.groupId ?? '(no groupId — did the upload to the server fail?)'}`);

  await api.shutdown();
}

main().catch(async (e) => {
  console.error('FAILED:', e?.message || e);
  try { await api.shutdown(); } catch {}
  process.exit(1);
});
