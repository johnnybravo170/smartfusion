'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ComponentType, ReactNode } from 'react';
import { cn } from '@/lib/utils';

type NavLinkProps = {
  href: string;
  icon?: ComponentType<{ className?: string }>;
  children: ReactNode;
  onNavigate?: () => void;
  className?: string;
  /** When true, the label is hidden and tooltip-only — used by the collapsed sidebar. */
  collapsed?: boolean;
  /** Plain-text version of the label, used as the title attribute when collapsed. */
  label?: string;
};

export function NavLink({
  href,
  icon: Icon,
  children,
  onNavigate,
  className,
  collapsed = false,
  label,
}: NavLinkProps) {
  const pathname = usePathname();
  const isActive = pathname === href || pathname?.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={isActive ? 'page' : undefined}
      data-active={isActive ? 'true' : undefined}
      title={collapsed ? (label ?? undefined) : undefined}
      className={cn(
        'flex items-center rounded-md text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
        collapsed ? 'justify-center px-2 py-1.5' : 'gap-2.5 px-3 py-1.5',
        isActive && 'bg-muted text-foreground',
        className,
      )}
    >
      {Icon ? <Icon className="size-4" /> : null}
      {collapsed ? null : <span>{children}</span>}
    </Link>
  );
}
