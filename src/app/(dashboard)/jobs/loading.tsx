export default function Loading() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 animate-pulse">
      <div className="flex items-end justify-between">
        <div>
          <div className="h-8 w-24 rounded bg-muted" />
          <div className="mt-2 h-4 w-48 rounded bg-muted" />
        </div>
        <div className="h-9 w-28 rounded-md bg-muted" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-48 rounded-xl border bg-card" />
        ))}
      </div>
    </div>
  );
}
