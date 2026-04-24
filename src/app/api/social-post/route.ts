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
  completedAt?: string | null;
}): { system: string; user: string } {
  const system = `You write social media captions for a local pressure washing business. Your job is to sound like a real person who is proud of their work, not a marketing agency.

RULES:
- 1-2 sentences MAX for the caption. Let the photos do the talking.
- Sound like a real tradesperson posting from the job site, not a copywriter.
- No corporate speak. Never say "thrilled", "exceptional", "trusted professionals", "don't hesitate to reach out".
- Max 2 emojis per post. Less is more. No emoji spam.
- Mention the city/area naturally when provided.
- Vary your style. Don't use the same formula every time.
- NEVER invent details you don't know. You do NOT know the day of the week, time of day, how long the job took, or the weather. Only state facts from the data provided or what you can see in the photos. If you want to mention something specific, it must come from the provided context.

GOOD EXAMPLES (study these):
- "Chilliwack driveway, back to its original colour."
- "The homeowner thought they needed a new driveway. Turns out they just needed us."
- "Before you replace your deck, call us first."
- "This one was satisfying."
- "They said it couldn't be cleaned. We said hold my pressure washer."
- "Night and day difference on this one."

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
  if (opts.completedAt) {
    const d = new Date(opts.completedAt);
    const day = d.toLocaleDateString('en-CA', { weekday: 'long' });
    const time = d.getHours() < 12 ? 'morning' : d.getHours() < 17 ? 'afternoon' : 'evening';
    lines.push(`- Completed: ${day} ${time}`);
  }
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
  before: PhotoWithUrl & { url: string };
  after: PhotoWithUrl & { url: string };
} | null {
  const before = photos.find((p) => p.tag === 'before' && p.url);
  const after = photos.find((p) => p.tag === 'after' && p.url);
  if (!before?.url || !after?.url) return null;
  return {
    before: before as PhotoWithUrl & { url: string },
    after: after as PhotoWithUrl & { url: string },
  };
}

function parseCaptionResponse(text: string): { caption: string; hashtags: string[] } {
  // Claude with vision often wraps JSON in markdown fences or adds
  // commentary before/after. Extract the JSON object robustly.
  try {
    // Try 1: strip markdown fences and parse
    const stripped = text
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();
    const parsed = JSON.parse(stripped) as { caption: string; hashtags: string[] };
    return {
      caption: parsed.caption ?? '',
      hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : [],
    };
  } catch {
    // Try 2: find JSON object in the text (Claude may add text around it)
    const jsonMatch = text.match(/\{[\s\S]*"caption"[\s\S]*"hashtags"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as { caption: string; hashtags: string[] };
        return {
          caption: parsed.caption ?? '',
          hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : [],
        };
      } catch {
        // Fall through
      }
    }
    // Try 3: just use the raw text as the caption
    return { caption: text.trim(), hashtags: [] };
  }
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

  // 7. Call Claude with vision (send the actual photos)
  const { system, user } = buildSocialPrompt({
    platform,
    city: customerCity,
    surfaces,
    businessName: tenant.name,
    completedAt: job.completed_at ?? null,
  });

  const model = process.env.CHAT_MODEL || 'claude-sonnet-4-6';

  // Fetch photos as base64 for Claude vision
  let imageContent: Anthropic.Messages.ImageBlockParam[] = [];
  try {
    const [beforeRes, afterRes] = await Promise.all([
      fetch(pair.before.url),
      fetch(pair.after.url),
    ]);
    if (beforeRes.ok && afterRes.ok) {
      const [beforeBuf, afterBuf] = await Promise.all([
        beforeRes.arrayBuffer(),
        afterRes.arrayBuffer(),
      ]);
      const beforeB64 = Buffer.from(beforeBuf).toString('base64');
      const afterB64 = Buffer.from(afterBuf).toString('base64');
      const beforeType = (beforeRes.headers.get('content-type') || 'image/jpeg') as
        | 'image/jpeg'
        | 'image/png'
        | 'image/gif'
        | 'image/webp';
      const afterType = (afterRes.headers.get('content-type') || 'image/jpeg') as
        | 'image/jpeg'
        | 'image/png'
        | 'image/gif'
        | 'image/webp';

      imageContent = [
        { type: 'image', source: { type: 'base64', media_type: beforeType, data: beforeB64 } },
        { type: 'image', source: { type: 'base64', media_type: afterType, data: afterB64 } },
      ];
    }
  } catch {
    // If photo fetch fails, proceed without vision (text-only prompt)
  }

  try {
    const client = getAnthropicClient();
    const userContent: Anthropic.Messages.ContentBlockParam[] = [
      ...imageContent,
      {
        type: 'text',
        text:
          (imageContent.length > 0
            ? 'The first image is the BEFORE photo and the second is the AFTER photo. Describe what you actually SEE was cleaned (driveway, deck, siding, fence, etc). Do NOT guess from the surface list if it contradicts what the photos show.\n\n'
            : '') + user,
      },
    ];

    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: userContent }],
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
