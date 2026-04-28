import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NavLink } from '@/components/layout/nav-link';
import { SidebarNav } from '@/components/layout/sidebar';
import type { VerticalNavItem } from '@/lib/verticals/load-pack';

const pathnameMock = vi.hoisted(() => vi.fn<() => string>());

vi.mock('next/navigation', () => ({
  usePathname: pathnameMock,
}));

const TEST_NAV: VerticalNavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: 'LayoutDashboard' },
  { href: '/contacts', label: 'Contacts', icon: 'Users' },
  { href: '/quotes', label: 'Quotes', icon: 'FileText' },
  { href: '/jobs', label: 'Jobs', icon: 'ClipboardList' },
  { href: '/invoices', label: 'Invoices', icon: 'Receipt' },
  { href: '/inbox', label: 'Inbox', icon: 'Inbox' },
  { href: '/settings/team', label: 'Team', icon: 'UserCog' },
  { href: '/referrals', label: 'Refer & Earn', icon: 'Gift' },
  { href: '/settings', label: 'Settings', icon: 'Settings' },
];

describe('SidebarNav', () => {
  beforeEach(() => {
    pathnameMock.mockReset();
  });

  it('renders every nav item as a link', () => {
    pathnameMock.mockReturnValue('/dashboard');
    render(<SidebarNav navItems={TEST_NAV} />);

    for (const item of TEST_NAV) {
      const links = screen.getAllByRole('link', { name: new RegExp(item.label, 'i') });
      expect(links.length).toBeGreaterThan(0);
      expect(links[0]).toHaveAttribute('href', item.href);
    }
  });
});

describe('NavLink active state', () => {
  beforeEach(() => {
    pathnameMock.mockReset();
  });

  it('marks link as active when pathname matches href exactly', () => {
    pathnameMock.mockReturnValue('/quotes');
    render(<NavLink href="/quotes">Quotes</NavLink>);
    const link = screen.getByRole('link', { name: 'Quotes' });
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(link).toHaveAttribute('data-active', 'true');
  });

  it('marks link as active when pathname is a nested route', () => {
    pathnameMock.mockReturnValue('/quotes/new');
    render(<NavLink href="/quotes">Quotes</NavLink>);
    const link = screen.getByRole('link', { name: 'Quotes' });
    expect(link).toHaveAttribute('aria-current', 'page');
  });

  it('does not mark link as active when pathname does not match', () => {
    pathnameMock.mockReturnValue('/dashboard');
    render(<NavLink href="/quotes">Quotes</NavLink>);
    const link = screen.getByRole('link', { name: 'Quotes' });
    expect(link).not.toHaveAttribute('aria-current');
    expect(link).not.toHaveAttribute('data-active');
  });

  it('does not match partial path prefixes', () => {
    pathnameMock.mockReturnValue('/quotesy');
    render(<NavLink href="/quotes">Quotes</NavLink>);
    const link = screen.getByRole('link', { name: 'Quotes' });
    expect(link).not.toHaveAttribute('aria-current');
  });
});
