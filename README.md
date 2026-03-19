# actual-budget-mcp

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
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

## Quick Start

The fastest way to get started - copy this into Claude Code or Claude Desktop:

> Install the MCP server actual-budget-mcp from npm. My Actual Budget server is at http://localhost:5006, my password is YOUR_PASSWORD and my budget ID is YOUR_BUDGET_ID

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

### Option 3: From source (for contributors)

```bash
git clone https://github.com/henfrydls/actual-budget-mcp.git
cd actual-budget-mcp
npm install
cp .env.example .env   # Edit with your credentials
npm run build
npm run test:connection # Verify it works
```

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

## Tools (15)

### Read

| Tool | Description | Example prompt |
|------|-------------|----------------|
| `list_accounts` | All accounts with balances | "Show me all my accounts" |
| `get_budget_month` | Budget for a specific month | "What does my March budget look like?" |
| `get_transactions` | Transactions with filters | "Show me transactions from last week over 5000" |
| `get_category_balance` | Category history across months | "How has my food spending changed?" |
| `get_budget_summary` | Executive budget overview | "Give me a budget summary for February" |

### Analysis

| Tool | Description | Example prompt |
|------|-------------|----------------|
| `budget_vs_actual` | Budgeted vs spent per category | "Am I over budget on anything this month?" |
| `spending_projection` | End-of-month spending forecast | "Will I stay within budget this month?" |
| `category_trends` | Spending trends over time | "What are my spending trends for the last 6 months?" |

### Write

| Tool | Description | Example prompt |
|------|-------------|----------------|
| `create_transaction` | Add a new transaction | "I spent 500 on groceries from Cartera today" |
| `update_transaction` | Edit an existing transaction | "Change the amount on that transaction to 600" |
| `delete_transaction` | Remove a transaction | "Delete that test transaction" |
| `update_budget_amount` | Change a budget amount | "Set my food budget to 15,000 for this month" |
| `recategorize_transaction` | Move to another category | "Move that transaction to Entertainment" |
| `create_transfer` | Transfer between accounts | "Transfer 10,000 from Checking to Savings" |
| `run_bank_sync` | Sync with linked banks | "Sync my bank transactions" |

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

## Troubleshooting

**"Could not connect to Actual Budget server"**
- Make sure Actual Budget is running (open the app or start the server)
- Check that `ACTUAL_SERVER_URL` is correct

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
