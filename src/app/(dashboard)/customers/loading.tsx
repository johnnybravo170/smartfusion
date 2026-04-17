export default function Loading() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 animate-pulse">
      <div className="flex items-end justify-between">
        <div>
          <div className="h-8 w-40 rounded bg-muted" />
          <div className="mt-2 h-4 w-56 rounded bg-muted" />
        </div>
        <div className="h-9 w-32 rounded-md bg-muted" />
      </div>
      <div className="h-10 w-full rounded-md bg-muted" />
      <div className="space-y-2">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-14 rounded-lg border bg-card" />
        ))}
      </div>
    </div>
  );
}
