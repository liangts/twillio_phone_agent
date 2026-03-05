'use strict';

const STORAGE_KEY = 'callboard_api_base';
const DEFAULT_STATUS = 'live';
const CALLS_PAGE_SIZE = 50;
const TRANSCRIPT_PAGE_SIZE = 200;
const LAUNCHES_PAGE_SIZE = 25;

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
  toast: document.getElementById('toast'),
  launchToInput: document.getElementById('launchToInput'),
  launchTemplateSelect: document.getElementById('launchTemplateSelect'),
  launchObjectiveInput: document.getElementById('launchObjectiveInput'),
  launchSubmitBtn: document.getElementById('launchSubmitBtn'),
  launchRequestStatus: document.getElementById('launchRequestStatus'),
  launchesList: document.getElementById('launchesList'),
  refreshLaunchesBtn: document.getElementById('refreshLaunchesBtn'),
  templateList: document.getElementById('templateList'),
  templateIdInput: document.getElementById('templateIdInput'),
  templateNameInput: document.getElementById('templateNameInput'),
  templateDescriptionInput: document.getElementById('templateDescriptionInput'),
  templateInstructionsInput: document.getElementById('templateInstructionsInput'),
  templateVoiceInput: document.getElementById('templateVoiceInput'),
  templateModelInput: document.getElementById('templateModelInput'),
  templateActiveInput: document.getElementById('templateActiveInput'),
  templateDefaultInput: document.getElementById('templateDefaultInput'),
  templateSaveBtn: document.getElementById('templateSaveBtn'),
  templateResetBtn: document.getElementById('templateResetBtn')
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
  toastTimer: null,
  launches: [],
  launchesNextCursor: null,
  isLoadingLaunches: false,
  launchInFlight: false,
  templates: [],
  isLoadingTemplates: false,
  editingTemplateId: null,
  selectedTemplateId: null
};

function normalizeBase(value) {
  if (!value) return '';
  return value.replace(/\/+$/, '');
}

function normalizeE164(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  return /^\+[1-9]\d{7,14}$/.test(trimmed) ? trimmed : null;
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

function trimUri(value) {
  if (!value) return '-';
  return String(value).replace(/^sip:/i, '').replace(/^tel:/i, '');
}

function setStatus(el, text, variant) {
  if (!el) return;
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

function setLaunchStatus(text, variant) {
  setStatus(elements.launchRequestStatus, text, variant);
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

async function fetchJson(url, init) {
  const response = await fetch(url, {
    ...(init || {}),
    headers: {
      Accept: 'application/json',
      ...(init?.headers || {})
    }
  });

  const contentType = response.headers.get('content-type') || '';
  let payload = null;
  if (contentType.includes('application/json')) {
    payload = await response.json().catch(() => null);
  } else {
    const text = await response.text().catch(() => '');
    payload = text ? { message: text } : {};
  }

  if (!response.ok) {
    const errMsg = payload?.error?.message || payload?.message || `Request failed: ${response.status}`;
    throw new Error(errMsg);
  }

  return payload;
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
    const direction = call.direction ? ` · ${call.direction}` : '';
    metaLine.textContent = `Started ${formatDateTime(call.started_at)}${direction}`;

    const timeLine = document.createElement('div');
    timeLine.className = 'meta-line';
    const updatedAt = call.updated_at || call.started_at;
    const launchSuffix = call.launch_id ? ` · launch ${call.launch_id}` : '';
    timeLine.textContent = `Updated ${formatDateTime(updatedAt)}${launchSuffix}`;

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

function renderLaunches() {
  const launches = state.launches || [];
  if (!launches.length) {
    elements.launchesList.innerHTML = '<div class="empty-state">No launches yet.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const launch of launches) {
    const card = document.createElement('div');
    card.className = 'launch-card';

    const top = document.createElement('div');
    top.className = 'launch-top';

    const status = document.createElement('span');
    status.className = `badge ${launch.status || 'unknown'}`;
    status.textContent = launch.status || 'unknown';

    const id = document.createElement('span');
    id.className = 'launch-id';
    id.textContent = launch.launch_id;

    top.appendChild(status);
    top.appendChild(id);

    const target = document.createElement('div');
    target.className = 'meta-line';
    target.textContent = `Target ${trimUri(launch.target_e164)}`;

    const template = document.createElement('div');
    template.className = 'meta-line';
    template.textContent = `Template ${launch.template_id || '-'}`;

    const updated = document.createElement('div');
    updated.className = 'meta-line';
    updated.textContent = `Updated ${formatDateTime(launch.updated_at)}`;

    const actionRow = document.createElement('div');
    actionRow.className = 'launch-actions';

    if (launch.openai_call_id) {
      const openBtn = document.createElement('button');
      openBtn.className = 'button ghost small';
      openBtn.textContent = 'Open Call';
      openBtn.dataset.openCallId = launch.openai_call_id;
      actionRow.appendChild(openBtn);
    }

    if (launch.error_message) {
      const err = document.createElement('div');
      err.className = 'meta-line error-text';
      err.textContent = launch.error_message;
      actionRow.appendChild(err);
    }

    card.appendChild(top);
    card.appendChild(target);
    card.appendChild(template);
    card.appendChild(updated);
    if (actionRow.childNodes.length) {
      card.appendChild(actionRow);
    }

    fragment.appendChild(card);
  }

  elements.launchesList.innerHTML = '';
  elements.launchesList.appendChild(fragment);
}

function renderTemplateOptions() {
  const select = elements.launchTemplateSelect;
  const templates = state.templates.filter((item) => Number(item.is_active) === 1);

  select.innerHTML = '';
  if (!templates.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No active templates';
    select.appendChild(option);
    state.selectedTemplateId = null;
    return;
  }

  const preferred =
    state.selectedTemplateId && templates.find((item) => item.template_id === state.selectedTemplateId)
      ? state.selectedTemplateId
      : (templates.find((item) => Number(item.is_default) === 1)?.template_id || templates[0].template_id);

  state.selectedTemplateId = preferred;

  for (const template of templates) {
    const option = document.createElement('option');
    option.value = template.template_id;
    const suffix = Number(template.is_default) === 1 ? ' (default)' : '';
    option.textContent = `${template.name}${suffix}`;
    if (template.template_id === preferred) {
      option.selected = true;
    }
    select.appendChild(option);
  }
}

function renderTemplateList() {
  const templates = state.templates || [];
  if (!templates.length) {
    elements.templateList.innerHTML = '<div class="empty-state">No templates yet.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const template of templates) {
    const card = document.createElement('div');
    card.className = 'template-card';

    const top = document.createElement('div');
    top.className = 'template-top';

    const title = document.createElement('strong');
    title.textContent = template.name;

    const badges = document.createElement('div');
    badges.className = 'template-badges';

    const idBadge = document.createElement('span');
    idBadge.className = 'summary-pill';
    idBadge.textContent = template.template_id;
    badges.appendChild(idBadge);

    const activeBadge = document.createElement('span');
    activeBadge.className = `summary-pill ${Number(template.is_active) ? 'success-pill' : 'warning-pill'}`;
    activeBadge.textContent = Number(template.is_active) ? 'active' : 'inactive';
    badges.appendChild(activeBadge);

    if (Number(template.is_default) === 1) {
      const defaultBadge = document.createElement('span');
      defaultBadge.className = 'summary-pill';
      defaultBadge.textContent = 'default';
      badges.appendChild(defaultBadge);
    }

    top.appendChild(title);
    top.appendChild(badges);

    const desc = document.createElement('div');
    desc.className = 'meta-line';
    desc.textContent = template.description || 'No description';

    const actions = document.createElement('div');
    actions.className = 'template-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'button ghost small';
    editBtn.textContent = 'Edit';
    editBtn.dataset.templateId = template.template_id;
    editBtn.dataset.action = 'edit';

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'button ghost small';
    toggleBtn.textContent = Number(template.is_active) ? 'Deactivate' : 'Activate';
    toggleBtn.dataset.templateId = template.template_id;
    toggleBtn.dataset.action = Number(template.is_active) ? 'deactivate' : 'activate';

    const defaultBtn = document.createElement('button');
    defaultBtn.className = 'button ghost small';
    defaultBtn.textContent = 'Set default';
    defaultBtn.dataset.templateId = template.template_id;
    defaultBtn.dataset.action = 'default';
    defaultBtn.disabled = Number(template.is_default) === 1;

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'button ghost small';
    deleteBtn.textContent = 'Delete';
    deleteBtn.dataset.templateId = template.template_id;
    deleteBtn.dataset.action = 'delete';

    actions.appendChild(editBtn);
    actions.appendChild(toggleBtn);
    actions.appendChild(defaultBtn);
    actions.appendChild(deleteBtn);

    card.appendChild(top);
    card.appendChild(desc);
    card.appendChild(actions);
    fragment.appendChild(card);
  }

  elements.templateList.innerHTML = '';
  elements.templateList.appendChild(fragment);
}

function clearTemplateForm() {
  state.editingTemplateId = null;
  elements.templateIdInput.value = '';
  elements.templateNameInput.value = '';
  elements.templateDescriptionInput.value = '';
  elements.templateInstructionsInput.value = '';
  elements.templateVoiceInput.value = '';
  elements.templateModelInput.value = '';
  elements.templateActiveInput.checked = true;
  elements.templateDefaultInput.checked = false;
  elements.templateIdInput.disabled = false;
  elements.templateSaveBtn.textContent = 'Save Template';
}

function fillTemplateForm(template) {
  state.editingTemplateId = template.template_id;
  elements.templateIdInput.value = template.template_id;
  elements.templateNameInput.value = template.name || '';
  elements.templateDescriptionInput.value = template.description || '';
  elements.templateInstructionsInput.value = template.instruction_block || '';
  elements.templateVoiceInput.value = template.voice_override || '';
  elements.templateModelInput.value = template.model_override || '';
  elements.templateActiveInput.checked = Number(template.is_active) === 1;
  elements.templateDefaultInput.checked = Number(template.is_default) === 1;
  elements.templateIdInput.disabled = true;
  elements.templateSaveBtn.textContent = 'Update Template';
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
    showToast(err?.message || 'Failed to load calls.', 'error');
  } finally {
    state.isLoadingCalls = false;
  }
}

async function loadLaunches({ reset }) {
  if (state.isLoadingLaunches) return;
  state.isLoadingLaunches = true;

  try {
    let url = apiUrl(`/api/outbound/launches?limit=${LAUNCHES_PAGE_SIZE}`);
    if (!reset && state.launchesNextCursor) {
      url += `&cursor=${encodeURIComponent(state.launchesNextCursor)}`;
    }

    const data = await fetchJson(url);
    if (reset) {
      state.launches = data.items || [];
    } else {
      state.launches = state.launches.concat(data.items || []);
    }
    state.launchesNextCursor = data.next_cursor || null;
    renderLaunches();
  } catch (err) {
    showToast(err?.message || 'Failed to load launches.', 'error');
  } finally {
    state.isLoadingLaunches = false;
  }
}

async function loadTemplates() {
  if (state.isLoadingTemplates) return;
  state.isLoadingTemplates = true;

  try {
    const data = await fetchJson(apiUrl('/api/outbound/templates?include_inactive=1'));
    state.templates = data.items || [];
    renderTemplateOptions();
    renderTemplateList();
  } catch (err) {
    showToast(err?.message || 'Failed to load templates.', 'error');
  } finally {
    state.isLoadingTemplates = false;
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
    call.direction || 'inbound',
    call.launch_id || '-',
    call.template_id || '-',
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
    showToast(err?.message || 'Failed to load transcript.', 'error');
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
      updateCallInList(state.selectedCallId, {
        last_seq: state.callDetail.last_seq,
        updated_at: Math.floor(Date.now() / 1000)
      });
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
    const result = await fetchJson(
      apiUrl(`/api/calls/${encodeURIComponent(state.selectedCallId)}/actions/${encodeURIComponent(action)}`),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload || {})
      }
    );

    if (result?.ok === false || result?.status === 'error') {
      throw new Error(result?.error?.message || result?.message || 'Action failed');
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
  } finally {
    state.actionInFlight = false;
    refreshActionButtons();
  }
}

async function triggerOutboundLaunch() {
  if (state.launchInFlight) return;
  const to = normalizeE164(elements.launchToInput.value);
  if (!to) {
    showToast('Target must be E.164 format, e.g. +14155550123.', 'error', 3000);
    return;
  }

  const templateId = elements.launchTemplateSelect.value || null;
  if (!templateId) {
    showToast('Select an active template before launching.', 'error', 3000);
    return;
  }

  state.launchInFlight = true;
  elements.launchSubmitBtn.disabled = true;
  setLaunchStatus('Launching...', 'warning');

  try {
    const payload = {
      to,
      template_id: templateId,
      objective_note: elements.launchObjectiveInput.value.trim() || null
    };

    const response = await fetchJson(apiUrl('/api/outbound/launches'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const launchId = response?.launch?.launch_id || response?.launch_id || 'new launch';
    setLaunchStatus('Queued', 'success');
    showToast(`Launch ${launchId} queued.`, 'success');

    elements.launchObjectiveInput.value = '';
    await loadLaunches({ reset: true });
    await loadCalls({ reset: true });
  } catch (err) {
    setLaunchStatus('Failed', 'error');
    showToast(err?.message || 'Failed to launch outbound call.', 'error', 3200);
  } finally {
    state.launchInFlight = false;
    elements.launchSubmitBtn.disabled = false;
  }
}

function collectTemplatePayload() {
  const templateId = elements.templateIdInput.value.trim();
  const name = elements.templateNameInput.value.trim();
  const instructionBlock = elements.templateInstructionsInput.value.trim();

  if (!templateId && !state.editingTemplateId) {
    throw new Error('Template ID is required.');
  }
  if (!name) {
    throw new Error('Template name is required.');
  }
  if (!instructionBlock) {
    throw new Error('Instruction block is required.');
  }

  return {
    template_id: templateId,
    name,
    description: elements.templateDescriptionInput.value.trim() || null,
    instruction_block: instructionBlock,
    voice_override: elements.templateVoiceInput.value.trim() || null,
    model_override: elements.templateModelInput.value.trim() || null,
    is_active: elements.templateActiveInput.checked,
    is_default: elements.templateDefaultInput.checked
  };
}

async function saveTemplate() {
  let payload;
  try {
    payload = collectTemplatePayload();
  } catch (err) {
    showToast(err?.message || 'Invalid template payload.', 'error', 3200);
    return;
  }

  elements.templateSaveBtn.disabled = true;

  try {
    if (state.editingTemplateId) {
      const updatePayload = { ...payload };
      delete updatePayload.template_id;
      await fetchJson(apiUrl(`/api/outbound/templates/${encodeURIComponent(state.editingTemplateId)}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatePayload)
      });
      showToast('Template updated.', 'success');
    } else {
      await fetchJson(apiUrl('/api/outbound/templates'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      showToast('Template created.', 'success');
    }

    await loadTemplates();
    clearTemplateForm();
  } catch (err) {
    showToast(err?.message || 'Failed to save template.', 'error', 3200);
  } finally {
    elements.templateSaveBtn.disabled = false;
  }
}

async function updateTemplate(templateId, payload, successMessage) {
  await fetchJson(apiUrl(`/api/outbound/templates/${encodeURIComponent(templateId)}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (successMessage) {
    showToast(successMessage, 'success');
  }
  await loadTemplates();
}

async function deleteTemplate(templateId) {
  const confirmed = window.confirm(`Delete template ${templateId}?`);
  if (!confirmed) return;

  try {
    await fetchJson(apiUrl(`/api/outbound/templates/${encodeURIComponent(templateId)}`), {
      method: 'DELETE'
    });
    showToast('Template deleted.', 'success');
    if (state.editingTemplateId === templateId) {
      clearTemplateForm();
    }
    await loadTemplates();
  } catch (err) {
    showToast(err?.message || 'Failed to delete template.', 'error', 3200);
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
    elements.callSubtitle.textContent = 'Failed to load call details.';
    showToast(err?.message || 'Failed to load call details.', 'error');
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
    loadLaunches({ reset: true });
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
      loadLaunches({ reset: true });
      loadTemplates();
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

  elements.launchesList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-open-call-id]');
    if (!button) return;
    const callId = button.dataset.openCallId;
    if (callId) {
      selectCall(callId);
      showToast(`Opening call ${callId}`, 'success', 1400);
    }
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

  elements.launchTemplateSelect.addEventListener('change', (event) => {
    state.selectedTemplateId = event.target.value || null;
  });

  elements.launchSubmitBtn.addEventListener('click', () => {
    triggerOutboundLaunch();
  });

  elements.refreshLaunchesBtn.addEventListener('click', () => {
    loadLaunches({ reset: true });
  });

  elements.templateSaveBtn.addEventListener('click', () => {
    saveTemplate();
  });

  elements.templateResetBtn.addEventListener('click', () => {
    clearTemplateForm();
  });

  elements.templateList.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-template-id]');
    if (!button) return;

    const templateId = button.dataset.templateId;
    const action = button.dataset.action;
    if (!templateId || !action) return;

    const template = state.templates.find((item) => item.template_id === templateId);
    if (!template) return;

    try {
      if (action === 'edit') {
        fillTemplateForm(template);
        return;
      }

      if (action === 'delete') {
        await deleteTemplate(templateId);
        return;
      }

      if (action === 'default') {
        await updateTemplate(templateId, { is_default: true, is_active: true }, 'Default template updated.');
        return;
      }

      if (action === 'activate') {
        await updateTemplate(templateId, { is_active: true }, 'Template activated.');
        return;
      }

      if (action === 'deactivate') {
        await updateTemplate(templateId, { is_active: false }, 'Template deactivated.');
      }
    } catch (err) {
      showToast(err?.message || 'Template action failed.', 'error', 3200);
    }
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
  loadLaunches({ reset: true });
  loadTemplates();
  startPolling();
  setActionStatus('Idle');
  setLaunchStatus('Idle');
  refreshActionButtons();
  updateCallSummary();
  applyMobileViewClass();
  clearTemplateForm();

  if (state.selectedCallId) {
    selectCall(state.selectedCallId);
  }
}

init();
