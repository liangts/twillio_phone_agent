import { requireIngestAuth } from './auth.js';
import {
  clamp,
  decodeCursor,
  fetchCall,
  fetchCalls,
  fetchTranscript,
  insertTranscript,
  nowSeconds,
  toInteger,
  toSeconds,
  upsertCall
} from './db.js';
import { CallRoom } from './callRoom.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
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

async function handleCallsList(request, env) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const limit = clamp(url.searchParams.get('limit'), 1, 200, 50);
  const cursor = decodeCursor(url.searchParams.get('cursor'));

  const response = await fetchCalls(env, { status, limit, cursor });
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
      return errorResponse(404, 'Not found', 'not_found');
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
