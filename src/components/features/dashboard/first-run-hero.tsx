import { ArrowRight, FileText, FolderPlus, Send, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const STEPS = [
  {
    n: 1,
    icon: UserPlus,
    title: 'Add a customer',
    body: 'Their name + how to reach them. 30 seconds.',
    href: '/contacts/new',
  },
  {
    n: 2,
    icon: FolderPlus,
    title: 'Start a project',
    body: 'A spot for the quote, photos, schedule, and money.',
    href: '/projects/new',
  },
  {
    n: 3,
    icon: FileText,
    title: 'Build a quote',
    body: 'Line items, scope, taxes — done from the truck.',
    href: '/quotes/new',
  },
] as const;

const STEPS_NON_RENO = [
  {
    n: 1,
    icon: UserPlus,
    title: 'Add a customer',
    body: 'Their name + how to reach them. 30 seconds.',
    href: '/contacts/new',
  },
  {
    n: 2,
    icon: FileText,
    title: 'Build your first quote',
    body: 'Line items, scope, taxes — done from the truck.',
    href: '/quotes/new',
  },
  {
    n: 3,
    icon: Send,
    title: 'Send it',
    body: 'Email it to your customer and get the job moving.',
    href: '/quotes',
  },
] as const;

/**
 * Welcome card shown above all dashboard sections when a tenant has zero
 * customers, projects, and quotes. Hides automatically the moment they
 * create their first anything. Three numbered click-cards hand them the
 * shortest path to seeing value, with copy tuned to the renovation
 * vertical (most signups) and a fallback variant for service-based
 * verticals like pressure-washing where projects aren't the unit of work.
 */
export function FirstRunHero({
  firstName,
  vertical,
}: {
  firstName: string | null;
  vertical: string;
}) {
  const isRenovation = vertical === 'renovation' || vertical === 'tile';
  const steps = isRenovation ? STEPS : STEPS_NON_RENO;
  const greeting = firstName ? `Welcome to HeyHenry, ${firstName}.` : 'Welcome to HeyHenry.';

  return (
    <Card>
      <CardHeader>
        <CardTitle>{greeting}</CardTitle>
        <CardDescription>
          Three steps to your first quote. Most contractors knock these out in 5 minutes.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-3">
        {steps.map((step) => {
          const Icon = step.icon;
          return (
            <Link
              key={step.n}
              href={step.href}
              className="group relative flex flex-col gap-2 rounded-lg border bg-background p-4 transition hover:border-foreground/40 hover:bg-muted/30"
            >
              <div className="flex items-center gap-2">
                <span className="inline-flex size-6 items-center justify-center rounded-full bg-foreground text-background text-xs font-semibold">
                  {step.n}
                </span>
                <Icon className="size-4 text-muted-foreground" aria-hidden />
              </div>
              <div className="flex-1">
                <p className="font-medium">{step.title}</p>
                <p className="text-xs text-muted-foreground">{step.body}</p>
              </div>
              <ArrowRight
                aria-hidden
                className="absolute right-3 top-3 size-4 text-muted-foreground opacity-0 transition group-hover:opacity-100"
              />
            </Link>
          );
        })}
      </CardContent>
    </Card>
  );
}
