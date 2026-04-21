'use client';

/**
 * Customer-facing estimate actions.
 *
 * Two CTAs: Accept Estimate and Send Feedback. Feedback is never rejected
 * — "declined" is reserved for operator use. Customer can click a line row
 * to expand an inline comment box, or use the general feedback textarea
 * at the bottom. When they Accept, any typed feedback is submitted first
 * so it ships alongside the approval.
 */

import { useState } from 'react';
import {
  approveEstimateAction,
  submitEstimateFeedbackAction,
} from '@/server/actions/estimate-approval';

export type EstimateLine = { id: string; label: string };

export function EstimateApprovalForm({
  approvalCode,
  lines,
}: {
  approvalCode: string;
  lines: EstimateLine[];
}) {
  const [mode, setMode] = useState<'pending' | 'approve' | 'done-approved' | 'done-feedback'>(
    'pending',
  );
  const [name, setName] = useState('');
  const [general, setGeneral] = useState('');
  const [lineComments, setLineComments] = useState<Record<string, string>>({});
  const [expandedLine, setExpandedLine] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function hasAnyFeedback(): boolean {
    if (general.trim()) return true;
    return Object.values(lineComments).some((v) => v.trim().length > 0);
  }

  function feedbackPayload() {
    const list: { costLineId?: string | null; body: string }[] = [];
    for (const [lineId, body] of Object.entries(lineComments)) {
      if (body.trim()) list.push({ costLineId: lineId, body });
    }
    if (general.trim()) list.push({ costLineId: null, body: general });
    return list;
  }

  async function handleAccept() {
    if (!name.trim()) {
      setError('Please type your name to confirm.');
      return;
    }
    setLoading(true);
    setError(null);

    // Save feedback first (if any) so it lands with the approval event.
    const fb = feedbackPayload();
    if (fb.length > 0) {
      const fbRes = await submitEstimateFeedbackAction(approvalCode, fb);
      if (!fbRes.ok) {
        setError(fbRes.error);
        setLoading(false);
        return;
      }
    }

    const res = await approveEstimateAction(approvalCode, name.trim());
    if (!res.ok) {
      setError(res.error);
      setLoading(false);
      return;
    }
    setMode('done-approved');
    setLoading(false);
  }

  async function handleSendFeedback() {
    const fb = feedbackPayload();
    if (fb.length === 0) {
      setError('Add a comment first — either on a line item or in the general box below.');
      return;
    }
    setLoading(true);
    setError(null);
    const res = await submitEstimateFeedbackAction(approvalCode, fb);
    if (!res.ok) {
      setError(res.error);
      setLoading(false);
      return;
    }
    setMode('done-feedback');
    setLoading(false);
  }

  if (mode === 'done-approved') {
    return (
      <div className="rounded-md bg-emerald-50 p-6 text-center text-sm text-emerald-900">
        <p className="font-medium">Estimate approved — thanks!</p>
        <p className="mt-1 text-xs">Your contractor has been notified.</p>
      </div>
    );
  }

  if (mode === 'done-feedback') {
    return (
      <div className="rounded-md bg-blue-50 p-6 text-center text-sm text-blue-900">
        <p className="font-medium">Feedback sent.</p>
        <p className="mt-1 text-xs">
          Your contractor will review your comments and reach out with an update.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error ? <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div> : null}

      {/* Per-line comment expanders */}
      <details className="rounded-md border">
        <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium hover:bg-muted/50">
          Have a question about a specific line? Click to comment per item.
        </summary>
        <div className="border-t p-3">
          <ul className="space-y-2">
            {lines.map((l) => {
              const isOpen = expandedLine === l.id;
              const hasText = !!lineComments[l.id]?.trim();
              return (
                <li key={l.id}>
                  <button
                    type="button"
                    onClick={() => setExpandedLine(isOpen ? null : l.id)}
                    className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/50"
                  >
                    <span>
                      {l.label}
                      {hasText ? (
                        <span className="ml-2 text-xs text-blue-700">(commented)</span>
                      ) : null}
                    </span>
                    <span className="text-xs text-muted-foreground">{isOpen ? '−' : '+'}</span>
                  </button>
                  {isOpen ? (
                    <textarea
                      value={lineComments[l.id] ?? ''}
                      onChange={(e) =>
                        setLineComments((prev) => ({ ...prev, [l.id]: e.target.value }))
                      }
                      rows={2}
                      placeholder={`What would you like to know or change about ${l.label}?`}
                      className="mt-1 w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      </details>

      {/* General feedback */}
      <div>
        <label htmlFor="general-feedback" className="mb-1 block text-sm font-medium">
          Not quite right? Send feedback and we'll revise.
        </label>
        <textarea
          id="general-feedback"
          value={general}
          onChange={(e) => setGeneral(e.target.value)}
          rows={3}
          placeholder="Any questions, concerns, or changes you'd like us to consider…"
          className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
        />
      </div>

      {/* Action buttons */}
      {mode === 'pending' ? (
        <div className="space-y-2">
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setMode('approve')}
              className="flex-1 rounded-md bg-emerald-600 px-4 py-3 text-sm font-medium text-white hover:bg-emerald-700"
            >
              Accept Estimate
            </button>
            <button
              type="button"
              onClick={handleSendFeedback}
              disabled={loading}
              className="flex-1 rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-medium text-blue-800 hover:bg-blue-100 disabled:opacity-50"
            >
              {loading ? 'Sending…' : 'Send Feedback'}
            </button>
          </div>
          <p className="text-center text-xs text-muted-foreground">
            {hasAnyFeedback()
              ? 'If you accept, your comments will be saved with your approval.'
              : 'Accepting locks in this estimate. Send feedback if you want revisions first.'}
          </p>
        </div>
      ) : null}

      {mode === 'approve' ? (
        <div className="space-y-3 rounded-md border p-4">
          <p className="text-sm text-muted-foreground">
            Type your name below to confirm approval of this estimate.
          </p>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
            placeholder="Your full name"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleAccept}
              disabled={loading}
              className="flex-1 rounded-md bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {loading ? 'Confirming…' : 'Confirm Approval'}
            </button>
            <button
              type="button"
              onClick={() => setMode('pending')}
              disabled={loading}
              className="rounded-md border px-3 py-2.5 text-sm font-medium hover:bg-muted/50 disabled:opacity-50"
            >
              Back
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
