# Twilio Phone Agent

This prototype bridges a Twilio voice call to an OpenAI Realtime agent. Incoming calls hit a Twilio Voice webhook, Twilio opens a Media Stream WebSocket, and the server relays audio to the OpenAI realtime endpoint while streaming the model's synthesized replies back to the caller.

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
   - `OPENAI_API_KEY`: OpenAI API key with access to the realtime model.
   - `OPENAI_MODEL`: Realtime-capable model (e.g., `gpt-4o-realtime`).
   - `PUBLIC_URL`: Public base URL **including the HTTPS scheme** (e.g., `https://voice.example.com`). The server converts this to `wss://` when constructing the Twilio media stream URL.
   - `PORT`: Local port (default `3000`).
   - `PROMPT_PATH`: Optional path to the system prompt file (default `config/agent_prompt.md`).
4. **Start the server**
   ```bash
   npm start
   ```

Optional email summary configuration (for call recordings + transcripts):
- `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE`: SMTP server details.
- `SMTP_USER` / `SMTP_PASS`: Credentials if your SMTP host requires auth.
- `EMAIL_FROM`: From-address for the summary email.
- `EMAIL_TO`: Recipient address for the summary email.

## Twilio configuration

1. In the Twilio Console, set your phone number's **Voice & Fax / A CALL COMES IN** webhook to `https://<PUBLIC_URL>/voice` (include the `https://` prefix).
2. The `/voice` endpoint responds with TwiML that instructs Twilio to start a bidirectional Media Stream to the same host at `wss://<PUBLIC_URL>/media`. You do **not** need to set a separate WebSocket env var—the server derives it from `PUBLIC_URL`. If you visit `GET /voice` locally (for example, with `curl http://localhost:3000/voice`) the server now returns a friendly reminder that the endpoint expects POST webhooks, which avoids the confusing `Cannot GET /voice` error.
3. Twilio sends base64-encoded mulaw audio (8 kHz) into the stream and accepts outbound mulaw audio from the bridge.

## OpenAI Realtime configuration

The server opens one OpenAI Realtime WebSocket per call and:
- sets the session prompt from `PROMPT_PATH`
- configures input/output audio to mulaw at 8 kHz
- enables VAD-based turn detection

Update `config/agent_prompt.md` to customize the agent personality. You can also point `PROMPT_PATH` to another file at runtime.

## Local development tips

- Use `ngrok` or another tunnel to expose your local server. Set `PUBLIC_URL` to the tunnel host (e.g., `https://abcd1234.ngrok.app`).
- Ensure your OpenAI key and model support realtime audio. The bridge will warn and skip OpenAI connection if `OPENAI_API_KEY` is absent.
- Health check: `GET /health` returns `{"status":"ok"}` when the server is running.

## Run in Docker

1. **Build the image** (from the repo root):
   ```bash
   docker build -t twilio-phone-agent .
   ```
2. **Run the container** (mount your prompt and pass env vars):
   ```bash
   docker run --rm -p 3000:3000 \
     -e OPENAI_API_KEY=sk-... \
     -e OPENAI_MODEL=gpt-4o-realtime \
     -e PUBLIC_URL=https://<public-host> \
     -e PROMPT_PATH=/app/config/agent_prompt.md \
     -v $(pwd)/config/agent_prompt.md:/app/config/agent_prompt.md \
     twilio-phone-agent
   ```

   Or load everything from a local `.env` file so you don't have to pass each value individually:

   ```bash
   docker run --rm -p 3000:3000 \
     --env-file .env \
     -v $(pwd)/config/agent_prompt.md:/app/config/agent_prompt.md \
     twilio-phone-agent
   ```

Environment variable notes:
- `PORT` defaults to `3000` inside the container; adjust the `-p` mapping if you change it.
- `PROMPT_PATH` should reference an in-container path. Mount your custom prompt file into the container and point to it.
- If you use `PUBLIC_URL` with HTTPS termination in front of the container (e.g., load balancer), set it to the public hostname that Twilio reaches.

## Caveats

- This bridge assumes mulaw audio on both sides. If your OpenAI session requires a different format, adjust the session settings in `src/server.js` and match the Twilio media stream codec accordingly.
- Error handling is minimal; production deployments should add retries, logging, and secure secret management.

## Call recording, transcripts, and email summaries

When SMTP settings are provided, each call is recorded and emailed after Twilio sends the `stop` event:

- The bridge collects the caller's inbound mu-law audio and the agent's outbound mu-law audio and packages each into a mono 8 kHz `.wav` file (mu-law encoded) attached to the email.
- Caller/agent transcripts are built from the OpenAI realtime messages (`input_text` and `output_text` deltas) and included in the email body.

To enable summaries, set the SMTP and email environment variables (see above). If SMTP is not configured, the bridge still runs but skips emailing.
