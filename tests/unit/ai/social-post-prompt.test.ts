import { describe, expect, it } from 'vitest';
import { buildSocialPrompt } from '@/app/api/social-post/route';

describe('buildSocialPrompt', () => {
  it('includes the platform name in the user prompt', () => {
    const { user } = buildSocialPrompt({
      platform: 'instagram',
      businessName: 'Sparkle Wash',
    });
    expect(user).toContain('instagram');
  });

  it('includes the business name in the user prompt', () => {
    const { user } = buildSocialPrompt({
      platform: 'facebook',
      businessName: 'Sparkle Wash',
    });
    expect(user).toContain('Sparkle Wash');
  });

  it('includes the city when provided', () => {
    const { user } = buildSocialPrompt({
      platform: 'instagram',
      city: 'Abbotsford',
      businessName: 'Sparkle Wash',
    });
    expect(user).toContain('Abbotsford');
  });

  it('omits city line when city is null', () => {
    const { user } = buildSocialPrompt({
      platform: 'instagram',
      city: null,
      businessName: 'Sparkle Wash',
    });
    expect(user).not.toContain('Customer area');
  });

  it('includes surface types when provided', () => {
    const { user } = buildSocialPrompt({
      platform: 'instagram',
      surfaces: ['Driveway', 'Patio'],
      businessName: 'Sparkle Wash',
    });
    expect(user).toContain('Driveway');
    expect(user).toContain('Patio');
  });

  it('omits surfaces line when array is empty', () => {
    const { user } = buildSocialPrompt({
      platform: 'instagram',
      surfaces: [],
      businessName: 'Sparkle Wash',
    });
    expect(user).not.toContain('Surfaces cleaned');
  });

  it('system prompt mentions pressure washing', () => {
    const { system } = buildSocialPrompt({
      platform: 'instagram',
      businessName: 'Sparkle Wash',
    });
    expect(system).toContain('pressure washing');
  });

  it('requests JSON output', () => {
    const { user } = buildSocialPrompt({
      platform: 'facebook',
      businessName: 'Sparkle Wash',
    });
    expect(user).toContain('JSON');
  });

  it('renders weekday + time-of-day in the contractor tenant timezone', () => {
    // 2026-05-08T05:00:00Z → Vancouver: Thursday May 7, 22:00 (evening)
    //                       Toronto:    Friday May 8, 01:00 (morning)
    // Without tz support, both would bucket as the runtime tz's hour —
    // wrong for a contractor in either zone if the route runs on UTC.
    const completedAt = '2026-05-08T05:00:00Z';

    const vancouver = buildSocialPrompt({
      platform: 'instagram',
      businessName: 'Sparkle Wash',
      completedAt,
      timezone: 'America/Vancouver',
    });
    expect(vancouver.user).toContain('Thursday evening');

    const toronto = buildSocialPrompt({
      platform: 'instagram',
      businessName: 'Sparkle Wash',
      completedAt,
      timezone: 'America/Toronto',
    });
    expect(toronto.user).toContain('Friday morning');
  });

  it('falls back to America/Vancouver when timezone is omitted', () => {
    const { user } = buildSocialPrompt({
      platform: 'instagram',
      businessName: 'Sparkle Wash',
      completedAt: '2026-05-08T05:00:00Z',
    });
    // Vancouver is UTC-7 in May (PDT) → Thu 22:00 → evening
    expect(user).toContain('Thursday evening');
  });
});
