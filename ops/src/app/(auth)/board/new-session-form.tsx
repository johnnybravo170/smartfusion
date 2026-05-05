'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { createBoardSessionAction, runBoardSessionAction } from './actions';

type AdvisorOption = {
  id: string;
  slug: string;
  name: string;
  emoji: string;
  role_kind: 'expert' | 'challenger' | 'chair';
};

/**
 * Topic-shaped advisor presets. Each lists slugs to include — the form
 * resolves slugs to IDs at runtime. Chair + DA are in every preset on
 * purpose: chair is mandatory, DA earns its keep on every topic.
 *
 * Picking by topic beats picking everyone. The marginal advisor on a
 * mismatched topic dilutes attention more than they add depth.
 */
const ADVISOR_PRESETS: Array<{ id: string; label: string; slugs: string[]; description: string }> =
  [
    {
      id: 'all',
      label: 'Everyone',
      slugs: [], // empty = include all
      description: 'All advisors. Default.',
    },
    {
      id: 'compensation',
      label: 'Compensation / Governance',
      slugs: [
        'strategic-chair',
        'devils-advocate',
        'customer-success',
        'surefooted-architect',
        'pricing-packaging',
        'founder-led-sales',
      ],
      description: 'Equity, partner pay, advisor agreements, friend-as-collaborator structures.',
    },
    {
      id: 'pricing',
      label: 'Pricing / Packaging',
      slugs: [
        'strategic-chair',
        'devils-advocate',
        'pricing-packaging',
        'founder-led-sales',
        'vertical-saas-strategist',
      ],
      description: 'Plan structure, value metric, discounts, monetization mechanics.',
    },
    {
      id: 'architecture',
      label: 'Architecture / Scale',
      slugs: [
        'strategic-chair',
        'devils-advocate',
        'surefooted-architect',
        'vertical-saas-strategist',
      ],
      description: 'Schema, data model, service boundaries, scaling decisions.',
    },
    {
      id: 'gtm',
      label: 'GTM / Sales motion',
      slugs: [
        'strategic-chair',
        'devils-advocate',
        'founder-led-sales',
        'customer-success',
        'vertical-saas-strategist',
      ],
      description: 'Sales process, ICP, channel choice, demos, onboarding.',
    },
    {
      id: 'triage',
      label: 'Quick triage',
      slugs: [
        'strategic-chair',
        'devils-advocate',
        'vertical-saas-strategist',
        'founder-led-sales',
      ],
      description: 'Fast gut-check with the smallest useful panel.',
    },
  ];

export function NewSessionForm({ advisors }: { advisors: AdvisorOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [topic, setTopic] = useState('');
  // Default selection: chair + every expert + DA challenger
  const [selected, setSelected] = useState<Set<string>>(new Set(advisors.map((a) => a.id)));
  const [activePreset, setActivePreset] = useState<string>('all');
  const [budget, setBudget] = useState(500);
  const [providerOverride, setProviderOverride] = useState<'' | 'anthropic' | 'openrouter'>('');
  const [modelOverride, setModelOverride] = useState('');
  const [autoRun, setAutoRun] = useState(true);
  const [isPending, startTransition] = useTransition();

  function toggle(id: string): void {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
    setActivePreset('custom');
  }

  function applyAdvisorPreset(presetId: string): void {
    const preset = ADVISOR_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    if (preset.id === 'all' || preset.slugs.length === 0) {
      setSelected(new Set(advisors.map((a) => a.id)));
    } else {
      const wanted = new Set(preset.slugs);
      const matched = advisors.filter((a) => wanted.has(a.slug)).map((a) => a.id);
      setSelected(new Set(matched));
    }
    setActivePreset(presetId);
  }

  function presetKimi(): void {
    setProviderOverride('openrouter');
    setModelOverride('moonshotai/kimi-k2.5');
  }

  function presetSonnet(): void {
    setProviderOverride('');
    setModelOverride('');
  }

  function onSubmit(e: React.FormEvent): void {
    e.preventDefault();
    if (selected.size < 2) {
      toast.error('Pick at least 2 advisors (must include the chair)');
      return;
    }
    const hasChair = advisors.some((a) => selected.has(a.id) && a.role_kind === 'chair');
    if (!hasChair) {
      toast.error('Selection must include a chair advisor');
      return;
    }
    startTransition(async () => {
      const r = await createBoardSessionAction({
        title: title.trim(),
        topic: topic.trim(),
        advisor_ids: [...selected],
        provider_override: providerOverride || null,
        model_override: modelOverride.trim() || null,
        budget_cents: budget,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      if (autoRun) {
        const runR = await runBoardSessionAction(r.id);
        if (!runR.ok) {
          toast.error(`Created but run failed: ${runR.error}`);
          router.push(`/board/sessions/${r.id}`);
          return;
        }
      }
      toast.success(autoRun ? 'Session running' : 'Session created');
      router.push(`/board/sessions/${r.id}`);
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-md border border-dashed border-[var(--border)] px-3 py-2 text-sm text-[var(--muted-foreground)] hover:border-[var(--foreground)] hover:text-[var(--foreground)]"
      >
        + Convene a board session
      </button>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-md border border-[var(--border)] p-4">
      <label className="block">
        <span className="block text-xs font-medium text-[var(--muted-foreground)]">Title</span>
        <input
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-3 py-2 text-sm"
          placeholder="Pricing model for design partners"
        />
      </label>

      <label className="block">
        <span className="block text-xs font-medium text-[var(--muted-foreground)]">
          Topic (the strategic question — give as much context as you can)
        </span>
        <textarea
          required
          rows={6}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          className="mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-3 py-2 text-sm"
          placeholder="We're considering per-seat vs per-job pricing for the GC vertical. Current thinking..."
        />
      </label>

      <div>
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-xs font-medium text-[var(--muted-foreground)]">
            Advisors ({selected.size} selected)
          </p>
        </div>

        <div className="mt-2 flex flex-wrap gap-1.5">
          {ADVISOR_PRESETS.map((p) => {
            const isActive = activePreset === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => applyAdvisorPreset(p.id)}
                title={p.description}
                className={`rounded-full border px-3 py-1 text-xs transition ${
                  isActive
                    ? 'border-[var(--foreground)] bg-[var(--muted)]'
                    : 'border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--foreground)] hover:text-[var(--foreground)]'
                }`}
              >
                {p.label}
              </button>
            );
          })}
          {activePreset === 'custom' ? (
            <span className="rounded-full border border-[var(--foreground)] bg-[var(--muted)] px-3 py-1 text-xs">
              Custom
            </span>
          ) : null}
        </div>

        <ul className="mt-2 grid gap-1 sm:grid-cols-2">
          {advisors.map((a) => (
            <li key={a.id}>
              <label className="flex cursor-pointer items-center gap-2 rounded border border-[var(--border)] p-2 text-sm">
                <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggle(a.id)} />
                <span>{a.emoji}</span>
                <span className="flex-1">{a.name}</span>
                <span className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
                  {a.role_kind}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="block text-xs font-medium text-[var(--muted-foreground)]">
            Budget cap (USD cents — default $5)
          </span>
          <input
            type="number"
            min={50}
            max={5000}
            value={budget}
            onChange={(e) => setBudget(Number(e.target.value))}
            className="mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-3 py-2 text-sm"
          />
          <span className="mt-1 block text-xs text-[var(--muted-foreground)]">{`$${(budget / 100).toFixed(2)}`}</span>
        </label>
        <div>
          <p className="text-xs font-medium text-[var(--muted-foreground)]">Model preset</p>
          <div className="mt-1 flex gap-2">
            <button
              type="button"
              onClick={presetSonnet}
              className={`flex-1 rounded border px-2 py-1.5 text-xs ${
                providerOverride === '' ? 'border-[var(--foreground)]' : 'border-[var(--border)]'
              }`}
            >
              Sonnet (default)
            </button>
            <button
              type="button"
              onClick={presetKimi}
              className={`flex-1 rounded border px-2 py-1.5 text-xs ${
                providerOverride === 'openrouter' && modelOverride.startsWith('moonshotai/kimi')
                  ? 'border-[var(--foreground)]'
                  : 'border-[var(--border)]'
              }`}
            >
              Kimi K2 (OpenRouter)
            </button>
          </div>
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">
            Override applies to ALL advisor + chair calls in this session.
          </p>
        </div>
      </div>

      <details>
        <summary className="cursor-pointer text-xs text-[var(--muted-foreground)]">
          Custom model override
        </summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <select
            value={providerOverride}
            onChange={(e) => setProviderOverride(e.target.value as '' | 'anthropic' | 'openrouter')}
            className="rounded-md border border-[var(--border)] bg-transparent px-3 py-2 text-sm"
          >
            <option value="">(default: anthropic)</option>
            <option value="anthropic">anthropic</option>
            <option value="openrouter">openrouter</option>
          </select>
          <input
            value={modelOverride}
            onChange={(e) => setModelOverride(e.target.value)}
            placeholder="claude-sonnet-4-6 / moonshotai/kimi-k2.5 / moonshotai/kimi-latest"
            className="rounded-md border border-[var(--border)] bg-transparent px-3 py-2 text-sm"
          />
        </div>
      </details>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} />
        Run discussion immediately after creating
      </label>

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md bg-[var(--foreground)] px-4 py-2 text-sm font-medium text-[var(--background)] disabled:opacity-50"
        >
          {isPending ? 'Working...' : autoRun ? 'Convene + run' : 'Convene'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border border-[var(--border)] px-4 py-2 text-sm"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
