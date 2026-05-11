'use client';

/**
 * useHenry — provider-agnostic voice + text session manager.
 *
 * Supports OpenAI Realtime and Gemini Live via a `RealtimeSession` abstraction.
 * The active provider is chosen by the server (POST /api/henry/session returns
 * { provider, clientSecret? | proxyUrl? }) based on the HENRY_VOICE_PROVIDER
 * env var (openai | gemini | auto).
 *
 * Audio is PCM16 mono in both directions; the sample rate matches the active
 * provider (24kHz for OpenAI, 16kHz input / 24kHz output for Gemini).
 *
 * Tool calls are dispatched to /api/henry/tool under the operator's RLS
 * session, except for the three client-side screen-awareness tools which
 * run in-process against React state.
 *
 * Return shape is API-compatible with the previous OpenAI-only implementation.
 */

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { findFeatureByPath } from '@/lib/ai/feature-catalog';
import { CLIENT_TOOL_NAMES } from '@/lib/henry/openai-tools';
import type {
  ProviderEvent,
  RealtimeSession,
  SessionInitResponse,
} from '@/lib/henry/providers/types';
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
  activeProvider: 'openai' | 'gemini' | null;
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

// OpenAI: 24kHz in both directions.
// Gemini: 16kHz input, 24kHz output (native audio models output at 24kHz).
const OPENAI_SAMPLE_RATE = 24_000;
const GEMINI_INPUT_SAMPLE_RATE = 16_000;
const OUTPUT_SAMPLE_RATE = 24_000; // Both providers output 24kHz audio.

/**
 * Tool name prefixes that signal a state mutation. After a successful call
 * we fire router.refresh() so the underlying RSC page re-renders.
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

function float32ToPcm16Base64(input: Float32Array, sampleRate: number): string {
  // If the AudioContext was created at a rate different from what we want to
  // send, resample. For Gemini we request a 16kHz context, so no resampling
  // is needed here — but the parameter is threaded through for clarity.
  void sampleRate; // currently a no-op; actual rate set on AudioContext
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
      page: feature ? { name: feature.name, summary: feature.summary } : null,
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

export function useHenry(): UseHenryReturn {
  const [messages, setMessages] = useState<HenryMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>('off');
  const [isSupported, setIsSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeProvider, setActiveProvider] = useState<'openai' | 'gemini' | null>(null);
  const clearError = useCallback(() => setError(null), []);

  const router = useRouter();
  const screen = useHenryScreen();
  const screenRef = useRef(screen);
  screenRef.current = screen;

  // ─── Provider session ref ────────────────────────────────────────────────
  const sessionRef = useRef<RealtimeSession | null>(null);
  const activeProviderRef = useRef<'openai' | 'gemini' | null>(null);

  // ─── Audio output state ──────────────────────────────────────────────────
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const playbackCursorRef = useRef<number>(0);
  const scheduledSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  // ─── Audio input state ───────────────────────────────────────────────────
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const procNodeRef = useRef<ScriptProcessorNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);

  // ─── Message streaming refs ──────────────────────────────────────────────
  const currentAssistantIdRef = useRef<string | null>(null);
  const currentUserIdRef = useRef<string | null>(null);

  // ─── Auto-reconnect plumbing ─────────────────────────────────────────────
  const voiceEnabledRef = useRef(false);
  const reconnectAttemptedRef = useRef(false);
  const connectRef = useRef<(() => Promise<void>) | null>(null);
  const startMicCaptureRef = useRef<(() => Promise<void>) | null>(null);
  // Stable proxy for the event handler. session.onEvent() is called once at
  // connect time; storing a ref lets us always forward to the latest closure
  // even as voiceEnabled / handleFunctionCall etc. change between renders.
  const handleProviderEventRef = useRef<(evt: ProviderEvent) => void>(() => {});

  useEffect(() => {
    setIsSupported(
      typeof window !== 'undefined' &&
        !!navigator.mediaDevices?.getUserMedia &&
        typeof AudioContext !== 'undefined' &&
        typeof WebSocket !== 'undefined',
    );
    setIsPanelOpen(readPanelState());
  }, []);

  // ─── Audio output ────────────────────────────────────────────────────────
  const playAudioChunk = useCallback((b64: string) => {
    const ctx = outputAudioCtxRef.current;
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch((e) => console.warn('[Henry] outputAudioCtx.resume failed:', e));
    }
    const pcm = pcm16Base64ToFloat32(b64);
    const buffer = ctx.createBuffer(1, pcm.length, OUTPUT_SAMPLE_RATE);
    buffer.copyToChannel(pcm, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, playbackCursorRef.current);
    src.start(startAt);
    playbackCursorRef.current = startAt + buffer.duration;
    setVoiceState('speaking');
    scheduledSourcesRef.current.add(src);
    src.onended = () => {
      scheduledSourcesRef.current.delete(src);
    };
  }, []);

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
    sessionRef.current?.send({ type: 'response.cancel' });
    silenceAllAudio();
    const fresh = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
    fresh.resume().catch(() => {});
    outputAudioCtxRef.current = fresh;
    setVoiceState('idle');
  }, [silenceAllAudio]);

  // ─── Tool call dispatch ──────────────────────────────────────────────────
  const handleFunctionCall = useCallback(
    async (callId: string, name: string, argsJson: string): Promise<void> => {
      setActiveTool(name);
      let output: string;
      let isError = false;
      let mutated = false;
      try {
        const args = argsJson ? JSON.parse(argsJson) : {};
        if (CLIENT_TOOL_NAMES.has(name)) {
          output = runClientTool(name, args, screenRef.current);
        } else {
          mutated = MUTATING_TOOL_PREFIXES.some((p) => name.startsWith(p));
          const res = await fetch('/api/henry/tool', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, args }),
          });
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
            isError = true;
          } else if (parsed && typeof parsed.result === 'string') {
            output = parsed.result;
          } else {
            console.error('[Henry] tool call returned no result', { name, raw });
            output = `Tool "${name}" returned an empty response.`;
          }
        }
      } catch (e) {
        output = `Tool call failed: ${e instanceof Error ? e.message : String(e)}`;
        isError = true;
      } finally {
        setActiveTool(null);
      }

      if (mutated && !isError) {
        router.refresh();
      }

      sessionRef.current?.send({ type: 'tool.result', callId, output, isError });
    },
    [router],
  );

  // ─── Provider event handler ──────────────────────────────────────────────
  const handleProviderEvent = useCallback(
    (evt: ProviderEvent) => {
      console.log('[Henry] ←', evt.type, evt);
      switch (evt.type) {
        case 'session.ready':
          setIsLoading(false);
          setError(null);
          return;

        case 'session.error':
          if (!evt.fatal) {
            console.warn('[Henry] non-fatal provider error:', evt.message);
            return;
          }
          setError(evt.message);
          // Trigger auto-reconnect via the same path as the old onclose handler.
          sessionRef.current = null;
          {
            const userWantedVoice = voiceEnabledRef.current;
            const canReconnect = userWantedVoice && !reconnectAttemptedRef.current;
            if (canReconnect) {
              reconnectAttemptedRef.current = true;
              setVoiceState('idle');
              void (async () => {
                try {
                  await connectRef.current?.();
                  await startMicCaptureRef.current?.();
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
            } else {
              setVoiceEnabled(false);
              setVoiceState('off');
              setIsLoading(false);
            }
          }
          return;

        case 'vad.speech_started':
          setVoiceState('listening');
          if (outputAudioCtxRef.current && playbackCursorRef.current > 0) {
            stopSpeaking();
          }
          return;

        case 'vad.speech_stopped':
          setVoiceState('processing');
          return;

        case 'transcript.user.delta': {
          const { delta } = evt;
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

        case 'transcript.user.done':
          currentUserIdRef.current = null;
          return;

        case 'response.started':
          setIsLoading(true);
          return;

        case 'audio.delta':
          playAudioChunk(evt.base64Pcm);
          return;

        case 'audio.done':
          // Use the ref — voiceEnabled in this closure captured its value at
          // connect time (before setVoiceEnabled(true) was flushed).
          setVoiceState(voiceEnabledRef.current ? 'idle' : 'off');
          return;

        case 'transcript.assistant.delta': {
          const { delta } = evt;
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

        case 'transcript.assistant.done':
          if (currentAssistantIdRef.current) {
            const id = currentAssistantIdRef.current;
            setMessages((prev) =>
              prev.map((m) => (m.id === id ? { ...m, isStreaming: false } : m)),
            );
            currentAssistantIdRef.current = null;
          }
          return;

        case 'tool.call':
          void handleFunctionCall(evt.callId, evt.name, evt.argsJson);
          return;

        case 'response.done':
          setIsLoading(false);
          // Functional update avoids reading stale voiceState from the closure;
          // voiceEnabledRef avoids reading stale voiceEnabled for the same reason.
          setVoiceState((prev) =>
            prev !== 'speaking' ? (voiceEnabledRef.current ? 'idle' : 'off') : prev,
          );
          return;
      }
    },
    [handleFunctionCall, playAudioChunk, stopSpeaking],
  );
  // Keep the ref in sync on every render so the stable proxy always delegates
  // to the latest handler version even when its other deps change.
  handleProviderEventRef.current = handleProviderEvent;

  // ─── Mic capture ────────────────────────────────────────────────────────
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
    if (!sessionRef.current || procNodeRef.current) return;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Henry] mic permission failed:', msg);
      setError(`Mic: ${msg}`);
      throw e;
    }
    micStreamRef.current = stream;

    // Use 16kHz for Gemini input, 24kHz for OpenAI.
    const inputRate =
      activeProviderRef.current === 'gemini' ? GEMINI_INPUT_SAMPLE_RATE : OPENAI_SAMPLE_RATE;
    const ctx = new AudioContext({ sampleRate: inputRate });
    inputAudioCtxRef.current = ctx;

    const source = ctx.createMediaStreamSource(stream);
    sourceNodeRef.current = source;

    // 4096 samples @ 24kHz ≈ 170ms; @ 16kHz ≈ 256ms.
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    procNodeRef.current = proc;

    let chunkCount = 0;
    proc.onaudioprocess = (e) => {
      const session = sessionRef.current;
      if (!session?.isConnected) return;
      const input = e.inputBuffer.getChannelData(0);
      const b64 = float32ToPcm16Base64(input, inputRate);
      session.send({ type: 'audio.append', base64Pcm: b64 });
      chunkCount++;
      if (chunkCount === 1 || chunkCount % 20 === 0) {
        console.log('[Henry] → audio.append', { chunk: chunkCount, rate: inputRate });
      }
    };

    source.connect(proc);
    proc.connect(ctx.destination);
  }, []);

  // ─── Session lifecycle ───────────────────────────────────────────────────
  const connect = useCallback(async (): Promise<void> => {
    if (sessionRef.current) return;
    setError(null);
    setVoiceState('idle');
    setIsLoading(true);

    let cfg: SessionInitResponse;
    try {
      const res = await fetch('/api/henry/session', { method: 'POST' });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Session mint ${res.status}: ${body || res.statusText}`);
      }
      cfg = (await res.json()) as SessionInitResponse;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Henry] session mint failed:', msg);
      setError(`Session: ${msg}`);
      setIsLoading(false);
      setVoiceState('off');
      setVoiceEnabled(false);
      throw e;
    }

    // Instantiate the right provider dynamically (code-split by Next.js).
    let session: RealtimeSession;
    if (cfg.provider === 'openai') {
      const { OpenAIRealtimeSession } = await import('@/lib/henry/providers/openai');
      session = new OpenAIRealtimeSession(cfg.clientSecret, cfg.model);
    } else {
      const { GeminiProxySession } = await import('@/lib/henry/providers/gemini');
      session = new GeminiProxySession(cfg.proxyUrl);
    }

    // Register a stable proxy so the session always dispatches to the latest
    // handler even after voiceEnabled / other deps change post-connect.
    session.onEvent((evt) => handleProviderEventRef.current(evt));
    sessionRef.current = session;
    activeProviderRef.current = cfg.provider;
    setActiveProvider(cfg.provider);

    // Create output AudioContext now (during user gesture chain) so iOS Safari
    // doesn't suspend it. Eagerly resume for the same reason.
    const out = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
    out.resume().catch((e) => console.warn('[Henry] outputAudioCtx.resume failed:', e));
    outputAudioCtxRef.current = out;
    playbackCursorRef.current = 0;

    try {
      await session.connect();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Henry] provider connect failed:', msg);
      sessionRef.current = null;
      setError(`Voice: ${msg}`);
      setIsLoading(false);
      setVoiceState('off');
      setVoiceEnabled(false);
      throw e;
    }
  }, []);

  const disconnect = useCallback(() => {
    reconnectAttemptedRef.current = false;
    sessionRef.current?.disconnect();
    sessionRef.current = null;
    activeProviderRef.current = null;
    setActiveProvider(null);
    stopMicCapture();
    silenceAllAudio();
    setVoiceEnabled(false);
    setVoiceState('off');
    setIsLoading(false);
    setActiveTool(null);
  }, [stopMicCapture, silenceAllAudio]);

  // Keep refs current so WS onclose closures can call the latest versions.
  connectRef.current = connect;
  startMicCaptureRef.current = startMicCapture;
  useEffect(() => {
    voiceEnabledRef.current = voiceEnabled;
  }, [voiceEnabled]);

  // ─── Panel controls ──────────────────────────────────────────────────────
  const togglePanel = useCallback(() => {
    setIsPanelOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(PANEL_STORAGE_KEY, String(next));
      } catch {
        /* ok */
      }
      if (!next && (sessionRef.current || micStreamRef.current)) {
        queueMicrotask(() => {
          sessionRef.current?.disconnect();
          sessionRef.current = null;
          activeProviderRef.current = null;
          stopMicCapture();
          for (const src of scheduledSourcesRef.current) {
            try {
              src.stop();
            } catch {
              /* ok */
            }
            try {
              src.disconnect();
            } catch {
              /* ok */
            }
          }
          scheduledSourcesRef.current.clear();
          outputAudioCtxRef.current?.close().catch(() => {});
          outputAudioCtxRef.current = null;
          playbackCursorRef.current = 0;
          setVoiceEnabled(false);
          setVoiceState('off');
          setActiveTool(null);
          setActiveProvider(null);
        });
      }
      return next;
    });
  }, [stopMicCapture]);

  const clearHistory = useCallback(() => {
    setMessages([]);
    setActiveTool(null);
    sessionRef.current?.send({ type: 'response.cancel' });
    for (const src of scheduledSourcesRef.current) {
      try {
        src.stop();
      } catch {
        /* ok */
      }
      try {
        src.disconnect();
      } catch {
        /* ok */
      }
    }
    scheduledSourcesRef.current.clear();
    playbackCursorRef.current = 0;
    setVoiceState((prev) => (prev === 'speaking' ? 'idle' : prev));
  }, []);

  // ─── Public voice controls ───────────────────────────────────────────────
  const toggleVoice = useCallback(async () => {
    if (voiceEnabled || sessionRef.current || micStreamRef.current) {
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

  // ─── Text path ───────────────────────────────────────────────────────────
  const sendMessage = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;

      setMessages((prev) => [...prev, { id: generateId(), role: 'user', content: trimmed }]);
      setIsLoading(true);

      if (!sessionRef.current) {
        try {
          await connect();
        } catch {
          setIsLoading(false);
          return;
        }
      }

      sessionRef.current?.send({
        type: 'text.send',
        text: trimmed,
        audioResponse: false, // typed input → text response only
      });
    },
    [connect],
  );

  // ─── Cleanup on unmount / page hide ─────────────────────────────────────
  useEffect(() => {
    const cleanup = () => {
      sessionRef.current?.disconnect();
      sessionRef.current = null;
    };
    window.addEventListener('pagehide', cleanup);
    return () => {
      window.removeEventListener('pagehide', cleanup);
      sessionRef.current?.disconnect();
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
    activeProvider,
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
