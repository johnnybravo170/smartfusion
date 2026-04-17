/**
 * Text-to-speech with ElevenLabs (via /api/tts proxy) and browser fallback.
 *
 * `speak()` tries ElevenLabs first. If the proxy returns a non-audio response
 * (501 = not configured, network error, etc.) it falls back to the browser
 * SpeechSynthesis API automatically.
 */

let currentAudio: HTMLAudioElement | null = null;

/**
 * Speaks the given text. Tries ElevenLabs via the server proxy first,
 * then falls back to browser SpeechSynthesis.
 */
export async function speak(text: string): Promise<void> {
  // Try ElevenLabs via our proxy
  try {
    const response = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (response.ok && response.headers.get('content-type')?.includes('audio')) {
      // Stop any ongoing audio before playing new one
      stopSpeaking();

      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      currentAudio = audio;

      return new Promise((resolve) => {
        audio.onended = () => {
          URL.revokeObjectURL(audioUrl);
          if (currentAudio === audio) currentAudio = null;
          resolve();
        };
        audio.onerror = () => {
          URL.revokeObjectURL(audioUrl);
          if (currentAudio === audio) currentAudio = null;
          resolve();
        };
        audio.play().catch(() => {
          if (currentAudio === audio) currentAudio = null;
          resolve();
        });
      });
    }
  } catch {
    // ElevenLabs unavailable, fall through to browser TTS
  }

  // Fallback: browser SpeechSynthesis
  return speakBrowser(text);
}

/**
 * Speaks the given text using the browser SpeechSynthesis API.
 * Picks a natural-sounding voice when available.
 */
function speakBrowser(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      resolve();
      return;
    }

    // Cancel any ongoing speech.
    speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    // Try to pick a natural-sounding voice.
    const voices = speechSynthesis.getVoices();
    const preferred = voices.find(
      (v) =>
        v.name.includes('Samantha') || // iOS
        v.name.includes('Google') || // Chrome
        v.name.includes('Daniel') || // macOS
        v.lang.startsWith('en'),
    );
    if (preferred) utterance.voice = preferred;

    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();

    speechSynthesis.speak(utterance);
  });
}

/** Immediately stops any ongoing speech (both Audio element and browser TTS). */
export function stopSpeaking(): void {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    speechSynthesis.cancel();
  }
}
