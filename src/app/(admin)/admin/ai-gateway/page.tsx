/**
 * AG-8 — admin dashboard for the AI gateway.
 *
 * One screen, scannable in 10 seconds. Pulls live data from AG-5's
 * ai_calls table via AG-6's spend tracker; reads currently-open
 * circuit breakers from the in-memory router state.
 *
 * Restricted to platform admins by the (admin) layout's
 * requirePlatformAdmin() guard.
 */

import { AlertTriangle, Check, X } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  gateway,
  getProviderHealth,
  getProviderSpendMicros,
  getRecentFailures,
  getTierProgress,
  getTopTasksByCostMtd,
  getVoiceUsageMtd,
  microsToUsd,
  type ProviderName,
  type TierProgress,
  type VoiceUsageMtd,
} from '@/lib/ai-gateway';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'AI Gateway',
};

const PROVIDERS: ProviderName[] = ['openai', 'gemini', 'anthropic'];

export default async function AdminAiGatewayPage() {
  // Pull everything in parallel. With ai_calls indexed on (provider,
  // created_at DESC) and (created_at DESC), all of these are cheap.
  const [
    spendMtdByProvider,
    healthByProvider,
    tierProgressByProvider,
    topTasks,
    recentFailures,
    voiceUsage,
  ] = await Promise.all([
    Promise.all(PROVIDERS.map((p) => getProviderSpendMicros(p, 'mtd'))),
    Promise.all(PROVIDERS.map((p) => getProviderHealth(p, '24h'))),
    Promise.all(PROVIDERS.map((p) => getTierProgress(p))),
    getTopTasksByCostMtd(10),
    getRecentFailures(50),
    getVoiceUsageMtd(),
  ]);

  const openBreakers = gateway().openBreakers();
  const totalMtdMicros = spendMtdByProvider.reduce((acc, m) => acc + m, BigInt(0));

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">AI Gateway</h1>
        <p className="text-sm text-muted-foreground">
          Per-provider spend, health, and tier progress for the AI gateway. Restricted to platform
          admins. Refresh to update.
        </p>
      </header>

      {openBreakers.length > 0 ? (
        <Card className="border-rose-300 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/30">
          <CardHeader className="flex flex-row items-center gap-2 space-y-0">
            <AlertTriangle className="size-4 text-rose-600 dark:text-rose-400" />
            <CardTitle className="text-base">Circuit-broken right now</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1 text-sm">
              {openBreakers.map((b) => (
                <li key={b.provider}>
                  <strong>{b.provider}</strong> — open until {fmtRelative(b.open_until_iso)}{' '}
                  (window: {Math.round(b.last_window_ms / 60_000)} min)
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <CardDescription>Total spend MTD</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              ${microsToUsd(totalMtdMicros).toFixed(2)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              Sum across all providers. Uses our internal cost calc; verify against provider
              invoices monthly.
            </p>
          </CardContent>
        </Card>

        {PROVIDERS.map((p, i) => (
          <ProviderSpendCard
            key={p}
            provider={p}
            mtd_micros={spendMtdByProvider[i]}
            health={healthByProvider[i]}
          />
        ))}
      </div>

      <VoiceSessionCard usage={voiceUsage} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tier-climb progress</CardTitle>
          <CardDescription>
            Per-provider spend tier we'd qualify for today. We over-route a slice of traffic to
            OpenAI / Anthropic intentionally so spend keeps flowing into these ladders.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {tierProgressByProvider.map((tp) => (
            <TierProgressRow key={tp.provider} progress={tp} />
          ))}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top tasks by cost (MTD)</CardTitle>
          </CardHeader>
          <CardContent>
            {topTasks.length === 0 ? (
              <p className="text-sm text-muted-foreground">No calls this month yet.</p>
            ) : (
              <ul className="flex flex-col divide-y text-sm">
                {topTasks.map((t) => (
                  <li key={t.task} className="flex items-center justify-between gap-3 py-2">
                    <span className="truncate font-medium">{t.task}</span>
                    <span className="flex items-baseline gap-2 tabular-nums text-muted-foreground">
                      <span className="text-xs">{t.calls.toLocaleString()} calls</span>
                      <span className="font-semibold text-foreground">
                        ${microsToUsd(t.cost_micros).toFixed(2)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Last 50 failures</CardTitle>
          </CardHeader>
          <CardContent>
            {recentFailures.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No failures recorded. Things are healthy.
              </p>
            ) : (
              <ul className="flex flex-col divide-y text-xs">
                {recentFailures.map((f, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: failures are ordered + display-only
                  <li key={i} className="flex flex-col gap-0.5 py-1.5">
                    <div className="grid grid-cols-[80px_60px_1fr_auto] gap-2">
                      <span className="tabular-nums text-muted-foreground">
                        {fmtRelative(f.created_at)}
                      </span>
                      <span className="font-medium">{f.provider}</span>
                      <span className="truncate" title={f.task}>
                        {f.task}
                      </span>
                      <span className="rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
                        {f.status}
                      </span>
                    </div>
                    {f.error_message ? (
                      <p
                        className="truncate text-muted-foreground pl-[88px]"
                        title={f.error_message}
                      >
                        {f.error_message}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function ProviderSpendCard({
  provider,
  mtd_micros,
  health,
}: {
  provider: ProviderName;
  mtd_micros: bigint;
  health: {
    success: number;
    error: number;
    rate: number;
    p50_latency: number;
    p95_latency: number;
  };
}) {
  const totalCalls = health.success + health.error;
  const healthy = health.rate >= 0.98;
  return (
    <Card>
      <CardHeader>
        <CardDescription className="capitalize">{provider} · MTD</CardDescription>
        <CardTitle className="text-2xl tabular-nums">
          ${microsToUsd(mtd_micros).toFixed(2)}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1 text-xs">
        <div className="flex items-center gap-1">
          {healthy ? (
            <Check className="size-3 text-emerald-600" />
          ) : (
            <X className="size-3 text-rose-600" />
          )}
          <span>
            <span className="tabular-nums">{(health.rate * 100).toFixed(1)}%</span> success ·{' '}
            <span className="tabular-nums text-muted-foreground">{totalCalls} calls / 24h</span>
          </span>
        </div>
        {totalCalls > 0 ? (
          <p className="text-muted-foreground">
            p50 {health.p50_latency}ms · p95 {health.p95_latency}ms
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function VoiceSessionCard({ usage }: { usage: VoiceUsageMtd }) {
  const fmtMin = (m: number) => (m < 1 ? `${Math.round(m * 60)}s` : `${m.toFixed(1)}m`);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Voice sessions (MTD)</CardTitle>
        <CardDescription>
          Henry voice turns logged this month. Input = mic audio; Output = assistant audio. Tracked
          separately from the gateway — costs appear on provider invoices, not in{' '}
          <code className="text-xs">ai_calls</code>.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {usage.turns === 0 ? (
          <p className="text-sm text-muted-foreground">No voice sessions logged this month.</p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Turns</p>
                <p className="tabular-nums font-semibold">{usage.turns.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Input audio</p>
                <p className="tabular-nums font-semibold">{fmtMin(usage.input_minutes)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Output audio</p>
                <p className="tabular-nums font-semibold">{fmtMin(usage.output_minutes)}</p>
              </div>
            </div>
            {usage.byProvider.length > 0 ? (
              <ul className="flex flex-col divide-y text-xs">
                {usage.byProvider.map((row) => (
                  <li
                    key={row.provider}
                    className="grid grid-cols-[80px_1fr_80px_80px] gap-2 py-1.5 items-center"
                  >
                    <span className="font-medium capitalize">{row.provider}</span>
                    <div className="relative h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className="absolute inset-y-0 left-0 rounded-full bg-blue-500"
                        style={{
                          width: `${Math.round((row.turns / usage.turns) * 100)}%`,
                        }}
                      />
                    </div>
                    <span className="tabular-nums text-muted-foreground text-right">
                      {row.turns} turns
                    </span>
                    <span className="tabular-nums text-right">
                      {fmtMin(row.input_minutes + row.output_minutes)} total
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TierProgressRow({ progress }: { progress: TierProgress }) {
  const pct = progress.next_tier
    ? Math.min(100, Math.round((progress.lifetime_usd / progress.next_tier.spend_usd) * 100))
    : 100;
  const ready = progress.ready_for_next;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="capitalize font-medium">{progress.provider}</span>
        <span className="text-xs text-muted-foreground">
          ${progress.lifetime_usd.toFixed(2)} lifetime · {progress.days_since_first_payment}d since
          first call
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium tabular-nums">{progress.current_tier.name}</span>
        <div className="relative h-2 flex-1 rounded-full bg-muted">
          <div
            className={cn(
              'absolute inset-y-0 left-0 rounded-full',
              ready ? 'bg-emerald-500' : 'bg-blue-500',
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="text-xs font-medium tabular-nums text-muted-foreground">
          {progress.next_tier ? progress.next_tier.name : 'top tier'}
        </span>
      </div>
      {progress.next_tier ? (
        <p className="text-xs text-muted-foreground">
          {progress.usd_remaining > 0
            ? `$${progress.usd_remaining.toFixed(2)} more spend`
            : '✓ spend gate met'}
          {progress.days_remaining > 0
            ? ` · ${progress.days_remaining} more days`
            : ' · ✓ time gate met'}
          {ready ? ' — ready to promote' : ''}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Top tier — no further promotion.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtRelative(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  if (Number.isNaN(diff)) return iso;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
