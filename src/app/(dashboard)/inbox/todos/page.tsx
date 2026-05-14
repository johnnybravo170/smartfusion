/**
 * Inbox → Todos sub-route. Layout (`../layout.tsx`) renders the header
 * + tab nav; this page only renders the todos content.
 */

import { TodoEmptyState } from '@/components/features/inbox/todo-empty-state';
import { TodoForm } from '@/components/features/inbox/todo-form';
import { TodoList } from '@/components/features/inbox/todo-list';
import { listTodos } from '@/lib/db/queries/todos';

export const metadata = { title: 'Todos — Inbox — HeyHenry' };

export default async function InboxTodosPage() {
  const todos = await listTodos({ limit: 200 });
  return (
    <>
      <TodoForm />
      {todos.length === 0 ? <TodoEmptyState /> : <TodoList todos={todos} />}
    </>
  );
}
