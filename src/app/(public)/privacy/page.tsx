/**
 * Privacy policy — narrative copy lives here, but the data-flow /
 * sub-processor table renders from docs/legal/vendors.yaml so the
 * marketing claim can never drift from production reality.
 *
 * Updates: edit this file for narrative changes. Edit
 * docs/legal/vendors.yaml when adding/removing a vendor — the table
 * below re-renders on the next deploy.
 */

import type { Metadata } from 'next';
import { loadVendors } from '@/lib/legal/vendors';

export const metadata: Metadata = {
  title: 'Privacy Policy — HeyHenry',
  robots: { index: true, follow: true },
};

const LAST_UPDATED = '2026-04-29';

export default function PrivacyPage() {
  const vendors = loadVendors();
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 prose prose-sm sm:prose-base dark:prose-invert">
      <h1>Privacy Policy</h1>
      <p className="text-muted-foreground">Last updated: {LAST_UPDATED}</p>

      <h2>What this document covers</h2>
      <p>
        HeyHenry (the "Service") helps general contractors and renovation operators run their
        business — managing customers, projects, estimates, change orders, draws, photos, and
        related artifacts. This policy describes what personal information we collect, how we use
        it, who else processes it on our behalf, and where it lives.
      </p>

      <h2>Who we are</h2>
      <p>
        HeyHenry is operated as a Canadian business. We comply with the{' '}
        <a
          href="https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/"
          target="_blank"
          rel="noreferrer"
        >
          Personal Information Protection and Electronic Documents Act (PIPEDA)
        </a>{' '}
        and applicable provincial privacy legislation, including Quebec's Law 25 where it applies.
      </p>

      <h2>What we collect</h2>
      <p>From operators (the contractors using HeyHenry):</p>
      <ul>
        <li>Account credentials (email, password hash, optional phone for MFA + SMS).</li>
        <li>Business profile (company name, GST/WCB numbers, branding).</li>
        <li>Billing info (handled directly by Stripe — card data never touches our servers).</li>
        <li>Operator-uploaded content (project photos, attachments, audio memos).</li>
      </ul>
      <p>From the operator's customers (homeowners or commercial clients):</p>
      <ul>
        <li>Contact info the operator records (name, email, phone, address).</li>
        <li>Estimate / change-order content the customer reviews and approves.</li>
        <li>
          Approval signatures (typed name + timestamp + IP, when the customer accepts an estimate or
          change order).
        </li>
        <li>Project photos / files the operator shares to a customer portal.</li>
      </ul>

      <h2>Where your data lives</h2>
      <p>
        Operator and customer data at rest is stored in{' '}
        <strong>Supabase, ca-central-1 (Montreal, Canada)</strong>. Encrypted backups are stored in{' '}
        <strong>Canadian object storage (Montreal)</strong>. The application is served from US-based
        edge hosts (Vercel) — these process data in transit only.
      </p>

      <h2>Sub-processors</h2>
      <p>
        We use the following third-party services to operate HeyHenry. This table is the source of
        truth for what data leaves Canada and for what purpose. It is generated from{' '}
        <a
          href="https://github.com/johnnybravo170/heyhenry/blob/main/docs/legal/vendors.yaml"
          target="_blank"
          rel="noreferrer"
        >
          our vendor inventory
        </a>{' '}
        and re-renders on every deploy.
      </p>
      <div className="not-prose overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="p-2 font-medium">Service</th>
              <th className="p-2 font-medium">Purpose</th>
              <th className="p-2 font-medium">Region</th>
              <th className="p-2 font-medium">Data sent</th>
            </tr>
          </thead>
          <tbody>
            {vendors.map((v) => (
              <tr key={v.slug} className="border-b align-top">
                <td className="p-2">
                  <a href={v.url} target="_blank" rel="noreferrer" className="underline">
                    {v.name}
                  </a>
                  {v.subprocessor_url ? (
                    <div className="mt-1 text-xs">
                      <a
                        href={v.subprocessor_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-muted-foreground hover:underline"
                      >
                        sub-processor list →
                      </a>
                    </div>
                  ) : null}
                </td>
                <td className="p-2">{v.purpose}</td>
                <td className="p-2 whitespace-nowrap">{v.region}</td>
                <td className="p-2">
                  <ul className="m-0 list-disc pl-4 text-xs">
                    {v.data_types.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                  {v.notes ? <p className="mt-1 text-xs text-muted-foreground">{v.notes}</p> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Cross-border transfers</h2>
      <p>
        Some of the services above are operated outside Canada (primarily in the United States).
        Personal information processed by those services is subject to the laws of those
        jurisdictions, including the ability of foreign authorities to obtain access to that
        information through lawful process. We have entered into data processing agreements with
        each sub-processor requiring privacy protections comparable to PIPEDA. By using HeyHenry you
        consent to these transfers as described above.
      </p>

      <h2>How we use the data</h2>
      <ul>
        <li>
          To operate the Service (auth, billing, sending operator-authored emails / SMS to
          customers).
        </li>
        <li>
          To provide AI-powered features the operator opted into (memo summarization, receipt
          extraction, vendor-quote parsing). The relevant prompt content is sent to the AI
          sub-processors listed above.
        </li>
        <li>To monitor and debug the application (Sentry — PII scrubbed where possible).</li>
        <li>To bill operators (Stripe).</li>
      </ul>
      <p>
        We do <strong>not</strong> sell personal information, and we do <strong>not</strong> use
        customer data for advertising.
      </p>

      <h2>Retention</h2>
      <ul>
        <li>Active operator + customer data: retained while the operator's account is active.</li>
        <li>Encrypted nightly backups: retained 30 days rolling.</li>
        <li>Soft-deleted records: retained 30 days, then hard-deleted on a scheduled job.</li>
        <li>Stripe billing records: retained per Stripe's policies.</li>
        <li>Sentry error logs: 30-day default retention.</li>
      </ul>

      <h2>Your rights</h2>
      <p>
        You may request access to, correction of, or deletion of personal information we hold.
        Operators can manage most of this directly in the app. For requests beyond the app's
        self-service tools, email <a href="mailto:privacy@heyhenry.io">privacy@heyhenry.io</a>. We
        respond within 30 days.
      </p>

      <h2>Changes to this policy</h2>
      <p>
        Material changes are announced in-app and via email to active operators. The vendor table
        above re-renders automatically when our sub-processor list changes — that is the canonical
        disclosure of who else processes data on our behalf.
      </p>

      <h2>Contact</h2>
      <p>
        Questions, concerns, or formal requests:{' '}
        <a href="mailto:privacy@heyhenry.io">privacy@heyhenry.io</a>.
      </p>
    </div>
  );
}
