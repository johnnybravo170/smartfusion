import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { speak, stopSpeaking } from '@/lib/voice/text-to-speech';

describe('text-to-speech', () => {
  let mockCancel: ReturnType<typeof vi.fn>;
  let mockSpeak: ReturnType<typeof vi.fn>;
  let capturedUtterance: { text: string; onend?: () => void; onerror?: () => void };

  beforeEach(() => {
    mockCancel = vi.fn();
    mockSpeak = vi.fn((utterance) => {
      capturedUtterance = utterance;
      // Simulate immediate completion.
      setTimeout(() => utterance.onend?.(), 0);
    });

    // biome-ignore lint/suspicious/noExplicitAny: mocking browser API
    (globalThis as any).speechSynthesis = {
      cancel: mockCancel,
      speak: mockSpeak,
      getVoices: () => [],
    };

    // biome-ignore lint/suspicious/noExplicitAny: mocking browser API
    (globalThis as any).SpeechSynthesisUtterance = class {
      text: string;
      lang = '';
      rate = 1;
      pitch = 1;
      voice: null = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    };

    // Default: fetch returns 501 (ElevenLabs not configured) so browser TTS is used
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'not configured' }), {
          status: 501,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
  });

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: mocking browser API
    delete (globalThis as any).speechSynthesis;
    // biome-ignore lint/suspicious/noExplicitAny: mocking browser API
    delete (globalThis as any).SpeechSynthesisUtterance;
    vi.restoreAllMocks();
  });

  it('falls back to browser TTS when proxy returns 501', async () => {
    await speak('Hello there');
    expect(mockSpeak).toHaveBeenCalledOnce();
    expect(capturedUtterance.text).toBe('Hello there');
  });

  it('falls back to browser TTS when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    await speak('Fallback text');
    expect(mockSpeak).toHaveBeenCalledOnce();
    expect(capturedUtterance.text).toBe('Fallback text');
  });

  it('uses Audio element when proxy returns audio', async () => {
    const mockPlay = vi.fn().mockResolvedValue(undefined);
    // biome-ignore lint/suspicious/noExplicitAny: mocking browser API
    let audioInstance: any;

    vi.stubGlobal(
      'Audio',
      class MockAudio {
        src = '';
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        play = mockPlay;
        pause = vi.fn();
        constructor() {
          // biome-ignore lint/suspicious/noExplicitAny: mocking browser API
          audioInstance = this as any;
        }
      },
    );

    vi.stubGlobal('URL', {
      createObjectURL: vi.fn().mockReturnValue('blob:mock'),
      revokeObjectURL: vi.fn(),
    });

    // jsdom's Blob doesn't expose .stream(), which the fetch Response
    // pulls on internally. Use a Uint8Array body — it has a working
    // ReadableStream contract under jsdom.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([102, 97, 107, 101]), {
          status: 200,
          headers: { 'Content-Type': 'audio/mpeg' },
        }),
      ),
    );

    const speakPromise = speak('ElevenLabs text');
    // Wait for the fetch + blob processing
    await vi.waitFor(() => {
      expect(mockPlay).toHaveBeenCalled();
    });

    // Simulate audio ended
    audioInstance.onended?.();
    await speakPromise;

    // Should NOT have used browser SpeechSynthesis
    expect(mockSpeak).not.toHaveBeenCalled();
  });

  it('resolves even when speechSynthesis is missing', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: mocking browser API
    delete (globalThis as any).speechSynthesis;
    await expect(speak('test')).resolves.toBeUndefined();
  });

  it('stopSpeaking calls speechSynthesis.cancel', () => {
    stopSpeaking();
    expect(mockCancel).toHaveBeenCalled();
  });

  it('stopSpeaking pauses current Audio element', async () => {
    const mockPause = vi.fn();
    const mockPlay = vi.fn().mockResolvedValue(undefined);

    vi.stubGlobal(
      'Audio',
      class MockAudio {
        src = '';
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        play = mockPlay;
        pause = mockPause;
      },
    );

    vi.stubGlobal('URL', {
      createObjectURL: vi.fn().mockReturnValue('blob:mock'),
      revokeObjectURL: vi.fn(),
    });

    // jsdom's Blob doesn't expose .stream(), which the fetch Response
    // pulls on internally. Use a Uint8Array body — it has a working
    // ReadableStream contract under jsdom.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([102, 97, 107, 101]), {
          status: 200,
          headers: { 'Content-Type': 'audio/mpeg' },
        }),
      ),
    );

    // Start speaking (don't await, we want to stop mid-play)
    speak('some text');
    await vi.waitFor(() => {
      expect(mockPlay).toHaveBeenCalled();
    });

    stopSpeaking();
    expect(mockPause).toHaveBeenCalled();
  });
});
