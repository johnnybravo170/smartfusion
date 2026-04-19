import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getArTemplate } from '@/lib/db/queries/ar-admin';

export const dynamic = 'force-dynamic';

export default async function AdminArTemplateDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const template = await getArTemplate(id);
  if (!template) notFound();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/admin/ar/templates"
          className="text-muted-foreground text-sm hover:text-foreground"
        >
          ← All templates
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{template.name}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary">{template.channel}</Badge>
          <span>· used in {template.usageCount} step(s)</span>
        </div>
      </div>

      {template.channel === 'email' ? (
        <Card>
          <CardHeader>
            <CardDescription>Headers</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <Row label="Subject" value={template.subject ?? '—'} />
            <Row
              label="From"
              value={
                template.fromEmail
                  ? template.fromName
                    ? `${template.fromName} <${template.fromEmail}>`
                    : template.fromEmail
                  : 'default'
              }
            />
            <Row label="Reply-To" value={template.replyTo ?? '—'} />
          </CardContent>
        </Card>
      ) : null}

      {template.bodyHtml ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">HTML body</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded-md bg-muted p-4 text-xs">
              <code>{template.bodyHtml}</code>
            </pre>
          </CardContent>
        </Card>
      ) : null}

      {template.bodyText ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Text body</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded-md bg-muted p-4 text-xs whitespace-pre-wrap">
              <code>{template.bodyText}</code>
            </pre>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-2">
      <div className="text-muted-foreground">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}
