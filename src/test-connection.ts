#!/usr/bin/env node

import 'dotenv/config';
import * as api from '@actual-app/api';
import { formatMoney } from './utils/money.js';

async function testConnection() {
  const { ACTUAL_SERVER_URL, ACTUAL_PASSWORD, ACTUAL_BUDGET_ID, ACTUAL_ENCRYPTION_PASSWORD, ACTUAL_DATA_DIR } = process.env;

  console.log('=== Actual Budget MCP - Connection Test ===\n');

  // Check env vars
  const missing: string[] = [];
  if (!ACTUAL_SERVER_URL) missing.push('ACTUAL_SERVER_URL');
  if (!ACTUAL_BUDGET_ID) missing.push('ACTUAL_BUDGET_ID');

  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    console.error('\nCreate a .env file with:');
    console.error('  ACTUAL_SERVER_URL=http://localhost:5006');
    console.error('  ACTUAL_BUDGET_ID=your-budget-sync-id');
    console.error('  ACTUAL_PASSWORD=your-password  (optional, leave empty if no password)');
    process.exit(1);
  }

  console.log(`Server URL: ${ACTUAL_SERVER_URL}`);
  console.log(`Budget ID:  ${ACTUAL_BUDGET_ID}`);
  console.log(`Password:   ${ACTUAL_PASSWORD ? 'Set' : 'None'}`);
  console.log(`Encryption: ${ACTUAL_ENCRYPTION_PASSWORD ? 'Yes' : 'No'}`);
  console.log('');

  try {
    // Step 1: Init
    console.log('1. Connecting to server...');
    await api.init({
      dataDir: ACTUAL_DATA_DIR || '/tmp/actual-budget-mcp-data',
      serverURL: ACTUAL_SERVER_URL!,
      password: ACTUAL_PASSWORD || '',
    });
    console.log('   Connected!\n');

    // Step 2: List available budgets
    console.log('2. Listing available budgets...');
    const budgets = await api.getBudgets();
    if (budgets.length === 0) {
      console.log('   No budgets found on server.');
      console.log('   This may mean the server requires a password. Set ACTUAL_PASSWORD in .env');
    } else {
      console.log(`   Found ${budgets.length} budget(s):`);
      for (const b of budgets) {
        console.log(`   - ${b.name || '(unnamed)'} | ID: ${b.cloudFileId || b.id || 'unknown'}`);
      }
    }
    console.log('');

    // Step 3: Download budget
    console.log('3. Downloading budget...');
    await api.downloadBudget(ACTUAL_BUDGET_ID!, {
      password: ACTUAL_ENCRYPTION_PASSWORD,
    });
    console.log('   Budget loaded!\n');

    // Step 4: List accounts
    console.log('4. Fetching accounts...');
    const accounts = await api.getAccounts();
    const openAccounts = accounts.filter(a => !a.closed);
    console.log(`   Found ${openAccounts.length} open accounts:\n`);

    for (const account of openAccounts) {
      const balance = await api.getAccountBalance(account.id);
      const type = account.offbudget ? 'off-budget' : 'on-budget';
      console.log(`   ${account.name} (${type}): ${formatMoney(balance)}`);
    }

    // Step 5: List categories
    console.log('\n5. Fetching category groups...');
    const groups = await api.getCategoryGroups();
    console.log(`   Found ${groups.length} category groups:\n`);

    for (const group of groups) {
      const catCount = group.categories?.length || 0;
      console.log(`   ${group.name} (${catCount} categories)`);
    }

    // Step 6: Budget month
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    console.log(`\n5. Fetching budget for ${currentMonth}...`);
    const budget = await api.getBudgetMonth(currentMonth);
    console.log(`   To Be Budgeted: ${formatMoney(budget.toBudget)}`);
    console.log(`   Total Income:   ${formatMoney(budget.totalIncome)}`);
    console.log(`   Total Spent:    ${formatMoney(budget.totalSpent)}`);

    console.log('\n=== All tests passed! MCP server is ready to use. ===');

    await api.shutdown();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nError: ${message}`);

    if (message.includes('fetch') || message.includes('ECONNREFUSED')) {
      console.error('\nCould not connect to the server. Check that:');
      console.error(`  1. Actual Budget server is running at ${ACTUAL_SERVER_URL}`);
      console.error('  2. The URL is correct');
    } else if (message.includes('password') || message.includes('auth')) {
      console.error('\nAuthentication failed. Check ACTUAL_PASSWORD in your .env');
    } else if (message.includes('budget') || message.includes('sync')) {
      console.error('\nCould not load budget. Check ACTUAL_BUDGET_ID in your .env');
      console.error('You can find your budget ID in the Actual Budget URL or settings');
    }

    try { await api.shutdown(); } catch { /* ignore */ }
    process.exit(1);
  }
}

testConnection();
