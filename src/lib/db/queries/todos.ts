/**
 * Todo queries that run through the RLS-aware Supabase server client.
 *
 * Tenant isolation is enforced by `current_tenant_id()` in the `todos` RLS
 * policies (see migration 0016). Todos are additionally per-user: we filter
 * by `user_id = auth.uid()` in application code so Will's todos don't appear
 * on Jonathan's inbox when they share a tenant.
 *
 * See PHASE_1_PLAN.md §8 Track E.
 */

import { createClient } from '@/lib/supabase/server';
import type { TodoRelatedType } from '@/lib/validators/todo';

export type TodoRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  title: string;
  done: boolean;
  due_date: string | null;
  related_type: TodoRelatedType | null;
  related_id: string | null;
  created_at: string;
  updated_at: string;
};

export type TodoListFilters = {
  done?: boolean;
  related_type?: TodoRelatedType;
  related_id?: string;
  limit?: number;
  offset?: number;
};

const TODO_COLUMNS =
  'id, tenant_id, user_id, title, done, due_date, related_type, related_id, created_at, updated_at';

async function getAuthUserId(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

/**
 * List the current user's todos for the current tenant. Returns `[]` when
 * the user is unauthenticated rather than throwing, because the Inbox page
 * tolerates an anonymous render during the redirect to /login.
 */
export async function listTodos(filters: TodoListFilters = {}): Promise<TodoRow[]> {
  const userId = await getAuthUserId();
  if (!userId) return [];

  const supabase = await createClient();
  const limit = filters.limit ?? 200;
  const offset = filters.offset ?? 0;

  let query = supabase.from('todos').select(TODO_COLUMNS).eq('user_id', userId);

  if (filters.done !== undefined) query = query.eq('done', filters.done);
  if (filters.related_type) query = query.eq('related_type', filters.related_type);
  if (filters.related_id) query = query.eq('related_id', filters.related_id);

  const { data, error } = await query
    // Not-yet-due first, then by due date ascending; undated rows last.
    .order('due_date', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    throw new Error(`Failed to list todos: ${error.message}`);
  }
  return (data ?? []) as TodoRow[];
}

export async function getTodo(id: string): Promise<TodoRow | null> {
  const userId = await getAuthUserId();
  if (!userId) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('todos')
    .select(TODO_COLUMNS)
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to load todo: ${error.message}`);
  }
  return (data as TodoRow | null) ?? null;
}

export async function countTodos(filters: Pick<TodoListFilters, 'done'> = {}): Promise<number> {
  const userId = await getAuthUserId();
  if (!userId) return 0;

  const supabase = await createClient();
  let query = supabase
    .from('todos')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);
  if (filters.done !== undefined) query = query.eq('done', filters.done);

  const { count, error } = await query;
  if (error) {
    throw new Error(`Failed to count todos: ${error.message}`);
  }
  return count ?? 0;
}
