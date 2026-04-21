import { NewKeyForm } from './new-key-form';

export default function NewKeyPage() {
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">New API key</h1>
        <p className="mt-1 text-sm text-[var(--muted-foreground)]">
          The raw secret is shown once after creation. Copy it to 1Password before closing the
          dialog — it's not recoverable.
        </p>
      </header>
      <NewKeyForm />
    </div>
  );
}
