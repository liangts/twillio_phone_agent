const fs = require('fs');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const nodemailer = require('nodemailer');
const WebSocket = require('ws');

dotenv.config();

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-realtime';
const PUBLIC_URL = process.env.PUBLIC_URL;
const PROMPT_PATH = process.env.PROMPT_PATH || path.join(__dirname, '..', 'config', 'agent_prompt.md');
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
const EMAIL_FROM = process.env.EMAIL_FROM;
const EMAIL_TO = process.env.EMAIL_TO;

if (!OPENAI_API_KEY) {
  console.warn('Warning: OPENAI_API_KEY is not set. The bridge will not connect to OpenAI until it is configured.');
}

function normalizeBaseUrl(url) {
  if (!url) return null;
  return url.replace(/\/$/, '');
}

function httpToWs(url) {
  if (!url) return null;
  if (url.startsWith('ws://') || url.startsWith('wss://')) {
    return url;
  }
  if (url.startsWith('https://')) {
    return `wss://${url.slice('https://'.length)}`;
  }
  if (url.startsWith('http://')) {
    return `ws://${url.slice('http://'.length)}`;
  }
  return `wss://${url}`;
}

const PUBLIC_HTTP_BASE = normalizeBaseUrl(PUBLIC_URL);
const PUBLIC_WS_BASE = httpToWs(PUBLIC_HTTP_BASE);

if (!PUBLIC_HTTP_BASE) {
  console.warn('Warning: PUBLIC_URL is not set. Twilio will not be able to connect to your webhook or media stream without a publicly reachable URL.');
}

const RESPONSE_COMPLETION_EVENTS = new Set([
  'response.completed',
  'response.canceled',
  'response.failed',
  'response.error'
]);

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

app.get('/voice', (_req, res) => {
  res.type('text/plain').send('POST Twilio call webhooks to this endpoint to initiate a media stream.');
});

app.post('/voice', (req, res) => {
  const streamUrl = PUBLIC_WS_BASE ? `${PUBLIC_WS_BASE}/media` : null;
  if (!PUBLIC_HTTP_BASE || !streamUrl) {
    console.error('PUBLIC_URL is missing or invalid. Twilio cannot be pointed to the media WebSocket.');
  }

  // Twilio only needs to send the caller's audio to the bridge; outbound audio
  // is still accepted even when the stream is declared as inbound-only.
  const twiml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    '  <Connect>',
    `    <Stream url="${streamUrl || ''}" track="inbound_track"/>`,
    '  </Connect>',
    '</Response>'
  ].join('\n');

  res.type('text/xml').send(twiml);
});

const server = app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

const wss = new WebSocket.Server({ server, path: '/media' });

const activeCalls = new Map();

function createMulawWavBuffer(dataBuffers) {
  const data = Buffer.concat(dataBuffers);
  const header = Buffer.alloc(44);
  const dataSize = data.length;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM header size
  header.writeUInt16LE(7, 20); // mu-law format code
  header.writeUInt16LE(1, 22); // channels
  header.writeUInt32LE(8000, 24); // sample rate
  header.writeUInt32LE(8000, 28); // byte rate
  header.writeUInt16LE(1, 32); // block align
  header.writeUInt16LE(8, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, data]);
}

function createMailTransport() {
  if (!SMTP_HOST || !EMAIL_FROM || !EMAIL_TO) {
    console.warn('Email is not configured. Set SMTP_HOST, EMAIL_FROM, and EMAIL_TO to enable summaries.');
    return null;
  }

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: SMTP_SECURE,
    auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
  });
}

async function emailCallSummary(call) {
  const transport = createMailTransport();
  if (!transport) return;

  const callerTranscript = call.callerTranscript.join('').trim();
  const agentTranscript = call.agentTranscript.join('').trim();

  const attachments = [];
  if (call.callerAudio.length) {
    attachments.push({
      filename: `caller-${call.streamSid}.wav`,
      content: createMulawWavBuffer(call.callerAudio)
    });
  }
  if (call.agentAudio.length) {
    attachments.push({
      filename: `agent-${call.streamSid}.wav`,
      content: createMulawWavBuffer(call.agentAudio)
    });
  }

  const subject = `Call summary for ${call.streamSid}`;
  const text = [
    `From: ${call.from || 'unknown'}`,
    `To: ${call.to || 'unknown'}`,
    '',
    'Caller transcript:',
    callerTranscript || '(none)',
    '',
    'Agent transcript:',
    agentTranscript || '(none)'
  ].join('\n');

  try {
    await transport.sendMail({
      from: EMAIL_FROM,
      to: EMAIL_TO,
      subject,
      text,
      attachments
    });
    console.log(`Sent call summary email for ${call.streamSid}`);
  } catch (err) {
    console.error('Failed to send call summary email', err);
  }
}

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

function requestOpenAIResponse(openAISocket, call) {
  if (!openAISocket || openAISocket.readyState !== WebSocket.OPEN) return;
  if (!call || call.awaitingResponse) return;

  call.awaitingResponse = true;

  openAISocket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
  openAISocket.send(JSON.stringify({ type: 'response.create' }));
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

  const cleanupActiveCall = ({ summarize = false } = {}) => {
    if (!streamSid) return Promise.resolve();
    const call = activeCalls.get(streamSid);
    if (!call) return Promise.resolve();
    activeCalls.delete(streamSid);
    if (summarize) {
      return emailCallSummary(call);
    }
    return Promise.resolve();
  };

  function teardown() {
    if (openAISocket && openAISocket.readyState === WebSocket.OPEN) {
      openAISocket.close();
    }
    if (twilioSocket.readyState === WebSocket.OPEN) {
      twilioSocket.close();
    }
  }

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
        const call = activeCalls.get(streamSid);
        if (call) {
          call.agentAudio.push(Buffer.from(payload.delta, 'base64'));
        }
        relayAudioToTwilio(twilioSocket, streamSid, payload.delta);
      }

      if (payload.type?.includes('input_text')) {
        const call = activeCalls.get(streamSid);
        const delta = payload.delta || payload.text || payload.input_text;
        if (call && delta) {
          call.callerTranscript.push(delta);
        }
      }

      if (payload.type?.includes('output_text')) {
        const call = activeCalls.get(streamSid);
        const delta = payload.delta || payload.text || payload.output_text;
        if (call && delta) {
          call.agentTranscript.push(Array.isArray(delta) ? delta.join(' ') : delta);
        }
      }

      if (RESPONSE_COMPLETION_EVENTS.has(payload.type)) {
        const call = activeCalls.get(streamSid);
        if (call) {
          call.awaitingResponse = false;
        }
      }
    },
    close: () => {
      console.log('OpenAI realtime WebSocket closed');
      cleanupActiveCall().finally(() => {
        if (twilioSocket.readyState === WebSocket.OPEN) {
          twilioSocket.close();
        }
      });
    },
    error: (err) => {
      console.error('Error from OpenAI realtime WebSocket', err);
      cleanupActiveCall().finally(() => {
        teardown();
      });
    }
  };

  const bindOpenAIHandlers = (socket) => {
    if (!socket) return;
    socket.on('message', openAIHandlers.message);
    socket.on('close', openAIHandlers.close);
    socket.on('error', openAIHandlers.error);
  };

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
      activeCalls.set(streamSid, {
        streamSid,
        from: event.start?.from,
        to: event.start?.to,
        callerAudio: [],
        agentAudio: [],
        callerTranscript: [],
        agentTranscript: [],
        awaitingResponse: false
      });
      openAISocket = createOpenAIClient(streamSid, {
        from: event.start?.from,
        to: event.start?.to
      });
      bindOpenAIHandlers(openAISocket);
      return;
    }

    if (event.event === 'media' && event.media?.payload) {
      const call = activeCalls.get(streamSid);
      if (call) {
        call.callerAudio.push(Buffer.from(event.media.payload, 'base64'));
      }
      relayAudioToOpenAI(openAISocket, event.media.payload);
      if (call) {
        requestOpenAIResponse(openAISocket, call);
      }
      return;
    }

    if (event.event === 'stop') {
      console.log('Twilio stream stopped');
      cleanupActiveCall({ summarize: true })
        .catch((err) => console.error('Failed to process call summary', err))
        .finally(() => {
          teardown();
        });
      }
  });

  twilioSocket.on('close', () => {
    console.log('Twilio media WebSocket closed');
    cleanupActiveCall().finally(() => {
      if (openAISocket && openAISocket.readyState === WebSocket.OPEN) {
        openAISocket.close();
      }
    });
  });

  twilioSocket.on('error', (err) => {
    console.error('Error from Twilio media WebSocket', err);
    cleanupActiveCall().finally(() => {
      teardown();
    });
  });

});

process.on('SIGINT', () => {
  console.log('Shutting down server');
  server.close(() => process.exit(0));
});
