'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WakeWordDetector } from '@/lib/voice/wake-word';

export type VoiceState = 'off' | 'idle' | 'listening' | 'processing' | 'speaking';

export type UseVoiceReturn = {
  voiceEnabled: boolean;
  voiceState: VoiceState;
  isSupported: boolean;
  toggleVoice: () => void;
  /** Start push-to-talk recording. Call stopPushToTalk to finish. */
  startPushToTalk: () => void;
  /** Stop push-to-talk recording and send the transcript. */
  stopPushToTalk: () => void;
  /** Stop TTS playback immediately. */
  stopSpeaking: () => void;
};

export function useVoice(
  sendMessage: (content: string) => void,
  latestCompleteResponse: string | null,
): UseVoiceReturn {
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>('off');
  const wakeDetectorRef = useRef<WakeWordDetector | null>(null);
  const pttRecognitionRef = useRef<any>(null);
  // Track the response we already spoke so we don't repeat it.
  const spokenResponseRef = useRef<string | null>(null);

  // Detect support after hydration to avoid server/client mismatch.
  const [isSupported, setIsSupported] = useState(false);
  useEffect(() => {
    setIsSupported('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);
  }, []);

  // Toggle voice mode on/off.
  const toggleVoice = useCallback(async () => {
    if (voiceEnabled) {
      wakeDetectorRef.current?.stop();
      const { stopSpeaking } = await import('@/lib/voice/text-to-speech');
      stopSpeaking();
      setVoiceEnabled(false);
      setVoiceState('off');
    } else {
      setVoiceEnabled(true);
      setVoiceState('idle');
    }
  }, [voiceEnabled]);

  // Start wake-word detection when voice mode is enabled.
  useEffect(() => {
    if (!voiceEnabled) return;

    let cancelled = false;

    (async () => {
      const { createWakeWordDetector } = await import('@/lib/voice/wake-word');
      if (cancelled) return;

      const detector = createWakeWordDetector(async () => {
        // Wake word detected. Pause wake word while we listen for the command.
        detector.stop();
        setVoiceState('listening');

        try {
          const { transcribeOnce } = await import('@/lib/voice/speech-to-text');
          const transcript = await transcribeOnce();
          if (transcript.trim()) {
            setVoiceState('processing');
            spokenResponseRef.current = null;
            sendMessage(transcript);
          } else {
            setVoiceState('idle');
            detector.start();
          }
        } catch {
          // No speech detected or timeout.
          setVoiceState('idle');
          detector.start();
        }
      });

      wakeDetectorRef.current = detector;
      detector.start();
    })();

    return () => {
      cancelled = true;
      wakeDetectorRef.current?.stop();
    };
  }, [voiceEnabled, sendMessage]);

  // Speak the response when streaming completes.
  useEffect(() => {
    if (
      !voiceEnabled ||
      !latestCompleteResponse ||
      voiceState !== 'processing' ||
      latestCompleteResponse === spokenResponseRef.current
    ) {
      return;
    }

    spokenResponseRef.current = latestCompleteResponse;
    setVoiceState('speaking');

    import('@/lib/voice/text-to-speech').then(({ speak }) =>
      speak(latestCompleteResponse).then(() => {
        setVoiceState('idle');
        // Resume wake-word detection after speaking.
        wakeDetectorRef.current?.start();
      }),
    );
  }, [voiceEnabled, latestCompleteResponse, voiceState]);

  // Push-to-talk: start
  const startPushToTalk = useCallback(async () => {
    if (!voiceEnabled) return;

    // Stop wake word while PTT is active.
    wakeDetectorRef.current?.stop();
    const { stopSpeaking } = await import('@/lib/voice/text-to-speech');
    stopSpeaking();

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    pttRecognitionRef.current = recognition;
    setVoiceState('listening');
    recognition.start();
  }, [voiceEnabled]);

  // Push-to-talk: stop
  const stopPushToTalk = useCallback(() => {
    const recognition = pttRecognitionRef.current;
    if (!recognition) return;

    // Collect final results on end.
    recognition.onresult = (event: any) => {
      let transcript = '';
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      if (transcript.trim()) {
        setVoiceState('processing');
        spokenResponseRef.current = null;
        sendMessage(transcript.trim());
      } else {
        setVoiceState('idle');
        wakeDetectorRef.current?.start();
      }
    };

    recognition.onend = () => {
      // If no result event fired, go back to idle.
      if (voiceState === 'listening') {
        setVoiceState('idle');
        wakeDetectorRef.current?.start();
      }
    };

    try {
      recognition.stop();
    } catch {
      // not running
    }
    pttRecognitionRef.current = null;
  }, [sendMessage, voiceState]);

  const handleStopSpeaking = useCallback(async () => {
    const { stopSpeaking } = await import('@/lib/voice/text-to-speech');
    stopSpeaking();
    setVoiceState('idle');
    wakeDetectorRef.current?.start();
  }, []);

  return {
    voiceEnabled,
    voiceState,
    isSupported,
    toggleVoice,
    startPushToTalk,
    stopPushToTalk,
    stopSpeaking: handleStopSpeaking,
  };
}
