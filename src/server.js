const fs = require('fs');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const WebSocket = require('ws');
const OpenAI = require('openai');
const Twilio = require('twilio');
const fetch = require('node-fetch');

dotenv.config();

function parseBooleanEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }

  const normalized = String(raw).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return fallback;
}

function parseNumberEnv(name, fallback, options = {}) {
  const { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY, clamp = false } = options;
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  let value = parsed;
  if (value < min) {
    value = clamp ? min : fallback;
  }
  if (value > max) {
    value = clamp ? max : fallback;
  }
  return value;
}

function parseIntegerEnv(name, fallback, options = {}) {
  const parsed = parseNumberEnv(name, fallback, options);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

function parseNoiseReductionType(value, fallback = 'near_field') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (normalized === 'near_field' || normalized === 'far_field') {
    return normalized;
  }
  return fallback;
}

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
const TWILIO_OUTBOUND_FROM = process.env.TWILIO_OUTBOUND_FROM || '';
const OPENAI_SIP_URI = process.env.OPENAI_SIP_URI || '';
const TWILIO_OUTBOUND_STATUS_CALLBACK_URL = process.env.TWILIO_OUTBOUND_STATUS_CALLBACK_URL || '';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const INPUT_TRANSCRIPTION_MODEL = process.env.INPUT_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe';
const INPUT_TRANSCRIPTION_LANGUAGE = process.env.INPUT_TRANSCRIPTION_LANGUAGE || '';
const OPENAI_INPUT_NOISE_REDUCTION = parseNoiseReductionType(
  process.env.OPENAI_INPUT_NOISE_REDUCTION,
  'near_field'
);
const OPENAI_TURN_DETECTION_THRESHOLD = parseNumberEnv(
  'OPENAI_TURN_DETECTION_THRESHOLD',
  0.7,
  { min: 0, max: 1, clamp: true }
);
const OPENAI_TURN_DETECTION_PREFIX_PADDING_MS = parseIntegerEnv(
  'OPENAI_TURN_DETECTION_PREFIX_PADDING_MS',
  300,
  { min: 0 }
);
const OPENAI_TURN_DETECTION_SILENCE_DURATION_MS = parseIntegerEnv(
  'OPENAI_TURN_DETECTION_SILENCE_DURATION_MS',
  700,
  { min: 0 }
);
const OPENAI_TURN_DETECTION_INTERRUPT_RESPONSE = parseBooleanEnv(
  'OPENAI_TURN_DETECTION_INTERRUPT_RESPONSE',
  true
);
const OPENAI_TURN_DETECTION_CREATE_RESPONSE = parseBooleanEnv(
  'OPENAI_TURN_DETECTION_CREATE_RESPONSE',
  true
);
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

function normalizeE164(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\+[1-9]\d{7,14}$/.test(trimmed) ? trimmed : null;
}

function escapeXml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSipUriWithLaunchId(baseUri, launchId) {
  if (!baseUri || !launchId) return null;
  const separator = baseUri.includes('?') ? '&' : '?';
  return `${baseUri}${separator}X-Launch-Id=${encodeURIComponent(launchId)}`;
}

function buildOutboundTwiml(sipUri) {
  return `<Response><Dial answerOnBridge=\"true\"><Sip>${escapeXml(sipUri)}</Sip></Dial></Response>`;
}

function normalizeReferTargetUri(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^(tel:|sip:)/i.test(trimmed)) return trimmed;
  const normalized = normalizeDialableNumber(trimmed);
  if (!normalized) return null;
  return `tel:${normalized.startsWith('+') ? normalized : `+${normalized}`}`;
}

function getTransferTargetUri(args = {}) {
  const candidates = [
    args.target_uri,
    args.targetUri,
    args.to,
    args.number,
    HUMAN_AGENT_NUMBER
  ];
  for (const candidate of candidates) {
    const normalized = normalizeReferTargetUri(candidate);
    if (normalized) return normalized;
  }
  return null;
}

async function inviteHumanAgentViaTwilio(call, args = {}) {
  if (!twilioClient || !HUMAN_AGENT_NUMBER) {
    return null;
  }
  const conferenceName = call?.conferenceName || args.conferenceName;
  const callToken = call?.callToken || args.callToken;
  const callerNumber = normalizeDialableNumber(call?.from) || normalizeDialableNumber(args.from);

  if (conferenceName && callToken && callerNumber) {
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
      console.log(`Invited human agent into conference ${conferenceName} via Twilio`);
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
  return null;
}

async function inviteHumanAgentViaRefer(call, args = {}) {
  const targetUri = getTransferTargetUri(args);
  if (!targetUri) {
    return {
      status: 'error',
      message: 'Transfer target is not configured. Set HUMAN_AGENT_NUMBER in E.164 format.'
    };
  }
  try {
    const response = await fetch(
      `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(call.callId)}/refer`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          target_uri: targetUri
        })
      }
    );
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error(
        `Failed to refer call ${call.callId} to ${targetUri}`,
        response.status,
        text
      );
      return {
        status: 'error',
        message: 'I could not transfer this call right now.'
      };
    }
    console.log(`Referred call ${call.callId} to ${targetUri}`);
    return {
      status: 'ok',
      message:
        args?.confirmationMessage ||
        'Let me connect you to a teammate now.'
    };
  } catch (err) {
    console.error(`Failed to refer call ${call.callId}`, err);
    return {
      status: 'error',
      message: 'I could not transfer this call right now.'
    };
  }
}

async function inviteHumanAgent(call, args = {}) {
  const requestedMode = (args?.transfer_mode || args?.mode || '').toLowerCase();
  if (requestedMode === 'twilio') {
    const twilioResult = await inviteHumanAgentViaTwilio(call, args);
    if (twilioResult) return twilioResult;
    return {
      status: 'error',
      message: 'Twilio conference transfer metadata is unavailable for this call.'
    };
  }

  const referResult = await inviteHumanAgentViaRefer(call, args);
  if (referResult.status === 'ok') return referResult;

  const twilioFallback = await inviteHumanAgentViaTwilio(call, args);
  if (twilioFallback) return twilioFallback;

  return referResult;
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

function mapTwilioCallStatusToOutboundEvent(status = '') {
  const lower = String(status || '').toLowerCase();
  if (lower === 'initiated' || lower === 'queued') return 'launch.queued';
  if (lower === 'ringing') return 'launch.ringing';
  if (lower === 'in-progress') return 'launch.answered';
  if (lower === 'completed') return 'launch.completed';
  if (lower === 'busy' || lower === 'failed' || lower === 'no-answer' || lower === 'canceled') {
    return 'launch.failed';
  }
  return null;
}

if (!DISCORD_WEBHOOK_URL) {
  console.log('DISCORD_WEBHOOK_URL is not configured; Discord notifications are disabled.');
}

if (!INGEST_ENABLED) {
  console.log('Cloudflare ingest is disabled (missing CF_INGEST_BASE_URL or CF_INGEST_TOKEN).');
}

if (!TWILIO_OUTBOUND_FROM || !OPENAI_SIP_URI || !TWILIO_OUTBOUND_STATUS_CALLBACK_URL) {
  console.log(
    'Outbound launch is partially configured. Set TWILIO_OUTBOUND_FROM, OPENAI_SIP_URI, and TWILIO_OUTBOUND_STATUS_CALLBACK_URL to enable call launch.'
  );
}

if (HUMAN_AGENT_NUMBER) {
  toolHandlers.set('transfer_to_human', {
    description:
      'Transfer the active call to a human using SIP REFER (or Twilio conference fallback when available).',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Optional context for why the caller is being transferred.'
        },
        target_uri: {
          type: 'string',
          description: 'Optional SIP or TEL URI, for example tel:+14155550123.'
        }
      }
    },
    handler: async (call, args = {}) => {
      return inviteHumanAgent(call, args);
    }
  });
} else {
  console.log(
    'Human transfer is disabled (missing HUMAN_AGENT_NUMBER).'
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

function buildRealtimeAudioInputConfig(transcription = null) {
  const inputConfig = {
    noise_reduction: {
      type: OPENAI_INPUT_NOISE_REDUCTION
    },
    turn_detection: {
      type: 'server_vad',
      threshold: OPENAI_TURN_DETECTION_THRESHOLD,
      prefix_padding_ms: OPENAI_TURN_DETECTION_PREFIX_PADDING_MS,
      silence_duration_ms: OPENAI_TURN_DETECTION_SILENCE_DURATION_MS,
      create_response: OPENAI_TURN_DETECTION_CREATE_RESPONSE,
      interrupt_response: OPENAI_TURN_DETECTION_INTERRUPT_RESPONSE
    }
  };

  if (transcription) {
    inputConfig.transcription = transcription;
  }

  return inputConfig;
}

function formatRealtimeAudioProfile() {
  return [
    `noise_reduction=${OPENAI_INPUT_NOISE_REDUCTION}`,
    `threshold=${OPENAI_TURN_DETECTION_THRESHOLD}`,
    `prefix_padding_ms=${OPENAI_TURN_DETECTION_PREFIX_PADDING_MS}`,
    `silence_duration_ms=${OPENAI_TURN_DETECTION_SILENCE_DURATION_MS}`,
    `interrupt_response=${OPENAI_TURN_DETECTION_INTERRUPT_RESPONSE}`,
    `create_response=${OPENAI_TURN_DETECTION_CREATE_RESPONSE}`
  ].join(', ');
}

function normalizeInstructionText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function renderLaunchScript(template, variables = {}) {
  const source = normalizeInstructionText(template);
  if (!source) return '';
  const rendered = source.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_match, key) => {
    const value = variables[String(key).toLowerCase()];
    if (value === undefined || value === null) return '';
    return String(value);
  });
  return rendered.replace(/\s+/g, ' ').trim();
}

function buildOutboundInstructions(launchContext = {}) {
  const instructionParts = [];
  const templateInstructions = normalizeInstructionText(launchContext.instruction_block);
  const openingScript = normalizeInstructionText(launchContext.opening_script);
  const calleeName = normalizeInstructionText(launchContext.callee_name);
  const targetNumber = normalizeInstructionText(launchContext.target_e164);
  const objectiveNote = normalizeInstructionText(launchContext.objective_note);

  if (templateInstructions) {
    instructionParts.push(templateInstructions);
  } else {
    instructionParts.push(
      'You are an outbound AI phone agent. Start naturally and continue to the first objective step in the same turn.'
    );
  }

  if (openingScript) {
    instructionParts.push(`Opening Script Template:\n${openingScript}`);
  }
  if (calleeName) {
    instructionParts.push(`Callee Name:\n${calleeName}`);
  }
  if (targetNumber) {
    instructionParts.push(`Target Number:\n${targetNumber}`);
  }
  if (objectiveNote) {
    instructionParts.push(`Objective:\n${objectiveNote}`);
  }

  return instructionParts.filter(Boolean).join('\n\n');
}

function buildOutboundKickoffInstructions(call) {
  if (!call?.launchId) return null;
  const launchContext = call.launchContext || {};
  const calleeName = normalizeInstructionText(launchContext.callee_name);
  const objectiveNote = normalizeInstructionText(launchContext.objective_note);
  const targetNumber = normalizeInstructionText(launchContext.target_e164 || call.to);
  const openingLine = renderLaunchScript(launchContext.opening_script, {
    callee_name: calleeName,
    objective_note: objectiveNote,
    target_e164: targetNumber
  });

  const lines = ['Start speaking now.'];
  if (openingLine) {
    lines.push(`Say this opening line first: "${openingLine}".`);
  } else if (calleeName) {
    lines.push(`Start by confirming identity naturally, for example: "Hi, is this ${calleeName}?"`);
  } else {
    lines.push('Start with a concise greeting.');
  }
  lines.push('Immediately after the greeting or identity check, say that you are calling on the user\'s behalf.');
  lines.push('In the same response, continue into the first objective question or next required step.');
  lines.push('Do not stop after only a greeting unless identity confirmation is explicitly required.');
  lines.push('When you describe the objective to the callee, phrase it from your side on the user\'s behalf.');
  lines.push('Do not describe the objective as if it came from the callee.');
  lines.push('For example, do not say "you want to reserve" to the callee. Say "I would like to reserve on Liang Tianshu\'s behalf" or equivalent wording that matches the template and language.');
  if (objectiveNote) {
    lines.push(`Objective context: ${objectiveNote}`);
  }
  return lines.join('\n');
}

function buildCallAcceptPayload(callEvent, options = {}) {
  const launchContext = options.launchContext || null;
  const isOutbound = Boolean(launchContext?.launch_id || launchContext?.template_id);
  const instructions = isOutbound ? buildOutboundInstructions(launchContext) : loadPrompt();
  const tools = getToolDefinitions();
  const transcription =
    INPUT_TRANSCRIPTION_MODEL
      ? {
          model: INPUT_TRANSCRIPTION_MODEL,
          ...(INPUT_TRANSCRIPTION_LANGUAGE ? { language: INPUT_TRANSCRIPTION_LANGUAGE } : {})
        }
      : null;

  const audioConfig = {
    input: buildRealtimeAudioInputConfig(transcription),
    output: {
      voice: launchContext?.voice_override || OPENAI_VOICE
    }
  };

  return {
    type: 'realtime',
    model: launchContext?.model_override || OPENAI_MODEL,
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

function extractLaunchIdFromCallEvent(callEvent) {
  const sipHeaders = callEvent?.data?.sip_headers || [];
  const launchHeader = getSipHeaderValue(sipHeaders, 'x-launch-id');
  return (
    launchHeader ||
    callEvent?.data?.metadata?.launch_id ||
    callEvent?.data?.launch_id ||
    null
  );
}

function createCallState(callId, callEvent, launchContext = null) {
  const sipHeaders = callEvent?.data?.sip_headers || [];
  const rawFromHeader = getSipHeaderValue(sipHeaders, 'from');
  const rawToHeader = getSipHeaderValue(sipHeaders, 'to');
  const rawDiversionHeader = getSipHeaderValue(sipHeaders, 'diversion');
  const rawHistoryInfoHeader = getSipHeaderValue(sipHeaders, 'history-info');
  const rawLaunchIdHeader = getSipHeaderValue(sipHeaders, 'x-launch-id');

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
  const launchId = launchContext?.launch_id || rawLaunchIdHeader || callEvent?.data?.launch_id || null;
  const templateId = launchContext?.template_id || null;
  const calleeName = launchContext?.callee_name || null;
  const direction = launchId ? 'outbound' : 'inbound';

  return {
    callId,
    from,
    to,
    callToken,
    conferenceName,
    provider: callEvent?.data?.provider || (callEvent?.data?.twilio ? 'twilio' : null),
    launchId,
    templateId,
    calleeName,
    direction,
    launchContext,
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
    rawLaunchIdHeader,
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

async function sendIngestOutbound(event, payload = {}) {
  if (!INGEST_ENABLED) return;
  await sendIngestRequest('/ingest/outbound', {
    event,
    ts: Math.floor(Date.now() / 1000),
    ...payload
  });
}

async function fetchOutboundLaunchContext(launchId) {
  if (!launchId || !INGEST_ENABLED) return null;
  try {
    const response = await fetch(
      buildIngestUrl(`/internal/outbound/launches/${encodeURIComponent(launchId)}/context`),
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${CF_INGEST_TOKEN}`,
          Accept: 'application/json'
        }
      }
    );
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.warn(`Launch context fetch failed for ${launchId}`, response.status, text);
      return null;
    }
    const payload = await response.json().catch(() => null);
    return payload?.context || null;
  } catch (err) {
    console.warn(`Launch context request failed for ${launchId}`, err?.message || err);
    return null;
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
      history_info: call.rawHistoryInfoHeader || null,
      launch_id: call.rawLaunchIdHeader || null
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
    launch_id: call.launchId || null,
    template_id: call.templateId || null,
    direction: call.direction || null,
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
  if (call.launchId) {
    const outboundEvent = reason === 'socket_error' ? 'launch.failed' : 'launch.completed';
    sendIngestOutbound(outboundEvent, {
      launch_id: call.launchId,
      openai_call_id: call.callId,
      status: outboundEvent === 'launch.failed' ? 'failed' : 'completed',
      ended_at: Math.floor(call.endedAt / 1000),
      reason,
      error_code: outboundEvent === 'launch.failed' ? 'socket_error' : null,
      error_message: outboundEvent === 'launch.failed' ? 'Realtime socket error' : null
    }).catch(() => {});
  }
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

  if (call.launchId) {
    lines.push(`Launch: ${call.launchId}`);
  }

  if (call.templateId) {
    lines.push(`Template: ${call.templateId}`);
  }

  if (call.calleeName) {
    lines.push(`Callee: ${call.calleeName}`);
  }

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
      if (call.launchId) {
        sendIngestOutbound('launch.openai_live', {
          launch_id: call.launchId,
          openai_call_id: call.callId,
          status: 'openai_live'
        }).catch(() => {});
      }
      if (call.direction === 'outbound') {
        const kickoff = buildOutboundKickoffInstructions(call);
        if (kickoff) {
          sendSystemResponse(call, kickoff);
        }
      } else if (WELCOME_MESSAGE) {
        sendSystemResponse(call, WELCOME_MESSAGE);
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
    const launchIdFromEvent = extractLaunchIdFromCallEvent(callEvent);
    const launchContext =
      launchIdFromEvent ? await fetchOutboundLaunchContext(launchIdFromEvent) : null;
    const callState = createCallState(callId, callEvent, launchContext);

    if (launchIdFromEvent && !launchContext) {
      console.warn(
        `Launch context unavailable for ${launchIdFromEvent}; falling back to base prompt for call ${callId}.`
      );
    }

    activeCalls.set(callId, callState);
    await sendIngestCall(callState, 'start', { status: 'incoming' });

    if (callState.launchId) {
      await sendIngestOutbound('launch.openai_incoming', {
        launch_id: callState.launchId,
        openai_call_id: callId,
        template_id: callState.templateId || null,
        status: 'openai_incoming'
      });
    }

    const acceptPayload = buildCallAcceptPayload(callEvent, {
      launchContext: callState.launchContext
    });
    console.log(`Accepting call ${callId} with audio profile: ${formatRealtimeAudioProfile()}`);
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
      if (callState.launchId) {
        await sendIngestOutbound('launch.failed', {
          launch_id: callState.launchId,
          openai_call_id: callId,
          status: 'failed',
          error_code: 'openai_accept_failed',
          error_message: `OpenAI accept failed with status ${resp.status}`
        });
      }
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
  '/control/outbound/launch',
  controlJsonParser,
  requireControlAuth,
  async (req, res) => {
    if (!twilioClient) {
      return res.status(503).json({
        ok: false,
        error: {
          code: 'twilio_not_configured',
          message: 'Twilio credentials are missing. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.'
        }
      });
    }

    if (!TWILIO_OUTBOUND_FROM || !OPENAI_SIP_URI || !TWILIO_OUTBOUND_STATUS_CALLBACK_URL) {
      return res.status(503).json({
        ok: false,
        error: {
          code: 'outbound_not_configured',
          message:
            'Outbound launch is not configured. Set TWILIO_OUTBOUND_FROM, OPENAI_SIP_URI, and TWILIO_OUTBOUND_STATUS_CALLBACK_URL.'
        }
      });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const launchId = typeof body.launch_id === 'string' ? body.launch_id.trim() : '';
    const to = normalizeE164(body.to || body.target_e164 || '');
    if (!launchId) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 'invalid_launch_id',
          message: 'launch_id is required.'
        }
      });
    }

    if (!to) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 'invalid_target',
          message: 'to must be a valid E.164 number (e.g. +14155550123).'
        }
      });
    }

    await sendIngestOutbound('launch.requested', {
      launch_id: launchId,
      target_e164: to,
      template_id: body.template_id || null,
      callee_name: body.callee_name || null,
      objective_note: body.objective_note || null
    });

    const sipUri = buildSipUriWithLaunchId(OPENAI_SIP_URI, launchId);
    if (!sipUri) {
      return res.status(500).json({
        ok: false,
        error: {
          code: 'invalid_sip_target',
          message: 'Failed to build outbound SIP target URI.'
        }
      });
    }

    const twiml = buildOutboundTwiml(sipUri);
    const separator = TWILIO_OUTBOUND_STATUS_CALLBACK_URL.includes('?') ? '&' : '?';
    const statusCallbackUrl = `${TWILIO_OUTBOUND_STATUS_CALLBACK_URL}${separator}launch_id=${encodeURIComponent(launchId)}`;

    try {
      const call = await twilioClient.calls.create({
        to,
        from: TWILIO_OUTBOUND_FROM,
        twiml,
        statusCallback: statusCallbackUrl,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
      });

      await sendIngestOutbound('launch.queued', {
        launch_id: launchId,
        target_e164: to,
        template_id: body.template_id || null,
        callee_name: body.callee_name || null,
        twilio_call_sid: call.sid,
        twilio_status: call.status || 'queued'
      });

      return res.json({
        ok: true,
        launch_id: launchId,
        twilio_call_sid: call.sid,
        status: call.status || 'queued'
      });
    } catch (err) {
      const errorCode = err?.code ? String(err.code) : 'twilio_create_failed';
      const errorMessage = err?.message || 'Failed to create outbound Twilio call.';
      await sendIngestOutbound('launch.failed', {
        launch_id: launchId,
        target_e164: to,
        template_id: body.template_id || null,
        error_code: errorCode,
        error_message: errorMessage
      });
      return res.status(502).json({
        ok: false,
        launch_id: launchId,
        error: {
          code: errorCode,
          message: errorMessage
        }
      });
    }
  }
);

app.post(
  '/twilio/outbound/status',
  express.urlencoded({ extended: false }),
  async (req, res) => {
    const launchId = String(req.query.launch_id || req.body?.launch_id || '').trim();
    if (!launchId) {
      return res.sendStatus(200);
    }

    const callSid = req.body?.CallSid || null;
    const callStatus = req.body?.CallStatus || req.body?.CallStatusCallbackEvent || '';
    const event = mapTwilioCallStatusToOutboundEvent(callStatus) || 'launch.queued';
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const payload = {
      launch_id: launchId,
      twilio_call_sid: callSid,
      twilio_status: callStatus,
      twilio_call_duration: req.body?.CallDuration || null,
      twilio_error_code: req.body?.ErrorCode || null,
      twilio_error_message: req.body?.ErrorMessage || null
    };

    if (event === 'launch.answered') {
      payload.answered_at = timestampSeconds;
    }
    if (event === 'launch.completed' || event === 'launch.failed') {
      payload.ended_at = timestampSeconds;
    }

    await sendIngestOutbound(event, payload);
    return res.sendStatus(200);
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
