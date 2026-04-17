import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWakeWordDetector } from '@/lib/voice/wake-word';

let mockInstance: {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: unknown) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

function MockSpeechRecognition() {
  mockInstance = {
    continuous: false,
    interimResults: false,
    lang: '',
    onresult: null,
    onend: null,
    onerror: null,
    start: vi.fn(),
    stop: vi.fn(),
  };
  return mockInstance;
}

describe('createWakeWordDetector', () => {
  beforeEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: mocking browser API
    (globalThis as any).webkitSpeechRecognition = MockSpeechRecognition;
  });

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: mocking browser API
    delete (globalThis as any).webkitSpeechRecognition;
    // biome-ignore lint/suspicious/noExplicitAny: mocking browser API
    delete (globalThis as any).SpeechRecognition;
  });

  it('returns isSupported: false when SpeechRecognition is unavailable', () => {
    // biome-ignore lint/suspicious/noExplicitAny: mocking browser API
    delete (globalThis as any).webkitSpeechRecognition;
    const detector = createWakeWordDetector(vi.fn());
    expect(detector.isSupported).toBe(false);
  });

  it('returns isSupported: true when API is available', () => {
    const detector = createWakeWordDetector(vi.fn());
    expect(detector.isSupported).toBe(true);
  });

  it('starts recognition on start()', () => {
    const detector = createWakeWordDetector(vi.fn());
    detector.start();
    expect(mockInstance.start).toHaveBeenCalled();
  });

  it('fires callback when "hey henry" is detected', () => {
    const onWake = vi.fn();
    createWakeWordDetector(onWake);

    mockInstance.onresult?.({
      resultIndex: 0,
      results: [{ 0: { transcript: 'Hey Henry, what is my schedule?' }, length: 1 }],
    });

    expect(onWake).toHaveBeenCalledOnce();
  });

  it('fires callback for "hey, henry" variant', () => {
    const onWake = vi.fn();
    createWakeWordDetector(onWake);

    mockInstance.onresult?.({
      resultIndex: 0,
      results: [{ 0: { transcript: 'Hey, Henry' }, length: 1 }],
    });

    expect(onWake).toHaveBeenCalledOnce();
  });

  it('does NOT fire callback for unrelated speech', () => {
    const onWake = vi.fn();
    createWakeWordDetector(onWake);

    mockInstance.onresult?.({
      resultIndex: 0,
      results: [{ 0: { transcript: 'Hello world' }, length: 1 }],
    });

    expect(onWake).not.toHaveBeenCalled();
  });

  it('stops recognition and prevents restart on stop()', () => {
    const detector = createWakeWordDetector(vi.fn());
    detector.start();
    detector.stop();

    expect(mockInstance.stop).toHaveBeenCalled();
    expect(mockInstance.onend).toBeNull();
  });
});
