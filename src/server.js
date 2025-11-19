const fs = require('fs');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const WebSocket = require('ws');
const OpenAI = require('openai');
const Twilio = require('twilio');

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_WEBHOOK_SECRET = process.env.OPENAI_WEBHOOK_SECRET;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-realtime';
const OPENAI_VOICE = process.env.OPENAI_VOICE || 'alloy';
const PROMPT_PATH = process.env.PROMPT_PATH || path.join(__dirname, '..', 'config', 'agent_prompt.md');
const WELCOME_MESSAGE = process.env.WELCOME_MESSAGE || 'Thanks for calling. How can I help you today?';
const WS_CONNECT_DELAY_MS = Number(process.env.WS_CONNECT_DELAY_MS || 250);
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const HUMAN_AGENT_NUMBER = process.env.HUMAN_AGENT_NUMBER;
const TWILIO_HUMAN_LABEL = process.env.TWILIO_HUMAN_LABEL || 'human agent';

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY. Cannot accept calls without an API key.');
  process.exit(1);
}

if (!OPENAI_WEBHOOK_SECRET) {
  console.error('Missing OPENAI_WEBHOOK_SECRET. Set it to the secret configured in the OpenAI SIP Connector webhook.');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const app = express();

const activeCalls = new Map();
const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

const toolHandlers = new Map();

if (twilioClient && HUMAN_AGENT_NUMBER) {
  toolHandlers.set('transfer_to_human', {
    description: 'Invite a live human agent into the current call via Twilio Programmable SIP.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Optional context for why the caller is being transferred.'
        }
      }
    },
    handler: async (call, args = {}) => {
      const conferenceName = call.conferenceName || args.conferenceName;
      const callToken = call.callToken || args.callToken;
      const callerNumber = call.from || args.from;

      if (!conferenceName || !callToken || !callerNumber) {
        const missing = [];
        if (!conferenceName) missing.push('conferenceName');
        if (!callToken) missing.push('callToken');
        if (!callerNumber) missing.push('callerNumber');
        console.error(
          `transfer_to_human requested but missing metadata: ${missing.join(', ')}`
        );
        return {
          status: 'error',
          message: 'I tried to add a teammate but could not find the call metadata.'
        };
      }

      try {
        await twilioClient
          .conferences(conferenceName)
          .participants.create({
            from: callerNumber,
            label: TWILIO_HUMAN_LABEL,
            to: HUMAN_AGENT_NUMBER,
            earlyMedia: false,
            callToken
          });
        console.log(`Invited human agent into conference ${conferenceName}`);
        return {
          status: 'ok',
          message:
            args?.confirmationMessage ||
            'Bringing a teammate into the call now. Thanks for waiting!'
        };
      } catch (err) {
        console.error('Failed to add human agent via Twilio', err);
        return {
          status: 'error',
          message: 'I could not reach a human agent right now.'
        };
      }
    }
  });
} else {
  console.log(
    'Twilio warm transfer is disabled (missing TWILIO credentials or HUMAN_AGENT_NUMBER).'
  );
}

function getToolDefinitions() {
  if (!toolHandlers.size) {
    return undefined;
  }

  return Array.from(toolHandlers.entries()).map(([name, descriptor]) => ({
    type: 'function',
    name,
    description: descriptor.description,
    parameters: descriptor.parameters || { type: 'object', properties: {} }
  }));
}

function loadPrompt() {
  try {
    return fs.readFileSync(PROMPT_PATH, 'utf8');
  } catch (err) {
    console.warn(`Prompt file not found at ${PROMPT_PATH}. Using default instructions.`);
    return 'You are a helpful realtime phone agent.';
  }
}

function buildCallAcceptPayload(callEvent) {
  const instructions = loadPrompt();
  const from = callEvent?.data?.from?.number || callEvent?.data?.from || 'unknown';
  const to = callEvent?.data?.to?.number || callEvent?.data?.to || 'unknown';
  const tools = getToolDefinitions();

  return {
    type: 'realtime',
    model: OPENAI_MODEL,
    instructions,
    audio: {
      output: {
        voice: OPENAI_VOICE
      }
    },
    ...(tools ? { tools } : {})
  };
}

function resolveWsUrl(callEvent, callId) {
  return (
    callEvent?.data?.wss_url ||
    callEvent?.data?.sip_wss_url ||
    callEvent?.data?.websocket_url ||
    `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`
  );
}

function createCallState(callId, callEvent) {
  const from = callEvent?.data?.from?.number || callEvent?.data?.from || 'unknown';
  const to = callEvent?.data?.to?.number || callEvent?.data?.to || 'unknown';
  const callToken =
    callEvent?.data?.call_token ||
    callEvent?.data?.twilio?.call_token ||
    callEvent?.data?.metadata?.call_token ||
    null;
  const conferenceName = extractConferenceName(callEvent);

  return {
    callId,
    from,
    to,
    callToken,
    conferenceName,
    ws: null,
    transcripts: {
      caller: [],
      agent: []
    },
    createdAt: Date.now(),
    pendingToolCalls: new Map()
  };
}

function extractConferenceName(callEvent) {
  const sipHeaders = callEvent?.data?.sip_headers;
  if (Array.isArray(sipHeaders)) {
    const header = sipHeaders.find((h) => {
      const name = (h.name || '').toLowerCase();
      return name === 'x-conferencename' || name === 'x-conference-name';
    });
    if (header?.value) {
      return header.value;
    }
  }
  return callEvent?.data?.metadata?.conference || null;
}

function closeActiveCall(callId, reason = 'unknown') {
  const call = activeCalls.get(callId);
  if (!call) return;
  if (call.ws && call.ws.readyState === WebSocket.OPEN) {
    call.ws.close();
  }
  activeCalls.delete(callId);
  console.log(`Cleaned up call ${callId} (${reason})`);
}

function sendSystemResponse(call, instructions) {
  if (!instructions || !call.ws || call.ws.readyState !== WebSocket.OPEN) return;
  call.ws.send(
    JSON.stringify({
      type: 'response.create',
      response: {
        instructions
      }
    })
  );
}

function handleToolCallDelta(call, delta) {
  if (!toolHandlers.size) return;
  if (!delta) return;
  const toolCallId = delta.tool_call_id || delta.id;
  if (!toolCallId) return;

  const entry =
    call.pendingToolCalls.get(toolCallId) || {
      id: toolCallId,
      name: delta.name,
      arguments: ''
    };

  if (delta.name) {
    entry.name = delta.name;
  }

  if (typeof delta.arguments === 'string') {
    entry.arguments = (entry.arguments || '') + delta.arguments;
  } else if (delta.arguments && typeof delta.arguments === 'object') {
    entry.arguments = JSON.stringify(delta.arguments);
  }

  if (typeof delta.completed === 'boolean') {
    entry.completed = delta.completed;
  }

  call.pendingToolCalls.set(toolCallId, entry);

  const done =
    delta.status === 'completed' ||
    delta.completed === true ||
    delta.is_final === true ||
    delta.done === true;

  if (done) {
    finalizeToolCall(call, toolCallId);
  }
}

function handleToolCallDone(call, payload) {
  if (!toolHandlers.size) return;
  const toolCallId = payload?.tool_call_id || payload?.id;
  if (!toolCallId) return;
  finalizeToolCall(call, toolCallId);
}

function finalizeToolCall(call, toolCallId) {
  const toolCall = call.pendingToolCalls.get(toolCallId);
  if (!toolCall) return;
  call.pendingToolCalls.delete(toolCallId);

  executeToolCall(call, toolCall).catch((err) => {
    console.error(`Tool ${toolCall.name} failed`, err);
    sendSystemResponse(call, 'I could not complete that action. Let me keep helping in the meantime.');
  });
}

async function executeToolCall(call, toolCall) {
  const handlerEntry = toolHandlers.get(toolCall.name);
  if (!handlerEntry) {
    console.warn(`No handler registered for tool ${toolCall.name}`);
    return;
  }

  let args = {};
  if (toolCall.arguments) {
    try {
      args = JSON.parse(toolCall.arguments);
    } catch (err) {
      console.warn('Failed to parse tool arguments, passing raw string.');
      args = { raw: toolCall.arguments };
    }
  }

  const result = await handlerEntry.handler(call, args);
  if (result?.message) {
    sendSystemResponse(call, result.message);
  }
}

function handleRealtimeMessage(call, raw) {
  let payload;
  try {
    payload = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch (err) {
    console.error('Failed to parse realtime event', err);
    return;
  }

  switch (payload.type) {
    case 'response.output_text.delta':
      if (payload.delta) {
        call.transcripts.agent.push(Array.isArray(payload.delta) ? payload.delta.join(' ') : payload.delta);
      }
      break;
    case 'response.output_audio.delta':
      // Nothing to relay back—OpenAI streams audio directly to the caller via SIP.
      break;
    default:
      if (payload.type?.includes('input_text')) {
        const delta = payload.delta || payload.text || payload.input_text;
        if (delta) {
          call.transcripts.caller.push(Array.isArray(delta) ? delta.join(' ') : delta);
        }
      }
      break;
  }

  if (payload.type === 'response.output_tool_call.delta') {
    handleToolCallDelta(call, payload.delta || payload);
  }

  if (payload.type === 'response.output_tool_call.done') {
    handleToolCallDone(call, payload);
  }

  if (payload.type === 'response.completed') {
    console.log(`Call ${call.callId}: response completed.`);
  }
}

function connectRealtimeSocket(call, wsUrl) {
  const url = wsUrl || `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(call.callId)}`;
  const delay = Math.max(0, WS_CONNECT_DELAY_MS);

  setTimeout(() => {
    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        Origin: 'https://api.openai.com'
      }
    });

    call.ws = ws;

    ws.on('open', () => {
      console.log(`Realtime socket open for call ${call.callId}`);
      if (WELCOME_MESSAGE) {
        const message = {
          type: 'response.create',
          response: {
            instructions: WELCOME_MESSAGE
          }
        };
        ws.send(JSON.stringify(message));
      }
    });

    ws.on('message', (data) => handleRealtimeMessage(call, data));

    ws.on('close', (code, reason) => {
      console.log(`Realtime socket closed for ${call.callId}`, code, reason?.toString?.());
      activeCalls.delete(call.callId);
    });

    ws.on('error', (err) => {
      console.error(`Realtime socket error for ${call.callId}`, err);
      closeActiveCall(call.callId, 'socket_error');
    });
  }, delay);
}

async function acceptIncomingCall(callEvent) {
  const callId = callEvent?.data?.call_id;
  if (!callId) {
    throw new Error('Incoming call event missing call_id');
  }

  const callState = createCallState(callId, callEvent);
  activeCalls.set(callId, callState);

  const acceptPayload = buildCallAcceptPayload(callEvent);
  const resp = await fetch(
    `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/accept`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(acceptPayload)
    }
  );

  if (!resp.ok) {
    activeCalls.delete(callId);
    const text = await resp.text().catch(() => '');
    throw new Error(`Failed to accept call ${callId}: ${resp.status} ${resp.statusText} ${text}`);
  }

  const wsUrl = resolveWsUrl(callEvent, callId);
  connectRealtimeSocket(callState, wsUrl);
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post(
  '/openai/webhook',
  express.raw({ type: '*/*' }),
  async (req, res) => {
    const rawBody = req.body;
    try {
      const event = await openai.webhooks.unwrap(
        rawBody.toString('utf8'),
        req.headers,
        OPENAI_WEBHOOK_SECRET
      );

      if (!event?.type) {
        return res.sendStatus(200);
      }

      switch (event.type) {
        case 'realtime.call.incoming':
          await acceptIncomingCall(event);
          res.set('Authorization', `Bearer ${OPENAI_API_KEY}`);
          return res.sendStatus(200);
        case 'realtime.call.ended':
        case 'realtime.call.disconnected':
          closeActiveCall(event?.data?.call_id || event?.data?.id || 'unknown', event.type);
          return res.sendStatus(200);
        default:
          console.log(`Received ${event.type}`);
          return res.sendStatus(200);
      }
    } catch (err) {
      const message = err?.message || '';
      if (
        err?.name === 'InvalidWebhookSignatureError' ||
        message.toLowerCase().includes('invalid signature')
      ) {
        return res.status(400).send('Invalid signature');
      }
      console.error('Error handling webhook', err);
      return res.status(500).send('Server error');
    }
  }
);

const server = app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

process.on('SIGINT', () => {
  console.log('Shutting down server');
  server.close(() => process.exit(0));
});
