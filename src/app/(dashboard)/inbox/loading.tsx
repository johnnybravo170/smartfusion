export default function Loading() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 animate-pulse">
      <div>
        <div className="h-8 w-24 rounded bg-muted" />
        <div className="mt-2 h-4 w-48 rounded bg-muted" />
      </div>
      <div className="flex gap-2">
        <div className="h-9 w-24 rounded-md bg-muted" />
        <div className="h-9 w-24 rounded-md bg-muted" />
      </div>
      <div className="space-y-2">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-16 rounded-lg border bg-card" />
        ))}
      </div>
    </div>
  );
}
