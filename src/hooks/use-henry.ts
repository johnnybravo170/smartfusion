'use client';

/**
 * useHenry — OpenAI Realtime voice + text session manager.
 *
 * Migrated from Gemini Live on 2026-04-21. Opens a WebSocket to
 * wss://api.openai.com/v1/realtime using an ephemeral client_secret minted
 * at /api/henry/session. Audio is PCM16 24kHz mono in both directions.
 * Server-side VAD (configured at mint time) detects end-of-turn, so the UX
 * is "enable voice → talk → pause → Henry replies" with no push-to-talk.
 *
 * Tool calls are dispatched to /api/henry/tool under the operator's RLS
 * session, except for the three client-side screen-awareness tools which
 * run in-process against React state.
 *
 * Return shape stays API-compatible with the existing chat-panel but
 * exposes `toggleVoice` / `stopSpeaking` only — push-to-talk is gone.
 */

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { findFeatureByPath } from '@/lib/ai/feature-catalog';
import { CLIENT_TOOL_NAMES } from '@/lib/henry/openai-tools';
import { useHenryScreen } from '@/lib/henry/screen-context';

export type HenryMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
};

export type VoiceState = 'off' | 'idle' | 'listening' | 'processing' | 'speaking';

export type UseHenryReturn = {
  messages: HenryMessage[];
  isLoading: boolean;
  isPanelOpen: boolean;
  activeTool: string | null;
  error: string | null;
  sendMessage: (content: string) => void;
  togglePanel: () => void;
  clearHistory: () => void;
  clearError: () => void;
  voice: {
    voiceEnabled: boolean;
    voiceState: VoiceState;
    isSupported: boolean;
    toggleVoice: () => void;
    stopSpeaking: () => void;
  };
};

const PANEL_STORAGE_KEY = 'heyhenry-chat-open';
const SAMPLE_RATE = 24_000; // OpenAI Realtime = PCM16 24kHz both directions

/**
 * Tool name prefixes that signal a state mutation. After a tool with
 * one of these prefixes returns successfully, we fire router.refresh()
 * so the underlying RSC page (whatever tab the operator is on)
 * re-renders with the new data — no manual reload needed.
 *
 * Keep it conservative: read-only tools (`list_*`, `get_*`) shouldn't
 * trigger a refresh because that's wasted work in voice sessions where
 * tools fire continuously.
 */
const MUTATING_TOOL_PREFIXES = [
  'create_',
  'update_',
  'delete_',
  'set_',
  'add_',
  'remove_',
  'transition_',
  'cancel_',
  'send_',
  'mark_',
  'upsert_',
  'lock_',
  'unlock_',
];

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function readPanelState(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(PANEL_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function float32ToPcm16Base64(input: Float32Array): string {
  const buf = new ArrayBuffer(input.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function pcm16Base64ToFloat32(b64: string): Float32Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const len = bytes.length / 2;
  const buf = new ArrayBuffer(len * 4);
  const out = new Float32Array(buf);
  for (let i = 0; i < len; i++) {
    out[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  return out;
}

function runClientTool(
  name: string,
  args: Record<string, unknown>,
  screen: ReturnType<typeof useHenryScreen>,
): string {
  if (name === 'get_current_screen_context') {
    const form = screen.form;
    const feature = findFeatureByPath(screen.route);
    return JSON.stringify({
      route: screen.route,
      page: feature
        ? {
            name: feature.name,
            summary: feature.summary,
          }
        : null,
      form: form
        ? {
            formId: form.formId,
            title: form.title,
            fields: form.fields.map((f) => ({
              name: f.name,
              label: f.label,
              type: f.type,
              description: f.description,
              options: f.options,
              currentValue: f.currentValue ?? null,
            })),
            canSubmit: Boolean(form.submit),
          }
        : null,
    });
  }

  if (name === 'fill_current_form') {
    const form = screen.form;
    if (!form) {
      return 'No form is currently registered on this screen. Use a regular tool (e.g. create_customer) instead.';
    }
    const fields = Array.isArray(args.fields)
      ? (args.fields as Array<{ name?: unknown; value?: unknown }>)
      : [];
    const results: string[] = [];
    for (const f of fields) {
      const fname = typeof f.name === 'string' ? f.name : '';
      const fvalue = f.value == null ? '' : String(f.value);
      if (!fname) {
        results.push(`(skipped) missing name`);
        continue;
      }
      const ok = form.setField(fname, fvalue);
      results.push(`${fname}: ${ok ? 'set' : 'not accepted (unknown field?)'}`);
    }
    return `Filled ${fields.length} field(s): ${results.join('; ')}`;
  }

  if (name === 'submit_current_form') {
    const form = screen.form;
    if (!form) return 'No form registered on this screen.';
    if (!form.submit)
      return 'This form does not support programmatic submit; ask the operator to tap the submit button.';
    form.submit();
    return 'Form submitted.';
  }

  return `Unknown client tool: ${name}`;
}

// ─── OpenAI Realtime server event shapes (subset we actually consume) ─────
type ServerEvent =
  | { type: 'session.created' | 'session.updated' }
  | { type: 'error'; error?: { message?: string; code?: string } }
  | { type: 'input_audio_buffer.speech_started' }
  | { type: 'input_audio_buffer.speech_stopped' }
  | {
      type: 'conversation.item.input_audio_transcription.delta';
      delta?: string;
      item_id?: string;
    }
  | {
      type: 'conversation.item.input_audio_transcription.completed';
      transcript?: string;
      item_id?: string;
    }
  | { type: 'response.created' }
  | { type: 'response.output_audio.delta'; delta?: string }
  | { type: 'response.output_audio.done' }
  | { type: 'response.output_audio_transcript.delta'; delta?: string }
  | { type: 'response.output_audio_transcript.done' }
  | { type: 'response.output_text.delta'; delta?: string }
  | { type: 'response.output_text.done' }
  | {
      type: 'response.function_call_arguments.done';
      call_id?: string;
      name?: string;
      arguments?: string;
    }
  | { type: 'response.done'; response?: { status?: string } }
  | { type: string };

export function useHenry(): UseHenryReturn {
  const [messages, setMessages] = useState<HenryMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>('off');
  const [isSupported, setIsSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clearError = useCallback(() => setError(null), []);

  const router = useRouter();

  const screen = useHenryScreen();
  const screenRef = useRef(screen);
  screenRef.current = screen;

  const wsRef = useRef<WebSocket | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const procNodeRef = useRef<ScriptProcessorNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const playbackCursorRef = useRef<number>(0);
  // Track every AudioBufferSourceNode we schedule so we can explicitly
  // stop() them on teardown. Closing the AudioContext SHOULD silence
  // queued sources but iOS Safari is inconsistent — explicit stop is
  // belt-and-suspenders so the user actually gets silence on tap.
  const scheduledSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const currentAssistantIdRef = useRef<string | null>(null);
  const currentUserIdRef = useRef<string | null>(null);

  // Auto-reconnect plumbing. The onclose handler runs inside `connect`, so we
  // can't reference `connect`/`startMicCapture` directly without a ref hop.
  const voiceEnabledRef = useRef(false);
  const reconnectAttemptedRef = useRef(false);
  const connectRef = useRef<(() => Promise<void>) | null>(null);
  const startMicCaptureRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    setIsSupported(
      typeof window !== 'undefined' &&
        !!navigator.mediaDevices?.getUserMedia &&
        typeof AudioContext !== 'undefined' &&
        typeof WebSocket !== 'undefined',
    );
    setIsPanelOpen(readPanelState());
  }, []);

  const togglePanel = useCallback(() => {
    setIsPanelOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(PANEL_STORAGE_KEY, String(next));
      } catch {
        // localStorage unavailable
      }
      // Closing the panel = "I'm done with Henry for now." Tear down
      // the voice session so audio stops and the mic releases. Without
      // this Henry kept reacting to ambient sound and finishing his
      // last sentence after the panel was already gone.
      if (!next && (wsRef.current || micStreamRef.current)) {
        // Use rAF so the close animation can start before we yank
        // the audio context.
        queueMicrotask(() => {
          // Inline the disconnect-y bits directly to avoid a forward
          // reference (disconnect isn't defined yet at this point in
          // the file).
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            try {
              wsRef.current.send(JSON.stringify({ type: 'response.cancel' }));
            } catch {
              /* socket may have closed mid-send */
            }
          }
          wsRef.current?.close();
          wsRef.current = null;
          micStreamRef.current?.getTracks().forEach((t) => {
            t.stop();
          });
          micStreamRef.current = null;
          for (const src of scheduledSourcesRef.current) {
            try {
              src.stop();
            } catch {
              /* already stopped */
            }
            try {
              src.disconnect();
            } catch {
              /* not connected */
            }
          }
          scheduledSourcesRef.current.clear();
          outputAudioCtxRef.current?.close().catch(() => {});
          outputAudioCtxRef.current = null;
          playbackCursorRef.current = 0;
          setVoiceEnabled(false);
          setVoiceState('off');
          setActiveTool(null);
        });
      }
      return next;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setMessages([]);
    setActiveTool(null);
    // Stop Henry mid-sentence if he's currently speaking, and cancel
    // any pending response. Without this, hitting the trash icon
    // emptied the visible thread but Henry kept finishing his
    // previous turn.
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify({ type: 'response.cancel' }));
      } catch {
        /* socket may have closed mid-send */
      }
    }
    for (const src of scheduledSourcesRef.current) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      try {
        src.disconnect();
      } catch {
        /* not connected */
      }
    }
    scheduledSourcesRef.current.clear();
    playbackCursorRef.current = 0;
    setVoiceState((prev) => (prev === 'speaking' ? 'idle' : prev));
  }, []);

  const sendEvent = useCallback((evt: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(evt));
  }, []);

  // ─── Audio out ─────────────────────────────────────────────────────────
  const playAudioChunk = useCallback((b64: string) => {
    const ctx = outputAudioCtxRef.current;
    if (!ctx) return;
    // iOS Safari (and some Android browsers) keep AudioContext in 'suspended'
    // state until you explicitly resume() — even when it was created during
    // a user gesture. Without this, the response audio is generated and
    // scheduled but you hear nothing.
    if (ctx.state === 'suspended') {
      ctx.resume().catch((e) => console.warn('[Henry] outputAudioCtx.resume failed:', e));
    }
    const pcm = pcm16Base64ToFloat32(b64);
    const buffer = ctx.createBuffer(1, pcm.length, SAMPLE_RATE);
    buffer.copyToChannel(pcm, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, playbackCursorRef.current);
    src.start(startAt);
    playbackCursorRef.current = startAt + buffer.duration;
    setVoiceState('speaking');
    // Track for explicit teardown; remove from set when it ends naturally.
    scheduledSourcesRef.current.add(src);
    src.onended = () => {
      scheduledSourcesRef.current.delete(src);
    };
  }, []);

  /**
   * Silence everything immediately — explicit stop on every queued audio
   * source, then close the output context. Belt-and-suspenders; closing
   * the context alone has been seen to leave a residual trail on iOS.
   */
  const silenceAllAudio = useCallback(() => {
    for (const src of scheduledSourcesRef.current) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      try {
        src.disconnect();
      } catch {
        /* not connected */
      }
    }
    scheduledSourcesRef.current.clear();
    outputAudioCtxRef.current?.close().catch(() => {});
    outputAudioCtxRef.current = null;
    playbackCursorRef.current = 0;
  }, []);

  const stopSpeaking = useCallback(() => {
    if (!outputAudioCtxRef.current) return;
    // Tell the server to stop generating BEFORE we tear down audio so
    // the cancel event lands on an open WS.
    sendEvent({ type: 'response.cancel' });
    silenceAllAudio();
    // Spin up a fresh context for the next response chunk. Eagerly
    // resume — iOS Safari creates fresh contexts in 'suspended' state
    // outside a user gesture (this codepath runs from a WS message
    // handler, which iOS does NOT count as a gesture).
    const fresh = new AudioContext({ sampleRate: SAMPLE_RATE });
    fresh.resume().catch(() => {});
    outputAudioCtxRef.current = fresh;
    setVoiceState('idle');
  }, [sendEvent, silenceAllAudio]);

  // ─── Tool call dispatch ────────────────────────────────────────────────
  const handleFunctionCall = useCallback(
    async (callId: string, name: string, argsJson: string): Promise<void> => {
      setActiveTool(name);
      let output: string;
      let mutated = false;
      try {
        const args = argsJson ? JSON.parse(argsJson) : {};
        if (CLIENT_TOOL_NAMES.has(name)) {
          output = runClientTool(name, args, screenRef.current);
        } else {
          // Tool name prefixes that signal a state mutation. After a
          // successful call we'll fire router.refresh() so the underlying
          // page (e.g. the Schedule tab the operator was looking at when
          // they asked Henry to "lock in the dates") re-fetches RSC data
          // and reflects the change without a manual reload.
          mutated = MUTATING_TOOL_PREFIXES.some((p) => name.startsWith(p));
          const res = await fetch('/api/henry/tool', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, args }),
          });
          // Read the body once, then decide. Surface real errors to the model
          // (and the user) instead of silently degrading to "No output." —
          // that pattern caused the model to end its turn with no audio when
          // the tool route returned 401/500.
          const raw = await res.text();
          let parsed: { result?: string; error?: string } | null = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            parsed = null;
          }
          if (!res.ok) {
            const reason = parsed?.error ?? raw.slice(0, 200) ?? res.statusText;
            console.error('[Henry] tool call failed', { name, status: res.status, reason });
            output = `Tool "${name}" failed (${res.status}): ${reason}`;
          } else if (parsed && typeof parsed.result === 'string') {
            output = parsed.result;
          } else {
            console.error('[Henry] tool call returned no result', { name, raw });
            output = `Tool "${name}" returned an empty response.`;
          }
        }
      } catch (e) {
        output = `Tool call failed: ${e instanceof Error ? e.message : String(e)}`;
      } finally {
        setActiveTool(null);
      }

      // Refresh the underlying RSC page when a mutating tool succeeded
      // so the operator sees the change without a manual reload (e.g.
      // Henry firms up a task → Schedule tab re-renders with the solid
      // bar). Only when output doesn't start with our error prefixes —
      // we don't want to refresh on a no-op tool failure.
      if (mutated && !/^(Tool ".+" failed|Failed |Tool call failed)/.test(output)) {
        router.refresh();
      }

      sendEvent({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output,
        },
      });
      sendEvent({ type: 'response.create' });
    },
    [sendEvent, router],
  );

  // ─── Server event handler ──────────────────────────────────────────────
  const handleServerEvent = useCallback(
    (evt: ServerEvent) => {
      // Temporary: log every event so we can diagnose what the server is
      // actually sending. Remove once voice is verified working.
      console.log('[Henry] ←', evt.type, evt);
      switch (evt.type) {
        case 'session.created':
        case 'session.updated':
          setIsLoading(false);
          setError(null);
          return;

        case 'error': {
          const msg = ('error' in evt && evt.error?.message) || 'Realtime error';
          const code = ('error' in evt && evt.error?.code) || '';
          // Suppress harmless server complaints. "Cancellation failed: no
          // active response" fires when stopSpeaking() races a response that
          // already finished — annoying red banner, no user impact.
          const isHarmless =
            /no active response/i.test(msg) || code === 'response_cancel_not_active';
          if (isHarmless) {
            console.warn('[Henry] suppressed realtime error:', msg);
            return;
          }
          console.error('[Henry] realtime error:', msg, evt);
          setError(msg);
          return;
        }

        case 'input_audio_buffer.speech_started':
          setVoiceState('listening');
          // User interrupted Henry; flush any queued output audio.
          if (outputAudioCtxRef.current && playbackCursorRef.current > 0) {
            stopSpeaking();
          }
          return;

        case 'input_audio_buffer.speech_stopped':
          setVoiceState('processing');
          return;

        case 'conversation.item.input_audio_transcription.delta': {
          const delta = 'delta' in evt ? evt.delta : undefined;
          if (!delta) return;
          setMessages((prev) => {
            let id = currentUserIdRef.current;
            if (!id) {
              id = generateId();
              currentUserIdRef.current = id;
              return [...prev, { id, role: 'user', content: delta }];
            }
            return prev.map((m) => (m.id === id ? { ...m, content: m.content + delta } : m));
          });
          return;
        }

        case 'conversation.item.input_audio_transcription.completed':
          currentUserIdRef.current = null;
          return;

        case 'response.created':
          setIsLoading(true);
          return;

        case 'response.output_audio.delta': {
          const delta = 'delta' in evt ? evt.delta : undefined;
          if (delta) playAudioChunk(delta);
          return;
        }

        case 'response.output_audio.done':
          setVoiceState(voiceEnabled ? 'idle' : 'off');
          return;

        case 'response.output_audio_transcript.delta': {
          const delta = 'delta' in evt ? evt.delta : undefined;
          if (!delta) return;
          setMessages((prev) => {
            let id = currentAssistantIdRef.current;
            if (!id) {
              id = generateId();
              currentAssistantIdRef.current = id;
              return [...prev, { id, role: 'assistant', content: delta, isStreaming: true }];
            }
            return prev.map((m) => (m.id === id ? { ...m, content: m.content + delta } : m));
          });
          return;
        }

        case 'response.output_audio_transcript.done':
          if (currentAssistantIdRef.current) {
            const id = currentAssistantIdRef.current;
            setMessages((prev) =>
              prev.map((m) => (m.id === id ? { ...m, isStreaming: false } : m)),
            );
            currentAssistantIdRef.current = null;
          }
          return;

        // Text-only responses (typed input → text override) stream via
        // output_text.* instead of output_audio_transcript.*.
        case 'response.output_text.delta': {
          const delta = 'delta' in evt ? evt.delta : undefined;
          if (!delta) return;
          setMessages((prev) => {
            let id = currentAssistantIdRef.current;
            if (!id) {
              id = generateId();
              currentAssistantIdRef.current = id;
              return [...prev, { id, role: 'assistant', content: delta, isStreaming: true }];
            }
            return prev.map((m) => (m.id === id ? { ...m, content: m.content + delta } : m));
          });
          return;
        }

        case 'response.output_text.done':
          if (currentAssistantIdRef.current) {
            const id = currentAssistantIdRef.current;
            setMessages((prev) =>
              prev.map((m) => (m.id === id ? { ...m, isStreaming: false } : m)),
            );
            currentAssistantIdRef.current = null;
          }
          return;

        case 'response.function_call_arguments.done': {
          const callId = 'call_id' in evt ? evt.call_id : undefined;
          const name = 'name' in evt ? evt.name : undefined;
          const args = 'arguments' in evt ? evt.arguments : undefined;
          if (callId && name) {
            handleFunctionCall(callId, name, args ?? '{}');
          }
          return;
        }

        case 'response.done':
          setIsLoading(false);
          if (voiceState !== 'speaking') {
            setVoiceState(voiceEnabled ? 'idle' : 'off');
          }
          return;

        default:
          // Quietly ignore the many other informational events.
          return;
      }
    },
    [handleFunctionCall, playAudioChunk, stopSpeaking, voiceEnabled, voiceState],
  );

  // ─── Mic capture ───────────────────────────────────────────────────────
  const stopMicCapture = useCallback(() => {
    procNodeRef.current?.disconnect();
    sourceNodeRef.current?.disconnect();
    procNodeRef.current = null;
    sourceNodeRef.current = null;
    for (const t of micStreamRef.current?.getTracks() ?? []) t.stop();
    micStreamRef.current = null;
    inputAudioCtxRef.current?.close().catch(() => {});
    inputAudioCtxRef.current = null;
  }, []);

  const startMicCapture = useCallback(async () => {
    if (!wsRef.current || procNodeRef.current) return;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Henry] mic permission failed:', msg);
      setError(`Mic: ${msg}`);
      throw e;
    }
    micStreamRef.current = stream;

    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    inputAudioCtxRef.current = ctx;

    const source = ctx.createMediaStreamSource(stream);
    sourceNodeRef.current = source;

    // 4096 samples @ 24kHz ≈ 170ms per chunk.
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    procNodeRef.current = proc;

    let chunkCount = 0;
    proc.onaudioprocess = (e) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const input = e.inputBuffer.getChannelData(0);
      const b64 = float32ToPcm16Base64(input);
      ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 }));
      chunkCount++;
      if (chunkCount === 1 || chunkCount % 20 === 0) {
        console.log('[Henry] → input_audio_buffer.append', { chunk: chunkCount });
      }
    };

    source.connect(proc);
    proc.connect(ctx.destination);
  }, []);

  // ─── Session lifecycle ─────────────────────────────────────────────────
  const connect = useCallback(async (): Promise<void> => {
    if (wsRef.current) return;
    setError(null);
    setVoiceState('idle');
    setIsLoading(true);

    let cfg: { clientSecret: string; model: string };
    try {
      const res = await fetch('/api/henry/session', { method: 'POST' });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Session mint ${res.status}: ${body || res.statusText}`);
      }
      cfg = (await res.json()) as { clientSecret: string; model: string };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Henry] session mint failed:', msg);
      setError(`Session: ${msg}`);
      setIsLoading(false);
      setVoiceState('off');
      setVoiceEnabled(false);
      throw e;
    }

    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(cfg.model)}`;
    // Browser WS can't set Authorization header; OpenAI accepts the ephemeral
    // token via the `openai-insecure-api-key` subprotocol. "Insecure" flags
    // that the key is client-visible — safe here because client_secrets
    // expire in ~1 minute.
    const ws = new WebSocket(url, ['realtime', `openai-insecure-api-key.${cfg.clientSecret}`]);

    ws.onopen = () => {
      console.log('[Henry] Realtime WS open, subprotocol=', ws.protocol);
      // Clear the loading state even before session.created — if the
      // server never sends it, at least the UI un-freezes.
      setIsLoading(false);
    };

    ws.onmessage = (msg) => {
      try {
        const evt = JSON.parse(msg.data as string) as ServerEvent;
        handleServerEvent(evt);
      } catch (e) {
        console.warn('[Henry] bad server event:', e);
      }
    };

    ws.onerror = (e) => {
      console.error('[Henry] WS error:', e);
      setError('Realtime connection error');
      setVoiceState('off');
      setIsLoading(false);
    };

    ws.onclose = (e) => {
      console.warn('[Henry] WS closed:', e.code, e.reason);
      wsRef.current = null;
      // If the socket dies (idle timeout, mobile background, network drop)
      // we must release the mic and audio output regardless of whether we
      // try to reconnect — the next connect() will rebuild them.
      stopMicCapture();
      outputAudioCtxRef.current?.close().catch(() => {});
      outputAudioCtxRef.current = null;
      playbackCursorRef.current = 0;

      const isAbnormal = e.code !== 1000 && e.code !== 1005;
      const userWantedVoice = voiceEnabledRef.current;
      const canReconnect = isAbnormal && userWantedVoice && !reconnectAttemptedRef.current;

      if (canReconnect) {
        // One transparent reconnect attempt. Mobile Safari backgrounding,
        // wifi/cell handoffs, and OpenAI idle timeouts all surface as 1006;
        // re-minting a session and reopening usually picks voice back up
        // without the operator having to tap anything.
        reconnectAttemptedRef.current = true;
        setVoiceState('idle');
        void (async () => {
          try {
            await connectRef.current?.();
            await startMicCaptureRef.current?.();
            // Allow another auto-reconnect after the link has been stable
            // for 30s — prevents tight loops if the next drop is immediate.
            setTimeout(() => {
              reconnectAttemptedRef.current = false;
            }, 30_000);
          } catch (err) {
            console.error('[Henry] auto-reconnect failed:', err);
            setError('Voice disconnected. Tap the mic to resume.');
            setVoiceEnabled(false);
            setVoiceState('off');
            setIsLoading(false);
          }
        })();
        return;
      }

      if (isAbnormal) {
        setError('Voice disconnected. Tap the mic to resume.');
      }
      setVoiceEnabled(false);
      setVoiceState('off');
      setIsLoading(false);
    };

    wsRef.current = ws;

    const out = new AudioContext({ sampleRate: SAMPLE_RATE });
    // iOS Safari starts AudioContexts suspended; resume() during the user
    // gesture chain (toggleVoice → connect) is the only reliable moment to
    // unlock playback. Without this, all assistant audio is silent.
    out.resume().catch((e) => console.warn('[Henry] outputAudioCtx.resume failed:', e));
    outputAudioCtxRef.current = out;
    playbackCursorRef.current = 0;

    // Wait for the OpenAI Realtime server to send `session.created` (or
    // `session.updated`) before returning. WS readyState hitting OPEN isn't
    // enough — events sent in the gap between `onopen` and `session.created`
    // get dropped server-side, which is why the first text message after a
    // fresh panel open would vanish until the user retried.
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        ws.removeEventListener('message', onMessage);
        ws.removeEventListener('error', onErr);
        ws.removeEventListener('close', onClose);
      };
      const onMessage = (msg: MessageEvent) => {
        try {
          const evt = JSON.parse(msg.data as string) as { type?: string };
          if (evt.type === 'session.created' || evt.type === 'session.updated') {
            cleanup();
            resolve();
          }
        } catch {
          // handleServerEvent (ws.onmessage) owns parse-error logging.
        }
      };
      const onErr = () => {
        cleanup();
        reject(new Error('Realtime WS errored before session.created'));
      };
      const onClose = () => {
        cleanup();
        reject(new Error('Realtime WS closed before session.created'));
      };
      ws.addEventListener('message', onMessage);
      ws.addEventListener('error', onErr, { once: true });
      ws.addEventListener('close', onClose, { once: true });
    });
  }, [handleServerEvent, stopMicCapture]);

  const disconnect = useCallback(() => {
    // User-initiated teardown — clear the auto-reconnect lockout so the next
    // session can also auto-recover from its first abnormal close.
    reconnectAttemptedRef.current = false;
    // Tell the server to stop generating BEFORE closing the WS so the
    // cancel actually lands.
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify({ type: 'response.cancel' }));
      } catch {
        /* socket may have closed mid-send */
      }
    }
    wsRef.current?.close();
    wsRef.current = null;
    stopMicCapture();
    silenceAllAudio();
    setVoiceEnabled(false);
    setVoiceState('off');
    setIsLoading(false);
    setActiveTool(null);
  }, [stopMicCapture, silenceAllAudio]);

  // Keep refs current so the WS onclose closure (which captures `connect`
  // before it's fully defined) can call the latest versions.
  connectRef.current = connect;
  startMicCaptureRef.current = startMicCapture;
  useEffect(() => {
    voiceEnabledRef.current = voiceEnabled;
  }, [voiceEnabled]);

  // ─── Public voice controls ─────────────────────────────────────────────
  const toggleVoice = useCallback(async () => {
    // Treat a tap as "turn off" if either flag OR any live audio resource is
    // present. Without this, a stale mic stream after a dropped WS would
    // cause the next tap to reconnect instead of turning the mic off.
    if (voiceEnabled || wsRef.current || micStreamRef.current) {
      disconnect();
      return;
    }
    setVoiceEnabled(true);
    try {
      await connect();
      await startMicCapture();
    } catch (e) {
      console.error('[Henry] toggleVoice failed:', e);
      setVoiceEnabled(false);
    }
  }, [voiceEnabled, connect, disconnect, startMicCapture]);

  // ─── Text path (opens session if not already open, then injects a user turn) ──
  const sendMessage = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;

      setMessages((prev) => [...prev, { id: generateId(), role: 'user', content: trimmed }]);
      setIsLoading(true);

      if (!wsRef.current) {
        try {
          await connect();
        } catch {
          setIsLoading(false);
          return;
        }
      }

      sendEvent({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: trimmed }],
        },
      });
      // Typed input → text-only response. The session default is audio
      // (set at mint time for voice mode); voice turns triggered by server
      // VAD still get audio, but typed messages shouldn't talk back.
      sendEvent({
        type: 'response.create',
        response: { output_modalities: ['text'] },
      });
    },
    [connect, sendEvent],
  );

  // Tab close / navigate-away: tear down so the session doesn't linger on
  // OpenAI's side burning tokens.
  useEffect(() => {
    const cleanup = () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
    window.addEventListener('pagehide', cleanup);
    return () => {
      window.removeEventListener('pagehide', cleanup);
      wsRef.current?.close();
      stopMicCapture();
      outputAudioCtxRef.current?.close().catch(() => {});
    };
  }, [stopMicCapture]);

  return {
    messages,
    isLoading,
    isPanelOpen,
    activeTool,
    error,
    sendMessage,
    togglePanel,
    clearHistory,
    clearError,
    voice: {
      voiceEnabled,
      voiceState,
      isSupported,
      toggleVoice,
      stopSpeaking,
    },
  };
}
