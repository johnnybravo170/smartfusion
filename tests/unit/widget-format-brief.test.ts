import { describe, expect, it } from 'vitest';

import { formatWidgetBriefText } from '@/lib/widget/format-brief';

describe('formatWidgetBriefText', () => {
  it('renders the full envelope with email present', () => {
    const out = formatWidgetBriefText({
      name: 'Jane Homeowner',
      phone: '+1 604 555 0100',
      email: 'jane@example.com',
      description: 'Need a quote on a kitchen reno.\nBudget around 30k.',
    });

    expect(out).toContain('Submitted via website lead form');
    expect(out).toContain('Name: Jane Homeowner');
    expect(out).toContain('Phone: +1 604 555 0100');
    expect(out).toContain('Email: jane@example.com');
    expect(out).toContain('Need a quote on a kitchen reno.');
    expect(out).toContain('Budget around 30k.');
  });

  it('omits the Email line when email is null', () => {
    const out = formatWidgetBriefText({
      name: 'Pat',
      phone: '604-555-0101',
      email: null,
      description: 'Pressure-wash driveway please.',
    });

    expect(out).not.toContain('Email:');
    expect(out).toContain('Name: Pat');
    expect(out).toContain('Phone: 604-555-0101');
  });

  it('caps pasted_text length so the column never explodes', () => {
    const huge = 'A'.repeat(40_000);
    const out = formatWidgetBriefText({
      name: 'X',
      phone: 'Y',
      email: null,
      description: huge,
    });
    expect(out.length).toBeLessThanOrEqual(16_000);
  });
});
