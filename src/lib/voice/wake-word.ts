export type WakeWordCallback = () => void;

export type WakeWordDetector = {
  start: () => void;
  stop: () => void;
  isSupported: boolean;
};

/**
 * Creates a continuous wake-word detector that listens for "Hey Henry"
 * using the browser SpeechRecognition API. When the wake phrase is
 * detected the `onWake` callback fires.
 */
export function createWakeWordDetector(onWake: WakeWordCallback): WakeWordDetector {
  const SpeechRecognition =
    typeof window !== 'undefined'
      ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
      : null;

  if (!SpeechRecognition) {
    return { start: () => {}, stop: () => {}, isSupported: false };
  }

  const recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  let stopped = false;

  recognition.onresult = (event: any) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript.toLowerCase().trim();
      if (
        transcript.includes('hey henry') ||
        transcript.includes('hey, henry') ||
        transcript.includes('a henry')
      ) {
        onWake();
        break;
      }
    }
  };

  // Auto-restart on end (browsers kill recognition after silence).
  recognition.onend = () => {
    if (!stopped) {
      try {
        recognition.start();
      } catch {
        // already running
      }
    }
  };

  recognition.onerror = () => {
    // Errors like "no-speech" are expected; onend will restart.
  };

  return {
    start: () => {
      stopped = false;
      try {
        recognition.start();
      } catch {
        // already running
      }
    },
    stop: () => {
      stopped = true;
      recognition.onend = null;
      try {
        recognition.stop();
      } catch {
        // not running
      }
    },
    isSupported: true,
  };
}
