import { clamp } from './db.js';

const SNAPSHOT_LIMIT = 200;

export class CallRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.callId = null;
    this.clients = new Map();

    const sockets = state.getWebSockets();
    for (const ws of sockets) {
      this.attachSocket(ws, false);
    }
  }

  attachSocket(ws, isNew, metaOverride) {
    if (isNew) {
      ws.accept();
    }
    const meta = metaOverride || ws.deserializeAttachment() || { afterSeq: 0 };
    this.clients.set(ws, meta);

    ws.addEventListener('message', (event) => {
      this.onMessage(ws, event);
    });

    ws.addEventListener('close', () => {
      this.clients.delete(ws);
    });

    ws.addEventListener('error', () => {
      this.clients.delete(ws);
      try {
        ws.close();
      } catch (_err) {}
    });
  }

  async onMessage(ws, event) {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch (_err) {
      return;
    }

    if (payload?.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: payload.t || Date.now() }));
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const callIdHeader = request.headers.get('x-call-id');
    if (callIdHeader && !this.callId) {
      this.callId = callIdHeader;
    }

    if (url.pathname.endsWith('/broadcast')) {
      return this.handleBroadcast(request);
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request);
    }

    return new Response('Not found', { status: 404 });
  }

  async handleWebSocket(request) {
    const url = new URL(request.url);
    const afterSeq = clamp(url.searchParams.get('after_seq') || 0, 0, Number.MAX_SAFE_INTEGER, 0);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const meta = { afterSeq };
    server.serializeAttachment(meta);
    this.attachSocket(server, true, meta);

    this.sendSnapshot(server, afterSeq).catch(() => {});

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async sendSnapshot(ws, afterSeq) {
    const callId = this.callId || 'unknown';
    const call = await this.env.DB.prepare(
      'SELECT call_id, status, started_at, ended_at, last_seq FROM calls WHERE call_id = ?'
    )
      .bind(callId)
      .first();

    const segments = await this.env.DB.prepare(
      'SELECT seq, ts, speaker, text FROM transcript_segments WHERE call_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
    )
      .bind(callId, afterSeq, SNAPSHOT_LIMIT)
      .all();

    const message = {
      type: 'snapshot',
      call: call || { call_id: callId, status: 'unknown', started_at: null, ended_at: null, last_seq: 0 },
      segments: segments?.results || []
    };

    ws.send(JSON.stringify(message));
  }

  async handleBroadcast(request) {
    const token = request.headers.get('x-internal-token');
    if (!token || token !== this.env.INGEST_TOKEN) {
      return new Response('Forbidden', { status: 403 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch (_err) {
      return new Response('Bad Request', { status: 400 });
    }

    if (!payload) {
      return new Response('Bad Request', { status: 400 });
    }

    const message = JSON.stringify(payload);
    for (const ws of this.clients.keys()) {
      try {
        ws.send(message);
      } catch (_err) {
        try {
          ws.close();
        } catch (_closeErr) {}
        this.clients.delete(ws);
      }
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
