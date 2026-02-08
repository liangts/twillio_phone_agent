# Twilio Phone Agent

This server now mirrors the architecture from Twilio’s SIP connector tutorials:

```
Twilio / Wavix SIP trunk ──▶ OpenAI Realtime SIP Connector ──▶ (this repo) ──▶ OpenAI Realtime Calls API (HTTP + WebSocket)
```

OpenAI terminates the RTP/audio path. Our code only needs to:
1. Receive webhook events from the OpenAI SIP connector.
2. Accept incoming calls with the right model/voice/prompt via `POST /v1/realtime/calls/{call_id}/accept`.
3. Attach to the per-call WebSocket so we can observe transcripts, send system instructions, and react to tool invocations (e.g., warm transfers).

## Getting started

1. **Install dependencies**
   ```bash
   npm install
   ```
2. **Copy environment defaults**
   ```bash
   cp .env.example .env
   ```
3. **Fill in `.env`**
   - `OPENAI_API_KEY`: Project API key with access to the Realtime Calls API.
   - `OPENAI_WEBHOOK_SECRET`: Secret you configured when creating the SIP connector webhook.
   - `OPENAI_MODEL`: Realtime-capable model (default `gpt-realtime`).
   - `OPENAI_VOICE`: Voice for synthesized speech (default `alloy`).
   - `PROMPT_PATH`: Path to the markdown file that defines your system instructions.
   - `WELCOME_MESSAGE`: Optional greeting that is spoken as soon as the WebSocket comes up.
   - `PORT`: Local port for the Express server (default `3000`).
   - Optional transfer settings:
     - `HUMAN_AGENT_NUMBER`: PSTN destination in E.164 format (`+15551112222`). The server automatically converts it to `tel:+15551112222` for OpenAI SIP refer transfers.
     - `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN`: Optional Twilio REST credentials used only for conference-based transfer fallback flows.
     - `TWILIO_HUMAN_LABEL`: Participant label used for Twilio conference fallback transfers.
     - `CONTROL_API_TOKEN`: Optional bearer token required by manual control endpoints (`/control/calls/:call_id/*`).
   - Optional Discord transcript streaming:
     - `DISCORD_WEBHOOK_URL`: Discord webhook endpoint for posting live transcripts/notifications.
   - Optional transcription tuning:
      - `INPUT_TRANSCRIPTION_MODEL`: Speech-to-text model for caller audio (default `gpt-4o-mini-transcribe`).
      - `INPUT_TRANSCRIPTION_LANGUAGE`: Force transcription language (leave blank for auto).
4. **Start the server**
   ```bash
   npm start
   ```

## Configure OpenAI + Twilio

1. **OpenAI SIP Connector**
   - Create a connector in the OpenAI console and point the webhook URL to `https://<public-host>/openai/webhook`.
   - Copy the webhook secret into `OPENAI_WEBHOOK_SECRET`.
   - Grant the connector access to the SIP credentials Twilio (or your carrier) will use.
2. **Twilio Elastic SIP Trunk or Programmable SIP**
   - Set the trunk’s termination SIP URI to the OpenAI connector domain.
   - Configure authentication/ACLs that match what you entered in the OpenAI console.
   - Point an inbound Twilio number at the trunk so PSTN calls land in the connector.
3. **Static tunnel** (recommended)
   - Use Ngrok (or similar) with a reserved domain so the webhook URL never changes:
     ```bash
     ngrok http 3000 --url voice.example.ngrok.app
     ```

## Runtime behavior

- `/openai/webhook` verifies the `X-OpenAI-Signature`, accepts `realtime.call.incoming` events, and acknowledges other call lifecycle events with `200 OK`.
- Accepting a call posts your prompt/voice/metadata via `/v1/realtime/calls/{call_id}/accept`, then connects to the Realtime Calls WebSocket (`wss://api.openai.com/v1/realtime?call_id=...`).
- The WebSocket handler logs transcripts, greets the caller (if `WELCOME_MESSAGE` is set), and reacts to tool calls (warm transfer, CRM lookups, etc.). Caller and agent utterances are transcribed turn-by-turn; each completed sentence is sent to Discord (if `DISCORD_WEBHOOK_URL` is present) in the form `Caller: ...` / `Agent: ...`. If `HUMAN_AGENT_NUMBER` is present, the server registers a `transfer_to_human` tool that transfers the call using OpenAI SIP refer (`POST /v1/realtime/calls/{call_id}/refer`) to `tel:+...`.
- `GET /health` returns `{"status":"ok"}` for uptime checks.
- Manual operator controls are available from:
  - `POST /control/calls/:call_id/transfer`
  - `POST /control/calls/:call_id/hangup`
  These endpoints operate on the server’s active in-memory call map. If `CONTROL_API_TOKEN` is set, pass `Authorization: Bearer <token>`.

### Cloudflare Worker control proxy (for dashboard actions)

If your dashboard calls the Cloudflare Worker API, configure these Worker secrets/vars so Worker can proxy actions to your ELB-hosted Docker service:

- `CONTROL_API_BASE_URL`: Base URL for this service (for example `https://voice-api.example.com`).
- `CONTROL_API_TOKEN`: Optional token forwarded as bearer auth to `/control/calls/:call_id/*`.
- `CONTROL_API_TIMEOUT_MS`: Optional upstream timeout in milliseconds (default `8000`).
- Optional Cloudflare Access service token headers (if your ELB/API is protected by Access):
  - `CONTROL_API_ACCESS_CLIENT_ID`
  - `CONTROL_API_ACCESS_CLIENT_SECRET`

### React dashboard

The newer dashboard UI lives in `dashboard/` (React + Vite). It can be hosted on Cloudflare Pages or any static host.

```bash
cd dashboard
npm install
npm run build
npx wrangler pages deploy dist --project-name <your-pages-project>
```

Set API base at runtime with `?api=https://phone.ocpp.evcheckpoint.net`, or set `VITE_API_BASE` when building.

### Enabling the transfer tool

1. **Set destination number**  
   Configure `HUMAN_AGENT_NUMBER` in E.164 format (for example `+14155550123`).
2. **Prompt the model**  
   Update `config/agent_prompt.md` to tell the AI when to call the `transfer_to_human` tool (for example: “If the caller asks for a person, call the `transfer_to_human` function.”).
3. **Twilio conference fallback (optional)**  
   If you migrate to a Twilio conference-based warm-transfer architecture, you can also provide conference metadata (`conferenceName`, `callToken`) and Twilio credentials to transfer by adding a participant to the conference.

## Run in Docker

```bash
docker build -t twilio-phone-agent .
docker run --rm -p 3000:3000 \\
  --env-file .env \\
  -v $(pwd)/config/agent_prompt.md:/app/config/agent_prompt.md \\
  twilio-phone-agent
```

Remember to expose `3000` through your tunnel or reverse proxy so OpenAI can reach `/openai/webhook`.

## Next steps

- Wire in OpenAI tool handlers that call back into Twilio Programmable SIP for warm transfers.
- Persist transcripts/metadata to your CRM or analytics stack.
- Add structured observability (metrics, distributed tracing) before moving to production.
