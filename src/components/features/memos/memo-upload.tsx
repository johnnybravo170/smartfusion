'use client';

/**
 * Voice memo upload and transcription component.
 *
 * Supports both MediaRecorder (in-browser recording) and file upload.
 * After upload, user triggers transcription which extracts work items
 * mapped to cost buckets.
 */

import { Loader2, Mic, MicOff, Upload } from 'lucide-react';
import { useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { transcribeMemoAction, uploadMemoAction } from '@/server/actions/project-memos';

type MemoRow = {
  id: string;
  status: string;
  transcript: string | null;
  ai_extraction: Record<string, unknown> | null;
  created_at: string;
};

type MemoUploadProps = {
  projectId: string;
  memos: MemoRow[];
};

export function MemoUpload({ projectId, memos }: MemoUploadProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [transcribing, setTranscribing] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        for (const t of stream.getTracks()) t.stop();
        uploadBlob(blob, 'recording.webm');
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch {
      toast.error('Could not access microphone. Please check permissions.');
    }
  }

  function stopRecording() {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    uploadBlob(file, file.name);
    // Reset file input
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function uploadBlob(blob: Blob, filename: string) {
    startTransition(async () => {
      const formData = new FormData();
      formData.append('project_id', projectId);
      formData.append('audio', blob, filename);

      const result = await uploadMemoAction(formData);
      if (result.ok) {
        toast.success('Audio uploaded. Click "Transcribe" to process.');
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleTranscribe(memoId: string) {
    setTranscribing(memoId);
    startTransition(async () => {
      const result = await transcribeMemoAction(memoId);
      setTranscribing(null);
      if (result.ok) {
        toast.success('Transcription complete!');
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="space-y-6">
      {/* Upload controls */}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant={isRecording ? 'destructive' : 'default'}
          onClick={isRecording ? stopRecording : startRecording}
          disabled={isPending}
        >
          {isRecording ? (
            <>
              <MicOff className="mr-2 size-4" /> Stop recording
            </>
          ) : (
            <>
              <Mic className="mr-2 size-4" /> Record memo
            </>
          )}
        </Button>

        <span className="text-sm text-muted-foreground">or</span>

        <Button
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
          disabled={isPending}
        >
          <Upload className="mr-2 size-4" /> Upload audio
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={handleFileUpload}
        />

        {isPending && !transcribing ? (
          <span className="text-sm text-muted-foreground flex items-center gap-1">
            <Loader2 className="size-3 animate-spin" /> Uploading...
          </span>
        ) : null}
      </div>

      {/* Memo list */}
      {memos.length > 0 ? (
        <div className="space-y-4">
          {memos.map((memo) => (
            <div key={memo.id} className="rounded-lg border p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-muted-foreground">
                  {new Date(memo.created_at).toLocaleDateString('en-CA', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </span>
                <span className="text-xs font-medium uppercase tracking-wider">{memo.status}</span>
              </div>

              {memo.status === 'pending' ? (
                <Button
                  size="sm"
                  onClick={() => handleTranscribe(memo.id)}
                  disabled={isPending || transcribing === memo.id}
                >
                  {transcribing === memo.id ? (
                    <>
                      <Loader2 className="mr-2 size-3 animate-spin" /> Transcribing...
                    </>
                  ) : (
                    'Transcribe'
                  )}
                </Button>
              ) : null}

              {memo.status === 'transcribing' || memo.status === 'extracting' ? (
                <p className="text-sm text-muted-foreground flex items-center gap-1">
                  <Loader2 className="size-3 animate-spin" /> Processing...
                </p>
              ) : null}

              {memo.status === 'failed' ? (
                <div>
                  <p className="text-sm text-red-600 mb-2">Transcription failed.</p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleTranscribe(memo.id)}
                    disabled={isPending}
                  >
                    Retry
                  </Button>
                </div>
              ) : null}

              {memo.status === 'ready' && memo.transcript ? (
                <div className="space-y-3">
                  <div>
                    <h4 className="text-xs font-medium text-muted-foreground mb-1">Transcript</h4>
                    <p className="text-sm whitespace-pre-wrap">{memo.transcript}</p>
                  </div>

                  {memo.ai_extraction &&
                  Array.isArray((memo.ai_extraction as Record<string, unknown>).work_items) ? (
                    <div>
                      <h4 className="text-xs font-medium text-muted-foreground mb-1">
                        Extracted Work Items
                      </h4>
                      <ul className="space-y-1">
                        {(
                          (memo.ai_extraction as Record<string, unknown>).work_items as Array<{
                            area: string;
                            description: string;
                            suggested_bucket: string;
                            section: string;
                          }>
                        ).map((item) => (
                          <li
                            key={`${item.section}-${item.suggested_bucket}-${item.area}`}
                            className="text-sm rounded bg-muted/50 px-2 py-1"
                          >
                            <span className="font-medium">{item.area}</span>: {item.description}
                            <span className="text-xs text-muted-foreground ml-2">
                              [{item.section} / {item.suggested_bucket}]
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No memos yet. Record or upload audio from a site walk-through.
        </p>
      )}
    </div>
  );
}
