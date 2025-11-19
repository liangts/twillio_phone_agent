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

## Outstanding questions to confirm
- Does the OpenAI Realtime API accept externally hosted files/knowledge bases, or should we embed text snippets from config for now?
- Do we want DTMF handling (Twilio sends `dtmf` events) to trigger tool calls or routing inside the agent?
- Should we store transcripts and audio for QA? If so, where and with what retention policy?

## Can this run on AWS Amplify?
- **Amplify Hosting is static/SSR oriented**: It is designed for front-end apps (static or SSR) and serverless Functions. It does not expose a long-lived TCP/WebSocket port that a Twilio Media Stream can connect to, so the Node WebSocket bridge in this repo cannot be hosted directly there.
- **Amplify Functions are short-lived**: Backend functions run as Lambdas behind API Gateway. API Gateway WebSockets trigger Lambdas per message and are not intended to maintain a continuous bidirectional stream to a third-party WebSocket (OpenAI). Long-running OpenAI sessions plus audio transcoding exceed typical Lambda execution windows and cold-start constraints.
- **Recommended AWS targets**: Use a container/service that supports persistent WebSocket servers such as **App Runner**, **ECS Fargate**, or **Elastic Beanstalk**. You can still manage DNS via Route 53/Amplify domains while pointing to the service’s HTTPS/WebSocket endpoint.
- **If Amplify must be used**: You could host a UI with Amplify Hosting and deploy the bridge separately (e.g., App Runner). Trying to force the bridge into Amplify Functions with API Gateway WebSockets would require custom connection state storage (DynamoDB), background processes for OpenAI streaming, and likely still hit Lambda runtime/memory limits.
