'use strict';

const STORAGE_KEY = 'callboard_api_base';
const DEFAULT_STATUS = 'live';
const CALLS_PAGE_SIZE = 50;
const TRANSCRIPT_PAGE_SIZE = 200;

const elements = {
  pageRoot: document.getElementById('pageRoot'),
  apiBaseInput: document.getElementById('apiBaseInput'),
  statusFilter: document.getElementById('statusFilter'),
  refreshBtn: document.getElementById('refreshBtn'),
  mobileTabs: document.getElementById('mobileTabs'),
  showCallsBtn: document.getElementById('showCallsBtn'),
  showTranscriptBtn: document.getElementById('showTranscriptBtn'),
  callSearchInput: document.getElementById('callSearchInput'),
  liveCount: document.getElementById('liveCount'),
  incomingCount: document.getElementById('incomingCount'),
  endedCount: document.getElementById('endedCount'),
  callsList: document.getElementById('callsList'),
  loadMoreCalls: document.getElementById('loadMoreCalls'),
  listStatus: document.getElementById('listStatus'),
  listMeta: document.getElementById('listMeta'),
  callSubtitle: document.getElementById('callSubtitle'),
  callMeta: document.getElementById('callMeta'),
  transcript: document.getElementById('transcript'),
  loadMoreTranscript: document.getElementById('loadMoreTranscript'),
  autoScrollToggle: document.getElementById('autoScrollToggle'),
  jumpLatestBtn: document.getElementById('jumpLatestBtn'),
  wsStatus: document.getElementById('wsStatus'),
  reconnectBtn: document.getElementById('reconnectBtn'),
  transferBtn: document.getElementById('transferBtn'),
  hangupBtn: document.getElementById('hangupBtn'),
  actionStatus: document.getElementById('actionStatus'),
  searchInput: document.getElementById('searchInput'),
  exportJson: document.getElementById('exportJson'),
  exportCsv: document.getElementById('exportCsv'),
  toast: document.getElementById('toast')
};

const state = {
  apiBase: '',
  statusFilter: DEFAULT_STATUS,
  calls: [],
  nextCursor: null,
  selectedCallId: null,
  callDetail: null,
  transcript: [],
  lastSeq: 0,
  segmentSet: new Set(),
  ws: null,
  wsConnected: false,
  isLoadingCalls: false,
  isLoadingTranscript: false,
  callSearchTerm: '',
  searchTerm: '',
  autoScroll: true,
  pendingNewSegments: 0,
  mobileView: 'calls',
  poller: null,
  reconnectTimer: null,
  actionInFlight: false,
  toastTimer: null
};

function normalizeBase(value) {
  if (!value) return '';
  return value.replace(/\/+$/, '');
}

function resolveApiBase() {
  const url = new URL(window.location.href);
  const param = url.searchParams.get('api');
  if (param) {
    localStorage.setItem(STORAGE_KEY, param);
  }
  return normalizeBase(param || localStorage.getItem(STORAGE_KEY) || '');
}

function apiUrl(path) {
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }
  return `${state.apiBase}${path}`;
}

function wsUrl(path) {
  let base = state.apiBase || window.location.origin;
  base = base.replace(/^http/, 'ws');
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }
  return `${base}${path}`;
}

function formatDateTime(seconds) {
  if (!seconds) return '-';
  const date = new Date(seconds * 1000);
  return date.toLocaleString();
}

function formatSegmentTime(value) {
  if (!value) return '-';
  const num = Number(value);
  const ms = num < 1e12 ? num * 1000 : num;
  return new Date(ms).toLocaleTimeString();
}

function formatDuration(seconds) {
  if (!seconds) return '-';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}m ${secs}s`;
}

function trimUri(value) {
  if (!value) return '-';
  return value.replace(/^sip:/, '').replace(/^tel:/, '');
}

function setStatus(el, text, variant) {
  el.textContent = text;
  if (variant === 'error') {
    el.style.background = 'rgba(255, 107, 61, 0.15)';
    el.style.color = '#c94f2c';
    return;
  }
  if (variant === 'success') {
    el.style.background = 'rgba(27, 154, 106, 0.12)';
    el.style.color = '#1b9a6a';
    return;
  }
  if (variant === 'warning') {
    el.style.background = 'rgba(240, 180, 41, 0.2)';
    el.style.color = '#8f6b0a';
    return;
  }
  el.style.background = '';
  el.style.color = '';
}

function setActionStatus(text, variant) {
  setStatus(elements.actionStatus, text, variant);
}

function showToast(message, variant = 'success', timeoutMs = 2600) {
  if (!elements.toast || !message) return;
  elements.toast.textContent = message;
  elements.toast.classList.remove('hidden', 'error', 'success', 'warning');
  if (variant) {
    elements.toast.classList.add(variant);
  }
  if (state.toastTimer) {
    clearTimeout(state.toastTimer);
  }
  state.toastTimer = setTimeout(() => {
    elements.toast.classList.add('hidden');
    elements.toast.classList.remove('error', 'success', 'warning');
    state.toastTimer = null;
  }, timeoutMs);
}

function isMobileViewport() {
  return window.matchMedia('(max-width: 900px)').matches;
}

function applyMobileViewClass() {
  if (!elements.pageRoot) return;
  if (!isMobileViewport()) {
    elements.pageRoot.classList.remove('view-calls', 'view-transcript');
    if (elements.mobileTabs) {
      elements.mobileTabs.classList.add('hidden');
    }
    return;
  }
  if (elements.mobileTabs) {
    elements.mobileTabs.classList.remove('hidden');
  }
  elements.pageRoot.classList.remove('view-calls', 'view-transcript');
  elements.pageRoot.classList.add(state.mobileView === 'transcript' ? 'view-transcript' : 'view-calls');
  elements.showCallsBtn.classList.toggle('active', state.mobileView === 'calls');
  elements.showTranscriptBtn.classList.toggle('active', state.mobileView === 'transcript');
}

function setMobileView(view) {
  state.mobileView = view === 'transcript' ? 'transcript' : 'calls';
  applyMobileViewClass();
}

function getFilteredCalls() {
  const term = state.callSearchTerm;
  if (!term) return state.calls;
  return state.calls.filter((call) => {
    const callId = (call.call_id || '').toLowerCase();
    const fromUri = trimUri(call.from_uri || '').toLowerCase();
    const toUri = trimUri(call.to_uri || '').toLowerCase();
    return callId.includes(term) || fromUri.includes(term) || toUri.includes(term);
  });
}

function updateCallSummary() {
  let live = 0;
  let incoming = 0;
  let ended = 0;
  for (const call of state.calls) {
    const status = call?.status || '';
    if (status === 'live') live += 1;
    else if (status === 'incoming') incoming += 1;
    else if (status === 'ended') ended += 1;
  }
  elements.liveCount.textContent = `Live ${live}`;
  elements.incomingCount.textContent = `Incoming ${incoming}`;
  elements.endedCount.textContent = `Ended ${ended}`;
}

function clearPendingSegments() {
  state.pendingNewSegments = 0;
  elements.jumpLatestBtn.classList.add('hidden');
}

function updateJumpLatestButton() {
  if (state.pendingNewSegments <= 0) {
    elements.jumpLatestBtn.classList.add('hidden');
    return;
  }
  elements.jumpLatestBtn.textContent = `Jump to latest (${state.pendingNewSegments})`;
  elements.jumpLatestBtn.classList.remove('hidden');
}

function isTypingElement(el) {
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return Boolean(el.isContentEditable);
}

function isActionableCall(call) {
  if (!call) return false;
  return call.status !== 'ended' && call.status !== 'failed';
}

function refreshActionButtons() {
  const enabled = Boolean(state.selectedCallId) && isActionableCall(state.callDetail) && !state.actionInFlight;
  elements.transferBtn.disabled = !enabled;
  elements.hangupBtn.disabled = !enabled;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }
  return response.json();
}

function renderCalls(reset) {
  if (reset) {
    elements.callsList.innerHTML = '';
  }
  const filteredCalls = getFilteredCalls();
  if (filteredCalls.length === 0) {
    const emptyText = state.calls.length
      ? 'No calls match this filter.'
      : 'No calls yet. Incoming calls will appear here.';
    elements.callsList.innerHTML = `<div class="empty-state">${emptyText}</div>`;
    elements.listMeta.textContent = state.calls.length ? 'No calls match your filter.' : '0 calls';
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const call of filteredCalls) {
    const card = document.createElement('div');
    card.className = 'call-card';
    if (call.call_id === state.selectedCallId) {
      card.classList.add('active');
    }
    card.dataset.callId = call.call_id;

    const title = document.createElement('h3');
    title.textContent = trimUri(call.from_uri);

    const badge = document.createElement('span');
    const status = call.status || 'unknown';
    badge.className = `badge ${status}`;
    badge.textContent = status;

    const metaLine = document.createElement('div');
    metaLine.className = 'meta-line';
    metaLine.textContent = `Started ${formatDateTime(call.started_at)}`;

    const timeLine = document.createElement('div');
    timeLine.className = 'meta-line';
    const updatedAt = call.updated_at || call.started_at;
    timeLine.textContent = `Updated ${formatDateTime(updatedAt)}`;

    card.appendChild(badge);
    card.appendChild(title);
    card.appendChild(metaLine);
    card.appendChild(timeLine);

    fragment.appendChild(card);
  }
  elements.callsList.innerHTML = '';
  elements.callsList.appendChild(fragment);
  elements.listMeta.textContent = `${filteredCalls.length} shown · ${state.calls.length} total`;
}

async function loadCalls({ reset }) {
  if (state.isLoadingCalls) return;
  state.isLoadingCalls = true;
  setStatus(elements.listStatus, 'Loading...');

  try {
    let url = apiUrl(`/api/calls?limit=${CALLS_PAGE_SIZE}`);
    if (state.statusFilter && state.statusFilter !== 'all') {
      url += `&status=${encodeURIComponent(state.statusFilter)}`;
    }
    if (!reset && state.nextCursor) {
      url += `&cursor=${encodeURIComponent(state.nextCursor)}`;
    }
    const data = await fetchJson(url);

    if (reset) {
      state.calls = data.items || [];
    } else {
      state.calls = state.calls.concat(data.items || []);
    }
    state.nextCursor = data.next_cursor || null;
    updateCallSummary();
    renderCalls(true);
    setStatus(elements.listStatus, 'Ready');
    elements.loadMoreCalls.disabled = !state.nextCursor;
  } catch (err) {
    setStatus(elements.listStatus, 'Error', 'error');
    elements.listMeta.textContent = 'Failed to load calls.';
    console.error(err);
  } finally {
    state.isLoadingCalls = false;
  }
}

async function loadCallDetail(callId) {
  if (!callId) return;
  const data = await fetchJson(apiUrl(`/api/calls/${callId}`));
  state.callDetail = data.call;
  renderCallMeta();
}

function renderCallMeta() {
  const call = state.callDetail;
  if (!call) {
    elements.callMeta.querySelectorAll('.meta-value').forEach((el) => {
      el.textContent = '-';
    });
    elements.callSubtitle.textContent = 'Pick a call to see details.';
    refreshActionButtons();
    return;
  }

  const values = [
    call.call_id,
    call.status || 'unknown',
    trimUri(call.from_uri),
    trimUri(call.to_uri),
    formatDateTime(call.started_at),
    formatDateTime(call.ended_at)
  ];

  elements.callMeta.querySelectorAll('.meta-value').forEach((el, index) => {
    el.textContent = values[index] || '-';
  });

  elements.callSubtitle.textContent = `Last update: ${formatDateTime(call.updated_at)} | Seq: ${call.last_seq || 0}`;
  refreshActionButtons();
}

function clearTranscript() {
  state.transcript = [];
  state.lastSeq = 0;
  state.segmentSet.clear();
  state.pendingNewSegments = 0;
  elements.transcript.innerHTML = '';
  elements.jumpLatestBtn.classList.add('hidden');
  elements.searchInput.value = '';
  state.searchTerm = '';
  setActionStatus('Idle');
  refreshActionButtons();
}

function applyTranscriptFilter() {
  const term = state.searchTerm;
  const segments = elements.transcript.querySelectorAll('.segment');
  segments.forEach((seg) => {
    const text = seg.dataset.text || '';
    if (!term || text.includes(term)) {
      seg.style.display = '';
    } else {
      seg.style.display = 'none';
    }
  });
}

function appendSegments(segments) {
  if (!segments || segments.length === 0) return;
  const fragment = document.createDocumentFragment();
  const shouldScroll = isNearBottom();
  let addedCount = 0;

  for (const segment of segments) {
    if (state.segmentSet.has(segment.seq)) continue;
    state.segmentSet.add(segment.seq);
    state.transcript.push(segment);
    state.lastSeq = Math.max(state.lastSeq, segment.seq);
    addedCount += 1;

    const card = document.createElement('div');
    card.className = `segment speaker-${segment.speaker || 'system'}`;
    card.dataset.text = (segment.text || '').toLowerCase();

    const meta = document.createElement('div');
    meta.className = 'segment-meta';
    const metaLeft = document.createElement('span');
    metaLeft.textContent = `${segment.speaker || 'system'} · seq ${segment.seq}`;
    const metaRight = document.createElement('span');
    metaRight.textContent = formatSegmentTime(segment.ts);
    meta.appendChild(metaLeft);
    meta.appendChild(metaRight);

    const text = document.createElement('div');
    text.className = 'segment-text';
    text.textContent = segment.text;

    card.appendChild(meta);
    card.appendChild(text);
    fragment.appendChild(card);
  }

  elements.transcript.appendChild(fragment);

  applyTranscriptFilter();

  if (state.autoScroll && shouldScroll) {
    scrollTranscriptToBottom();
    clearPendingSegments();
  } else if (addedCount > 0) {
    state.pendingNewSegments += addedCount;
    updateJumpLatestButton();
  }
}

async function loadTranscriptPage(afterSeq) {
  if (!state.selectedCallId || state.isLoadingTranscript) return;
  state.isLoadingTranscript = true;
  elements.loadMoreTranscript.disabled = true;

  try {
    const url = apiUrl(
      `/api/calls/${state.selectedCallId}/transcript?after_seq=${afterSeq}&limit=${TRANSCRIPT_PAGE_SIZE}`
    );
    const data = await fetchJson(url);
    appendSegments(data.items);
    const expectedLast = data.last_seq || state.lastSeq;
    elements.loadMoreTranscript.disabled = state.lastSeq >= expectedLast;
  } catch (err) {
    console.error(err);
  } finally {
    state.isLoadingTranscript = false;
  }
}

function updateCallInList(callId, updates) {
  const existing = state.calls.find((item) => item.call_id === callId);
  if (!existing) return;
  Object.assign(existing, updates);
  updateCallSummary();
  renderCalls(true);
}

function handleWsMessage(message) {
  if (!message) return;
  if (message.type === 'snapshot') {
    if (message.call) {
      state.callDetail = { ...state.callDetail, ...message.call };
      renderCallMeta();
      updateCallInList(message.call.call_id, message.call);
    }
    appendSegments(message.segments || []);
    return;
  }

  if (message.type === 'transcript.segment') {
    appendSegments([message.segment]);
    if (state.callDetail) {
      state.callDetail.last_seq = Math.max(state.callDetail.last_seq || 0, message.segment.seq || 0);
      renderCallMeta();
      updateCallInList(state.selectedCallId, { last_seq: state.callDetail.last_seq, updated_at: Math.floor(Date.now() / 1000) });
    }
    return;
  }

  if (message.type === 'call.status') {
    if (state.callDetail) {
      state.callDetail.status = message.status;
      if (message.ended_at) {
        state.callDetail.ended_at = message.ended_at;
      }
      renderCallMeta();
      updateCallInList(message.call_id, { status: message.status, ended_at: message.ended_at });
    }
  }
}

async function triggerCallAction(action, payload = {}) {
  if (!state.selectedCallId || state.actionInFlight) return;

  state.actionInFlight = true;
  refreshActionButtons();
  setActionStatus(action === 'transfer' ? 'Transferring...' : 'Ending call...', 'warning');

  try {
    const response = await fetch(
      apiUrl(`/api/calls/${encodeURIComponent(state.selectedCallId)}/actions/${encodeURIComponent(action)}`),
      {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload || {})
      }
    );

    let result = {};
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      result = await response.json().catch(() => ({}));
    } else {
      const text = await response.text().catch(() => '');
      result = text ? { message: text } : {};
    }

    const errorMessage =
      result?.error?.message || result?.message || `Action failed (${response.status})`;
    if (!response.ok || result?.ok === false || result?.status === 'error') {
      throw new Error(errorMessage);
    }

    if (action === 'hangup') {
      const endedAt = Math.floor(Date.now() / 1000);
      if (!state.callDetail) {
        state.callDetail = { call_id: state.selectedCallId };
      }
      state.callDetail.status = 'ended';
      state.callDetail.ended_at = endedAt;
      renderCallMeta();
      updateCallInList(state.selectedCallId, { status: 'ended', ended_at: endedAt });
      setActionStatus('Call ended', 'success');
      showToast('Call ended successfully.', 'success');
    } else {
      setActionStatus('Transfer requested', 'success');
      showToast('Transfer request sent.', 'success');
    }
  } catch (err) {
    setActionStatus('Action failed', 'error');
    showToast(err?.message || 'Action failed.', 'error', 3200);
    console.error(err);
  } finally {
    state.actionInFlight = false;
    refreshActionButtons();
  }
}

function connectWebSocket() {
  if (!state.selectedCallId) return;
  disconnectWebSocket();

  const url = wsUrl(`/ws/calls/${state.selectedCallId}?after_seq=${state.lastSeq}`);
  const ws = new WebSocket(url);
  state.ws = ws;
  setStatus(elements.wsStatus, 'Connecting...');

  ws.addEventListener('open', () => {
    state.wsConnected = true;
    setStatus(elements.wsStatus, 'Live');
  });

  ws.addEventListener('message', (event) => {
    try {
      const payload = JSON.parse(event.data);
      handleWsMessage(payload);
    } catch (_err) {}
  });

  ws.addEventListener('close', () => {
    state.wsConnected = false;
    setStatus(elements.wsStatus, 'Disconnected', 'error');
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    state.wsConnected = false;
    setStatus(elements.wsStatus, 'Error', 'error');
    scheduleReconnect();
  });
}

function disconnectWebSocket() {
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (state.reconnectTimer || !state.selectedCallId) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    if (!state.wsConnected) {
      connectWebSocket();
    }
  }, 2000);
}

function isNearBottom() {
  const el = elements.transcript;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}

function scrollTranscriptToBottom() {
  elements.transcript.scrollTop = elements.transcript.scrollHeight;
  clearPendingSegments();
}

function updateHash() {
  if (!state.selectedCallId) return;
  const url = new URL(window.location.href);
  url.hash = `call=${state.selectedCallId}`;
  history.replaceState(null, '', url.toString());
}

async function selectCall(callId) {
  if (!callId) return;
  state.selectedCallId = callId;
  updateHash();
  renderCalls(true);
  clearTranscript();
  if (isMobileViewport()) {
    setMobileView('transcript');
  }
  elements.callSubtitle.textContent = 'Loading call details...';

  try {
    await loadCallDetail(callId);
    await loadTranscriptPage(0);
    connectWebSocket();
  } catch (err) {
    console.error(err);
    elements.callSubtitle.textContent = 'Failed to load call details.';
  }
}

function exportTranscript(format) {
  if (!state.callDetail) return;
  const payload = {
    call: state.callDetail,
    transcript: state.transcript
  };
  let blob;
  let filename;

  if (format === 'json') {
    blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    filename = `${state.callDetail.call_id || 'call'}-transcript.json`;
  } else {
    const lines = ['seq,ts,speaker,text'];
    state.transcript.forEach((seg) => {
      const text = (seg.text || '').replace(/"/g, '""');
      lines.push(`${seg.seq},${seg.ts},${seg.speaker || ''},"${text}"`);
    });
    blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    filename = `${state.callDetail.call_id || 'call'}-transcript.csv`;
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function startPolling() {
  if (state.poller) clearInterval(state.poller);
  state.poller = setInterval(() => {
    loadCalls({ reset: true });
  }, 5000);
}

function init() {
  state.apiBase = resolveApiBase();
  elements.apiBaseInput.value = state.apiBase;
  setMobileView('calls');
  applyMobileViewClass();

  const hash = window.location.hash.replace('#', '');
  const match = hash.match(/call=([^&]+)/);
  if (match) {
    state.selectedCallId = decodeURIComponent(match[1]);
    if (isMobileViewport()) {
      state.mobileView = 'transcript';
    }
  }

  elements.statusFilter.value = state.statusFilter;

  elements.apiBaseInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const value = normalizeBase(event.target.value.trim());
      localStorage.setItem(STORAGE_KEY, value);
      state.apiBase = value;
      loadCalls({ reset: true });
      if (state.selectedCallId) {
        selectCall(state.selectedCallId);
      }
    }
  });

  elements.refreshBtn.addEventListener('click', () => {
    loadCalls({ reset: true });
  });

  elements.statusFilter.addEventListener('change', (event) => {
    state.statusFilter = event.target.value;
    loadCalls({ reset: true });
  });

  elements.callSearchInput.addEventListener('input', (event) => {
    state.callSearchTerm = event.target.value.trim().toLowerCase();
    renderCalls(true);
  });

  elements.showCallsBtn.addEventListener('click', () => {
    setMobileView('calls');
  });

  elements.showTranscriptBtn.addEventListener('click', () => {
    setMobileView('transcript');
  });

  elements.callsList.addEventListener('click', (event) => {
    const card = event.target.closest('.call-card');
    if (!card) return;
    const callId = card.dataset.callId;
    if (callId) selectCall(callId);
  });

  elements.loadMoreCalls.addEventListener('click', () => {
    loadCalls({ reset: false });
  });

  elements.loadMoreTranscript.addEventListener('click', () => {
    loadTranscriptPage(state.lastSeq);
  });

  elements.autoScrollToggle.addEventListener('change', (event) => {
    state.autoScroll = event.target.checked;
    if (state.autoScroll) {
      scrollTranscriptToBottom();
    }
  });

  elements.transcript.addEventListener('scroll', () => {
    if (isNearBottom()) {
      clearPendingSegments();
    }
  });

  elements.jumpLatestBtn.addEventListener('click', () => {
    scrollTranscriptToBottom();
  });

  elements.reconnectBtn.addEventListener('click', () => {
    connectWebSocket();
    showToast('Reconnecting stream...', 'warning', 1600);
  });

  elements.transferBtn.addEventListener('click', () => {
    if (!state.selectedCallId) return;
    const reason = window.prompt('Optional transfer reason:', '');
    if (reason === null) return;
    const payload = reason.trim() ? { reason: reason.trim() } : {};
    triggerCallAction('transfer', payload);
  });

  elements.hangupBtn.addEventListener('click', () => {
    if (!state.selectedCallId) return;
    const confirmed = window.confirm('End this call now?');
    if (!confirmed) return;
    triggerCallAction('hangup');
  });

  elements.searchInput.addEventListener('input', (event) => {
    state.searchTerm = event.target.value.trim().toLowerCase();
    applyTranscriptFilter();
  });

  elements.exportJson.addEventListener('click', () => {
    exportTranscript('json');
  });

  elements.exportCsv.addEventListener('click', () => {
    exportTranscript('csv');
  });

  window.addEventListener('resize', () => {
    applyMobileViewClass();
  });

  window.addEventListener('keydown', (event) => {
    if (isTypingElement(document.activeElement)) {
      return;
    }
    if (event.key === '/') {
      event.preventDefault();
      elements.searchInput.focus();
      return;
    }
    if ((event.key === 'r' || event.key === 'R') && event.metaKey) {
      return;
    }
    if (event.key === 'r' || event.key === 'R') {
      event.preventDefault();
      connectWebSocket();
      showToast('Reconnecting stream...', 'warning', 1600);
    }
  });

  loadCalls({ reset: true });
  startPolling();
  setActionStatus('Idle');
  refreshActionButtons();
  updateCallSummary();
  applyMobileViewClass();

  if (state.selectedCallId) {
    selectCall(state.selectedCallId);
  }
}

init();
