import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerAllPrompts(server: McpServer): void {
  server.prompt(
    'monthly-review',
    'Review your budget for a specific month — checks spending vs budget, highlights overspending, and suggests adjustments.',
    { month: z.string().optional().describe('Month to review (YYYY-MM or natural language). Defaults to current month.') },
    async ({ month }) => {
      const monthStr = month || 'this month';
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Please do a complete budget review for ${monthStr}. Follow these steps:

1. First, use get_budget_summary to get the overview for ${monthStr}
2. Then use budget_vs_actual to see which categories are over or under budget
3. Use spending_by_category to see where the money went
4. Finally, give me:
   - A summary of how the month went
   - Which categories went over budget and by how much
   - Which categories had unused budget
   - Suggestions for next month's budget adjustments
   - My savings rate and whether it's improving

Keep the analysis concise and actionable.`,
            },
          },
        ],
      };
    },
  );

  server.prompt(
    'spending-check',
    'Quick check on current month spending — are you on track or overspending?',
    {},
    async () => {
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Do a quick spending check for this month:

1. Use spending_projection to see if I'm on track
2. Use budget_vs_actual to find any categories already over budget
3. Give me a brief summary:
   - Am I on track overall?
   - Which categories should I watch?
   - How much can I still spend this month?

Keep it short — just the key numbers and warnings.`,
            },
          },
        ],
      };
    },
  );

  server.prompt(
    'spending-patterns',
    'Deep analysis of spending patterns and trends over the last few months.',
    { months: z.string().optional().describe('Number of months to analyze (default 6)') },
    async ({ months }) => {
      const monthCount = months || '6';
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Analyze my financial patterns over the last ${monthCount} months:

1. Use monthly_summary with months=${monthCount} for the big picture
2. Use category_trends to see which categories are increasing/decreasing
3. Use get_budget_summary for the current month
4. Provide insights:
   - Overall spending trend (going up or down?)
   - Categories with the biggest changes
   - Savings rate trend
   - Unusual spending patterns
   - Concrete suggestions to improve my finances

Be specific with numbers and percentages.`,
            },
          },
        ],
      };
    },
  );
}
