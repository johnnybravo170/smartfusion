'use client';

import { Menu, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { NAV_ITEMS } from '@/lib/constants/nav';
import { NavLink } from './nav-link';

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Primary" className="flex flex-col gap-1 p-3">
      {NAV_ITEMS.map((item) => (
        <NavLink key={item.href} href={item.href} icon={item.icon} onNavigate={onNavigate}>
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

export function SidebarNav() {
  return (
    <aside
      aria-label="Sidebar"
      className="hidden w-64 shrink-0 border-r bg-background md:flex md:flex-col"
    >
      <div className="flex h-14 items-center border-b px-4">
        <span className="text-sm font-semibold">HeyHenry</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        <NavList />
      </div>
    </aside>
  );
}

export function MobileSidebarToggle() {
  const [open, setOpen] = useState(false);

  return (
    <div className="md:hidden">
      <Button
        variant="ghost"
        size="icon"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Menu className="size-5" />
      </Button>

      {open ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-label="Close navigation overlay"
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <div
            className="absolute inset-y-0 left-0 w-64 border-r bg-background shadow-lg"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation menu"
          >
            <div className="flex h-14 items-center justify-between border-b px-4">
              <span className="text-sm font-semibold">HeyHenry</span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close menu"
                onClick={() => setOpen(false)}
              >
                <X className="size-5" />
              </Button>
            </div>
            <div className="overflow-y-auto">
              <NavList onNavigate={() => setOpen(false)} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
