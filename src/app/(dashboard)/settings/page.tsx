import {
  Bell,
  Bot,
  Building2,
  ChevronRight,
  CreditCard,
  FileText,
  HardHat,
  Layers,
  Mic,
  Ruler,
  ShieldCheck,
  Tag,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { Suspense } from 'react';
import { CalendarFeedCard } from '@/components/features/settings/calendar-feed-card';
import { DataExportCard } from '@/components/features/settings/data-export-card';
import { PublicQuoteLinkCard } from '@/components/features/settings/public-quote-link-card';
import { QuoteSettingsCard } from '@/components/features/settings/quote-settings-card';
import { StripeConnectCard } from '@/components/features/settings/stripe-connect-card';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

async function StripeSection() {
  const tenant = await getCurrentTenant();
  if (!tenant) return null;

  const supabase = await createClient();
  const { data } = await supabase
    .from('tenants')
    .select('stripe_account_id, stripe_onboarded_at')
    .eq('id', tenant.id)
    .single();

  return (
    <StripeConnectCard
      stripeAccountId={(data?.stripe_account_id as string) ?? null}
      stripeOnboardedAt={(data?.stripe_onboarded_at as string) ?? null}
    />
  );
}

async function QuoteSettingsSection() {
  const tenant = await getCurrentTenant();
  if (!tenant) return null;

  const supabase = await createClient();
  const { data } = await supabase
    .from('tenants')
    .select('quote_validity_days')
    .eq('id', tenant.id)
    .single();

  const validityDays = (data?.quote_validity_days as number) ?? 30;

  return <QuoteSettingsCard currentValidityDays={validityDays} />;
}

async function PublicQuoteLinkSection() {
  const tenant = await getCurrentTenant();
  if (!tenant) return null;

  return <PublicQuoteLinkCard currentSlug={tenant.slug} businessName={tenant.name} />;
}

async function ExportSection() {
  const tenant = await getCurrentTenant();
  if (!tenant) return null;

  const supabase = await createClient();
  const { data: lastExport } = await supabase
    .from('data_exports')
    .select('download_url, created_at, status, expires_at')
    .eq('status', 'ready')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Only show the link if it hasn't expired.
  const isExpired = lastExport?.expires_at
    ? new Date(lastExport.expires_at as string) < new Date()
    : true;

  return (
    <DataExportCard
      lastExportUrl={!isExpired ? ((lastExport?.download_url as string) ?? null) : null}
      lastExportDate={lastExport?.created_at ? (lastExport.created_at as string) : null}
    />
  );
}

async function CalendarSection() {
  const tenant = await getCurrentTenant();
  if (!tenant?.slug) return null;

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.heyhenry.io';
  const feedUrl = `${baseUrl}/api/calendar/${tenant.slug}.ics`;

  return <CalendarFeedCard feedUrl={feedUrl} />;
}

function VoiceSection() {
  const isConfigured = !!process.env.ELEVENLABS_API_KEY && !!process.env.ELEVENLABS_VOICE_ID;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Mic className="size-5" />
          <div>
            <CardTitle>Voice</CardTitle>
            <CardDescription>
              {isConfigured
                ? 'Using ElevenLabs for natural text-to-speech.'
                : 'Using browser default voice. Configure ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in environment variables to enable natural voice.'}
            </CardDescription>
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Current: {isConfigured ? 'ElevenLabs' : 'Browser (default)'}
        </p>
      </CardHeader>
    </Card>
  );
}

export default function SettingsPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage your account, payments, and preferences.
        </p>
      </div>

      <Link href="/settings/profile" className="block">
        <Card className="transition-colors hover:bg-muted/50">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Building2 className="size-5" />
                <div>
                  <CardTitle>Business profile</CardTitle>
                  <CardDescription>
                    Logo, contact info, socials, and how you sign off on emails.
                  </CardDescription>
                </div>
              </div>
              <ChevronRight className="size-5 text-muted-foreground" />
            </div>
          </CardHeader>
        </Card>
      </Link>

      <Link href="/settings/billing" className="block">
        <Card className="transition-colors hover:bg-muted/50">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CreditCard className="size-5" />
                <div>
                  <CardTitle>Billing</CardTitle>
                  <CardDescription>
                    Plan, payment method, and self-serve cancellation.
                  </CardDescription>
                </div>
              </div>
              <ChevronRight className="size-5 text-muted-foreground" />
            </div>
          </CardHeader>
        </Card>
      </Link>

      <Link href="/settings/security" className="block">
        <Card className="transition-colors hover:bg-muted/50">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldCheck className="size-5" />
                <div>
                  <CardTitle>Security</CardTitle>
                  <CardDescription>
                    Two-factor authentication and account protection.
                  </CardDescription>
                </div>
              </div>
              <ChevronRight className="size-5 text-muted-foreground" />
            </div>
          </CardHeader>
        </Card>
      </Link>

      <Suspense fallback={<div className="h-48 animate-pulse rounded-xl border bg-card" />}>
        <StripeSection />
      </Suspense>

      <Suspense fallback={<div className="h-48 animate-pulse rounded-xl border bg-card" />}>
        <PublicQuoteLinkSection />
      </Suspense>

      <Link href="/settings/automations" className="block">
        <Card className="transition-colors hover:bg-muted/50">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Bot className="size-5" />
                <div>
                  <CardTitle>Automations</CardTitle>
                  <CardDescription>
                    Quote follow-ups and other background sequences Henry runs for you.
                  </CardDescription>
                </div>
              </div>
              <ChevronRight className="size-5 text-muted-foreground" />
            </div>
          </CardHeader>
        </Card>
      </Link>

      <Link href="/settings/reminders" className="block">
        <Card className="transition-colors hover:bg-muted/50">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Bell className="size-5" />
                <div>
                  <CardTitle>Reminders</CardTitle>
                  <CardDescription>
                    Recurring SMS nudges to log time, log receipts, or review your week.
                  </CardDescription>
                </div>
              </div>
              <ChevronRight className="size-5 text-muted-foreground" />
            </div>
          </CardHeader>
        </Card>
      </Link>

      <Link href="/settings/team" className="block">
        <Card className="transition-colors hover:bg-muted/50">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users className="size-5" />
                <div>
                  <CardTitle>Team</CardTitle>
                  <CardDescription>Invite workers and manage your team.</CardDescription>
                </div>
              </div>
              <ChevronRight className="size-5 text-muted-foreground" />
            </div>
          </CardHeader>
        </Card>
      </Link>

      <Link href="/settings/catalog" className="block">
        <Card className="transition-colors hover:bg-muted/50">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Ruler className="size-5" />
                <div>
                  <CardTitle>Service Catalog</CardTitle>
                  <CardDescription>Surface types and pricing for your quotes.</CardDescription>
                </div>
              </div>
              <ChevronRight className="size-5 text-muted-foreground" />
            </div>
          </CardHeader>
        </Card>
      </Link>

      <Link href="/settings/cost-catalog" className="block">
        <Card className="transition-colors hover:bg-muted/50">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <HardHat className="size-5" />
                <div>
                  <CardTitle>Cost Catalog</CardTitle>
                  <CardDescription>
                    Materials, labour rates, and markup rules for GC projects.
                  </CardDescription>
                </div>
              </div>
              <ChevronRight className="size-5 text-muted-foreground" />
            </div>
          </CardHeader>
        </Card>
      </Link>

      <Link href="/settings/categories" className="block">
        <Card className="transition-colors hover:bg-muted/50">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Tag className="size-5" />
                <div>
                  <CardTitle>Expense categories</CardTitle>
                  <CardDescription>
                    Categories for overhead and project expenses. Optional account codes for your
                    bookkeeper.
                  </CardDescription>
                </div>
              </div>
              <ChevronRight className="size-5 text-muted-foreground" />
            </div>
          </CardHeader>
        </Card>
      </Link>

      <Link href="/settings/budget-category-templates" className="block">
        <Card className="transition-colors hover:bg-muted/50">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Layers className="size-5" />
                <div>
                  <CardTitle>Bucket Templates</CardTitle>
                  <CardDescription>
                    Reusable cost bucket sets applied when creating renovation projects.
                  </CardDescription>
                </div>
              </div>
              <ChevronRight className="size-5 text-muted-foreground" />
            </div>
          </CardHeader>
        </Card>
      </Link>

      <Link href="/settings/estimate-snippets" className="block">
        <Card className="transition-colors hover:bg-muted/50">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText className="size-5" />
                <div>
                  <CardTitle>Estimate Snippets</CardTitle>
                  <CardDescription>
                    Reusable boilerplate paragraphs (exclusions, change rates, acceptance terms)
                    that show up as one-click chips on the estimate editor.
                  </CardDescription>
                </div>
              </div>
              <ChevronRight className="size-5 text-muted-foreground" />
            </div>
          </CardHeader>
        </Card>
      </Link>

      <Suspense fallback={<div className="h-32 animate-pulse rounded-xl border bg-card" />}>
        <QuoteSettingsSection />
      </Suspense>

      <Suspense fallback={<div className="h-32 animate-pulse rounded-xl border bg-card" />}>
        <CalendarSection />
      </Suspense>

      <Suspense fallback={<div className="h-32 animate-pulse rounded-xl border bg-card" />}>
        <ExportSection />
      </Suspense>

      <VoiceSection />
    </div>
  );
}
