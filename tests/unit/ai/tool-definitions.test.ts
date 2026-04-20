import { describe, expect, it } from 'vitest';
import { allTools, executeToolCall, getToolDefinitions } from '@/lib/ai/tools';

describe('AI tool definitions', () => {
  it('exports a stable number of tools', () => {
    // Bump this when intentionally adding/removing tools. Hard-coded so
    // drift is caught in CI instead of surfacing as a runtime surprise.
    expect(allTools).toHaveLength(45);
  });

  it('each tool has a name, description, and valid input_schema', () => {
    for (const tool of allTools) {
      expect(tool.definition.name).toBeTruthy();
      expect(typeof tool.definition.name).toBe('string');
      expect(tool.definition.description).toBeTruthy();
      expect(typeof tool.definition.description).toBe('string');
      expect(tool.definition.input_schema).toBeDefined();
      expect(tool.definition.input_schema.type).toBe('object');
      expect(typeof tool.definition.input_schema.properties).toBe('object');
    }
  });

  it('has no duplicate tool names', () => {
    const names = allTools.map((t) => t.definition.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it('getToolDefinitions returns core tools when no vertical specified', () => {
    const defs = getToolDefinitions();
    expect(defs).toHaveLength(31);
  });

  it('getToolDefinitions returns all tools (33) for renovation vertical', () => {
    const defs = getToolDefinitions('renovation');
    expect(defs).toHaveLength(allTools.length);
    for (let i = 0; i < defs.length; i++) {
      expect(defs[i].name).toBe(allTools[i].definition.name);
      expect(defs[i].description).toBe(allTools[i].definition.description);
    }
  });

  it('executeToolCall returns error string for unknown tool', async () => {
    const result = await executeToolCall('nonexistent_tool', {});
    expect(typeof result).toBe('string');
    expect(result).toContain('Unknown tool');
    expect(result).toContain('nonexistent_tool');
  });

  it('all expected tool names are present', () => {
    const expectedNames = [
      'get_dashboard',
      'list_customers',
      'get_customer',
      'create_customer',
      'update_customer',
      'list_quotes',
      'get_quote',
      'create_quote',
      'send_quote',
      'list_jobs',
      'get_job',
      'update_job_status',
      'create_job',
      'schedule_job',
      'list_invoices',
      'get_revenue_summary',
      'create_invoice',
      'send_invoice',
      'list_todos',
      'create_todo',
      'complete_todo',
      'search_worklog',
      'add_worklog_note',
      'list_catalog',
      'send_sms',
      // Renovation tools
      'list_projects',
      'get_project',
      'create_project',
      'update_project_status',
      'get_project_budget',
      'log_time',
      'log_expense',
      'list_time_entries',
      'list_expenses',
    ];
    const actualNames = allTools.map((t) => t.definition.name);
    for (const name of expectedNames) {
      expect(actualNames).toContain(name);
    }
  });
});
