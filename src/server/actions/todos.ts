'use server';

/**
 * Server actions for the Todos module.
 *
 * Todos are tenant-scoped via RLS and additionally user-scoped — every row
 * carries `user_id` set to the calling user. Only the owner can see/modify
 * their todos. We never call the admin client here: inserts go through the
 * RLS-aware server client so the tenant check fires at the database.
 *
 * Spec: PHASE_1_PLAN.md §8 Track E.
 */

import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';
import {
  emptyToNull,
  todoCreateSchema,
  todoToggleSchema,
  todoUpdateSchema,
} from '@/lib/validators/todo';

export type TodoActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export type TodoFormInput = {
  title: string;
  due_date?: string;
  related_type?: string;
  related_id?: string;
};

export async function createTodoAction(input: TodoFormInput): Promise<TodoActionResult> {
  const parsed = todoCreateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: 'Not signed in.' };
  }

  const { data, error } = await supabase
    .from('todos')
    .insert({
      tenant_id: tenant.id,
      user_id: user.id,
      title: parsed.data.title,
      due_date: emptyToNull(parsed.data.due_date),
      related_type: parsed.data.related_type ?? null,
      related_id: emptyToNull(parsed.data.related_id),
    })
    .select('id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Failed to create todo.' };
  }

  revalidatePath('/inbox');
  return { ok: true, id: data.id };
}

export async function updateTodoAction(
  input: TodoFormInput & { id: string },
): Promise<TodoActionResult> {
  const parsed = todoUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: 'Not signed in.' };
  }

  const { error } = await supabase
    .from('todos')
    .update({
      title: parsed.data.title,
      due_date: emptyToNull(parsed.data.due_date),
      related_type: parsed.data.related_type ?? null,
      related_id: emptyToNull(parsed.data.related_id),
      updated_at: new Date().toISOString(),
    })
    .eq('id', parsed.data.id)
    .eq('user_id', user.id);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath('/inbox');
  return { ok: true, id: parsed.data.id };
}

export async function toggleTodoAction(input: {
  id: string;
  done: boolean;
}): Promise<TodoActionResult> {
  const parsed = todoToggleSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Invalid todo toggle.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: 'Not signed in.' };
  }

  const { error } = await supabase
    .from('todos')
    .update({ done: parsed.data.done, updated_at: new Date().toISOString() })
    .eq('id', parsed.data.id)
    .eq('user_id', user.id);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath('/inbox');
  return { ok: true, id: parsed.data.id };
}

/**
 * Hard delete. Todos aren't referenced elsewhere so there's no history to
 * preserve — removing the row keeps the list clean.
 */
export async function deleteTodoAction(id: string): Promise<TodoActionResult> {
  if (!id || typeof id !== 'string') {
    return { ok: false, error: 'Missing todo id.' };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: 'Not signed in.' };
  }

  const { error } = await supabase.from('todos').delete().eq('id', id).eq('user_id', user.id);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath('/inbox');
  return { ok: true, id };
}
