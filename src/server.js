const fs = require('fs');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const WebSocket = require('ws');

dotenv.config();

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-realtime';
const PUBLIC_URL = process.env.PUBLIC_URL;
const PROMPT_PATH = process.env.PROMPT_PATH || path.join(__dirname, '..', 'config', 'agent_prompt.md');

if (!OPENAI_API_KEY) {
  console.warn('Warning: OPENAI_API_KEY is not set. The bridge will not connect to OpenAI until it is configured.');
}

if (!PUBLIC_URL) {
  console.warn('Warning: PUBLIC_URL is not set. Twilio will not be able to connect to your media stream without a publicly reachable URL.');
}

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

function loadPrompt() {
  try {
    return fs.readFileSync(PROMPT_PATH, 'utf8');
  } catch (err) {
    console.warn(`Prompt file not found at ${PROMPT_PATH}. Using a default system message.`);
    return 'You are a helpful phone agent.';
  }
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/voice', (req, res) => {
  const streamUrl = `${PUBLIC_URL?.replace(/\/$/, '')}/media`;
  if (!PUBLIC_URL) {
    console.error('PUBLIC_URL is missing. Twilio cannot be pointed to the media WebSocket.');
  }

  const twiml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    '  <Connect>',
    `    <Stream url="${streamUrl}" track="inbound_track"/>`,
    '  </Connect>',
    '</Response>'
  ].join('\n');

  res.type('text/xml').send(twiml);
});

const server = app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

const wss = new WebSocket.Server({ server, path: '/media' });

function createOpenAIClient(streamSid, callInfo = {}) {
  if (!OPENAI_API_KEY) return null;

  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`;
  const headers = {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    'OpenAI-Beta': 'realtime=v1'
  };

  const socket = new WebSocket(url, { headers });
  const prompt = loadPrompt();

  socket.on('open', () => {
    const sessionUpdate = {
      type: 'session.update',
      session: {
        instructions: prompt,
        input_audio_format: 'pcm_mulaw',
        input_sampling_rate: 8000,
        output_audio_format: 'pcm_mulaw',
        output_sampling_rate: 8000,
        modalities: ['text', 'audio'],
        turn_detection: { type: 'server_vad' },
        metadata: {
          streamSid,
          from: callInfo.from,
          to: callInfo.to
        }
      }
    };

    socket.send(JSON.stringify(sessionUpdate));
  });

  return socket;
}

function relayAudioToOpenAI(openAISocket, audioBase64) {
  if (!openAISocket || openAISocket.readyState !== WebSocket.OPEN) return;

  const message = {
    type: 'input_audio_buffer.append',
    audio: audioBase64
  };

  openAISocket.send(JSON.stringify(message));
}

function relayAudioToTwilio(twilioSocket, streamSid, audioBase64) {
  if (!twilioSocket || twilioSocket.readyState !== WebSocket.OPEN) return;

  const message = {
    event: 'media',
    streamSid,
    media: {
      payload: audioBase64,
      track: 'outbound'
    }
  };

  twilioSocket.send(JSON.stringify(message));
}

wss.on('connection', (twilioSocket) => {
  console.log('Twilio media stream connected');
  let streamSid;
  let openAISocket;

  function teardown() {
    if (openAISocket && openAISocket.readyState === WebSocket.OPEN) {
      openAISocket.close();
    }
    if (twilioSocket.readyState === WebSocket.OPEN) {
      twilioSocket.close();
    }
  }

  twilioSocket.on('message', (data) => {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch (err) {
      console.error('Failed to parse Twilio media message', err);
      return;
    }

    if (event.event === 'start') {
      streamSid = event.start?.streamSid;
      openAISocket = createOpenAIClient(streamSid, {
        from: event.start?.from,
        to: event.start?.to
      });
      return;
    }

    if (event.event === 'media' && event.media?.payload) {
      relayAudioToOpenAI(openAISocket, event.media.payload);
      return;
    }

    if (event.event === 'stop') {
      console.log('Twilio stream stopped');
      teardown();
    }
  });

  twilioSocket.on('close', () => {
    console.log('Twilio media WebSocket closed');
    if (openAISocket && openAISocket.readyState === WebSocket.OPEN) {
      openAISocket.close();
    }
  });

  twilioSocket.on('error', (err) => {
    console.error('Error from Twilio media WebSocket', err);
    teardown();
  });

  const openAIHandlers = {
    message: (raw) => {
      let payload;
      try {
        payload = JSON.parse(raw.toString());
      } catch (err) {
        console.error('Failed to parse OpenAI message', err);
        return;
      }

      if (payload.type === 'response.output_audio.delta' && payload.delta) {
        relayAudioToTwilio(twilioSocket, streamSid, payload.delta);
      }
    },
    close: () => {
      console.log('OpenAI realtime WebSocket closed');
      if (twilioSocket.readyState === WebSocket.OPEN) {
        twilioSocket.close();
      }
    },
    error: (err) => {
      console.error('Error from OpenAI realtime WebSocket', err);
      teardown();
    }
  };

  const bindOpenAIHandlers = () => {
    if (!openAISocket) return;
    openAISocket.on('message', openAIHandlers.message);
    openAISocket.on('close', openAIHandlers.close);
    openAISocket.on('error', openAIHandlers.error);
  };

  const openAIInterval = setInterval(() => {
    if (openAISocket && openAISocket.readyState === WebSocket.OPEN) {
      clearInterval(openAIInterval);
    }
    if (openAISocket && openAISocket.readyState === WebSocket.CONNECTING) {
      return;
    }
    if (openAISocket && openAISocket.readyState === WebSocket.OPEN) {
      bindOpenAIHandlers();
    }
  }, 100);
});

process.on('SIGINT', () => {
  console.log('Shutting down server');
  server.close(() => process.exit(0));
});
