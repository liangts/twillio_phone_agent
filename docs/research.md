# API research: Twilio voice streaming + OpenAI Realtime

## Twilio call handling options
- **TwiML Voice with Media Streams (WebSocket)**: Use `<Start><Stream url="wss://your-host/..."/>` in the initial TwiML response to fork live audio to a WebSocket server. Twilio sends JSON frames with base64-encoded audio (mu-law 8 kHz mono by default) plus events for start/stop, mark messages, and bidirectional support via `streamSid`. Allows sending audio back with `media` messages.
- **Twilio Voice SDK / WebRTC**: For browser/softphone experiences, Twilio Voice SDK can stream Opus audio over WebRTC; for PSTN transfers, Media Streams via TwiML is simpler because the PSTN call can be bridged without SDK clients.
- **Call control**: Keep a webhook to return TwiML for answering and streaming; use `mark` or custom messages to signal agent state. Twilio will reconnect on WebSocket failures; you must handle `start`, `media`, and `stop` frames per stream.

## OpenAI Realtime API highlights
- **Connection**: Bidirectional WebSocket to `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview` with Bearer auth. Supports JSON events and binary audio chunks. System or assistant instructions can be sent at session start, enabling per-customer prompts.
- **Audio format**: Expects 16-bit linear PCM at 24 kHz, mono. The API can emit synthesized speech audio frames and partial/final transcripts. Supports function calls/tool calls in-stream.
- **Session state**: Each WebSocket corresponds to one conversation. You can send an `input_audio_buffer.append` with PCM data, then `response.create` to start generation. System prompts are provided via `response.create` or session instructions; knowledge grounding can be embedded as text or uploaded files when available.

## Integration considerations
- **Transcoding**: Convert Twilio's mu-law 8 kHz audio to 16-bit PCM 24 kHz before forwarding to OpenAI. For output, downsample/resample AI audio to mu-law 8 kHz before sending back to Twilio via `media` frames on the Twilio stream.
- **WebSocket bridge**: Stand up a server that terminates two WebSockets—one from Twilio Media Streams and one to OpenAI Realtime. Map each Twilio `streamSid` to an OpenAI session. Relay audio in both directions and translate control events (start/stop, marks, response events).
- **Prompt/knowledge storage**: Keep a per-customer configuration file (YAML/JSON) with system prompt text and optional knowledge snippets; send these as session instructions when establishing the OpenAI connection. If OpenAI expands hosted knowledge bases, swap config to reference remote assets instead.
- **Reliability**: Implement backpressure and timeouts so OpenAI generations do not lag call audio. Log transcripts (with redaction if required) to help tune prompts. Consider Twilio `<Hangup>` or `<Redirect>` if the agent needs to terminate or transfer.

## Pivot: Twilio SIP connector + OpenAI Realtime Calls API
Twilio’s January 2025 tutorials (“[Connect the OpenAI Realtime SIP Connector with Twilio Elastic SIP Trunking](https://www.twilio.com/en-us/blog/developers/tutorials/product/openai-realtime-api-elastic-sip-trunking)” and “[Warm transfer with the OpenAI Realtime API + Programmable SIP](https://www.twilio.com/en-us/blog/developers/tutorials/product/warm-transfer-openai-realtime-programmable-sip)”) document a new pattern where OpenAI terminates the RTP path. Instead of proxying audio ourselves, we let the OpenAI SIP connector sit between the carrier/PBX trunk and the model—the webhook only orchestrates the “brain.”

### Flow summary
- **Call ingress**: Twilio Elastic SIP Trunk (or another SIP carrier such as Wavix) dials the SIP URI provided by the OpenAI SIP connector. Twilio handles PSTN, codec negotiation, and PSTN↔SIP conversion.
- **OpenAI SIP connector**: OpenAI authenticates the SIP INVITE, spins up a Realtime Calls session, and immediately POSTs a `realtime.call.incoming` webhook to our server. The payload includes the `call_id`, caller/callee metadata, and a `wss_url` for attaching to the session once we accept it.
- **Our webhook responsibilities**:
  - Verify the request signature using the `X-Openai-Signature` header and the webhook secret configured in the OpenAI console (Twilio’s sample code rejects mismatches with HTTP 400).
  - On `realtime.call.incoming`, respond right away by calling `POST https://api.openai.com/v1/realtime/calls/{call_id}/accept` with a `callAccept` JSON document that sets the model (`gpt-realtime` family), modalities (audio + text), instructions/system prompt, the voice to synthesize, and optional tool definitions.
  - After the accept succeeds, connect to the provided `wss_url` with the short-lived client secret that OpenAI returns. This WebSocket becomes our control/data plane for the conversation: send `response.create` events, ingest `response.delta` events, and handle tool invocations.
  - Return `200 OK` to the webhook request (with `Authorization` header echoed back per the tutorial) so OpenAI knows we accepted. Non-incoming events (call ended, metrics, etc.) can be acknowledged with an empty 200 body.
- **Realtime Calls API**: Once the WebSocket is up, OpenAI streams ASR transcripts, voice synthesis, and tool invocations directly to us. Audio never traverses our infrastructure—only the JSON/text control channel does. Ending the session or issuing events now happens via HTTP (`/calls/{call_id}/...`) or the WebSocket instead of media relay hacks.

### Config + operational notes from the tutorials
- **Static webhook URL**: Because OpenAI is the one calling our webhook, the docs recommend reserving an Ngrok domain (or similar) so the webhook endpoint URL never changes. Without that, you must keep updating the OpenAI SIP Connector configuration.
- **SIP trunk setup**: Twilio Elastic SIP Trunking needs:
  - Termination SIP URI pointing to the OpenAI connector host.
  - ACLs and auth that match the credentials entered in the OpenAI console.
  - A PSTN-capable Twilio number set to Forward calls through the trunk.
- **Webhook payload shape**: The Node TypeScript sample (tsx server) unmarshals the JSON body and immediately switches on `event.event_type`. Only when it equals `realtime.call.incoming` does it call `/accept`; other event types simply 200/No-op.
- **callAccept body**: Includes `model`, `voice`, `instructions`, `metadata`, and `tools`. You can also set `conversation` options like turn-taking rules, response timeouts, and `modalities` (e.g., audio + text). This becomes the Realtime session’s initial state.
- **WebSocket connect**: The tutorial waits a few hundred milliseconds after `/accept` before attaching to the `wss_url` (OpenAI calls it `connectWithDelay`) to avoid connecting before the session is ready. Once connected, the app:
  - Listens for `response.output_text.delta`, `response.output_audio.delta`, and `response.completed` events (no Twilio `media` frames anymore).
  - Sends JSON instructions such as `response.create` or tool results (`response.output_tool_call.delta` with `result` fields).
- **Error handling**: If `/accept` fails, or we do not respond with 200, OpenAI tears down the SIP leg and Twilio falls back to PSTN failover routing. The sample logs errors and returns 500 for unexpected cases, plus 400 for signature mismatches.

### What this means for this repo
- The existing `src/server.js` is a dual-WebSocket audio bridge. Under the SIP connector architecture we can drop the Twilio media WebSocket entirely.
- The new minimum viable server is:
  1. HTTP endpoint `/openai/webhook` that validates signatures and dispatches events.
  2. Utility to POST `/v1/realtime/calls/{call_id}/accept` with project- or customer-specific prompts + tool definitions.
  3. `RealtimeCallsClient` that dials the temporary `wss_url` per call, drives the Realtime session, and surfaces transcripts or tool invocations to downstream systems.
- Tooling hooks (functions, data lookups, CRM actions) now happen via OpenAI tool calls; audio conversion/transcoding becomes OpenAI’s problem.
- Monitoring now focuses on webhook latency (<500 ms to accept the call), `/accept` success, and WebSocket stability rather than RTP forwarding load.

## Warm transfer + Programmable SIP (per Twilio tutorial #2)
- **Architecture**: Twilio phone number → Programmable SIP domain (handles IVR/app-to-app bridging) → OpenAI SIP Connector → our webhook + Realtime Calls session. When the caller asks for a human, we instruct Twilio to park the OpenAI bot and invite a person via Programmable SIP.
- **Tool-driven escalation**: The TypeScript example defines a tool such as `transfer_to_human`. When the model emits a `response.output_tool_call` asking to run that tool, the webhook (or WebSocket handler) calls Twilio’s Voice API with the `callToken` provided by OpenAI to add a human participant into the existing conference (`client.conferences(...).participants.create({ to: HUMAN_AGENT_NUMBER, callToken })`). The call token maps the OpenAI SIP call back to Twilio so Programmable SIP can bridge the human and disconnect the AI leg cleanly.
- **Session metadata**: Keeping track of `call_id`, `conferenceName`, `callToken`, caller phone, and current role assignments lets us update CRM, mute/unmute the AI participant, or later re-summon the AI.
- **Observability**: The tutorial logs tool invocations, WebSocket close codes, and warm-transfer success/failure so ops teams can audit automations before giving customers self-service escalations.
- **Implication for our rewrite**: our webhook/WSS handler needs a plug-in style tool registry—one tool might trigger a Twilio Programmable SIP API call, another might push data to CRM, etc. This is pure HTTP/WebSocket logic; we never touch audio.

## Outstanding questions to confirm
- Does the OpenAI Realtime API accept externally hosted files/knowledge bases, or should we embed text snippets from config for now?
- Do we want DTMF handling (Twilio sends `dtmf` events) to trigger tool calls or routing inside the agent?
- Should we store transcripts and audio for QA? If so, where and with what retention policy?

## Can this run on AWS Amplify?
- **Amplify Hosting is static/SSR oriented**: It is designed for front-end apps (static or SSR) and serverless Functions. It does not expose a long-lived TCP/WebSocket port that a Twilio Media Stream can connect to, so the Node WebSocket bridge in this repo cannot be hosted directly there.
- **Amplify Functions are short-lived**: Backend functions run as Lambdas behind API Gateway. API Gateway WebSockets trigger Lambdas per message and are not intended to maintain a continuous bidirectional stream to a third-party WebSocket (OpenAI). Long-running OpenAI sessions plus audio transcoding exceed typical Lambda execution windows and cold-start constraints.
- **Recommended AWS targets**: Use a container/service that supports persistent WebSocket servers such as **App Runner**, **ECS Fargate**, or **Elastic Beanstalk**. You can still manage DNS via Route 53/Amplify domains while pointing to the service’s HTTPS/WebSocket endpoint.
- **If Amplify must be used**: You could host a UI with Amplify Hosting and deploy the bridge separately (e.g., App Runner). Trying to force the bridge into Amplify Functions with API Gateway WebSockets would require custom connection state storage (DynamoDB), background processes for OpenAI streaming, and likely still hit Lambda runtime/memory limits.
