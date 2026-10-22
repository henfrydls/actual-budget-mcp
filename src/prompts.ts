import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { offeredTools } from './tools/index.js';

/**
 * The tools each prompt tells the model to call (#222).
 *
 * A prompt here is a short script: "use spending_projection, then
 * budget_vs_actual, then tell me". With the chat toolset none of those three
 * is offered, so `prompts/list` returned three prompts that name five tools
 * `tools/list` does not have, and following one of them means calling
 * something that is not there.
 *
 * So a prompt is offered only when everything it names is. The lists are
 * here rather than inferred from the text because a prompt's text is prose,
 * and a test crosses the two so neither can drift from the other.
 */
const NEEDS: Record<string, string[]> = {
  'monthly-review': ['get_budget_summary', 'budget_vs_actual', 'spending_by_category'],
  'spending-check': ['spending_projection', 'budget_vs_actual'],
  'spending-patterns': ['monthly_summary', 'category_trends', 'get_budget_summary'],
};

/**
 * Register the prompts whose tools are all there.
 *
 * `offered` defaults to what `registerAllTools` just registered, which is why
 * the entry point registers the tools first. A test pins that order.
 */
export function registerAllPrompts(
  server: McpServer,
  offered: ReadonlySet<string> = offeredTools(),
): void {
  const has = (prompt: string) => (NEEDS[prompt] ?? []).every((tool) => offered.has(tool));

  if (has('monthly-review')) server.prompt(
    'monthly-review',
    'Review your budget for a specific month: checks spending vs budget, highlights overspending, and suggests adjustments.',
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

  if (has('spending-check')) server.prompt(
    'spending-check',
    'Quick check on current month spending. Are you on track, or overspending?',
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

Keep it short: just the key numbers and warnings.`,
            },
          },
        ],
      };
    },
  );

  if (has('spending-patterns')) server.prompt(
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
