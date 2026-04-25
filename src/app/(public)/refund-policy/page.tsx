export const metadata = {
  title: 'Refund policy — HeyHenry',
};

export default function RefundPolicyPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Refund policy</h1>
      <p className="mt-4 text-base leading-relaxed text-muted-foreground">
        If you decide HeyHenry isn't for you, cancel anytime and we'll refund the unused portion of
        your current billing period to your original payment method. No questions, no friction.
      </p>

      <h2 className="mt-10 text-xl font-semibold">What happens when you cancel</h2>
      <ul className="mt-3 space-y-2 text-sm leading-relaxed list-disc pl-5">
        <li>Auto-renewal stops immediately. No further charges.</li>
        <li>
          We refund the unused days of the period you've already paid for, prorated to the day.
        </li>
        <li>
          You keep access until the end of that paid period, so you have time to export data, wrap
          active jobs, and transition cleanly.
        </li>
        <li>
          Refunds go to your original payment method, usually within 5-10 business days depending on
          your bank.
        </li>
      </ul>

      <h2 className="mt-10 text-xl font-semibold">What we don't do</h2>
      <ul className="mt-3 space-y-2 text-sm leading-relaxed list-disc pl-5">
        <li>We don't ask why you're leaving.</li>
        <li>We don't try to talk you out of it.</li>
        <li>We don't make you call a phone number, fill out a form, or wait for an agent.</li>
        <li>We don't refund past billing periods, only the current one.</li>
      </ul>

      <p className="mt-10 text-sm">
        <strong>Cancel anytime from Settings → Billing.</strong>
      </p>

      <p className="mt-4 text-sm text-muted-foreground">
        Questions? Email{' '}
        <a href="mailto:jonathan@smartfusion.ca" className="underline underline-offset-2">
          jonathan@smartfusion.ca
        </a>
        .
      </p>
    </div>
  );
}
