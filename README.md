# actual-budget-mcp

[![npm version](https://img.shields.io/npm/v/actual-budget-mcp)](https://www.npmjs.com/package/actual-budget-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js->=20-green.svg)](https://nodejs.org/)

Talk to your budget. An MCP server that connects [Actual Budget](https://actualbudget.org/) to Claude, so you can ask questions, create transactions, and analyze spending in natural conversation.

## Features

- **Ask about your budget in plain language** - "How much did I spend on food this month?" or "Am I over budget on anything?"
- **Create and manage transactions** - Add expenses, transfers, and edits without opening the app
- **Get spending insights** - Projections, trends, and budget vs actual comparisons
- **Use names, not IDs** - Say "Cartera" instead of `a1b2c3d4-...`, with helpful suggestions if ambiguous
- **Natural dates in English and Spanish** - "last month", "este mes", "hace 3 meses", "yesterday"
- **Clean formatted output** - Aligned tables and clear summaries, not raw JSON
- **Clear error messages** - If something's wrong, you'll know exactly what to fix

## Prerequisites

- [Actual Budget](https://actualbudget.org/) server running (local or remote)
- [Node.js](https://nodejs.org/) 20 or higher

## Quick Start

The fastest way to get started - copy this into Claude Code or Claude Desktop:

```bash
Install the MCP server actual-budget-mcp from https://github.com/henfrydls/actual-budget-mcp. My Actual Budget server is at http://localhost:5006, my password is YOUR_PASSWORD and my budget ID is YOUR_BUDGET_ID
```

Claude will configure everything for you.

## Installation

### Option 1: Claude Code (one command)

```bash
claude mcp add actual-budget-mcp -e ACTUAL_SERVER_URL=http://localhost:5006 -e ACTUAL_PASSWORD=your-password -e ACTUAL_BUDGET_ID=your-budget-id -- npx -y actual-budget-mcp
```

### Option 2: Claude Desktop

Add this to your `claude_desktop_config.json`:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "actual-budget-mcp": {
      "command": "npx",
      "args": ["-y", "actual-budget-mcp"],
      "env": {
        "ACTUAL_SERVER_URL": "http://localhost:5006",
        "ACTUAL_PASSWORD": "your-password",
        "ACTUAL_BUDGET_ID": "your-budget-sync-id"
      }
    }
  }
}
```

### Option 3: Cursor

Go to **Cursor Settings > MCP > Add new MCP server** and add:

```json
{
  "mcpServers": {
    "actual-budget-mcp": {
      "command": "npx",
      "args": ["-y", "actual-budget-mcp"],
      "env": {
        "ACTUAL_SERVER_URL": "http://localhost:5006",
        "ACTUAL_PASSWORD": "your-password",
        "ACTUAL_BUDGET_ID": "your-budget-sync-id"
      }
    }
  }
}
```

### Option 4: VS Code (GitHub Copilot)

Add this to your VS Code `settings.json`:

```json
{
  "mcp": {
    "servers": {
      "actual-budget-mcp": {
        "command": "npx",
        "args": ["-y", "actual-budget-mcp"],
        "env": {
          "ACTUAL_SERVER_URL": "http://localhost:5006",
          "ACTUAL_PASSWORD": "your-password",
          "ACTUAL_BUDGET_ID": "your-budget-sync-id"
        }
      }
    }
  }
}
```

### Option 5: From source (for contributors)

```bash
git clone https://github.com/henfrydls/actual-budget-mcp.git
cd actual-budget-mcp
npm install
cp .env.example .env   # Edit with your credentials
npm run build
npm run test:connection # Verify it works
```

### Verify your setup

After installing, you can verify the connection works:

```bash
npx -y actual-budget-mcp --verify
```

This will connect to your Actual Budget server and confirm everything is configured correctly.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `ACTUAL_SERVER_URL` | Yes | Your Actual Budget server URL (e.g., `http://localhost:5006`) |
| `ACTUAL_PASSWORD` | Yes | Server password (set in Actual Budget under Settings) |
| `ACTUAL_BUDGET_ID` | Yes | Budget Sync ID (found in Settings > Show advanced settings) |
| `ACTUAL_ENCRYPTION_PASSWORD` | No | Only if your budget file is encrypted |
| `ACTUAL_DATA_DIR` | No | Cache directory (default: `/tmp/actual-budget-mcp-data`) |

### Finding your Budget ID

1. Open Actual Budget
2. Go to **Settings** (gear icon)
3. Click **Show advanced settings**
4. Copy the **Sync ID**

## Tools (18)

### Read (7)

| Tool | Description | Example prompt |
|------|-------------|----------------|
| `list_accounts` | All accounts with balances | "Show me all my accounts" |
| `get_budget_month` | Budget for a specific month | "What does my March budget look like?" |
| `get_transactions` | Transactions with filters | "Show me transactions from last week over 5000" |
| `get_category_balance` | Category history across months | "How has my food spending changed?" |
| `get_budget_summary` | Executive budget overview | "Give me a budget summary for February" |
| `get_categories` | All category groups and categories | "What categories do I have?" |
| `get_payees` | All payees in the budget | "List all my payees" |

<details>
<summary>Parameters</summary>

**get_budget_month** - `month` (optional): YYYY-MM or natural language ("this month", "last month", "enero 2025")

**get_transactions** - `account` (optional): account name | `start_date` / `end_date` (optional): YYYY-MM-DD or natural language | `category` (optional): category name | `payee` (optional): payee name | `min_amount` / `max_amount` (optional): filter by amount | `limit` (optional, default 50)

**get_category_balance** - `category` (required): category name or ID | `months` (optional, default 3): months to look back

**get_budget_summary** - `month` (optional): YYYY-MM or natural language

</details>

### Analysis (4)

| Tool | Description | Example prompt |
|------|-------------|----------------|
| `budget_vs_actual` | Budgeted vs spent per category | "Am I over budget on anything this month?" |
| `spending_projection` | End-of-month spending forecast | "Will I stay within budget this month?" |
| `category_trends` | Spending trends over time | "What are my spending trends for the last 6 months?" |
| `spending_by_category` | Spending breakdown by category | "Show me spending by category for February" |

<details>
<summary>Parameters</summary>

**budget_vs_actual** - `month` (optional): YYYY-MM or natural language | `group` (optional): filter by category group

**spending_projection** - `month` (optional): YYYY-MM or natural language

**category_trends** - `category` (optional): specific category or top spending if omitted | `months` (optional, default 6)

**spending_by_category** - `start_date` / `end_date` (optional): date range | `include_income` (optional, default false) | `limit` (optional, default 20)

</details>

### Write (7)

| Tool | Description | Example prompt |
|------|-------------|----------------|
| `create_transaction` | Add a new transaction | "I spent 500 on groceries from Cartera today" |
| `update_transaction` | Edit an existing transaction | "Change the amount on that transaction to 600" |
| `delete_transaction` | Remove a transaction | "Delete that test transaction" |
| `update_budget_amount` | Change a budget amount | "Set my food budget to 15,000 for this month" |
| `recategorize_transaction` | Move to another category | "Move that transaction to Entertainment" |
| `create_transfer` | Transfer between accounts | "Transfer 10,000 from Checking to Savings" |
| `run_bank_sync` | Sync with linked banks | "Sync my bank transactions" |

<details>
<summary>Parameters</summary>

**create_transaction** - `account` (required): account name | `amount` (required): negative for expenses, positive for income | `payee` (optional) | `category` (optional) | `date` (optional) | `notes` (optional) | `cleared` (optional)

**update_transaction** - `transaction_id` (required) | `amount`, `payee`, `category`, `date`, `notes`, `cleared` (all optional)

**delete_transaction** - `transaction_id` (required)

**update_budget_amount** - `category` (required) | `amount` (required) | `month` (optional)

**recategorize_transaction** - `transaction_id` (required) | `category` (required)

**create_transfer** - `from_account` (required) | `to_account` (required) | `amount` (required) | `date` (optional) | `notes` (optional)

**run_bank_sync** - `account` (optional): sync specific account or all if omitted

</details>

## Usage Examples

Here are real prompts you can use:

```
"How much did I spend in February?"

"Show me my top 5 spending categories this month"

"Am I over budget on anything?"

"I spent 1,200 on electricity from my BHD account yesterday"

"What's my savings rate this month?"

"Show me all transactions from Cartera in the last 30 days"

"Transfer 5,000 from Checking to Savings"

"What are my spending trends for food over the last 6 months?"
```

## How is this different?

Compared to other Actual Budget MCP servers:

| Feature | actual-budget-mcp | Others |
|---------|-------------------|--------|
| Natural language dates | "last month", "este mes", "hace 3 meses" | Only YYYY-MM-DD |
| Name resolution | Type "Cartera" instead of UUIDs | Requires exact IDs |
| Output format | Aligned tables, readable text | Raw JSON |
| Error messages | Clear instructions on how to fix | Generic errors |
| Analysis tools | Budget vs actual, projections, trends | Not available |
| Bilingual dates | English + Spanish | English only |
| API version | @actual-app/api 26.x (current) | Often outdated |

## Security

- This server connects to your Actual Budget instance using the credentials you provide
- Credentials are passed as environment variables and never stored by the MCP server
- All communication with your Actual Budget server happens locally (or to your self-hosted server)
- The server only accesses budget data through the official `@actual-app/api` library
- No data is sent to third parties

## Troubleshooting

**"Could not connect to Actual Budget server"**
- Make sure Actual Budget is running (open the app or start the server)
- Check that `ACTUAL_SERVER_URL` is correct
- Run `npx -y actual-budget-mcp --verify` to test your connection

**"Authentication failed"**
- Your server requires a password. Set `ACTUAL_PASSWORD` in your config
- If you forgot the password, reset it in Actual Budget under Settings > Server

**"Budget not found"**
- Check your `ACTUAL_BUDGET_ID`. Find it in Settings > Show advanced settings > Sync ID

**"Budget file is encrypted"**
- Set `ACTUAL_ENCRYPTION_PASSWORD` with your encryption password

**"Ambiguous name: matches X, Y"**
- Be more specific. Instead of "BHD", try "BHD Nomina" or "BHD Mi Pais"

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

```bash
git clone https://github.com/henfrydls/actual-budget-mcp.git
cd actual-budget-mcp
npm install
npm run build
npm run test:connection  # Needs .env configured
```

## License

[MIT](LICENSE) - DLSLabs
