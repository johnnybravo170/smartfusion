'use client';

import { Loader2, Mic, Radio, Square, Volume2 } from 'lucide-react';
import type { VoiceState } from '@/hooks/use-voice';
import { cn } from '@/lib/utils';

const config: Record<
  Exclude<VoiceState, 'off'>,
  { icon: typeof Mic; label: string; color: string }
> = {
  idle: {
    icon: Radio,
    label: "Listening for 'Hey Henry'...",
    color: 'bg-emerald-500/10 text-emerald-600',
  },
  listening: { icon: Mic, label: 'Listening...', color: 'bg-red-500/10 text-red-600' },
  processing: { icon: Loader2, label: 'Thinking...', color: 'bg-amber-500/10 text-amber-600' },
  speaking: { icon: Volume2, label: 'Speaking...', color: 'bg-blue-500/10 text-blue-600' },
};

export function VoiceIndicator({
  voiceState,
  onStopSpeaking,
}: {
  voiceState: VoiceState;
  onStopSpeaking: () => void;
}) {
  if (voiceState === 'off') return null;

  const { icon: Icon, label, color } = config[voiceState];

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
            voiceState === 'processing' && 'animate-spin',
            voiceState === 'listening' && 'animate-pulse',
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
