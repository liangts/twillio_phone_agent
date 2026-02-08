const fs = require('fs');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const WebSocket = require('ws');
const OpenAI = require('openai');
const Twilio = require('twilio');
const fetch = require('node-fetch');

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
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const INPUT_TRANSCRIPTION_MODEL = process.env.INPUT_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe';
const INPUT_TRANSCRIPTION_LANGUAGE = process.env.INPUT_TRANSCRIPTION_LANGUAGE || '';
const CF_INGEST_BASE_URL = process.env.CF_INGEST_BASE_URL || '';
const CF_INGEST_TOKEN = process.env.CF_INGEST_TOKEN || '';
const CONTROL_API_TOKEN = process.env.CONTROL_API_TOKEN || '';
const INGEST_ENABLED = Boolean(CF_INGEST_BASE_URL && CF_INGEST_TOKEN);

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
const pendingAccepts = new Set();
const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

const toolHandlers = new Map();

function parseBearerToken(header = '') {
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function requireControlAuth(req, res, next) {
  if (!CONTROL_API_TOKEN) {
    return next();
  }
  const token = parseBearerToken(req.headers.authorization || '');
  if (!token || token !== CONTROL_API_TOKEN) {
    return res.status(401).json({
      ok: false,
      error: {
        code: 'unauthorized',
        message: 'Unauthorized'
      }
    });
  }
  return next();
}

function normalizeDialableNumber(value) {
  if (!value || typeof value !== 'string') return null;
  const match = value.match(/\+?\d{7,15}/);
  return match ? match[0] : null;
}

async function inviteHumanAgent(call, args = {}) {
  if (!twilioClient || !HUMAN_AGENT_NUMBER) {
    return {
      status: 'error',
      message: 'Twilio transfer is not configured on this server.'
    };
  }

  const conferenceName = call?.conferenceName || args.conferenceName;
  const callToken = call?.callToken || args.callToken;
  const callerNumber = normalizeDialableNumber(call?.from) || normalizeDialableNumber(args.from);

  if (!conferenceName || !callToken || !callerNumber) {
    const missing = [];
    if (!conferenceName) missing.push('conferenceName');
    if (!callToken) missing.push('callToken');
    if (!callerNumber) missing.push('callerNumber');
    console.error(`transfer_to_human requested but missing metadata: ${missing.join(', ')}`);
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

async function requestCallHangup(callId) {
  try {
    const response = await fetch(
      `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    const text = await response.text().catch(() => '');
    return { ok: response.ok, status: response.status, text };
  } catch (err) {
    return { ok: false, status: 0, text: err?.message || 'request failed' };
  }
}

if (!DISCORD_WEBHOOK_URL) {
  console.log('DISCORD_WEBHOOK_URL is not configured; Discord notifications are disabled.');
}

if (!INGEST_ENABLED) {
  console.log('Cloudflare ingest is disabled (missing CF_INGEST_BASE_URL or CF_INGEST_TOKEN).');
}

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
      return inviteHumanAgent(call, args);
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
  const transcription =
    INPUT_TRANSCRIPTION_MODEL
      ? {
          model: INPUT_TRANSCRIPTION_MODEL,
          ...(INPUT_TRANSCRIPTION_LANGUAGE ? { language: INPUT_TRANSCRIPTION_LANGUAGE } : {})
        }
      : null;

  const audioConfig = {
    output: {
      voice: OPENAI_VOICE
    }
  };

  if (transcription) {
    audioConfig.input = {
      transcription
    };
  }

  return {
    type: 'realtime',
    model: OPENAI_MODEL,
    instructions,
    output_modalities: ['audio'],
    audio: audioConfig,
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

function getSipHeaderValue(sipHeaders = [], headerName) {
  if (!Array.isArray(sipHeaders) || !headerName) return null;
  const target = headerName.toLowerCase();
  const header = sipHeaders.find((h) => (h?.name || '').toLowerCase() === target);
  return header?.value || null;
}

function getNumberFromHeader(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/\+?\d{7,15}/);
  return match ? match[0] : null;
}

function createCallState(callId, callEvent) {
  const sipHeaders = callEvent?.data?.sip_headers || [];
  const rawFromHeader = getSipHeaderValue(sipHeaders, 'from');
  const rawToHeader = getSipHeaderValue(sipHeaders, 'to');
  const rawDiversionHeader = getSipHeaderValue(sipHeaders, 'diversion');
  const rawHistoryInfoHeader = getSipHeaderValue(sipHeaders, 'history-info');

  const forwardedHeader = rawDiversionHeader || rawHistoryInfoHeader || null;
  const forwardedFromNumber = getNumberFromHeader(forwardedHeader);

  const from =
    callEvent?.data?.from?.number ||
    callEvent?.data?.from ||
    getNumberFromHeader(rawFromHeader) ||
    rawFromHeader ||
    'unknown';
  const to =
    callEvent?.data?.to?.number ||
    callEvent?.data?.to ||
    getNumberFromHeader(rawToHeader) ||
    rawToHeader ||
    'unknown';

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
    provider: callEvent?.data?.provider || (callEvent?.data?.twilio ? 'twilio' : null),
    ws: null,
    transcripts: {
      caller: [],
      agent: []
    },
    transcriptLog: [],
    currentCallerText: '',
    currentAgentText: '',
    transcriptSeq: 0,
    status: 'incoming',
    endedAt: null,
    createdAt: Date.now(),
    pendingToolCalls: new Map(),
    rawFromHeader,
    rawToHeader,
    rawDiversionHeader,
    rawHistoryInfoHeader,
    forwardedFrom: forwardedFromNumber || forwardedHeader || null
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
  markCallEnded(call, reason);
  if (call.ws && call.ws.readyState === WebSocket.OPEN) {
    call.ws.close();
  }
  activeCalls.delete(callId);
  console.log(`Cleaned up call ${callId} (${reason})`);
}

function normalizeSpeaker(speaker) {
  if (!speaker) return 'system';
  const lower = speaker.toLowerCase();
  if (lower.includes('caller')) return 'caller';
  if (lower.includes('agent')) return 'agent';
  return lower;
}

function buildIngestUrl(pathname) {
  const base = CF_INGEST_BASE_URL.replace(/\/+$/, '');
  return `${base}${pathname}`;
}

async function sendIngestRequest(pathname, payload) {
  if (!INGEST_ENABLED) return;
  try {
    const response = await fetch(buildIngestUrl(pathname), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CF_INGEST_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.warn(`Ingest ${pathname} failed`, response.status, text);
    }
  } catch (err) {
    console.warn(`Ingest ${pathname} request failed`, err?.message || err);
  }
}

function buildCallPayload(call, overrides = {}) {
  const ts = overrides.ts || Math.floor(Date.now() / 1000);
  const baseMeta = {
    forwarded_from: call.forwardedFrom || null,
    sip_headers: {
      from: call.rawFromHeader || null,
      to: call.rawToHeader || null,
      diversion: call.rawDiversionHeader || null,
      history_info: call.rawHistoryInfoHeader || null
    }
  };
  const { meta: overrideMeta, ...restOverrides } = overrides;
  return {
    call_id: call.callId,
    status: call.status,
    ts,
    from_uri: call.from,
    to_uri: call.to,
    provider: call.provider,
    conference_name: call.conferenceName,
    call_token: call.callToken,
    meta: { ...baseMeta, ...(overrideMeta || {}) },
    ...restOverrides
  };
}

async function sendIngestCall(call, event, overrides = {}) {
  if (!INGEST_ENABLED || !call) return;
  const payload = buildCallPayload(call, { event, ...overrides });
  await sendIngestRequest('/ingest/call', payload);
}

async function sendIngestTranscript(call, speaker, text) {
  if (!INGEST_ENABLED || !call) return;
  const normalized = normalizeTextFragment(text).trim();
  if (!normalized) return;
  call.transcriptSeq += 1;
  const payload = {
    call_id: call.callId,
    seq: call.transcriptSeq,
    ts: Date.now(),
    speaker: normalizeSpeaker(speaker),
    text: normalized
  };
  await sendIngestRequest('/ingest/transcript', payload);
}

function markCallEnded(call, reason) {
  if (!call || call.endedAt) return;
  call.endedAt = Date.now();
  call.status = 'ended';
  sendIngestCall(call, 'end', {
    status: 'ended',
    ts: Math.floor(call.endedAt / 1000),
    meta: { ...(call.meta || {}), reason }
  }).catch(() => {});
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

function normalizeTextFragment(fragment) {
  if (!fragment) return '';
  if (typeof fragment === 'string') return fragment;
  if (Array.isArray(fragment)) {
    return fragment.map((part) => normalizeTextFragment(part)).filter(Boolean).join(' ');
  }
  if (typeof fragment === 'object') {
    if (Array.isArray(fragment.text)) {
      return fragment.text.map((part) => normalizeTextFragment(part)).filter(Boolean).join(' ');
    }
    if (typeof fragment.text === 'string') {
      return fragment.text;
    }
    if (typeof fragment.value === 'string') {
      return fragment.value;
    }
  }
  return '';
}

function appendTranscriptBuffer(buffer, fragment) {
  const text = normalizeTextFragment(fragment);
  if (!text) return buffer || '';
  return `${buffer || ''}${text}`;
}

function recordTranscriptLine(call, speaker, text) {
  const normalized = normalizeTextFragment(text);
  if (!normalized) return;
  const trimmed = normalized.trim();
  if (!trimmed) return;

  if (speaker === 'Caller') {
    call.transcripts.caller.push(trimmed);
  } else {
    call.transcripts.agent.push(trimmed);
  }

  if (Array.isArray(call.transcriptLog)) {
    call.transcriptLog.push({ speaker, text: trimmed, at: Date.now() });
  }

  const line = `${speaker}: ${trimmed}`;
  sendDiscordMessage(line);
  sendIngestTranscript(call, speaker, trimmed).catch(() => {});
}

function announceIncomingCall(call) {
  if (!call) return;
  const lines = [`Call ${call.callId} accepted.`];

  if (call.conferenceName) {
    lines.push(`Conference: ${call.conferenceName}`);
  }

  if (call.rawFromHeader || call.from) {
    lines.push(`From header: ${call.rawFromHeader || call.from}`);
  }

  if (call.rawDiversionHeader || call.rawHistoryInfoHeader) {
    lines.push(
      `Diversion header: ${call.rawDiversionHeader || call.rawHistoryInfoHeader}`
    );
  }

  if (call.forwardedFrom && (call.rawDiversionHeader || call.rawHistoryInfoHeader)) {
    lines.push(`Forwarded from number: ${call.forwardedFrom}`);
  }

  sendDiscordMessage(lines.join('\n'));
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

function processCallerTranscriptEvent(call, payload) {
  const type = payload?.type;
  if (!type) return false;

  if (type === 'conversation.item.input_audio_transcription.delta') {
    call.currentCallerText = appendTranscriptBuffer(call.currentCallerText, payload.delta || payload.text);
    return true;
  }

  if (type === 'conversation.item.input_audio_transcription.completed') {
    const transcript = payload.transcript || call.currentCallerText;
    recordTranscriptLine(call, 'Caller', transcript);
    call.currentCallerText = '';
    return true;
  }

  if (type === 'conversation.item.input_text.delta' || (type.includes('input_text') && type.endsWith('.delta'))) {
    call.currentCallerText = appendTranscriptBuffer(
      call.currentCallerText,
      payload.delta || payload.text || payload.input_text
    );
    return true;
  }

  if (
    type === 'conversation.item.input_text.completed' ||
    type === 'conversation.item.input_text.done' ||
    (type.includes('input_text') && (type.endsWith('.completed') || type.endsWith('.done')))
  ) {
    const transcript = payload.text || payload.input_text || call.currentCallerText;
    recordTranscriptLine(call, 'Caller', transcript);
    call.currentCallerText = '';
    return true;
  }

  return false;
}

function processAgentTranscriptEvent(call, payload) {
  const type = payload?.type;
  if (!type) return false;

  if (type === 'response.output_audio_transcript.delta') {
    call.currentAgentText = appendTranscriptBuffer(call.currentAgentText, payload.delta || payload.text);
    return true;
  }

  if (type === 'response.output_audio_transcript.done') {
    const transcript = payload.transcript || call.currentAgentText;
    recordTranscriptLine(call, 'Agent', transcript);
    call.currentAgentText = '';
    return true;
  }

  if (type === 'response.output_text.delta' || (type.includes('output_text') && type.endsWith('.delta'))) {
    const fragment = payload.delta || payload.text || payload.output_text;
    call.currentAgentText = appendTranscriptBuffer(call.currentAgentText, fragment);
    return true;
  }

  if (
    type === 'response.output_text.done' ||
    type === 'response.output_text.completed' ||
    (type.includes('output_text') && (type.endsWith('.done') || type.endsWith('.completed')))
  ) {
    const fragment = payload.output_text || payload.text || call.currentAgentText;
    recordTranscriptLine(call, 'Agent', fragment);
    call.currentAgentText = '';
    return true;
  }

  return false;
}

function handleRealtimeMessage(call, raw) {
  let payload;
  try {
    payload = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch (err) {
    console.error('Failed to parse realtime event', err);
    return;
  }

  if (processCallerTranscriptEvent(call, payload)) {
    return;
  }

  if (processAgentTranscriptEvent(call, payload)) {
    return;
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
      call.status = 'live';
      sendIngestCall(call, 'status', { status: 'live' }).catch(() => {});
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
      markCallEnded(call, 'ws_close');
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

  if (activeCalls.has(callId) || pendingAccepts.has(callId)) {
    console.log(`Skipping duplicate incoming event for call ${callId}`);
    return;
  }
  pendingAccepts.add(callId);

  try {
    const callState = createCallState(callId, callEvent);
    activeCalls.set(callId, callState);
    await sendIngestCall(callState, 'start', { status: 'incoming' });

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
      callState.status = 'failed';
      await sendIngestCall(callState, 'status', { status: 'failed' });
      activeCalls.delete(callId);
      const text = await resp.text().catch(() => '');
      throw new Error(`Failed to accept call ${callId}: ${resp.status} ${resp.statusText} ${text}`);
    }

    announceIncomingCall(callState);

    const wsUrl = resolveWsUrl(callEvent, callId);
    connectRealtimeSocket(callState, wsUrl);
  } finally {
    pendingAccepts.delete(callId);
  }
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const controlJsonParser = express.json({ type: 'application/json' });

app.post(
  '/control/calls/:callId/transfer',
  controlJsonParser,
  requireControlAuth,
  async (req, res) => {
    const callId = req.params.callId;
    const call = activeCalls.get(callId);
    if (!call) {
      return res.status(404).json({
        ok: false,
        error: {
          code: 'call_not_found',
          message: `Call ${callId} is not active on this server.`
        }
      });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = await inviteHumanAgent(call, body);
    if (result.status !== 'ok') {
      return res.status(400).json({
        ok: false,
        call_id: callId,
        ...result
      });
    }

    if (!body.silent) {
      sendSystemResponse(call, body.confirmationMessage || result.message);
    }

    return res.json({
      ok: true,
      call_id: callId,
      ...result
    });
  }
);

app.post(
  '/control/calls/:callId/hangup',
  controlJsonParser,
  requireControlAuth,
  async (req, res) => {
    const callId = req.params.callId;
    const call = activeCalls.get(callId);
    if (!call) {
      return res.status(404).json({
        ok: false,
        error: {
          code: 'call_not_found',
          message: `Call ${callId} is not active on this server.`
        }
      });
    }

    const hangupResult = await requestCallHangup(callId);
    if (!hangupResult.ok) {
      console.warn(
        `OpenAI hangup request returned ${hangupResult.status} for ${callId}: ${hangupResult.text}`
      );
    }

    closeActiveCall(callId, 'operator_hangup');
    return res.json({
      ok: true,
      call_id: callId,
      remote_hangup_ok: hangupResult.ok,
      remote_status: hangupResult.status
    });
  }
);

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
async function sendDiscordMessage(content, webhookUrl = DISCORD_WEBHOOK_URL) {
  if (!webhookUrl) {
    console.warn('Discord webhook URL is not configured. Skipping message.', content?.slice?.(0, 80));
    return;
  }

  if (!content) return;
  const chunks = chunkString(content, 1900);
  for (let i = 0; i < chunks.length; i++) {
    const suffix = chunks.length > 1 ? ` (part ${i + 1}/${chunks.length})` : '';
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `${chunks[i]}${suffix}`
        })
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        console.error('Failed to post Discord message', response.status, text);
      }
    } catch (err) {
      console.error('Discord webhook request failed', err);
    }
  }
}

function chunkString(str, length) {
  if (!str) return [];
  const result = [];
  for (let i = 0; i < str.length; i += length) {
    result.push(str.slice(i, i + length));
  }
  return result;
}
