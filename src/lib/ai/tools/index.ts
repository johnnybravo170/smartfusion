import type { AiTool, ToolDefinition } from '../types';
import { catalogTools } from './catalog';
import { changeOrderTools } from './change-orders';
import { customerTools } from './customers';
import { dashboardTools, setDashboardTimezone } from './dashboard';
import { invoiceTools, setInvoiceTimezone } from './invoices';
import { jobTools } from './jobs';
import { projectTools } from './projects';
import { quoteTools } from './quotes';
import { smsTools } from './sms';
import { timeExpenseTools } from './time-expenses';
import { todoTools } from './todos';
import { worklogTools } from './worklog';

/** Core tools available to all verticals. */
const coreTools: AiTool[] = [
  ...dashboardTools,
  ...customerTools,
  ...quoteTools,
  ...jobTools,
  ...invoiceTools,
  ...todoTools,
  ...worklogTools,
  ...catalogTools,
  ...smsTools,
];

/** Renovation-specific tools (projects, budget, time/expense, change orders). */
const renovationTools: AiTool[] = [...projectTools, ...timeExpenseTools, ...changeOrderTools];

/** All 37 tools registered for the AI chat. */
export const allTools: AiTool[] = [...coreTools, ...renovationTools];

/** Build a handler lookup map for fast dispatch. */
const handlerMap = new Map<string, AiTool['handler']>();
for (const tool of allTools) {
  handlerMap.set(tool.definition.name, tool.handler);
}

/**
 * Returns ToolDefinition[] for the Claude API `tools` parameter.
 * When vertical is provided, only returns tools relevant to that vertical.
 */
export function getToolDefinitions(vertical?: string): ToolDefinition[] {
  if (vertical === 'renovation' || vertical === 'tile') {
    return allTools.map((t) => t.definition);
  }
  // Pressure washing: core tools only
  return coreTools.map((t) => t.definition);
}

/**
 * Set the timezone used by dashboard and invoice tools.
 * Call this before executing tool calls in the API route.
 */
export function setToolTimezone(timezone: string) {
  setDashboardTimezone(timezone);
  setInvoiceTimezone(timezone);
}

/**
 * Dispatch a tool call by name. Returns the result string.
 * If the tool is not found, returns an error string (never throws).
 */
export async function executeToolCall(
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  const handler = handlerMap.get(name);
  if (!handler) {
    return `Unknown tool: "${name}". Available tools: ${allTools.map((t) => t.definition.name).join(', ')}`;
  }
  try {
    return await handler(input);
  } catch (e) {
    return `Tool "${name}" failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}
