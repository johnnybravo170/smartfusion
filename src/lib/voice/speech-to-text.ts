/**
 * Captures a single utterance and resolves with the transcript.
 * Used after wake-word detection to capture the user's command.
 * Rejects after 10 seconds of silence.
 */
export function transcribeOnce(): Promise<string> {
  return new Promise((resolve, reject) => {
    const SpeechRecognition =
      typeof window !== 'undefined'
        ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
        : null;

    if (!SpeechRecognition) {
      reject(new Error('SpeechRecognition not supported'));
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    let resolved = false;

    recognition.onresult = (event: any) => {
      if (resolved) return;
      resolved = true;
      const transcript = event.results[0][0].transcript;
      resolve(transcript);
    };

    recognition.onerror = (event: any) => {
      if (resolved) return;
      resolved = true;
      reject(new Error(event.error));
    };

    recognition.onend = () => {
      if (resolved) return;
      resolved = true;
      reject(new Error('No speech detected'));
    };

    recognition.start();

    // Timeout after 10 seconds of silence.
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try {
          recognition.stop();
        } catch {
          // not running
        }
        reject(new Error('Timeout'));
      }
    }, 10_000);
  });
}
