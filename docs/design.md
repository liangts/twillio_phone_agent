# Twilio SIP → OpenAI Realtime bridge (design notes)

## Goals
- Accept inbound SIP calls (Twilio/Wavix) through the OpenAI SIP Connector.
- Drive the conversation over the Realtime Calls HTTP/WebSocket APIs (no RTP relay).
- Stream labeled transcripts (`Caller:` / `Agent:`) to Discord while the call is live.
- Support tool calls (e.g., warm transfer via Twilio Programmable SIP) and minimal observability.

## High-level flow
1. Twilio SIP Trunk (or other carrier) INVITEs the OpenAI SIP Connector.
2. OpenAI sends `realtime.call.incoming` to our webhook `POST /openai/webhook`.
3. We verify the signature, `POST /v1/realtime/calls/{call_id}/accept` with model/voice/tools, then connect to the provided realtime WebSocket.
4. As OpenAI streams events, we:
   - Track caller/agent transcripts and push completed utterances to Discord.
   - Execute tool calls (e.g., `transfer_to_human`) via Twilio’s REST API.
5. On call end or socket close, we clean up active call state.

## Env & configuration
- Required: `OPENAI_API_KEY`, `OPENAI_WEBHOOK_SECRET`.
- Optional:
  - Audio/output: `OPENAI_MODEL`, `OPENAI_VOICE`, `WELCOME_MESSAGE`.
  - Transcription: `INPUT_TRANSCRIPTION_MODEL`, `INPUT_TRANSCRIPTION_LANGUAGE`.
  - Discord: `DISCORD_WEBHOOK_URL`.
  - Twilio warm transfer: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `HUMAN_AGENT_NUMBER`, `TWILIO_HUMAN_LABEL`.
- Defaults live in `.env.example`; `Dockerfile` uses env at runtime (not baked in).

## Key server pieces (src/server.js)
- **Express setup**: raw body parsing on `/openai/webhook` to preserve signature validity; JSON for `/health`. Server listens on `PORT`.
- **OpenAI client**: `openai.webhooks.unwrap` verifies signatures; `/accept` posted via `fetch`.
- **Twilio client**: instantiated when credentials + `HUMAN_AGENT_NUMBER` are present; registers `transfer_to_human` tool.
- **Discord helper**: `sendDiscordMessage(content, webhookUrl?)` chunks to 1900 chars, posts to the webhook, logs errors.

### Per-call lifecycle
- `createCallState(callId, event)`:
  - Extracts caller/target numbers from SIP headers (`From`/`To`), and forwarding hints from `Diversion`/`History-Info`.
  - Stores Twilio `callToken`, conference name (if present), transcript buffers, and tool-call tracking.
- `buildCallAcceptPayload(event)`:
  - Sets model/voice, `output_modalities`/audio output.
  - Adds input transcription via `audio.input.transcription` (model + optional language).
  - Attaches tool definitions when available.
- `acceptIncomingCall(event)`:
  - Creates call state, POSTs `/accept`, announces caller info to Discord, then opens the realtime WebSocket.

### Realtime WebSocket handling
- `handleRealtimeMessage(call, payload)` routes events to:
  - `processCallerTranscriptEvent`: listens for `conversation.item.input_audio_transcription.delta/completed` (and input_text fallbacks) to build `Caller:` lines.
  - `processAgentTranscriptEvent`: prefers `response.audio_transcript.delta/done` and falls back to `response.output_text` events for `Agent:` lines.
  - Tool calls: `response.output_tool_call.delta/done` drive `executeToolCall`.
- Transcript helpers:
  - `normalizeTextFragment` / `appendTranscriptBuffer` coalesce mixed payload shapes.
  - `recordTranscriptLine` appends to in-memory logs and pushes each completed utterance to Discord.
- Socket lifecycle:
  - On open: sends `WELCOME_MESSAGE` if set.
  - On close/error: removes call and closes peer sockets.

### Tooling (warm transfer example)
- Tool definition: `transfer_to_human` registers when Twilio creds + `HUMAN_AGENT_NUMBER` exist.
- Execution: `executeToolCall` invokes Twilio `participants.create` with `callToken`, caller number, and labels; returns a status message to be spoken back to the caller.

## SIP header handling
- `getSipHeaderValue` / `getNumberFromHeader` parse E.164 numbers from `From`, `To`, `Diversion`, `History-Info`.
- `announceIncomingCall` posts an immediate Discord message after `/accept` succeeds, showing raw `From` and any forwarding headers/number.

## Transcript delivery to Discord
- Each completed caller/agent turn emits a Discord message (`Caller: …` / `Agent: …`).
- If `DISCORD_WEBHOOK_URL` is unset, messages are skipped with a warning.

## Error handling / observability
- Signature failures return 400; other webhook errors return 500 with logs.
- `/accept` failures throw with status/body; 404 special-cased earlier to avoid noise.
- Minimal logging to stdout; can be upgraded to structured logging if needed.

## Future improvements
- Add final transcript dump on call end (interleaving `transcriptLog` by timestamp).
- Backpressure/retry for Discord/Twilio calls (with timeouts).
- Optional metrics (latency from webhook to `/accept`, socket uptime, transcript counts).

