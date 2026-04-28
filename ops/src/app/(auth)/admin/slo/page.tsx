import { getSloPageData, type SloStatus, type SloTile } from '@/server/ops-services/slo';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<SloStatus, string> = {
  ok: 'OK',
  warn: 'Warn',
  breach: 'Breach',
  'no-data': '—',
};

const STATUS_CLASS: Record<SloStatus, string> = {
  ok: 'bg-emerald-500/15 text-emerald-700',
  warn: 'bg-amber-500/15 text-amber-700',
  breach: 'bg-red-500/15 text-red-700',
  'no-data': 'bg-[var(--muted)] text-[var(--muted-foreground)]',
};

function StatusPill({ status }: { status: SloStatus }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_CLASS[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function TileCard({ tile }: { tile: SloTile }) {
  return (
    <div className="rounded-md border border-[var(--border)] p-4">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-[var(--muted-foreground)]">
          {tile.label}
        </div>
        <StatusPill status={tile.status} />
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{tile.actual}</div>
      <div className="mt-1 text-xs text-[var(--muted-foreground)] tabular-nums">
        Target {tile.target}
        {tile.sub ? ` · ${tile.sub}` : ''}
      </div>
    </div>
  );
}

export default async function SloPage() {
  const data = await getSloPageData(7);

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">SLO dashboard</h1>
        <p className="mt-1 text-xs text-[var(--muted-foreground)]">
          Last {data.windowDays} days · refreshed {new Date(data.generatedAt).toLocaleString()}
        </p>
        {data.warning ? (
          <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800">
            {data.warning}
          </p>
        ) : null}
      </div>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {data.overallTiles.map((tile) => (
          <TileCard key={tile.label} tile={tile} />
        ))}
        <TileCard tile={data.sendStats.transactional} />
        <TileCard tile={data.sendStats.autoresponderEmail} />
        <TileCard tile={data.sendStats.autoresponderSms} />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold">Hot paths · p95 latency</h2>
        <div className="overflow-hidden rounded-md border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--muted)]/40 text-xs uppercase tracking-wide text-[var(--muted-foreground)]">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Transaction</th>
                <th className="px-4 py-2 text-right font-medium">p95</th>
                <th className="px-4 py-2 text-right font-medium">Errors</th>
                <th className="px-4 py-2 text-right font-medium">Volume</th>
                <th className="px-4 py-2 text-right font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {data.hotPaths.map((p) => (
                <tr key={p.transaction}>
                  <td className="px-4 py-2 font-mono text-xs">{p.transaction}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {p.count === 0 ? '—' : `${(p.p95Ms / 1000).toFixed(2)} s`}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-[var(--muted-foreground)]">
                    {p.count === 0 ? '—' : `${(p.errorRate * 100).toFixed(1)} %`}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-[var(--muted-foreground)]">
                    {p.count.toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <StatusPill status={p.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-[var(--muted-foreground)]">
          Targets are placeholders. Tune after a week of baseline data.
        </p>
      </section>
    </div>
  );
}
