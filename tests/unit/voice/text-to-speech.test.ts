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
  });

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: mocking browser API
    delete (globalThis as any).speechSynthesis;
    // biome-ignore lint/suspicious/noExplicitAny: mocking browser API
    delete (globalThis as any).SpeechSynthesisUtterance;
  });

  it('calls speechSynthesis.speak with the provided text', async () => {
    await speak('Hello there');
    expect(mockSpeak).toHaveBeenCalledOnce();
    expect(capturedUtterance.text).toBe('Hello there');
  });

  it('cancels ongoing speech before speaking', async () => {
    await speak('New text');
    expect(mockCancel).toHaveBeenCalled();
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
});
