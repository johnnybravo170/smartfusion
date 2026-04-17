/**
 * POST /api/social-post — Generate AI social media captions for job photos.
 *
 * Takes a job ID and target platform, finds before/after photos, calls
 * Claude for a platform-specific caption, and returns the caption with
 * signed photo URLs.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { getCustomer } from '@/lib/db/queries/customers';
import { getJob } from '@/lib/db/queries/jobs';
import { listPhotosByJob, type PhotoWithUrl } from '@/lib/db/queries/photos';
import { getQuote } from '@/lib/db/queries/quotes';

// ---------------------------------------------------------------------------
// Lazy-init Anthropic client (matches chat route pattern)
// ---------------------------------------------------------------------------

let _client: Anthropic | null = null;
function getAnthropicClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Platform = 'instagram' | 'facebook';

type SocialPostRequest = {
  jobId: string;
  platform: Platform;
};

export type SocialPostResponse = {
  caption: string;
  hashtags: string[];
  beforeUrl: string;
  afterUrl: string;
};

// ---------------------------------------------------------------------------
// Prompt construction (exported for unit testing)
// ---------------------------------------------------------------------------

export function buildSocialPrompt(opts: {
  platform: Platform;
  city?: string | null;
  surfaces?: string[];
  businessName: string;
}): { system: string; user: string } {
  const system = `You write social media captions for a local pressure washing business. Your job is to sound like a real person who is proud of their work, not a marketing agency.

RULES:
- 1-2 sentences MAX for the caption. Let the photos do the talking.
- Sound like a real tradesperson posting from the job site, not a copywriter.
- No corporate speak. Never say "thrilled", "exceptional", "trusted professionals", "don't hesitate to reach out".
- Max 2 emojis per post. Less is more. No emoji spam.
- Mention the city/area naturally when provided.
- Vary your style. Don't use the same formula every time.

GOOD EXAMPLES (study these):
- "2 years of grime. Gone in 2 hours."
- "The homeowner thought they needed a new driveway. Turns out they just needed us."
- "Before you replace your deck, call us first."
- "3 hours, 2 surface cleaners, 1 very happy customer."
- "Saturday morning in Abbotsford. This one was satisfying."
- "They said it couldn't be cleaned. We said hold my pressure washer."

BAD EXAMPLES (never write like this):
- "We're thrilled to showcase this AMAZING transformation! Contact us today for a free quote! 💪🔥✨🏠"
- "At [Business], we pride ourselves on delivering exceptional results for our valued customers."
- "Check out this incredible before and after! We are so proud of our team!"

For hashtags: 5-8 max. Mix of local (#abbotsford #fraservalley) and trade (#pressurewashing #beforeandafter #satisfying). No made-up hashtags.`;

  const lines = [`Write a ${opts.platform} caption for this pressure washing job:`];
  if (opts.city) lines.push(`- Customer area: ${opts.city}`);
  if (opts.surfaces && opts.surfaces.length > 0) {
    lines.push(`- Surfaces cleaned: ${opts.surfaces.join(', ')}`);
  }
  lines.push(`- Business name: ${opts.businessName}`);
  lines.push('');
  lines.push(
    'Return valid JSON only, no markdown fences: { "caption": "...", "hashtags": ["...", "..."] }',
  );

  return { system, user: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findBeforeAfterPair(photos: PhotoWithUrl[]): {
  before: PhotoWithUrl;
  after: PhotoWithUrl;
} | null {
  const before = photos.find((p) => p.tag === 'before' && p.url);
  const after = photos.find((p) => p.tag === 'after' && p.url);
  if (!before || !after) return null;
  return { before, after };
}

function parseCaptionResponse(text: string): { caption: string; hashtags: string[] } {
  // Strip markdown fences if the model wraps the JSON anyway
  const cleaned = text
    .replace(/```json\s*/g, '')
    .replace(/```\s*/g, '')
    .trim();
  const parsed = JSON.parse(cleaned) as { caption: string; hashtags: string[] };
  return {
    caption: parsed.caption ?? '',
    hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : [],
  };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  // 1. Authenticate
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Parse body
  let body: SocialPostRequest;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { jobId, platform } = body;
  if (!jobId || !['instagram', 'facebook'].includes(platform)) {
    return Response.json(
      { error: 'jobId (string) and platform (instagram|facebook) are required' },
      { status: 400 },
    );
  }

  // 3. Load job
  const job = await getJob(jobId);
  if (!job) {
    return Response.json({ error: 'Job not found' }, { status: 404 });
  }

  // 4. Load photos and find before/after pair
  const photos = await listPhotosByJob(jobId);
  const pair = findBeforeAfterPair(photos);
  if (!pair) {
    return Response.json(
      { error: 'This job needs at least one "before" and one "after" photo' },
      { status: 422 },
    );
  }

  // 5. Load customer city (if available)
  let customerCity: string | null = null;
  if (job.customer_id) {
    const customer = await getCustomer(job.customer_id);
    customerCity = customer?.city ?? null;
  }

  // 6. Load surfaces from linked quote (if available)
  let surfaces: string[] = [];
  if (job.quote_id) {
    try {
      const quote = await getQuote(job.quote_id);
      if (quote?.surfaces) {
        surfaces = quote.surfaces.map((s) => s.surface_type);
      }
    } catch {
      // Non-critical; proceed without surfaces
    }
  }

  // 7. Call Claude
  const { system, user } = buildSocialPrompt({
    platform,
    city: customerCity,
    surfaces,
    businessName: tenant.name,
  });

  const model = process.env.CHAT_MODEL || 'claude-sonnet-4-6';

  try {
    const client = getAnthropicClient();
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: user }],
    });

    // Extract text from response
    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return Response.json({ error: 'No text in AI response' }, { status: 500 });
    }

    const { caption, hashtags } = parseCaptionResponse(textBlock.text);

    const result: SocialPostResponse = {
      caption,
      hashtags,
      beforeUrl: pair.before.url ?? '',
      afterUrl: pair.after.url ?? '',
    };

    return Response.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to generate caption';
    return Response.json({ error: message }, { status: 500 });
  }
}
