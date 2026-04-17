/**
 * POST /api/tts — Text-to-speech proxy for ElevenLabs.
 *
 * Keeps the API key server-side. Returns audio/mpeg stream on success.
 * Returns 501 when env vars are missing so the client can fall back
 * to browser SpeechSynthesis.
 *
 * Rate limited: 500 chars max per request, 50 requests/hour per tenant.
 */

import { getCurrentTenant } from '@/lib/auth/helpers';

// ---------------------------------------------------------------------------
// Rate limiting (in-memory, good enough for v1)
// ---------------------------------------------------------------------------

const MAX_CHARS = 500;
const MAX_REQUESTS_PER_HOUR = 50;

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(tenantId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(tenantId);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(tenantId, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return true;
  }

  if (entry.count >= MAX_REQUESTS_PER_HOUR) {
    return false;
  }

  entry.count += 1;
  return true;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  // 1. Authenticate
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 2. Check env vars
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;

  if (!apiKey || !voiceId) {
    return new Response(JSON.stringify({ error: 'ElevenLabs not configured' }), {
      status: 501,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 3. Parse body
  let text: string;
  try {
    const body = (await request.json()) as { text?: string };
    text = typeof body.text === 'string' ? body.text.trim() : '';
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!text) {
    return new Response(JSON.stringify({ error: 'Text is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 4. Rate limit
  if (!checkRateLimit(tenant.id)) {
    return new Response(JSON.stringify({ error: 'TTS rate limit exceeded (50/hour)' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 5. Truncate long text
  const truncatedText = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}...` : text;

  // 6. Call ElevenLabs
  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: truncatedText,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      console.error('[TTS] ElevenLabs error:', response.status, errorText);
      return new Response(JSON.stringify({ error: 'TTS provider error' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Stream the audio back
    return new Response(response.body, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('[TTS] Fetch failed:', err);
    return new Response(JSON.stringify({ error: 'TTS request failed' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
