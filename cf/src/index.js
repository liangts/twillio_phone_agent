import { requireIngestAuth } from './auth.js';
import {
  clamp,
  createOutboundLaunch,
  createPromptTemplate,
  decodeCursor,
  deletePromptTemplate,
  fetchCall,
  fetchCalls,
  fetchDefaultPromptTemplate,
  fetchOutboundLaunch,
  fetchOutboundLaunchContext,
  fetchOutboundLaunches,
  fetchPromptTemplate,
  fetchPromptTemplates,
  fetchTranscript,
  insertTranscript,
  nowSeconds,
  toInteger,
  toSeconds,
  updateOutboundLaunch,
  updatePromptTemplate,
  upsertCall
} from './db.js';
import { CallRoom } from './callRoom.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
      ...headers
    }
  });
}

function errorResponse(status, message, code = 'bad_request', details = undefined) {
  return jsonResponse({ error: { code, message, details } }, status);
}

function parseTimeoutMs(value, fallback = 8000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 1000) return 1000;
  if (parsed > 30000) return 30000;
  return Math.floor(parsed);
}

function getControlBaseUrl(env) {
  return (env?.CONTROL_API_BASE_URL || '').replace(/\/+$/, '');
}

function normalizeE164(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\+[1-9]\d{7,14}$/.test(trimmed)) return null;
  return trimmed;
}

function normalizeTemplateId(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(trimmed)) return null;
  return trimmed;
}

function normalizeOptionalText(value, maxLen = 1200) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, maxLen);
}

function normalizeRequiredText(value, maxLen = 1200) {
  const text = normalizeOptionalText(value, maxLen);
  return text || null;
}

function createLaunchId() {
  const random = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  return `launch_${nowSeconds()}_${random}`;
}

function mapOutboundEventStatus(event, fallbackStatus = 'requested') {
  switch ((event || '').toLowerCase()) {
    case 'launch.requested':
      return 'requested';
    case 'launch.queued':
      return 'queued';
    case 'launch.ringing':
      return 'ringing';
    case 'launch.answered':
      return 'answered';
    case 'launch.openai_incoming':
      return 'openai_incoming';
    case 'launch.openai_live':
      return 'openai_live';
    case 'launch.completed':
      return 'completed';
    case 'launch.failed':
      return 'failed';
    default:
      return fallbackStatus;
  }
}

function mapTwilioCallStatus(status, fallbackStatus = 'queued') {
  switch ((status || '').toLowerCase()) {
    case 'queued':
    case 'initiated':
      return 'queued';
    case 'ringing':
      return 'ringing';
    case 'in-progress':
      return 'answered';
    case 'completed':
      return 'completed';
    case 'busy':
    case 'failed':
    case 'no-answer':
    case 'canceled':
      return 'failed';
    default:
      return fallbackStatus;
  }
}

async function broadcastToRoom(env, callId, payload) {
  if (!env?.CALL_ROOM || !callId) return;
  const id = env.CALL_ROOM.idFromName(callId);
  const stub = env.CALL_ROOM.get(id);
  await stub.fetch('https://call-room/broadcast', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-token': env.INGEST_TOKEN || '',
      'x-call-id': callId
    },
    body: JSON.stringify(payload)
  });
}

function withCallIdHeader(request, callId) {
  const headers = new Headers(request.headers);
  headers.set('x-call-id', callId);
  return new Request(request, { headers });
}

async function handleIngestCall(request, env) {
  const authError = requireIngestAuth(request, env);
  if (authError) return authError;

  let payload;
  try {
    payload = await request.json();
  } catch (_err) {
    return errorResponse(400, 'Invalid JSON payload');
  }

  if (!payload?.call_id) {
    return errorResponse(400, 'call_id is required');
  }

  const event = payload.event || 'status';
  const status = payload.status || (event === 'end' ? 'ended' : 'incoming');
  const ts = toSeconds(payload.ts || nowSeconds());

  await upsertCall(env, {
    ...payload,
    event,
    status,
    ts
  });

  if (payload.launch_id && payload.call_id) {
    await updateOutboundLaunch(env, payload.launch_id, {
      openai_call_id: payload.call_id,
      status: status === 'live' ? 'openai_live' : undefined,
      last_event_json: JSON.stringify({
        event: 'call.ingest',
        status,
        call_id: payload.call_id,
        launch_id: payload.launch_id,
        ts
      })
    });
  }

  if (event === 'start' || event === 'end' || payload.status) {
    const statusPayload = {
      type: 'call.status',
      call_id: payload.call_id,
      status,
      ended_at: event === 'end' ? ts : payload.ended_at ? toSeconds(payload.ended_at) : null
    };
    await broadcastToRoom(env, payload.call_id, statusPayload);
  }

  return jsonResponse({ ok: true });
}

async function handleIngestTranscript(request, env) {
  const authError = requireIngestAuth(request, env);
  if (authError) return authError;

  let payload;
  try {
    payload = await request.json();
  } catch (_err) {
    return errorResponse(400, 'Invalid JSON payload');
  }

  const callId = payload?.call_id;
  const seq = toInteger(payload?.seq, null);
  if (!callId || seq === null) {
    return errorResponse(400, 'call_id and seq are required');
  }

  const ts = payload?.ts ? Number(payload.ts) : Date.now();
  const speaker = payload?.speaker || 'system';
  const text = payload?.text;
  if (!text) {
    return errorResponse(400, 'text is required');
  }

  const inserted = await insertTranscript(env, {
    call_id: callId,
    seq,
    ts,
    speaker,
    text,
    raw_json: payload?.raw ? JSON.stringify(payload.raw) : payload?.raw_json || null
  });

  if (inserted) {
    const segmentPayload = {
      type: 'transcript.segment',
      segment: { seq, ts, speaker, text }
    };
    await broadcastToRoom(env, callId, segmentPayload);
  }

  return jsonResponse({ ok: true, inserted });
}

async function handleIngestOutbound(request, env) {
  const authError = requireIngestAuth(request, env);
  if (authError) return authError;

  let payload;
  try {
    payload = await request.json();
  } catch (_err) {
    return errorResponse(400, 'Invalid JSON payload');
  }

  const launchId = payload?.launch_id;
  if (!launchId) {
    return errorResponse(400, 'launch_id is required');
  }

  const existing = await fetchOutboundLaunch(env, launchId);
  if (!existing) {
    return errorResponse(404, 'Launch not found', 'not_found');
  }

  const mappedStatus = mapOutboundEventStatus(payload?.event, payload?.status || existing.status);
  const twilioStatus = mapTwilioCallStatus(payload?.twilio_status, mappedStatus);
  const status = payload?.twilio_status ? twilioStatus : mappedStatus;

  const updates = {
    status,
    twilio_call_sid: payload?.twilio_call_sid || payload?.call_sid,
    openai_call_id: payload?.openai_call_id,
    error_code: payload?.error_code || payload?.twilio_error_code || null,
    error_message: payload?.error_message || payload?.twilio_error_message || null,
    answered_at: payload?.answered_at,
    ended_at: payload?.ended_at,
    last_event_json: JSON.stringify({ ...payload, ts: nowSeconds() })
  };

  const launch = await updateOutboundLaunch(env, launchId, updates);
  if (!launch) {
    return errorResponse(404, 'Launch not found', 'not_found');
  }

  return jsonResponse({ ok: true, launch });
}

async function handleCallsList(request, env) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const direction = url.searchParams.get('direction');
  const limit = clamp(url.searchParams.get('limit'), 1, 200, 50);
  const cursor = decodeCursor(url.searchParams.get('cursor'));

  const response = await fetchCalls(env, { status, direction, limit, cursor });
  return jsonResponse(response);
}

async function handleCallDetail(callId, env) {
  const call = await fetchCall(env, callId);
  if (!call) {
    return errorResponse(404, 'Call not found', 'not_found');
  }
  return jsonResponse({ call });
}

async function handleTranscript(callId, request, env) {
  const url = new URL(request.url);
  const afterSeq = clamp(url.searchParams.get('after_seq'), 0, Number.MAX_SAFE_INTEGER, 0);
  const limit = clamp(url.searchParams.get('limit'), 1, 1000, 200);

  const items = await fetchTranscript(env, callId, afterSeq, limit);
  const call = await fetchCall(env, callId);

  return jsonResponse({
    call_id: callId,
    after_seq: afterSeq,
    items,
    last_seq: call?.last_seq || 0
  });
}

async function handleWebSocket(callId, request, env) {
  const id = env.CALL_ROOM.idFromName(callId);
  const stub = env.CALL_ROOM.get(id);
  const forwarded = withCallIdHeader(request, callId);
  return stub.fetch(forwarded);
}

async function handleCallAction(callId, action, request, env) {
  const controlBase = getControlBaseUrl(env);
  if (!controlBase) {
    return errorResponse(
      503,
      'Control API is not configured on this Worker',
      'control_unavailable'
    );
  }

  if (action !== 'transfer' && action !== 'hangup') {
    return errorResponse(404, 'Not found', 'not_found');
  }

  let payload = {};
  if ((request.headers.get('content-type') || '').includes('application/json')) {
    try {
      payload = await request.json();
    } catch (_err) {
      return errorResponse(400, 'Invalid JSON payload');
    }
  }

  const controller = new AbortController();
  const timeoutMs = parseTimeoutMs(env?.CONTROL_API_TIMEOUT_MS, 8000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
    if (env?.CONTROL_API_TOKEN) {
      headers.Authorization = `Bearer ${env.CONTROL_API_TOKEN}`;
    }
    if (env?.CONTROL_API_ACCESS_CLIENT_ID) {
      headers['CF-Access-Client-Id'] = env.CONTROL_API_ACCESS_CLIENT_ID;
    }
    if (env?.CONTROL_API_ACCESS_CLIENT_SECRET) {
      headers['CF-Access-Client-Secret'] = env.CONTROL_API_ACCESS_CLIENT_SECRET;
    }

    const response = await fetch(
      `${controlBase}/control/calls/${encodeURIComponent(callId)}/${encodeURIComponent(action)}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(payload || {}),
        signal: controller.signal
      }
    );

    let responsePayload = null;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      responsePayload = await response.json().catch(() => null);
    } else {
      const text = await response.text().catch(() => '');
      responsePayload = text ? { message: text } : {};
    }

    if (!response.ok) {
      return jsonResponse(
        responsePayload || {
          error: {
            code: 'control_request_failed',
            message: `Control API failed (${response.status})`
          }
        },
        response.status
      );
    }

    if (action === 'hangup') {
      const endedAt = nowSeconds();
      await upsertCall(env, {
        call_id: callId,
        event: 'status',
        status: 'ended',
        ts: endedAt,
        ended_at: endedAt
      });
      await broadcastToRoom(env, callId, {
        type: 'call.status',
        call_id: callId,
        status: 'ended',
        ended_at: endedAt
      });
    }

    return jsonResponse(responsePayload || { ok: true });
  } catch (err) {
    if (err?.name === 'AbortError') {
      return errorResponse(504, 'Control request timed out', 'control_timeout');
    }
    return errorResponse(
      502,
      'Failed to reach control API',
      'control_upstream_error',
      err?.message || String(err)
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function requestControlLaunch(env, launchPayload) {
  const controlBase = getControlBaseUrl(env);
  if (!controlBase) {
    return {
      ok: false,
      status: 503,
      payload: {
        error: { code: 'control_unavailable', message: 'Control API is not configured on this Worker' }
      }
    };
  }

  const controller = new AbortController();
  const timeoutMs = parseTimeoutMs(env?.CONTROL_API_TIMEOUT_MS, 10000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
    if (env?.CONTROL_API_TOKEN) {
      headers.Authorization = `Bearer ${env.CONTROL_API_TOKEN}`;
    }
    if (env?.CONTROL_API_ACCESS_CLIENT_ID) {
      headers['CF-Access-Client-Id'] = env.CONTROL_API_ACCESS_CLIENT_ID;
    }
    if (env?.CONTROL_API_ACCESS_CLIENT_SECRET) {
      headers['CF-Access-Client-Secret'] = env.CONTROL_API_ACCESS_CLIENT_SECRET;
    }

    const response = await fetch(`${controlBase}/control/outbound/launch`, {
      method: 'POST',
      headers,
      body: JSON.stringify(launchPayload),
      signal: controller.signal
    });

    const contentType = response.headers.get('content-type') || '';
    let payload;
    if (contentType.includes('application/json')) {
      payload = await response.json().catch(() => ({}));
    } else {
      const text = await response.text().catch(() => '');
      payload = text ? { message: text } : {};
    }

    return {
      ok: response.ok,
      status: response.status,
      payload
    };
  } catch (err) {
    if (err?.name === 'AbortError') {
      return {
        ok: false,
        status: 504,
        payload: {
          error: { code: 'control_timeout', message: 'Control launch request timed out' }
        }
      };
    }
    return {
      ok: false,
      status: 502,
      payload: {
        error: {
          code: 'control_upstream_error',
          message: 'Failed to reach control API',
          details: err?.message || String(err)
        }
      }
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function handleOutboundLaunchCreate(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch (_err) {
    return errorResponse(400, 'Invalid JSON payload');
  }

  const to = normalizeE164(payload?.to || payload?.target_e164);
  if (!to) {
    return errorResponse(400, 'Target number must be valid E.164 format (e.g. +14155550123)', 'invalid_target');
  }

  const requestedTemplateId = normalizeTemplateId(payload?.template_id || '');
  let template = null;

  if (requestedTemplateId) {
    template = await fetchPromptTemplate(env, requestedTemplateId);
    if (!template) {
      return errorResponse(404, 'Template not found', 'template_not_found');
    }
    if (!template.is_active) {
      return errorResponse(400, 'Template is inactive', 'template_inactive');
    }
  } else {
    template = await fetchDefaultPromptTemplate(env);
    if (!template) {
      return errorResponse(400, 'No active default template configured', 'template_missing_default');
    }
  }

  const objectiveNote = normalizeOptionalText(payload?.objective_note, 1200);
  const launchId = createLaunchId();

  const launch = await createOutboundLaunch(env, {
    launch_id: launchId,
    status: 'requested',
    template_id: template.template_id,
    target_e164: to,
    objective_note: objectiveNote,
    instruction_block: template.instruction_block,
    voice_override: template.voice_override,
    model_override: template.model_override,
    last_event_json: JSON.stringify({ event: 'launch.requested', ts: nowSeconds(), source: 'worker' })
  });

  const controlPayload = {
    launch_id: launchId,
    to,
    template_id: template.template_id,
    objective_note: objectiveNote,
    instruction_block: template.instruction_block,
    voice_override: template.voice_override,
    model_override: template.model_override
  };

  const launchResponse = await requestControlLaunch(env, controlPayload);
  if (!launchResponse.ok) {
    await updateOutboundLaunch(env, launchId, {
      status: 'failed',
      error_code: launchResponse.payload?.error?.code || 'control_request_failed',
      error_message:
        launchResponse.payload?.error?.message ||
        launchResponse.payload?.message ||
        `Control API failed (${launchResponse.status})`,
      last_event_json: JSON.stringify({
        event: 'launch.failed',
        source: 'worker',
        status: launchResponse.status,
        response: launchResponse.payload
      })
    });

    return jsonResponse(
      launchResponse.payload || {
        error: {
          code: 'control_request_failed',
          message: `Control API failed (${launchResponse.status})`
        }
      },
      launchResponse.status
    );
  }

  const twilioCallSid = launchResponse.payload?.twilio_call_sid || launchResponse.payload?.call_sid || null;
  const queuedStatus = mapOutboundEventStatus('launch.queued', launchResponse.payload?.status || 'queued');

  const updatedLaunch = await updateOutboundLaunch(env, launchId, {
    status: queuedStatus,
    twilio_call_sid: twilioCallSid,
    last_event_json: JSON.stringify({
      event: 'launch.queued',
      source: 'worker',
      twilio_call_sid: twilioCallSid,
      response: launchResponse.payload
    })
  });

  return jsonResponse({
    ok: true,
    launch: updatedLaunch || launch
  });
}

async function handleOutboundLaunchList(request, env) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const limit = clamp(url.searchParams.get('limit'), 1, 200, 50);
  const cursor = decodeCursor(url.searchParams.get('cursor'));

  const response = await fetchOutboundLaunches(env, { status, limit, cursor });
  return jsonResponse(response);
}

async function handleOutboundLaunchDetail(launchId, env) {
  const launch = await fetchOutboundLaunch(env, launchId);
  if (!launch) {
    return errorResponse(404, 'Launch not found', 'not_found');
  }
  return jsonResponse({ launch });
}

async function handleInternalLaunchContext(launchId, request, env) {
  const authError = requireIngestAuth(request, env);
  if (authError) return authError;

  const context = await fetchOutboundLaunchContext(env, launchId);
  if (!context) {
    return errorResponse(404, 'Launch not found', 'not_found');
  }

  return jsonResponse({
    context: {
      launch_id: context.launch.launch_id,
      status: context.launch.status,
      target_e164: context.launch.target_e164,
      template_id: context.launch.template_id,
      instruction_block: context.launch.instruction_block,
      objective_note: context.launch.objective_note,
      voice_override: context.launch.voice_override,
      model_override: context.launch.model_override,
      twilio_call_sid: context.launch.twilio_call_sid,
      openai_call_id: context.launch.openai_call_id,
      template: context.template
        ? {
            template_id: context.template.template_id,
            name: context.template.name,
            description: context.template.description,
            is_active: context.template.is_active,
            is_default: context.template.is_default
          }
        : null
    }
  });
}

async function handleTemplateList(request, env) {
  const url = new URL(request.url);
  const includeInactive = url.searchParams.get('include_inactive') !== '0';
  const templates = await fetchPromptTemplates(env, { includeInactive });
  return jsonResponse({ items: templates });
}

async function handleTemplateCreate(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch (_err) {
    return errorResponse(400, 'Invalid JSON payload');
  }

  const templateId = normalizeTemplateId(payload?.template_id || '');
  if (!templateId) {
    return errorResponse(400, 'template_id is required and must match [a-zA-Z0-9_-]', 'invalid_template_id');
  }

  const name = normalizeRequiredText(payload?.name, 120);
  if (!name) {
    return errorResponse(400, 'name is required', 'invalid_name');
  }

  const instructionBlock = normalizeRequiredText(payload?.instruction_block, 12000);
  if (!instructionBlock) {
    return errorResponse(400, 'instruction_block is required', 'invalid_instruction_block');
  }

  try {
    const template = await createPromptTemplate(env, {
      template_id: templateId,
      name,
      description: normalizeOptionalText(payload?.description, 500),
      instruction_block: instructionBlock,
      voice_override: normalizeOptionalText(payload?.voice_override, 80),
      model_override: normalizeOptionalText(payload?.model_override, 120),
      is_active: payload?.is_active,
      is_default: payload?.is_default
    });
    return jsonResponse({ ok: true, template }, 201);
  } catch (err) {
    const message = err?.message || String(err);
    if (message.includes('UNIQUE constraint failed')) {
      return errorResponse(409, 'Template id or name already exists', 'conflict');
    }
    return errorResponse(500, 'Failed to create template', 'template_create_failed', message);
  }
}

async function handleTemplateUpdate(templateId, request, env) {
  if (!normalizeTemplateId(templateId)) {
    return errorResponse(400, 'Invalid template_id', 'invalid_template_id');
  }

  let payload;
  try {
    payload = await request.json();
  } catch (_err) {
    return errorResponse(400, 'Invalid JSON payload');
  }

  if (payload?.name !== undefined) {
    const name = normalizeRequiredText(payload?.name, 120);
    if (!name) {
      return errorResponse(400, 'name cannot be empty', 'invalid_name');
    }
    payload.name = name;
  }

  if (payload?.instruction_block !== undefined) {
    const instructionBlock = normalizeRequiredText(payload?.instruction_block, 12000);
    if (!instructionBlock) {
      return errorResponse(400, 'instruction_block cannot be empty', 'invalid_instruction_block');
    }
    payload.instruction_block = instructionBlock;
  }

  if (payload?.description !== undefined) {
    payload.description = normalizeOptionalText(payload?.description, 500);
  }
  if (payload?.voice_override !== undefined) {
    payload.voice_override = normalizeOptionalText(payload?.voice_override, 80);
  }
  if (payload?.model_override !== undefined) {
    payload.model_override = normalizeOptionalText(payload?.model_override, 120);
  }

  try {
    const template = await updatePromptTemplate(env, templateId, payload);
    if (!template) {
      return errorResponse(404, 'Template not found', 'not_found');
    }
    return jsonResponse({ ok: true, template });
  } catch (err) {
    const message = err?.message || String(err);
    if (message.includes('UNIQUE constraint failed')) {
      return errorResponse(409, 'Template name already exists', 'conflict');
    }
    return errorResponse(500, 'Failed to update template', 'template_update_failed', message);
  }
}

async function handleTemplateDelete(templateId, env) {
  if (!normalizeTemplateId(templateId)) {
    return errorResponse(400, 'Invalid template_id', 'invalid_template_id');
  }

  try {
    const deleted = await deletePromptTemplate(env, templateId);
    if (!deleted) {
      return errorResponse(404, 'Template not found', 'not_found');
    }
    return jsonResponse({ ok: true, deleted: true });
  } catch (err) {
    const message = err?.message || String(err);
    if (message.includes('FOREIGN KEY constraint failed')) {
      return errorResponse(
        409,
        'Template is referenced by existing launches. Deactivate it instead of deleting.',
        'template_in_use'
      );
    }
    return errorResponse(500, 'Failed to delete template', 'template_delete_failed', message);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);

    if (segments[0] === 'ingest') {
      if (request.method !== 'POST') {
        return errorResponse(405, 'Method not allowed', 'method_not_allowed');
      }
      if (segments[1] === 'call') {
        return handleIngestCall(request, env);
      }
      if (segments[1] === 'transcript') {
        return handleIngestTranscript(request, env);
      }
      if (segments[1] === 'outbound') {
        return handleIngestOutbound(request, env);
      }
      return errorResponse(404, 'Not found', 'not_found');
    }

    if (segments[0] === 'internal' && segments[1] === 'outbound' && segments[2] === 'launches' && segments[3] && segments[4] === 'context') {
      if (request.method !== 'GET') {
        return errorResponse(405, 'Method not allowed', 'method_not_allowed');
      }
      return handleInternalLaunchContext(segments[3], request, env);
    }

    if (segments[0] === 'api' && segments[1] === 'calls') {
      if (segments.length === 2) {
        if (request.method !== 'GET') {
          return errorResponse(405, 'Method not allowed', 'method_not_allowed');
        }
        return handleCallsList(request, env);
      }
      const callId = segments[2];
      if (!callId) {
        return errorResponse(400, 'call_id is required');
      }
      if (segments.length === 5 && segments[3] === 'actions') {
        if (request.method !== 'POST') {
          return errorResponse(405, 'Method not allowed', 'method_not_allowed');
        }
        return handleCallAction(callId, segments[4], request, env);
      }
      if (request.method !== 'GET') {
        return errorResponse(405, 'Method not allowed', 'method_not_allowed');
      }
      if (segments.length === 3) {
        return handleCallDetail(callId, env);
      }
      if (segments.length === 4 && segments[3] === 'transcript') {
        return handleTranscript(callId, request, env);
      }
      return errorResponse(404, 'Not found', 'not_found');
    }

    if (segments[0] === 'api' && segments[1] === 'outbound') {
      if (segments[2] === 'templates') {
        if (segments.length === 3) {
          if (request.method === 'GET') return handleTemplateList(request, env);
          if (request.method === 'POST') return handleTemplateCreate(request, env);
          return errorResponse(405, 'Method not allowed', 'method_not_allowed');
        }
        const templateId = segments[3];
        if (!templateId) {
          return errorResponse(400, 'template_id is required');
        }
        if (request.method === 'PUT') {
          return handleTemplateUpdate(templateId, request, env);
        }
        if (request.method === 'DELETE') {
          return handleTemplateDelete(templateId, env);
        }
        return errorResponse(405, 'Method not allowed', 'method_not_allowed');
      }

      if (segments[2] === 'launches') {
        if (segments.length === 3) {
          if (request.method === 'POST') return handleOutboundLaunchCreate(request, env);
          if (request.method === 'GET') return handleOutboundLaunchList(request, env);
          return errorResponse(405, 'Method not allowed', 'method_not_allowed');
        }

        const launchId = segments[3];
        if (!launchId) {
          return errorResponse(400, 'launch_id is required');
        }
        if (request.method !== 'GET') {
          return errorResponse(405, 'Method not allowed', 'method_not_allowed');
        }
        return handleOutboundLaunchDetail(launchId, env);
      }

      return errorResponse(404, 'Not found', 'not_found');
    }

    if (segments[0] === 'ws' && segments[1] === 'calls' && segments[2]) {
      if (request.method !== 'GET') {
        return errorResponse(405, 'Method not allowed', 'method_not_allowed');
      }
      return handleWebSocket(segments[2], request, env);
    }

    return errorResponse(404, 'Not found', 'not_found');
  }
};

export { CallRoom };
