/**
 * Terms of Service — DRAFT pending legal review.
 *
 * Bump `LAST_UPDATED` here and `CURRENT_TOS_VERSION` in
 * src/lib/legal/versions.ts in the same commit when the copy changes — the
 * acceptance flow keys off the version string.
 */

import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Terms of Service — HeyHenry',
  robots: { index: true, follow: true },
};

const LAST_UPDATED = '2026-05-09';

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 prose prose-sm sm:prose-base dark:prose-invert">
      <h1>Terms of Service</h1>
      <p className="text-muted-foreground">Last updated: {LAST_UPDATED}</p>

      <div className="not-prose my-6 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
        <strong>Draft — pending legal review.</strong> These terms describe the substantive
        arrangement we intend to have with users today, but are scheduled for review by Canadian
        legal counsel before final publication. We&apos;ll notify accepted users by email when the
        finalised version is posted.
      </div>

      <h2>1. Who these terms are between</h2>
      <p>
        These Terms of Service (&quot;Terms&quot;) are an agreement between you (the contractor,
        business operator, or authorised employee accepting these Terms — &quot;you&quot;) and
        HeyHenry (&quot;HeyHenry&quot;, &quot;we&quot;, &quot;us&quot;) governing your use of the
        HeyHenry platform, web application, mobile experience, APIs, and any related services
        (collectively, the &quot;Service&quot;).
      </p>
      <p>
        By creating an account, signing in, or otherwise using the Service you confirm that you have
        read, understood, and agree to these Terms and to our{' '}
        <Link href="/privacy">Privacy Policy</Link>. If you do not agree, do not use the Service.
      </p>

      <h2>2. Your account</h2>
      <ul>
        <li>
          You must provide accurate signup information, including a working email and phone number.
          Each tenant (business workspace) must have at least one owner with a verified phone
          number.
        </li>
        <li>
          You are responsible for keeping your password and any access tokens confidential, and for
          all activity that happens under your account and your tenant&apos;s workspace. Notify us
          promptly if you suspect unauthorised access.
        </li>
        <li>
          You must be at least the age of majority in your jurisdiction and legally able to enter
          into this agreement on behalf of yourself and (if you sign up on behalf of a business)
          your business.
        </li>
      </ul>

      <h2>3. What you can do with the Service</h2>
      <p>
        Subject to these Terms, we grant you a limited, non-exclusive, non-transferable, revocable
        licence to use the Service to run your own contracting business — managing customers,
        projects, estimates, change orders, photos, communications, and related workflows.
      </p>

      <h2>4. What you can&apos;t do</h2>
      <ul>
        <li>
          Use the Service to send unsolicited commercial electronic messages in violation of CASL,
          the TCPA, GDPR, or any other applicable anti-spam, telemarketing, or privacy law.
        </li>
        <li>
          Upload content you don&apos;t have the right to upload, or use the Service to harass,
          defraud, or impersonate another person.
        </li>
        <li>
          Reverse-engineer the Service, scrape it at scale, attempt to bypass rate limits or access
          controls, or use it to build a directly competing product.
        </li>
        <li>
          Resell, sublicense, or rent the Service to a third party without our prior written
          consent.
        </li>
      </ul>

      <h2>5. Your data and your customers&apos; data</h2>
      <p>
        You retain ownership of the content you upload (estimates, project photos, customer records,
        communications). You grant us a limited licence to host, transmit, process, and display that
        content as needed to operate and improve the Service.
      </p>
      <p>
        When you record information about your own customers in the Service, you act as the data
        controller for that information and are responsible for having the lawful basis (consent,
        contract, or legitimate interest) to collect and process it. Our handling of all personal
        information — yours and your customers&apos; — is described in the{' '}
        <Link href="/privacy">Privacy Policy</Link>.
      </p>

      <h2>6. Subscriptions, trials, and refunds</h2>
      <ul>
        <li>
          Paid plans renew automatically at the interval shown at checkout (monthly or annual) until
          cancelled. You can cancel any time from your billing settings; cancellation takes effect
          at the end of the current billing period.
        </li>
        <li>
          Free trials convert to a paid plan on the date shown at signup unless cancelled before
          that date.
        </li>
        <li>
          Refunds are governed by our <Link href="/refund-policy">Refund Policy</Link>.
        </li>
        <li>
          Taxes (GST/HST/PST/QST/sales tax) are added where applicable. We may change pricing on at
          least 30 days&apos; notice, taking effect at your next renewal.
        </li>
      </ul>

      <h2>7. Service availability</h2>
      <p>
        We aim to keep the Service available 24/7 but make no guarantees. We may schedule
        maintenance, ship updates, or take parts of the Service offline temporarily. Where
        reasonably practical we will give advance notice of planned downtime.
      </p>

      <h2>8. Third-party services</h2>
      <p>
        The Service relies on third-party providers (e.g. Stripe for payments, Twilio for SMS,
        Resend for email, Supabase for hosting). Your use of features that depend on those providers
        is also subject to their terms. The list of sub-processors and what data they receive is
        published on the <Link href="/privacy">Privacy Policy</Link> page.
      </p>

      <h2>9. Suspension and termination</h2>
      <p>
        We may suspend or terminate your access if you breach these Terms, if your account is used
        to abuse another person or our systems, or if non-payment persists past the grace period.
        You may close your account at any time. On termination we will retain your data for the
        period described in the Privacy Policy and then delete it.
      </p>

      <h2>10. Disclaimers</h2>
      <p>
        The Service is provided &quot;as is&quot; and &quot;as available.&quot; To the maximum
        extent permitted by applicable law, we disclaim all implied warranties, including
        merchantability, fitness for a particular purpose, and non-infringement. HeyHenry is a
        record-keeping and workflow tool — it is not a substitute for professional accounting, tax,
        or legal advice.
      </p>

      <h2>11. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by applicable law, our aggregate liability arising out of or
        relating to the Service is limited to the greater of (a) the amount you paid us for the
        Service in the 12 months preceding the claim, or (b) CAD $100. We are not liable for
        indirect, incidental, special, consequential, or punitive damages, including lost profits or
        lost data, even if advised of the possibility.
      </p>

      <h2>12. Indemnification</h2>
      <p>
        You agree to indemnify and hold us harmless from claims brought by third parties (including
        your own customers) arising out of content you upload, communications you send through the
        Service, or your breach of these Terms or applicable law.
      </p>

      <h2>13. Changes to these Terms</h2>
      <p>
        We may update these Terms from time to time. Material changes will be announced by email or
        in-app notice and will take effect on the date stated in that notice. Continued use of the
        Service after the effective date constitutes acceptance of the updated Terms.
      </p>

      <h2>14. Governing law</h2>
      <p>
        These Terms are governed by the laws of the Province of British Columbia and the federal
        laws of Canada applicable therein, without regard to conflict-of-laws principles. The courts
        of British Columbia have exclusive jurisdiction, except that either party may seek
        injunctive relief in any court of competent jurisdiction.
      </p>

      <h2>15. Contact</h2>
      <p>
        Questions about these Terms? Email{' '}
        <a href="mailto:support@heyhenry.io">support@heyhenry.io</a>.
      </p>
    </div>
  );
}
