/**
 * Expense category queries (tenant-scoped via RLS).
 *
 * Categories form a two-level tree: parents at the top, children nested
 * one level deep (e.g. "Vehicles" → "Truck 1"). DB-level trigger enforces
 * the depth cap. Archived categories are kept for FK integrity but
 * filtered out of the active listings.
 */

import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';

export type ExpenseCategoryRow = {
  id: string;
  tenant_id: string;
  parent_id: string | null;
  name: string;
  account_code: string | null;
  display_order: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ExpenseCategoryTreeNode = ExpenseCategoryRow & {
  children: ExpenseCategoryRow[];
};

const CATEGORY_COLUMNS =
  'id, tenant_id, parent_id, name, account_code, display_order, archived_at, created_at, updated_at';

async function listExpenseCategoriesUncached(options?: {
  includeArchived?: boolean;
}): Promise<ExpenseCategoryRow[]> {
  const supabase = await createClient();
  let query = supabase
    .from('expense_categories')
    .select(CATEGORY_COLUMNS)
    .order('display_order', { ascending: true })
    .order('name', { ascending: true });

  if (!options?.includeArchived) {
    query = query.is('archived_at', null);
  }
  const { data, error } = await query;
  if (error) throw new Error(`Failed to list expense categories: ${error.message}`);
  return (data ?? []) as ExpenseCategoryRow[];
}

export const listExpenseCategories = cache(listExpenseCategoriesUncached);

/** Nest a flat row list into parent → children. */
export function buildCategoryTree(rows: ExpenseCategoryRow[]): ExpenseCategoryTreeNode[] {
  const byId = new Map<string, ExpenseCategoryTreeNode>();
  const roots: ExpenseCategoryTreeNode[] = [];
  for (const r of rows) {
    byId.set(r.id, { ...r, children: [] });
  }
  for (const r of rows) {
    const node = byId.get(r.id);
    if (!node) continue;
    if (r.parent_id) {
      const parent = byId.get(r.parent_id);
      if (parent) parent.children.push(node);
      else roots.push(node); // orphan — shouldn't happen, but defensive
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/**
 * Returns the flat list as choices for a category picker — parent names
 * with their children indented. Parents that have children are disabled
 * in the UI (operators can't log directly to a parent with children).
 */
export type CategoryPickerOption = {
  id: string;
  label: string;
  /** When true, the option is a parent with children — should not be selectable. */
  isParentHeader: boolean;
  parent_id: string | null;
};

export function buildPickerOptions(tree: ExpenseCategoryTreeNode[]): CategoryPickerOption[] {
  const options: CategoryPickerOption[] = [];
  for (const parent of tree) {
    const hasChildren = parent.children.length > 0;
    options.push({
      id: parent.id,
      label: parent.name,
      isParentHeader: hasChildren,
      parent_id: null,
    });
    for (const child of parent.children) {
      options.push({
        id: child.id,
        label: `${parent.name} › ${child.name}`,
        isParentHeader: false,
        parent_id: parent.id,
      });
    }
  }
  return options;
}
