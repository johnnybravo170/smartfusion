'use client';

/**
 * Homeowner-facing decision queue panel. Pinned to the top of the
 * portal, above the status bar. Each pending decision shows the
 * label + context + reference photos + due date and three buttons:
 * Approve, Decline, Ask a question.
 *
 * The Ask flow opens an inline textarea so the homeowner doesn't have
 * to leave the portal. All three actions submit through the public
 * approval-code path so the homeowner is never asked to log in.
 *
 * For the dedicated /decide/<code> SMS deep-link experience (Slice 7),
 * see the page at src/app/(public)/decide/[code]/page.tsx — it reuses
 * the same approval-code action under the hood.
 */

import { Loader2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useTenantTimezone } from '@/lib/auth/tenant-context';
import { cn } from '@/lib/utils';
import { askDecisionByCodeAction, decideByCodeAction } from '@/server/actions/project-decisions';

export type PortalDecision = {
  id: string;
  approval_code: string;
  label: string;
  description: string | null;
  due_date: string | null;
  photo_urls: string[];
  /** Multi-option vote when non-empty; otherwise binary approve/decline. */
  options: string[];
};

export function DecisionPanel({
  decisions,
  defaultCustomerName,
}: {
  decisions: PortalDecision[];
  defaultCustomerName: string;
}) {
  if (decisions.length === 0) return null;
  return (
    <section
      className="mb-8 rounded-lg border-2 border-amber-200 bg-amber-50/60 p-4"
      aria-labelledby="decisions-heading"
    >
      <h2 id="decisions-heading" className="text-base font-semibold text-amber-900">
        Decisions needed
      </h2>
      <p className="mt-0.5 text-xs text-amber-800/80">
        {decisions.length === 1
          ? "Here's one quick thing we need from you."
          : `Here are ${decisions.length} quick things we need from you.`}
      </p>
      <ul className="mt-4 space-y-3">
        {decisions.map((d) => (
          <DecisionCard key={d.id} decision={d} defaultCustomerName={defaultCustomerName} />
        ))}
      </ul>
    </section>
  );
}

function DecisionCard({
  decision,
  defaultCustomerName,
}: {
  decision: PortalDecision;
  defaultCustomerName: string;
}) {
  const tenantTz = useTenantTimezone();
  const [mode, setMode] = useState<'idle' | 'asking' | 'answered'>('idle');
  const [name, setName] = useState(defaultCustomerName);
  const [question, setQuestion] = useState('');
  const [pickedOption, setPickedOption] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const isMultiOption = decision.options.length > 0;

  function approve() {
    if (!name.trim()) {
      toast.error('Please enter your name first.');
      return;
    }
    startTransition(async () => {
      const res = await decideByCodeAction({
        code: decision.approval_code,
        value: 'approved',
        customerName: name,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success('Approved — thanks!');
      setMode('answered');
    });
  }

  function decline() {
    if (!name.trim()) {
      toast.error('Please enter your name first.');
      return;
    }
    startTransition(async () => {
      const res = await decideByCodeAction({
        code: decision.approval_code,
        value: 'declined',
        customerName: name,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success('Declined — your contractor will follow up.');
      setMode('answered');
    });
  }

  function confirmOption() {
    if (!name.trim()) {
      toast.error('Please enter your name first.');
      return;
    }
    if (!pickedOption) {
      toast.error('Please pick an option first.');
      return;
    }
    startTransition(async () => {
      const res = await decideByCodeAction({
        code: decision.approval_code,
        value: pickedOption,
        customerName: name,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Picked: ${pickedOption}`);
      setMode('answered');
    });
  }

  function submitQuestion() {
    if (!question.trim()) {
      toast.error('Please type a question first.');
      return;
    }
    if (!name.trim()) {
      toast.error('Please enter your name first.');
      return;
    }
    startTransition(async () => {
      const res = await askDecisionByCodeAction({
        code: decision.approval_code,
        customerName: name,
        question,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success('Sent — your contractor will reply.');
      setQuestion('');
      setMode('idle');
    });
  }

  if (mode === 'answered') {
    return (
      <li className="rounded-md border border-emerald-200 bg-emerald-50/80 p-3 text-sm text-emerald-900">
        Thanks, {name.trim()} — we got your response on &ldquo;{decision.label}&rdquo;.
      </li>
    );
  }

  return (
    <li className="rounded-md border bg-card p-3">
      <p className="text-sm font-medium">{decision.label}</p>
      {decision.description ? (
        <p className="mt-1 text-sm text-muted-foreground">{decision.description}</p>
      ) : null}
      {decision.due_date ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Due{' '}
          {new Intl.DateTimeFormat('en-CA', { timeZone: tenantTz }).format(
            new Date(decision.due_date),
          )}
        </p>
      ) : null}

      {decision.photo_urls.length > 0 ? (
        <div className="mt-2 grid grid-cols-3 gap-1.5 sm:grid-cols-4">
          {decision.photo_urls.map((url) => (
            // biome-ignore lint/performance/noImgElement: signed URLs bypass next/image
            <img
              key={url}
              src={url}
              alt=""
              className="aspect-square rounded-md border object-cover"
              loading="lazy"
            />
          ))}
        </div>
      ) : null}

      <div className="mt-3">
        <Input
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Your name"
          className="mb-2"
        />
      </div>

      {isMultiOption ? (
        <div className="space-y-1.5">
          {decision.options.map((opt) => (
            <label
              key={opt}
              className="flex cursor-pointer items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm hover:bg-muted"
              htmlFor={`opt-${decision.id}-${opt}`}
            >
              <input
                id={`opt-${decision.id}-${opt}`}
                type="radio"
                name={`decision-${decision.id}`}
                checked={pickedOption === opt}
                onChange={() => setPickedOption(opt)}
                disabled={pending}
              />
              <span>{opt}</span>
            </label>
          ))}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {isMultiOption ? (
          <Button
            type="button"
            size="sm"
            onClick={confirmOption}
            disabled={pending || !pickedOption}
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Confirm
          </Button>
        ) : (
          <>
            <Button type="button" size="sm" onClick={approve} disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Approve
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={decline} disabled={pending}>
              Decline
            </Button>
          </>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setMode((m) => (m === 'asking' ? 'idle' : 'asking'))}
          disabled={pending}
          aria-expanded={mode === 'asking'}
        >
          {mode === 'asking' ? 'Cancel' : 'Ask a question'}
        </Button>
      </div>

      {mode === 'asking' ? (
        <div className="mt-3 space-y-2">
          <Textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="What would you like to know?"
            rows={3}
          />
          <Button
            type="button"
            size="sm"
            onClick={submitQuestion}
            disabled={pending || !question.trim()}
            className={cn(pending && 'opacity-70')}
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Send question
          </Button>
        </div>
      ) : null}
    </li>
  );
}
