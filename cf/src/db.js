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

export function toFlag(value, fallback = 0) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value ? 1 : 0;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === '1' || lowered === 'true' || lowered === 'yes') return 1;
    if (lowered === '0' || lowered === 'false' || lowered === 'no') return 0;
  }
  return fallback ? 1 : 0;
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

export async function fetchCalls(env, { status, limit, cursor, direction }) {
  const params = [];
  const where = [];

  if (status) {
    where.push('status = ?');
    params.push(status);
  }

  if (direction) {
    where.push('direction = ?');
    params.push(direction);
  }

  if (cursor?.started_at && cursor?.call_id) {
    where.push('(started_at < ? OR (started_at = ? AND call_id < ?))');
    params.push(cursor.started_at, cursor.started_at, cursor.call_id);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const pageLimit = limit + 1;

  const query = `
    SELECT
      call_id,
      status,
      started_at,
      ended_at,
      from_uri,
      to_uri,
      provider,
      conference_name,
      launch_id,
      template_id,
      direction,
      last_seq,
      updated_at
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
    `SELECT
      call_id,
      status,
      started_at,
      ended_at,
      from_uri,
      to_uri,
      provider,
      conference_name,
      call_token,
      launch_id,
      template_id,
      direction,
      last_seq,
      created_at,
      updated_at
    FROM calls
    WHERE call_id = ?`
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
      call_id,
      status,
      started_at,
      ended_at,
      from_uri,
      to_uri,
      provider,
      conference_name,
      call_token,
      launch_id,
      template_id,
      direction,
      last_seq,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(call_id) DO UPDATE SET
      status = excluded.status,
      started_at = COALESCE(calls.started_at, excluded.started_at),
      ended_at = COALESCE(excluded.ended_at, calls.ended_at),
      from_uri = COALESCE(excluded.from_uri, calls.from_uri),
      to_uri = COALESCE(excluded.to_uri, calls.to_uri),
      provider = COALESCE(excluded.provider, calls.provider),
      conference_name = COALESCE(excluded.conference_name, calls.conference_name),
      call_token = COALESCE(excluded.call_token, calls.call_token),
      launch_id = COALESCE(excluded.launch_id, calls.launch_id),
      template_id = COALESCE(excluded.template_id, calls.template_id),
      direction = COALESCE(excluded.direction, calls.direction),
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
      payload.launch_id || null,
      payload.template_id || null,
      payload.direction || null,
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

export async function fetchPromptTemplates(env, { includeInactive = true } = {}) {
  const whereClause = includeInactive ? '' : 'WHERE is_active = 1';
  const result = await env.DB.prepare(
    `SELECT
      template_id,
      name,
      description,
      instruction_block,
      voice_override,
      model_override,
      is_active,
      is_default,
      created_at,
      updated_at
    FROM prompt_templates
    ${whereClause}
    ORDER BY is_default DESC, updated_at DESC, template_id ASC`
  ).all();
  return result?.results || [];
}

export async function fetchPromptTemplate(env, templateId) {
  const result = await env.DB.prepare(
    `SELECT
      template_id,
      name,
      description,
      instruction_block,
      voice_override,
      model_override,
      is_active,
      is_default,
      created_at,
      updated_at
    FROM prompt_templates
    WHERE template_id = ?`
  )
    .bind(templateId)
    .first();
  return result || null;
}

export async function fetchDefaultPromptTemplate(env) {
  const result = await env.DB.prepare(
    `SELECT
      template_id,
      name,
      description,
      instruction_block,
      voice_override,
      model_override,
      is_active,
      is_default,
      created_at,
      updated_at
    FROM prompt_templates
    WHERE is_default = 1 AND is_active = 1
    ORDER BY updated_at DESC
    LIMIT 1`
  ).first();
  return result || null;
}

export async function createPromptTemplate(env, payload) {
  const ts = nowSeconds();
  const requestedDefault = toFlag(payload.is_default, 0);
  const isActive = toFlag(payload.is_active, 1);

  const defaults = await env.DB.prepare(
    'SELECT template_id FROM prompt_templates WHERE is_default = 1 AND is_active = 1 LIMIT 1'
  ).first();

  let isDefault = requestedDefault;
  if (!isDefault && !defaults && isActive) {
    isDefault = 1;
  }

  if (isDefault) {
    await env.DB.prepare('UPDATE prompt_templates SET is_default = 0 WHERE is_default = 1').run();
  }

  await env.DB.prepare(
    `INSERT INTO prompt_templates (
      template_id,
      name,
      description,
      instruction_block,
      voice_override,
      model_override,
      is_active,
      is_default,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      payload.template_id,
      payload.name,
      payload.description || null,
      payload.instruction_block,
      payload.voice_override || null,
      payload.model_override || null,
      isActive,
      isDefault,
      ts,
      ts
    )
    .run();

  return fetchPromptTemplate(env, payload.template_id);
}

export async function updatePromptTemplate(env, templateId, payload) {
  const existing = await fetchPromptTemplate(env, templateId);
  if (!existing) {
    return null;
  }

  const ts = nowSeconds();
  const isActive = payload.is_active === undefined ? existing.is_active : toFlag(payload.is_active, existing.is_active);
  let isDefault = payload.is_default === undefined ? existing.is_default : toFlag(payload.is_default, existing.is_default);

  if (isDefault) {
    await env.DB.prepare('UPDATE prompt_templates SET is_default = 0 WHERE is_default = 1').run();
  }

  await env.DB.prepare(
    `UPDATE prompt_templates SET
      name = ?,
      description = ?,
      instruction_block = ?,
      voice_override = ?,
      model_override = ?,
      is_active = ?,
      is_default = ?,
      updated_at = ?
    WHERE template_id = ?`
  )
    .bind(
      payload.name === undefined ? existing.name : payload.name,
      payload.description === undefined ? existing.description : payload.description,
      payload.instruction_block === undefined ? existing.instruction_block : payload.instruction_block,
      payload.voice_override === undefined ? existing.voice_override : payload.voice_override,
      payload.model_override === undefined ? existing.model_override : payload.model_override,
      isActive,
      isDefault,
      ts,
      templateId
    )
    .run();

  if (!isDefault || !isActive) {
    const defaultTemplate = await fetchDefaultPromptTemplate(env);
    if (!defaultTemplate) {
      const fallback = await env.DB.prepare(
        'SELECT template_id FROM prompt_templates WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1'
      ).first();
      if (fallback?.template_id) {
        await env.DB.prepare('UPDATE prompt_templates SET is_default = 1 WHERE template_id = ?')
          .bind(fallback.template_id)
          .run();
      }
    }
  }

  return fetchPromptTemplate(env, templateId);
}

export async function deletePromptTemplate(env, templateId) {
  const existing = await fetchPromptTemplate(env, templateId);
  if (!existing) {
    return false;
  }

  await env.DB.prepare('DELETE FROM prompt_templates WHERE template_id = ?').bind(templateId).run();

  if (existing.is_default) {
    const fallback = await env.DB.prepare(
      'SELECT template_id FROM prompt_templates WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1'
    ).first();
    if (fallback?.template_id) {
      await env.DB.prepare('UPDATE prompt_templates SET is_default = 1 WHERE template_id = ?')
        .bind(fallback.template_id)
        .run();
    }
  }

  return true;
}

export async function createOutboundLaunch(env, payload) {
  const ts = nowSeconds();

  await env.DB.prepare(
    `INSERT INTO outbound_launches (
      launch_id,
      status,
      template_id,
      target_e164,
      objective_note,
      instruction_block,
      voice_override,
      model_override,
      created_at,
      updated_at,
      last_event_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      payload.launch_id,
      payload.status || 'requested',
      payload.template_id,
      payload.target_e164,
      payload.objective_note || null,
      payload.instruction_block,
      payload.voice_override || null,
      payload.model_override || null,
      ts,
      ts,
      payload.last_event_json || null
    )
    .run();

  return fetchOutboundLaunch(env, payload.launch_id);
}

export async function fetchOutboundLaunch(env, launchId) {
  const result = await env.DB.prepare(
    `SELECT
      launch_id,
      status,
      template_id,
      target_e164,
      objective_note,
      instruction_block,
      voice_override,
      model_override,
      twilio_call_sid,
      openai_call_id,
      error_code,
      error_message,
      created_at,
      updated_at,
      answered_at,
      ended_at,
      last_event_json
    FROM outbound_launches
    WHERE launch_id = ?`
  )
    .bind(launchId)
    .first();

  return result || null;
}

export async function fetchOutboundLaunches(env, { status, limit, cursor }) {
  const params = [];
  const where = [];

  if (status) {
    where.push('status = ?');
    params.push(status);
  }

  if (cursor?.created_at && cursor?.launch_id) {
    where.push('(created_at < ? OR (created_at = ? AND launch_id < ?))');
    params.push(cursor.created_at, cursor.created_at, cursor.launch_id);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const pageLimit = limit + 1;

  const query = `
    SELECT
      launch_id,
      status,
      template_id,
      target_e164,
      objective_note,
      voice_override,
      model_override,
      twilio_call_sid,
      openai_call_id,
      error_code,
      error_message,
      created_at,
      updated_at,
      answered_at,
      ended_at
    FROM outbound_launches
    ${whereClause}
    ORDER BY created_at DESC, launch_id DESC
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
    nextCursor = encodeCursor({ created_at: last.created_at, launch_id: last.launch_id });
  }

  return { items, next_cursor: nextCursor };
}

export async function updateOutboundLaunch(env, launchId, updates) {
  const existing = await fetchOutboundLaunch(env, launchId);
  if (!existing) {
    return null;
  }

  const ts = nowSeconds();
  const status = updates.status || existing.status;

  const terminalStatuses = new Set(['completed', 'failed', 'busy', 'no-answer', 'canceled']);
  const endedAt =
    updates.ended_at !== undefined
      ? (updates.ended_at ? toSeconds(updates.ended_at) : null)
      : terminalStatuses.has(status)
        ? (existing.ended_at || ts)
        : existing.ended_at;

  const answeredAt =
    updates.answered_at !== undefined
      ? (updates.answered_at ? toSeconds(updates.answered_at) : null)
      : (status === 'answered' || status === 'in-progress')
        ? (existing.answered_at || ts)
        : existing.answered_at;

  await env.DB.prepare(
    `UPDATE outbound_launches SET
      status = ?,
      template_id = ?,
      target_e164 = ?,
      objective_note = ?,
      instruction_block = ?,
      voice_override = ?,
      model_override = ?,
      twilio_call_sid = ?,
      openai_call_id = ?,
      error_code = ?,
      error_message = ?,
      updated_at = ?,
      answered_at = ?,
      ended_at = ?,
      last_event_json = ?
    WHERE launch_id = ?`
  )
    .bind(
      status,
      updates.template_id || existing.template_id,
      updates.target_e164 || existing.target_e164,
      updates.objective_note === undefined ? existing.objective_note : updates.objective_note,
      updates.instruction_block || existing.instruction_block,
      updates.voice_override === undefined ? existing.voice_override : updates.voice_override,
      updates.model_override === undefined ? existing.model_override : updates.model_override,
      updates.twilio_call_sid || existing.twilio_call_sid,
      updates.openai_call_id || existing.openai_call_id,
      updates.error_code === undefined ? existing.error_code : updates.error_code,
      updates.error_message === undefined ? existing.error_message : updates.error_message,
      ts,
      answeredAt,
      endedAt,
      updates.last_event_json === undefined ? existing.last_event_json : updates.last_event_json,
      launchId
    )
    .run();

  return fetchOutboundLaunch(env, launchId);
}

export async function fetchOutboundLaunchContext(env, launchId) {
  const launch = await env.DB.prepare(
    `SELECT
      launch_id,
      status,
      template_id,
      target_e164,
      objective_note,
      instruction_block,
      voice_override,
      model_override,
      twilio_call_sid,
      openai_call_id,
      error_code,
      error_message,
      created_at,
      updated_at,
      answered_at,
      ended_at
    FROM outbound_launches
    WHERE launch_id = ?`
  )
    .bind(launchId)
    .first();

  if (!launch) return null;

  const template = await fetchPromptTemplate(env, launch.template_id);

  return {
    launch,
    template
  };
}
