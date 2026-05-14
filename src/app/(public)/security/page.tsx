/**
 * Public security policy page — referenced from
 * /.well-known/security.txt (RFC 9116) and from any "report a
 * vulnerability" links we add in the app footer.
 *
 * Keep narrative; specifics that change frequently (vendors, audit
 * cadence) go in privacy / docs/legal/vendors.yaml so they stay in
 * sync with production reality.
 */

import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Security — HeyHenry',
  robots: { index: true, follow: true },
};

const LAST_UPDATED = '2026-05-13';

export default function SecurityPage() {
  return (
    <div className="prose prose-sm sm:prose-base mx-auto max-w-3xl px-4 py-12 dark:prose-invert">
      <h1>Security at HeyHenry</h1>
      <p>
        <em>Last updated {LAST_UPDATED}.</em>
      </p>

      <p>
        We're a small team building software that contractors run their businesses on. Security is
        part of that responsibility, not a bolt-on. This page explains how to reach us if you find
        an issue, and what we promise on our end.
      </p>

      <h2>Reporting a vulnerability</h2>
      <p>
        Email <a href="mailto:security@heyhenry.io">security@heyhenry.io</a> with as much detail as
        you can. We aim to acknowledge within one business day and to remediate critical issues as
        quickly as we can — typically within days.
      </p>
      <p>
        Please give us a reasonable disclosure window before going public. We don't run a paid bug
        bounty (yet), but we're happy to credit you on a public acknowledgements page if you'd like.
      </p>

      <h2>Safe-harbor commitment</h2>
      <p>If you act in good faith and:</p>
      <ul>
        <li>only access the minimum data needed to demonstrate the issue,</li>
        <li>don't degrade service for other customers,</li>
        <li>don't exfiltrate, retain, or share customer data, and</li>
        <li>give us a reasonable window to fix the issue before disclosure,</li>
      </ul>
      <p>
        we won't pursue legal action against you and we'll work with you on coordinated disclosure.
      </p>

      <h2>What we do on our end</h2>
      <ul>
        <li>Encryption in transit (TLS) is enforced at our edge.</li>
        <li>
          Encryption at rest is provided by Supabase (database) and Cloudflare R2 (backups), with
          encrypted nightly backup dumps using a key we control.
        </li>
        <li>
          Multi-tenant isolation is enforced at the database layer via Postgres row-level security
          on every customer-scoped table.
        </li>
        <li>
          Multi-factor authentication is available for all accounts and required for sensitive
          actions like billing changes, data export, and Stripe Connect setup.
        </li>
        <li>
          Sensitive actions are recorded in an append-only audit trail visible to the operator and
          to platform support.
        </li>
        <li>
          Vulnerability scanning runs on every CI build; critical advisories block merges, and we
          track remediation of everything else weekly via Dependabot.
        </li>
        <li>
          Incident response: see our{' '}
          <a
            href="https://github.com/johnnybravo170/heyhenry/blob/main/INCIDENT_RESPONSE.md"
            target="_blank"
            rel="noopener noreferrer"
          >
            public incident-response runbook
          </a>{' '}
          for severity tiers, communication cadence, and post-mortem template.
        </li>
      </ul>

      <h2>Sub-processors and data residency</h2>
      <p>
        See our <Link href="/privacy">Privacy Policy</Link> for the complete list of sub-processors
        and the data we share with each. Customer data is stored in Canada (ca-central-1) today.
      </p>

      <h2>Coming soon</h2>
      <ul>
        <li>SOC 2 Type II — scoping in 2026.</li>
        <li>Self-serve data export (GDPR Article 20 / PIPEDA portability).</li>
        <li>Self-serve account deletion with a 30-day reversibility window.</li>
        <li>
          Public status page at <code>status.heyhenry.io</code>.
        </li>
      </ul>

      <p className="text-sm text-muted-foreground">
        Found something we should add to this page? Email{' '}
        <a href="mailto:security@heyhenry.io">security@heyhenry.io</a>.
      </p>
    </div>
  );
}
