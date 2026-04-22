import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NavLink } from '@/components/layout/nav-link';
import { SidebarNav } from '@/components/layout/sidebar';
import { NAV_ITEMS } from '@/lib/constants/nav';

const pathnameMock = vi.hoisted(() => vi.fn<() => string>());

vi.mock('next/navigation', () => ({
  usePathname: pathnameMock,
}));

describe('NAV_ITEMS', () => {
  it('contains all nine nav items', () => {
    expect(NAV_ITEMS).toHaveLength(9);
    const hrefs = NAV_ITEMS.map((item) => item.href);
    expect(hrefs).toEqual([
      '/dashboard',
      '/customers',
      '/quotes',
      '/jobs',
      '/invoices',
      '/inbox',
      '/settings/team',
      '/referrals',
      '/settings',
    ]);
  });

  it('every nav item has a label and an icon component', () => {
    for (const item of NAV_ITEMS) {
      expect(item.label).toBeTruthy();
      expect(item.icon).toBeTypeOf('object');
    }
  });
});

describe('SidebarNav', () => {
  beforeEach(() => {
    pathnameMock.mockReset();
  });

  it('renders every nav item as a link', () => {
    pathnameMock.mockReturnValue('/dashboard');
    render(<SidebarNav />);

    for (const item of NAV_ITEMS) {
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
