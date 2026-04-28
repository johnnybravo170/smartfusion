'use client';

import { Check, ChevronsUpDown, Circle } from 'lucide-react';
import Link from 'next/link';
import { useTransition } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { UserMembership } from '@/lib/db/queries/memberships';
import { switchActiveTenantAction } from '@/server/actions/tenants';

type Props = {
  memberships: UserMembership[];
  activeTenantId: string | null;
};

export function WorkspaceSwitcher({ memberships, activeTenantId }: Props) {
  const [pending, startTransition] = useTransition();
  const active = memberships.find((m) => m.tenantId === activeTenantId) ?? memberships[0];
  const others = memberships.filter((m) => m.tenantId !== active?.tenantId);

  function handleSwitch(tenantId: string) {
    startTransition(async () => {
      const res = await switchActiveTenantAction({ tenantId });
      if (!res.ok) {
        // Fail-loud: alert is fine for V1; full toast system can come later.
        alert(`Could not switch workspace: ${res.error}`);
      }
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label="Workspace menu"
          disabled={pending}
          className="gap-1.5"
        >
          {active?.accentColor ? (
            <Circle
              className="size-2.5 shrink-0 fill-current"
              style={{ color: active.accentColor }}
              aria-hidden
            />
          ) : null}
          <span className="max-w-[10rem] truncate">{active?.tenantName ?? 'Account'}</span>
          {memberships.length > 1 ? <ChevronsUpDown className="size-3.5 opacity-60" /> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {active ? (
          <>
            <DropdownMenuLabel className="flex items-center gap-2">
              {active.accentColor ? (
                <span
                  className="inline-block size-2.5 rounded-full"
                  style={{ backgroundColor: active.accentColor }}
                  aria-hidden
                />
              ) : null}
              <span className="flex-1 truncate font-medium">{active.tenantName}</span>
              {active.isDemo ? (
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900">
                  Demo
                </span>
              ) : null}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        ) : null}

        {others.length > 0 ? (
          <>
            <DropdownMenuLabel className="text-muted-foreground text-xs uppercase tracking-wide">
              Switch workspace
            </DropdownMenuLabel>
            {others.map((m) => (
              <DropdownMenuItem
                key={m.tenantId}
                onSelect={(e) => {
                  e.preventDefault();
                  handleSwitch(m.tenantId);
                }}
                className="gap-2"
              >
                {m.accentColor ? (
                  <span
                    className="inline-block size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: m.accentColor }}
                    aria-hidden
                  />
                ) : (
                  <span className="inline-block size-2.5 shrink-0" aria-hidden />
                )}
                <span className="flex-1 truncate">{m.tenantName}</span>
                {m.isDemo ? (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900">
                    Demo
                  </span>
                ) : null}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        ) : null}

        <DropdownMenuItem asChild>
          <Link href="/settings">Profile &amp; settings</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/logout">Log out</Link>
        </DropdownMenuItem>

        {active && (
          <DropdownMenuItem disabled className="justify-center text-muted-foreground text-xs">
            <Check className="mr-1 size-3" /> {memberships.length} workspace
            {memberships.length === 1 ? '' : 's'}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
