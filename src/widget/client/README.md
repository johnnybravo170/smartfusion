# HeyHenry lead-capture client

Reference client module for embedding HeyHenry's lead-capture pipeline
into a tenant's own website (Next.js, Vite, Astro, plain JS — anything
that runs in a browser). The host site keeps its existing form design;
this module handles the API plumbing (photo upload, signed URLs, final
submit, AI classifier trigger via the server).

The full pipeline:

```
Homeowner fills out form  →  submitLead({...})
                              │
                              │  for each photo:
                              ├──▶  POST /api/widget/signed-upload-url   (mint signed PUT URL)
                              │      └─▶  PUT bytes → Supabase Storage   (bypasses Vercel 4.5 MB cap)
                              │
                              └──▶  POST /api/widget/submit
                                     └─▶  intake_drafts row created
                                          └─▶  AI classifier runs
                                               └─▶  contractor gets email with deep link
```

## Files in this folder

- `submit-lead.ts` — the actual client module. Copy this file verbatim
  into the tenant's repo (e.g. `lib/heyhenry/submit-lead.ts`).
- `README.md` — this file.

## Integration into a Next.js contact page

### 1. Drop the module in

Copy `submit-lead.ts` into the tenant's repo at e.g.
`lib/heyhenry/submit-lead.ts`. No transitive dependencies — just browser
`fetch` and `File`. Compiles cleanly in any modern Next.js project.

### 2. Add the widget token to `.env.local`

```
NEXT_PUBLIC_HEYHENRY_TOKEN=wgt_xxxxxxxxxxxxxxxxxxxxxxxx
```

Tokens are public-key-style — safe to ship in `NEXT_PUBLIC_*`. Abuse is
gated by per-IP + per-token rate limits on the API side, not by token
secrecy.

### 3. Wire up the form's `onSubmit`

Replace whatever the form currently does on submit with a `submitLead`
call:

```tsx
'use client';
import { useState, type FormEvent } from 'react';
import { submitLead } from '@/lib/heyhenry/submit-lead';

export function ContactForm() {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [description, setDescription] = useState('');
  const [photos, setPhotos] = useState<File[]>([]);
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus('sending');
    const result = await submitLead({
      token: process.env.NEXT_PUBLIC_HEYHENRY_TOKEN!,
      name,
      phone,
      email: email || null,
      description,
      photos,
    });
    if (result.ok) {
      setStatus('sent');
    } else {
      setStatus('error');
      setErrorMessage(result.error);
    }
  }

  if (status === 'sent') {
    return <p>Thanks — we'll get back to you within one business day.</p>;
  }

  return (
    <form onSubmit={handleSubmit}>
      {/* existing Name, Phone, Email, "Tell us about your project" fields */}

      {/* New: photo input — keep the host's own styling */}
      <label htmlFor="photos">Photos (optional)</label>
      <p style={{ fontSize: 14, color: '#666' }}>
        A wide shot plus a close-up of the area helps us quote faster.
      </p>
      <input
        id="photos"
        type="file"
        multiple
        accept="image/jpeg,image/png,image/heic,image/heif,image/webp"
        onChange={(e) => setPhotos(Array.from(e.target.files ?? []))}
      />
      {photos.length > 0 && (
        <p style={{ fontSize: 14 }}>
          {photos.length} photo{photos.length === 1 ? '' : 's'} selected
        </p>
      )}

      <button type="submit" disabled={status === 'sending'}>
        {status === 'sending' ? 'Sending…' : 'Send message'}
      </button>

      {/* Tiny "Powered by Henry" caption — Jonathan's V1 call */}
      <p style={{ marginTop: 12, fontSize: 12, color: '#999' }}>
        Powered by{' '}
        <a href="https://heyhenry.io" style={{ color: 'inherit' }}>
          Henry
        </a>
      </p>

      {status === 'error' && (
        <p role="alert" style={{ color: '#c33' }}>
          {errorMessage}
        </p>
      )}
    </form>
  );
}
```

The rest of the form (Name, Phone, Email, textarea) keeps its existing
markup, classes, and styles. The module imposes nothing.

### 4. Test against staging or production

Use a real widget token and submit the form. Within ~10–15 seconds the
contractor sees a new lead at `https://app.heyhenry.io/inbox/intake`
and receives a notification email.

## API behaviour

### `submitLead(input)`

- **`token`** — `wgt_...`, public-key-style.
- **`name` / `phone`** — required. Server rejects empty/whitespace.
- **`email`** — optional, validated only loosely.
- **`description`** — required. Free text up to ~5000 chars.
- **`photos`** — optional `File[]`. Each photo is validated and
  uploaded in sequence. Allowed mimes: `image/jpeg`, `image/png`,
  `image/heic`, `image/heif`, `image/webp`. Size cap: 25 MB per file.
  Files outside the allow-list are silently skipped — the form still
  submits.

Returns either:

```ts
{ ok: true; draftId: string; uploadedPhotos: number; skippedPhotos: number }
```

or

```ts
{ ok: false; error: string; orphanedUploads?: boolean }
```

`orphanedUploads = true` means one or more photos uploaded successfully
but the final submit failed — useful for telemetry, harmless otherwise
(the photos sit in storage unreferenced).

### Rate limits (per IP + per token)

Enforced server-side:

| Endpoint                    | Per IP            | Per token         |
|-----------------------------|-------------------|-------------------|
| `/api/widget/signed-upload-url` | 10 / hour         | 50 / hour         |
| `/api/widget/submit`            | 5 / hour          | 50 / hour         |

A homeowner won't hit these in normal use. If a token leaks and gets
hammered, the cap protects spend on the AI classifier.

### CORS

`/api/widget/*` returns `Access-Control-Allow-Origin: *`. Tenants who
want to lock to their own origin can have an `allowed_origins` list
seeded on their `widget_configs` row; requests from other origins then
get rejected at the auth gate.

## What this module does NOT do

- **Photo compression.** iPhone HEIC at 5–7 MB and Android JPEG up to
  ~12 MB upload fine. If you want smaller uploads, run them through
  `browser-image-compression` (or similar) before passing to
  `submitLead`.
- **CAPTCHA / spam.** The endpoint is rate-limited but not bot-gated.
  Add hCaptcha / Turnstile / honeypot field on the host form if spam
  becomes an issue.
- **Visual rendering.** No CSS is shipped. The host owns every pixel.

## Updating this module

If `/api/widget/*` changes shape, update `submit-lead.ts` here AND in
every tenant's repo that has copied it. There's no version negotiation
yet — V1 contract is "match the production endpoint." When the API
needs a breaking change, we'll add `Accept-Version` headers and
version the response shape.
