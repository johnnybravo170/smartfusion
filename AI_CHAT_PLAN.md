# HeyHenry AI Chat — Implementation Plan

## Overview
Two-stage AI assistant: text chat first (foundation), voice layer second.

## Stage 1: Text Chat (Plan A)

### Architecture
```
Chat UI (client) → /api/chat (streaming) → Claude API (tools) → existing DB queries → Supabase
```

### Key decision: reuse existing query layer
The app already has `src/lib/db/queries/*` with functions for dashboard, customers, jobs, quotes, invoices, todos, worklog, catalog. AI tool handlers are thin wrappers that call these functions and format results as text.

### File structure
```
src/lib/ai/
  tools/index.ts, types.ts, definitions per domain (7 files)
  system-prompt.ts
  format.ts

src/app/api/chat/route.ts          (streaming POST handler)

src/components/chat/
  chat-panel.tsx, chat-messages.tsx, chat-input.tsx
  chat-bubble.tsx, chat-tool-indicator.tsx, chat-toggle.tsx

src/hooks/use-chat.ts              (conversation state + streaming)

supabase/migrations/0023_chat_messages.sql
```

### 17 tools (adapted from MCP)
get_dashboard, list_customers, get_customer, create_customer, list_quotes, get_quote, list_jobs, get_job, update_job_status, list_invoices, get_revenue_summary, list_todos, create_todo, complete_todo, search_worklog, add_worklog_note, list_catalog

### Parallel work streams
- Stream 1 (backend): SDK install → types → tool defs → tool index → system prompt → API route → rate limiting
- Stream 2 (frontend): chat UI components → use-chat hook
- Join: layout integration (needs both)
- Independent: migration

### Tests
- Unit: tool definitions valid, tool handlers return formatted strings
- Integration: mock Anthropic SDK, verify /api/chat streaming
- E2E: open chat, ask question, verify response

## Stage 2: Voice Layer (Plan B)

### Architecture
```
Wake word (browser SpeechRecognition, on-device, free)
  → "Hey Henry" detected
  → Active listening (browser SR v1, Deepgram v2)
  → Transcribed text → /api/chat (same endpoint)
  → Response → TTS (browser SpeechSynthesis v1, ElevenLabs v2)
  → Back to listening
```

### State machine
IDLE → (wake word) → LISTENING → (silence) → PROCESSING → (response) → SPEAKING → (done) → IDLE

### Files
```
src/lib/voice/wake-word.ts, speech-to-text.ts, text-to-speech.ts
src/components/chat/voice-toggle.tsx, voice-indicator.tsx
src/hooks/use-voice.ts, use-wake-word.ts
```

## Execution: subagent-driven recommended
