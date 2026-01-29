export function getBearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

export function requireIngestAuth(request, env) {
  const token = getBearerToken(request);
  if (!token || !env?.INGEST_TOKEN || token !== env.INGEST_TOKEN) {
    return new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'Unauthorized' } }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  return null;
}
