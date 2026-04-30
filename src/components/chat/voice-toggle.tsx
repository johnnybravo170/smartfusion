'use client';

import { Loader2, Mic, MicOff, Volume2 } from 'lucide-react';
import type { VoiceState } from '@/hooks/use-voice';
import { cn } from '@/lib/utils';

const stateStyles: Record<VoiceState, string> = {
  off: 'text-muted-foreground hover:text-foreground',
  idle: 'text-emerald-500',
  listening: 'text-red-500 animate-pulse',
  processing: 'text-amber-500',
  speaking: 'text-blue-500',
};

const stateLabels: Record<VoiceState, string> = {
  off: 'Enable voice mode',
  idle: 'Voice on — tap to turn off',
  listening: 'Listening… (tap to turn off)',
  processing: 'Thinking… (tap to turn off)',
  speaking: 'Speaking… (tap to turn off)',
};

export function VoiceToggle({
  voiceState,
  isSupported,
  onToggle,
}: {
  voiceState: VoiceState;
  isSupported: boolean;
  onToggle: () => void;
}) {
  if (!isSupported) return null;

  function getIcon() {
    switch (voiceState) {
      case 'off':
        return <MicOff className="size-4" />;
      case 'processing':
        return <Loader2 className="size-4 animate-spin" />;
      case 'speaking':
        return <Volume2 className="size-4" />;
      default:
        return <Mic className="size-4" />;
    }
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={stateLabels[voiceState]}
      title={stateLabels[voiceState]}
      className={cn(
        'flex size-8 items-center justify-center rounded-lg transition-colors hover:bg-muted',
        stateStyles[voiceState],
      )}
    >
      {getIcon()}
    </button>
  );
}
