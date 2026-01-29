export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function toSeconds(value) {
  if (!value) return nowSeconds();
  const num = Number(value);
  if (!Number.isFinite(num)) return nowSeconds();
  if (num > 1e12) return Math.floor(num / 1000);
  return Math.floor(num);
}

export function toInteger(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.floor(num);
}

export function clamp(value, min, max, fallback) {
  const num = toInteger(value, fallback);
  if (num < min) return min;
  if (num > max) return max;
  return num;
}

export function encodeCursor(payload) {
  return btoa(JSON.stringify(payload));
}

export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    return JSON.parse(atob(cursor));
  } catch (_err) {
    return null;
  }
}

export async function fetchCalls(env, { status, limit, cursor }) {
  const params = [];
  const where = [];

  if (status) {
    where.push('status = ?');
    params.push(status);
  }

  if (cursor?.started_at && cursor?.call_id) {
    where.push('(started_at < ? OR (started_at = ? AND call_id < ?))');
    params.push(cursor.started_at, cursor.started_at, cursor.call_id);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const pageLimit = limit + 1;

  const query = `
    SELECT call_id, status, started_at, ended_at, from_uri, to_uri, conference_name, last_seq, updated_at
    FROM calls
    ${whereClause}
    ORDER BY started_at DESC, call_id DESC
    LIMIT ?
  `;
  params.push(pageLimit);

  const result = await env.DB.prepare(query).bind(...params).all();
  const rows = result?.results || [];
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor = null;
  if (hasMore) {
    const last = items[items.length - 1];
    nextCursor = encodeCursor({ started_at: last.started_at, call_id: last.call_id });
  }

  return { items, next_cursor: nextCursor };
}

export async function fetchCall(env, callId) {
  const result = await env.DB.prepare(
    'SELECT call_id, status, started_at, ended_at, from_uri, to_uri, provider, conference_name, last_seq, created_at, updated_at FROM calls WHERE call_id = ?'
  )
    .bind(callId)
    .first();
  return result || null;
}

export async function fetchTranscript(env, callId, afterSeq, limit) {
  const result = await env.DB.prepare(
    'SELECT seq, ts, speaker, text FROM transcript_segments WHERE call_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
  )
    .bind(callId, afterSeq, limit)
    .all();
  return result?.results || [];
}

export async function upsertCall(env, payload) {
  const status = payload.status || 'incoming';
  const ts = toSeconds(payload.ts);
  const startedAt = payload.event === 'start' ? ts : payload.started_at ? toSeconds(payload.started_at) : null;
  const endedAt = payload.event === 'end' ? ts : payload.ended_at ? toSeconds(payload.ended_at) : null;
  const createdAt = payload.created_at ? toSeconds(payload.created_at) : ts;

  const query = `
    INSERT INTO calls (
      call_id, status, started_at, ended_at, from_uri, to_uri, provider, conference_name, call_token, last_seq, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(call_id) DO UPDATE SET
      status = excluded.status,
      started_at = COALESCE(calls.started_at, excluded.started_at),
      ended_at = COALESCE(excluded.ended_at, calls.ended_at),
      from_uri = COALESCE(excluded.from_uri, calls.from_uri),
      to_uri = COALESCE(excluded.to_uri, calls.to_uri),
      provider = COALESCE(excluded.provider, calls.provider),
      conference_name = COALESCE(excluded.conference_name, calls.conference_name),
      call_token = COALESCE(excluded.call_token, calls.call_token),
      updated_at = excluded.updated_at
  `;

  await env.DB.prepare(query)
    .bind(
      payload.call_id,
      status,
      startedAt,
      endedAt,
      payload.from_uri || null,
      payload.to_uri || null,
      payload.provider || null,
      payload.conference_name || null,
      payload.call_token || null,
      payload.last_seq || 0,
      createdAt,
      ts
    )
    .run();

  return { status, ts, ended_at: endedAt };
}

export async function insertTranscript(env, payload) {
  const query = `
    INSERT OR IGNORE INTO transcript_segments (call_id, seq, ts, speaker, text, raw_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `;
  const result = await env.DB.prepare(query)
    .bind(
      payload.call_id,
      payload.seq,
      payload.ts,
      payload.speaker,
      payload.text,
      payload.raw_json || null
    )
    .run();

  const changes = result?.meta?.changes || result?.meta?.changed_db || result?.changes || 0;
  const inserted = changes > 0;

  if (inserted) {
    await env.DB.prepare(
      'UPDATE calls SET last_seq = MAX(last_seq, ?), updated_at = ? WHERE call_id = ?'
    )
      .bind(payload.seq, toSeconds(payload.ts), payload.call_id)
      .run();
  }

  return inserted;
}
