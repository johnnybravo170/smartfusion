'use client';

/**
 * useHenry — Gemini Live session manager.
 *
 * Single hook that replaces useChat + useVoice. Opens a WebSocket to Gemini's
 * Live API using an ephemeral token from /api/henry/session, streams mic
 * audio in (16kHz PCM16), plays Gemini's audio out (24kHz PCM16), and routes
 * tool calls through /api/henry/tool so they execute under tenant RLS.
 *
 * Return shape is kept compatible with the existing chat-panel so the UI
 * doesn't need a rewrite.
 */

import { GoogleGenAI, type LiveServerMessage, Modality, type Session } from '@google/genai';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CLIENT_TOOL_NAMES } from '@/lib/henry/client-tools';
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
  /** Most recent error message surfaced to the user. Cleared on successful connect. */
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
    startPushToTalk: () => void;
    stopPushToTalk: () => void;
    stopSpeaking: () => void;
  };
};

const PANEL_STORAGE_KEY = 'heyhenry-chat-open';
const INPUT_SAMPLE_RATE = 16_000; // Gemini Live expects 16kHz PCM16 input
const OUTPUT_SAMPLE_RATE = 24_000; // Gemini Live emits 24kHz PCM16 output

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

/** Float32 [-1,1] → Int16 PCM → base64. Endianness: little (matches Gemini). */
function float32ToPcm16Base64(input: Float32Array): string {
  const buf = new ArrayBuffer(input.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  // btoa requires a binary string; build it in chunks to avoid call-stack issues.
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Dispatch a client-side tool call against the current screen context.
 * Returns a human-readable string result for Gemini to reason about.
 */
function runClientTool(
  name: string,
  args: Record<string, unknown>,
  screen: ReturnType<typeof useHenryScreen>,
): string {
  if (name === 'get_current_screen_context') {
    const form = screen.form;
    return JSON.stringify({
      route: screen.route,
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

/** base64 PCM16 little-endian → Float32 in [-1,1]. Uses a plain ArrayBuffer so it
 * satisfies Web Audio's copyToChannel type signature. */
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

  // Screen context: current route + registered form. Stored in refs so the
  // handleToolCall callback always reads the latest values without needing
  // to be recreated (and thereby tearing down the active session).
  const screen = useHenryScreen();
  const screenRef = useRef(screen);
  screenRef.current = screen;

  const sessionRef = useRef<Session | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const procNodeRef = useRef<ScriptProcessorNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const playbackCursorRef = useRef<number>(0);
  const currentAssistantIdRef = useRef<string | null>(null);
  const currentUserIdRef = useRef<string | null>(null);

  // Detect support after hydration.
  useEffect(() => {
    setIsSupported(
      typeof window !== 'undefined' &&
        !!navigator.mediaDevices?.getUserMedia &&
        typeof AudioContext !== 'undefined',
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
      return next;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setMessages([]);
    setActiveTool(null);
  }, []);

  // ---------------------------------------------------------------------------
  // Audio helpers
  // ---------------------------------------------------------------------------

  const playAudioChunk = useCallback((b64: string) => {
    const ctx = outputAudioCtxRef.current;
    if (!ctx) return;
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
  }, []);

  const stopSpeaking = useCallback(() => {
    const ctx = outputAudioCtxRef.current;
    if (!ctx) return;
    // Simplest interruption: close and recreate the output context.
    ctx.close().catch(() => {});
    const fresh = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
    outputAudioCtxRef.current = fresh;
    playbackCursorRef.current = 0;
    setVoiceState('idle');
  }, []);

  // ---------------------------------------------------------------------------
  // Tool call dispatch (server-side via /api/henry/tool)
  // ---------------------------------------------------------------------------

  const handleToolCall = useCallback(
    async (
      calls: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>,
    ): Promise<void> => {
      const session = sessionRef.current;
      if (!session) return;

      const responses = await Promise.all(
        calls.map(async (fc) => {
          const name = fc.name ?? '';
          setActiveTool(name);
          try {
            // Client-side tools (screen awareness) run in-process: they
            // inspect / mutate React state, so a server round-trip would
            // be wrong.
            if (CLIENT_TOOL_NAMES.has(name)) {
              const output = runClientTool(name, fc.args ?? {}, screenRef.current);
              return { id: fc.id, name, response: { output } };
            }

            const res = await fetch('/api/henry/tool', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name, args: fc.args ?? {} }),
            });
            const { result } = (await res.json()) as { result?: string };
            return {
              id: fc.id,
              name,
              response: { output: result ?? 'No output.' },
            };
          } catch (e) {
            return {
              id: fc.id,
              name,
              response: {
                output: `Tool call failed: ${e instanceof Error ? e.message : String(e)}`,
              },
            };
          } finally {
            setActiveTool(null);
          }
        }),
      );

      session.sendToolResponse({ functionResponses: responses });
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Live server message handler
  // ---------------------------------------------------------------------------

  const handleServerMessage = useCallback(
    (msg: LiveServerMessage) => {
      // Audio out + text out arrive inside serverContent.modelTurn.parts
      const parts = msg.serverContent?.modelTurn?.parts ?? [];
      for (const part of parts) {
        const data = part.inlineData?.data;
        if (data && part.inlineData?.mimeType?.startsWith('audio/')) {
          playAudioChunk(data);
        }
      }

      // Output transcription (what Henry said)
      const outT = msg.serverContent?.outputTranscription?.text;
      if (outT) {
        setMessages((prev) => {
          let id = currentAssistantIdRef.current;
          if (!id) {
            id = generateId();
            currentAssistantIdRef.current = id;
            return [...prev, { id, role: 'assistant', content: outT, isStreaming: true }];
          }
          return prev.map((m) => (m.id === id ? { ...m, content: m.content + outT } : m));
        });
      }

      // Input transcription (what the user said)
      const inT = msg.serverContent?.inputTranscription?.text;
      if (inT) {
        setMessages((prev) => {
          let id = currentUserIdRef.current;
          if (!id) {
            id = generateId();
            currentUserIdRef.current = id;
            return [...prev, { id, role: 'user', content: inT }];
          }
          return prev.map((m) => (m.id === id ? { ...m, content: m.content + inT } : m));
        });
      }

      // Turn completion
      if (msg.serverContent?.turnComplete) {
        if (currentAssistantIdRef.current) {
          const finishId = currentAssistantIdRef.current;
          setMessages((prev) =>
            prev.map((m) => (m.id === finishId ? { ...m, isStreaming: false } : m)),
          );
          currentAssistantIdRef.current = null;
        }
        currentUserIdRef.current = null;
        setIsLoading(false);
        setVoiceState(voiceEnabled ? 'idle' : 'off');
      }

      // User barge-in → reset playback cursor and clear any queued audio
      if (msg.serverContent?.interrupted) {
        stopSpeaking();
      }

      // Tool calls
      if (msg.toolCall?.functionCalls) {
        handleToolCall(msg.toolCall.functionCalls);
      }
    },
    [playAudioChunk, stopSpeaking, handleToolCall, voiceEnabled],
  );

  // ---------------------------------------------------------------------------
  // Mic capture (defined before session lifecycle so disconnect can reference it)
  // ---------------------------------------------------------------------------

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

    // AudioContext forced to 16kHz so no resampling is needed.
    const ctx = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
    inputAudioCtxRef.current = ctx;

    const source = ctx.createMediaStreamSource(stream);
    sourceNodeRef.current = source;

    // ScriptProcessorNode is deprecated but universal. 4096 samples @ 16kHz ≈ 256ms.
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    procNodeRef.current = proc;

    proc.onaudioprocess = (e) => {
      if (!sessionRef.current) return;
      const input = e.inputBuffer.getChannelData(0);
      // Skip silence-ish chunks to cut bandwidth (very loose threshold).
      let max = 0;
      for (let i = 0; i < input.length; i++) {
        const a = Math.abs(input[i]);
        if (a > max) max = a;
      }
      if (max < 0.005) return;

      const b64 = float32ToPcm16Base64(input);
      sessionRef.current.sendRealtimeInput({
        audio: { data: b64, mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}` },
      });
      setVoiceState('listening');
    };

    source.connect(proc);
    proc.connect(ctx.destination);
  }, []);

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  const connect = useCallback(async () => {
    if (sessionRef.current) return;
    setError(null);
    setVoiceState('idle');
    setIsLoading(true);

    // 1. Fetch ephemeral token + config from server.
    let sessionConfig: {
      token: string;
      model: string;
      systemPrompt: string;
      tools: unknown[];
    };
    try {
      const res = await fetch('/api/henry/session', { method: 'POST' });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Session mint ${res.status}: ${body || res.statusText}`);
      }
      sessionConfig = await res.json();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Henry] session mint failed:', msg);
      setError(`Session: ${msg}`);
      setIsLoading(false);
      setVoiceState('off');
      setVoiceEnabled(false);
      throw e;
    }
    const { token, model, systemPrompt, tools } = sessionConfig;

    // 2. Open Gemini Live WebSocket. `token` is the raw API key during private
    // beta — see note in /api/henry/session for the security tradeoff.
    // apiVersion=v1alpha is required because gemini-live-2.5-flash-preview is
    // only registered for BidiGenerateContent on the v1alpha surface.
    const ai = new GoogleGenAI({
      apiKey: token,
      httpOptions: { apiVersion: 'v1alpha' },
    });

    try {
      const session = await ai.live.connect({
        model,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: systemPrompt,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          tools: tools.length > 0 ? [{ functionDeclarations: tools as never }] : undefined,
        },
        callbacks: {
          onopen: () => {
            console.log('[Henry] Live open');
            setIsLoading(false);
            setError(null);
          },
          onmessage: handleServerMessage,
          onerror: (e) => {
            const detail =
              (e as ErrorEvent)?.message ||
              // biome-ignore lint/suspicious/noExplicitAny: unknown error shape
              (e as any)?.error?.message ||
              JSON.stringify(e, Object.getOwnPropertyNames(e));
            console.error('[Henry] Live error:', detail, e);
            setError(`Live error: ${detail}`);
            setVoiceState('off');
            setIsLoading(false);
          },
          onclose: (e) => {
            const code = (e as CloseEvent)?.code;
            const reason = (e as CloseEvent)?.reason;
            console.warn('[Henry] Live closed:', code, reason);
            if (code && code !== 1000 && code !== 1005) {
              setError(`Live closed (${code}): ${reason || 'no reason given'}`);
            }
            sessionRef.current = null;
            setVoiceState('off');
            setVoiceEnabled(false);
            setIsLoading(false);
          },
        },
      });
      sessionRef.current = session;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Henry] live.connect failed:', msg);
      setError(`Connect: ${msg}`);
      setIsLoading(false);
      setVoiceState('off');
      setVoiceEnabled(false);
      throw e;
    }

    // 3. Prepare output audio context for playback.
    outputAudioCtxRef.current = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
    playbackCursorRef.current = 0;
  }, [handleServerMessage]);

  const disconnect = useCallback(() => {
    sessionRef.current?.close();
    sessionRef.current = null;
    stopMicCapture();
    outputAudioCtxRef.current?.close().catch(() => {});
    outputAudioCtxRef.current = null;
    playbackCursorRef.current = 0;
    setVoiceEnabled(false);
    setVoiceState('off');
    setIsLoading(false);
  }, [stopMicCapture]);

  // ---------------------------------------------------------------------------
  // Public voice controls
  // ---------------------------------------------------------------------------

  const toggleVoice = useCallback(async () => {
    if (voiceEnabled) {
      disconnect();
    } else {
      setVoiceEnabled(true);
      try {
        await connect();
        await startMicCapture();
      } catch (e) {
        console.error('[Henry] toggleVoice failed:', e);
        setVoiceEnabled(false);
      }
    }
  }, [voiceEnabled, connect, disconnect, startMicCapture]);

  const startPushToTalk = useCallback(async () => {
    if (!voiceEnabled) return;
    setVoiceState('listening');
    if (!procNodeRef.current) await startMicCapture();
  }, [voiceEnabled, startMicCapture]);

  const stopPushToTalk = useCallback(() => {
    stopMicCapture();
    setVoiceState('processing');
  }, [stopMicCapture]);

  // ---------------------------------------------------------------------------
  // Text message path (still useful as a fallback + for keyboard input)
  // ---------------------------------------------------------------------------

  const sendMessage = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;

      // Add user message to UI immediately.
      setMessages((prev) => [...prev, { id: generateId(), role: 'user', content: trimmed }]);
      setIsLoading(true);

      // Session may not be open yet; open it now for text-only interactions.
      if (!sessionRef.current) {
        try {
          await connect();
        } catch {
          setIsLoading(false);
          return;
        }
      }
      sessionRef.current?.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: trimmed }] }],
        turnComplete: true,
      });
    },
    [connect],
  );

  // Clean up on unmount.
  useEffect(() => {
    return () => {
      sessionRef.current?.close();
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
      startPushToTalk,
      stopPushToTalk,
      stopSpeaking,
    },
  };
}
