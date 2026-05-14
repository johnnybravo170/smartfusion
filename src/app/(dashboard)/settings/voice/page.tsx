import { Mic } from 'lucide-react';
import { SettingsPageHeader } from '@/components/features/settings/settings-page-header';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata = { title: 'Voice — Settings' };

export default function VoiceSettingsPage() {
  const isConfigured = !!process.env.ELEVENLABS_API_KEY && !!process.env.ELEVENLABS_VOICE_ID;

  return (
    <>
      <SettingsPageHeader
        title="Voice"
        description="The voice Henry uses when reading messages aloud."
      />
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Mic className="size-5" />
            <div>
              <CardTitle>Current voice</CardTitle>
              <CardDescription>
                {isConfigured
                  ? 'Using ElevenLabs for natural text-to-speech.'
                  : 'Using browser default voice. Configure ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in environment variables to enable natural voice.'}
              </CardDescription>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Current: {isConfigured ? 'ElevenLabs' : 'Browser (default)'}
          </p>
        </CardHeader>
      </Card>
    </>
  );
}
