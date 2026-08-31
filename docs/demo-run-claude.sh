#!/bin/bash
# Launches Claude Code for the README recording: pointed at the demo budget
# only, English regardless of the host machine's language setting, and with
# just the tools the demo exercises.
exec env -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID \
  -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_BRIDGE_SESSION_ID \
  -u CLAUDE_PID -u CLAUDE_EFFORT \
  claude --mcp-config .mcp.json --strict-mcp-config \
  --settings settings.json \
  --allowedTools 'mcp__actual-budget-mcp__spending_by_category,mcp__actual-budget-mcp__budget_vs_actual,mcp__actual-budget-mcp__monthly_summary,mcp__actual-budget-mcp__get_transactions,mcp__actual-budget-mcp__delete_transaction' \
  --append-system-prompt 'Be concise: lead with the answer, keep tables compact.' \
  --model sonnet
