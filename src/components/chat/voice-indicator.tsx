'use client';

import { Loader2, Mic, Square, Volume2 } from 'lucide-react';
import type { VoiceState } from '@/hooks/use-voice';
import { cn } from '@/lib/utils';

const config: Record<
  Exclude<VoiceState, 'off'>,
  { icon: typeof Mic; label: string; color: string }
> = {
  idle: {
    icon: Mic,
    label: 'Mic on — speak any time',
    color: 'bg-emerald-500/10 text-emerald-600',
  },
  listening: { icon: Mic, label: 'Listening…', color: 'bg-red-500/10 text-red-600' },
  processing: { icon: Loader2, label: 'Thinking…', color: 'bg-amber-500/10 text-amber-600' },
  speaking: { icon: Volume2, label: 'Speaking…', color: 'bg-blue-500/10 text-blue-600' },
};

export function VoiceIndicator({
  voiceEnabled,
  voiceState,
  onStopSpeaking,
}: {
  voiceEnabled: boolean;
  voiceState: VoiceState;
  onStopSpeaking: () => void;
}) {
  // Only hide the bar when the operator has actually disabled voice.
  // Per-turn state ("off" briefly between responses) must NOT hide it,
  // otherwise the bar disappears while the mic is still live.
  if (!voiceEnabled) return null;

  // If voiceEnabled but state is somehow "off" (race), show the ambient
  // "mic on" treatment rather than blanking out.
  const effective: Exclude<VoiceState, 'off'> = voiceState === 'off' ? 'idle' : voiceState;
  const { icon: Icon, label, color } = config[effective];

  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2 border-b px-4 py-2 text-xs font-medium',
        color,
      )}
    >
      <div className="flex items-center gap-2">
        <Icon
          className={cn(
            'size-3.5',
            effective === 'processing' && 'animate-spin',
            (effective === 'listening' || effective === 'idle') && 'animate-pulse',
          )}
        />
        <span>{label}</span>
      </div>
      {voiceState === 'speaking' && (
        <button
          type="button"
          onClick={onStopSpeaking}
          aria-label="Stop speaking"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-black/10"
        >
          <Square className="size-3" />
          <span>Stop</span>
        </button>
      )}
    </div>
  );
}
