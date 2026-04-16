'use client';

/**
 * Groups todos into four collapsible sections: Overdue, Today, Upcoming,
 * Done. "Done" starts collapsed; the rest start expanded. Each section is
 * hidden entirely when empty to keep the page short.
 */

import { ChevronDown } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { TodoRow } from '@/lib/db/queries/todos';
import { todoDueBucket } from './relative-time';
import { TodoItem } from './todo-item';

type SectionKey = 'overdue' | 'today' | 'upcoming' | 'done';

const SECTION_LABELS: Record<SectionKey, string> = {
  overdue: 'Overdue',
  today: 'Today',
  upcoming: 'Upcoming',
  done: 'Done',
};

function partition(todos: TodoRow[]): Record<SectionKey, TodoRow[]> {
  const sections: Record<SectionKey, TodoRow[]> = {
    overdue: [],
    today: [],
    upcoming: [],
    done: [],
  };
  for (const todo of todos) {
    if (todo.done) {
      sections.done.push(todo);
      continue;
    }
    const bucket = todoDueBucket(todo.due_date);
    if (bucket === 'overdue') sections.overdue.push(todo);
    else if (bucket === 'today') sections.today.push(todo);
    else sections.upcoming.push(todo);
  }
  return sections;
}

function Section({
  label,
  count,
  defaultOpen = true,
  children,
}: {
  label: string;
  count: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-2">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex items-center justify-between rounded-md px-1 py-1 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          <span>
            {label} <span className="font-normal text-muted-foreground/70">({count})</span>
          </span>
          <ChevronDown className={`size-3.5 transition-transform ${open ? '' : '-rotate-90'}`} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2">{children}</CollapsibleContent>
    </Collapsible>
  );
}

export function TodoList({ todos }: { todos: TodoRow[] }) {
  const sections = partition(todos);

  return (
    <div className="flex flex-col gap-5">
      {(['overdue', 'today', 'upcoming', 'done'] as SectionKey[]).map((key) => {
        const items = sections[key];
        if (items.length === 0) return null;
        return (
          <Section
            key={key}
            label={SECTION_LABELS[key]}
            count={items.length}
            defaultOpen={key !== 'done'}
          >
            {items.map((todo) => (
              <TodoItem key={todo.id} todo={todo} />
            ))}
          </Section>
        );
      })}
    </div>
  );
}
