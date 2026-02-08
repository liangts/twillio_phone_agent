import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const STORAGE_KEY = 'callboard_api_base'
const DEFAULT_STATUS = 'live'
const CALLS_PAGE_SIZE = 50
const TRANSCRIPT_PAGE_SIZE = 200

type CallStatus = 'incoming' | 'live' | 'ended' | 'failed' | string

type CallSummary = {
  call_id: string
  status?: CallStatus
  started_at?: number | null
  ended_at?: number | null
  from_uri?: string | null
  to_uri?: string | null
  conference_name?: string | null
  last_seq?: number | null
  updated_at?: number | null
  provider?: string | null
  created_at?: number | null
}

type TranscriptSegment = {
  seq: number
  ts: number
  speaker?: string
  text: string
}

type CallsResponse = {
  items?: CallSummary[]
  next_cursor?: string | null
}

type CallDetailResponse = {
  call?: CallSummary
}

type TranscriptResponse = {
  items?: TranscriptSegment[]
  last_seq?: number
}

type ToastVariant = 'success' | 'error' | 'warning'

type ToastState = {
  message: string
  variant: ToastVariant
} | null

function normalizeBase(value: string): string {
  return value.replace(/\/+$/, '')
}

function trimUri(value: string | null | undefined): string {
  if (!value) return '-'
  return value.replace(/^sip:/, '').replace(/^tel:/, '')
}

function formatDateTime(seconds: number | null | undefined): string {
  if (!seconds) return '-'
  return new Date(seconds * 1000).toLocaleString()
}

function formatSegmentTime(raw: number | string | null | undefined): string {
  if (!raw) return '-'
  const num = Number(raw)
  if (!Number.isFinite(num)) return '-'
  const ms = num < 1e12 ? num * 1000 : num
  return new Date(ms).toLocaleTimeString()
}

function parseSelectedCallFromHash(): string | null {
  const hash = window.location.hash.replace('#', '')
  const match = hash.match(/call=([^&]+)/)
  if (!match) return null
  return decodeURIComponent(match[1])
}

function resolveApiBase(): string {
  const url = new URL(window.location.href)
  const param = url.searchParams.get('api')
  const envBase =
    typeof import.meta.env.VITE_API_BASE === 'string' ? import.meta.env.VITE_API_BASE : ''
  if (param) {
    const normalized = normalizeBase(param)
    localStorage.setItem(STORAGE_KEY, normalized)
    return normalized
  }
  return normalizeBase(localStorage.getItem(STORAGE_KEY) || envBase || '')
}

function isNearBottom(el: HTMLElement | null): boolean {
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120
}

function isTypingElement(el: Element | null): boolean {
  if (!el) return false
  const target = el as HTMLElement
  const tag = target.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.headers || {}),
    },
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || `Request failed: ${response.status}`)
  }

  return (await response.json()) as T
}

function App() {
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const toastTimerRef = useRef<number | null>(null)
  const segmentSetRef = useRef<Set<number>>(new Set())
  const selectedCallRef = useRef<string | null>(parseSelectedCallFromHash())
  const lastSeqRef = useRef(0)
  const nextCursorRef = useRef<string | null>(null)

  const [apiBase, setApiBase] = useState<string>(resolveApiBase)
  const [apiInput, setApiInput] = useState<string>(resolveApiBase)
  const [statusFilter, setStatusFilter] = useState<string>(DEFAULT_STATUS)
  const [calls, setCalls] = useState<CallSummary[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [selectedCallId, setSelectedCallId] = useState<string | null>(parseSelectedCallFromHash)
  const [callDetail, setCallDetail] = useState<CallSummary | null>(null)
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([])
  const [lastSeq, setLastSeq] = useState(0)
  const [isLoadingCalls, setIsLoadingCalls] = useState(false)
  const [isLoadingTranscript, setIsLoadingTranscript] = useState(false)
  const [listStatus, setListStatus] = useState('Idle')
  const [wsStatus, setWsStatus] = useState('Disconnected')
  const [actionStatus, setActionStatus] = useState<{ text: string; variant?: ToastVariant }>({
    text: 'Idle',
  })
  const [detailMessage, setDetailMessage] = useState('Pick a call to see details.')
  const [callSearchTerm, setCallSearchTerm] = useState('')
  const [transcriptSearchTerm, setTranscriptSearchTerm] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [pendingNewSegments, setPendingNewSegments] = useState(0)
  const [actionInFlight, setActionInFlight] = useState(false)
  const [toast, setToast] = useState<ToastState>(null)
  const [isMobile, setIsMobile] = useState(window.matchMedia('(max-width: 900px)').matches)
  const [mobileView, setMobileView] = useState<'calls' | 'transcript'>(
    parseSelectedCallFromHash() && window.matchMedia('(max-width: 900px)').matches
      ? 'transcript'
      : 'calls'
  )

  const showToast = useCallback((message: string, variant: ToastVariant = 'success', timeoutMs = 2600) => {
    setToast({ message, variant })
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current)
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null)
      toastTimerRef.current = null
    }, timeoutMs)
  }, [])

  const apiUrl = useCallback(
    (path: string): string => {
      const normalizedPath = path.startsWith('/') ? path : `/${path}`
      return `${apiBase}${normalizedPath}`
    },
    [apiBase]
  )

  const wsUrl = useCallback(
    (path: string): string => {
      const normalizedPath = path.startsWith('/') ? path : `/${path}`
      const base = (apiBase || window.location.origin).replace(/^http/i, 'ws')
      return `${base}${normalizedPath}`
    },
    [apiBase]
  )

  const clearPendingSegments = useCallback(() => {
    setPendingNewSegments(0)
  }, [])

  const scrollTranscriptToBottom = useCallback(() => {
    const el = transcriptRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    clearPendingSegments()
  }, [clearPendingSegments])

  const disconnectWebSocket = useCallback(() => {
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    if (wsRef.current) {
      wsRef.current.onopen = null
      wsRef.current.onclose = null
      wsRef.current.onerror = null
      wsRef.current.onmessage = null
      wsRef.current.close()
      wsRef.current = null
    }
    setWsStatus('Disconnected')
  }, [])

  const updateCallInList = useCallback((callId: string, updates: Partial<CallSummary>) => {
    setCalls((prev) => prev.map((item) => (item.call_id === callId ? { ...item, ...updates } : item)))
  }, [])

  const appendSegments = useCallback(
    (segments: TranscriptSegment[]) => {
      if (!segments.length) return

      const shouldScroll = autoScroll && isNearBottom(transcriptRef.current)
      let added = 0
      let addedMaxSeq = lastSeqRef.current

      setTranscript((prev) => {
        const next = [...prev]
        for (const segment of segments) {
          const seq = Number(segment.seq)
          if (!Number.isFinite(seq)) continue
          if (segmentSetRef.current.has(seq)) continue
          segmentSetRef.current.add(seq)
          next.push({ ...segment, seq })
          added += 1
          if (seq > addedMaxSeq) {
            addedMaxSeq = seq
          }
        }
        return next
      })

      if (!added) return
      setLastSeq((prev) => Math.max(prev, addedMaxSeq))

      if (shouldScroll) {
        window.requestAnimationFrame(() => {
          scrollTranscriptToBottom()
        })
      } else {
        setPendingNewSegments((prev) => prev + added)
      }
    },
    [autoScroll, scrollTranscriptToBottom]
  )

  const loadCallDetail = useCallback(
    async (callId: string) => {
      const response = await fetchJson<CallDetailResponse>(apiUrl(`/api/calls/${encodeURIComponent(callId)}`))
      if (!response.call) {
        throw new Error('Call detail is missing in response.')
      }
      setCallDetail(response.call)
    },
    [apiUrl]
  )

  const loadTranscriptPage = useCallback(
    async (callId: string, afterSeq: number) => {
      if (isLoadingTranscript) return
      setIsLoadingTranscript(true)
      try {
        const data = await fetchJson<TranscriptResponse>(
          apiUrl(
            `/api/calls/${encodeURIComponent(callId)}/transcript?after_seq=${afterSeq}&limit=${TRANSCRIPT_PAGE_SIZE}`
          )
        )
        appendSegments(data.items || [])
        if (typeof data.last_seq === 'number') {
          setCallDetail((prev) => {
            if (!prev || prev.call_id !== callId) return prev
            return { ...prev, last_seq: Math.max(prev.last_seq || 0, data.last_seq || 0) }
          })
        }
      } finally {
        setIsLoadingTranscript(false)
      }
    },
    [apiUrl, appendSegments, isLoadingTranscript]
  )

  const handleWsMessage = useCallback(
    (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const message = payload as Record<string, unknown>
      const type = typeof message.type === 'string' ? message.type : ''

      if (type === 'snapshot') {
        const call = message.call as CallSummary | undefined
        if (call?.call_id) {
          setCallDetail((prev) => ({ ...(prev || {}), ...call }))
          updateCallInList(call.call_id, call)
        }
        const segments = Array.isArray(message.segments)
          ? (message.segments as TranscriptSegment[])
          : []
        appendSegments(segments)
        return
      }

      if (type === 'transcript.segment') {
        const segment = message.segment as TranscriptSegment | undefined
        if (!segment) return
        appendSegments([segment])
        setCallDetail((prev) => {
          if (!prev) return prev
          return { ...prev, last_seq: Math.max(prev.last_seq || 0, segment.seq || 0) }
        })
        if (selectedCallRef.current) {
          updateCallInList(selectedCallRef.current, {
            last_seq: Math.max(callDetail?.last_seq || 0, segment.seq || 0),
            updated_at: Math.floor(Date.now() / 1000),
          })
        }
        return
      }

      if (type === 'call.status') {
        const callId = String(message.call_id || '')
        const status = String(message.status || '')
        const endedAt = typeof message.ended_at === 'number' ? message.ended_at : undefined
        if (!callId || !status) return
        setCallDetail((prev) => {
          if (!prev || prev.call_id !== callId) return prev
          return { ...prev, status, ended_at: endedAt ?? prev.ended_at }
        })
        updateCallInList(callId, { status, ended_at: endedAt })
      }
    },
    [appendSegments, callDetail?.last_seq, updateCallInList]
  )

  const connectWebSocket = useCallback(
    function openSocket(callId: string) {
      disconnectWebSocket()
      const url = wsUrl(`/ws/calls/${encodeURIComponent(callId)}?after_seq=${lastSeqRef.current}`)
      const ws = new WebSocket(url)
      wsRef.current = ws
      setWsStatus('Connecting...')

      ws.onopen = () => {
        setWsStatus('Live')
      }

      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(String(event.data))
          handleWsMessage(parsed)
        } catch {
          // Ignore malformed events.
        }
      }

      const scheduleReconnect = () => {
        if (reconnectTimerRef.current || selectedCallRef.current !== callId) return
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null
          if (selectedCallRef.current === callId) {
            openSocket(callId)
          }
        }, 2000)
      }

      ws.onclose = () => {
        if (wsRef.current === ws) {
          wsRef.current = null
        }
        setWsStatus('Disconnected')
        scheduleReconnect()
      }

      ws.onerror = () => {
        setWsStatus('Error')
        scheduleReconnect()
      }
    },
    [disconnectWebSocket, handleWsMessage, wsUrl]
  )

  const loadCalls = useCallback(
    async (reset: boolean, statusOverride?: string) => {
      if (isLoadingCalls) return
      if (!reset && !nextCursorRef.current) return

      setIsLoadingCalls(true)
      setListStatus('Loading...')
      try {
        let url = apiUrl(`/api/calls?limit=${CALLS_PAGE_SIZE}`)
        const resolvedStatus = statusOverride ?? statusFilter
        if (resolvedStatus && resolvedStatus !== 'all') {
          url += `&status=${encodeURIComponent(resolvedStatus)}`
        }
        if (!reset && nextCursorRef.current) {
          url += `&cursor=${encodeURIComponent(nextCursorRef.current)}`
        }

        const data = await fetchJson<CallsResponse>(url)
        const items = data.items || []

        setCalls((prev) => (reset ? items : prev.concat(items)))
        const cursor = data.next_cursor || null
        setNextCursor(cursor)
        nextCursorRef.current = cursor
        setListStatus('Ready')
      } catch (err) {
        setListStatus('Error')
        showToast(err instanceof Error ? err.message : 'Failed to load calls.', 'error')
      } finally {
        setIsLoadingCalls(false)
      }
    },
    [apiUrl, isLoadingCalls, showToast, statusFilter]
  )

  const triggerCallAction = useCallback(
    async (action: 'transfer' | 'hangup', payload: Record<string, unknown> = {}) => {
      if (!selectedCallId || actionInFlight) return

      setActionInFlight(true)
      setActionStatus({
        text: action === 'transfer' ? 'Transferring...' : 'Ending call...',
        variant: 'warning',
      })

      try {
        const response = await fetch(apiUrl(`/api/calls/${encodeURIComponent(selectedCallId)}/actions/${action}`), {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        })

        let body: Record<string, unknown> = {}
        const contentType = response.headers.get('content-type') || ''
        if (contentType.includes('application/json')) {
          body = (await response.json().catch(() => ({}))) as Record<string, unknown>
        } else {
          const text = await response.text().catch(() => '')
          body = text ? { message: text } : {}
        }

        if (!response.ok || body.ok === false || body.status === 'error') {
          throw new Error(
            String(
              (body.error as { message?: string } | undefined)?.message ||
                body.message ||
                `Action failed (${response.status})`
            )
          )
        }

        if (action === 'hangup') {
          const endedAt = Math.floor(Date.now() / 1000)
          setCallDetail((prev) => (prev ? { ...prev, status: 'ended', ended_at: endedAt } : prev))
          updateCallInList(selectedCallId, { status: 'ended', ended_at: endedAt })
          setActionStatus({ text: 'Call ended', variant: 'success' })
          showToast('Call ended successfully.', 'success')
        } else {
          setActionStatus({ text: 'Transfer requested', variant: 'success' })
          showToast('Transfer request sent.', 'success')
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Action failed.'
        setActionStatus({ text: 'Action failed', variant: 'error' })
        showToast(message, 'error', 3200)
      } finally {
        setActionInFlight(false)
      }
    },
    [actionInFlight, apiUrl, selectedCallId, showToast, updateCallInList]
  )

  const exportTranscript = useCallback(
    (format: 'json' | 'csv') => {
      if (!callDetail) return

      let content = ''
      let filename = ''
      let mime = ''
      if (format === 'json') {
        content = JSON.stringify({ call: callDetail, transcript }, null, 2)
        filename = `${callDetail.call_id || 'call'}-transcript.json`
        mime = 'application/json'
      } else {
        const lines = ['seq,ts,speaker,text']
        transcript.forEach((segment) => {
          const safeText = (segment.text || '').replace(/"/g, '""')
          lines.push(`${segment.seq},${segment.ts},${segment.speaker || ''},"${safeText}"`)
        })
        content = lines.join('\n')
        filename = `${callDetail.call_id || 'call'}-transcript.csv`
        mime = 'text/csv'
      }

      const blob = new Blob([content], { type: mime })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    },
    [callDetail, transcript]
  )

  const actionableCall =
    Boolean(selectedCallId && callDetail) && callDetail?.status !== 'ended' && callDetail?.status !== 'failed'
  const actionButtonsDisabled = !actionableCall || actionInFlight

  const filteredCalls = useMemo(() => {
    if (!callSearchTerm) return calls
    return calls.filter((call) => {
      const callId = (call.call_id || '').toLowerCase()
      const from = trimUri(call.from_uri).toLowerCase()
      const to = trimUri(call.to_uri).toLowerCase()
      return callId.includes(callSearchTerm) || from.includes(callSearchTerm) || to.includes(callSearchTerm)
    })
  }, [callSearchTerm, calls])

  const callSummary = useMemo(() => {
    return calls.reduce(
      (acc, call) => {
        if (call.status === 'live') acc.live += 1
        else if (call.status === 'incoming') acc.incoming += 1
        else if (call.status === 'ended') acc.ended += 1
        return acc
      },
      { live: 0, incoming: 0, ended: 0 }
    )
  }, [calls])

  const filteredTranscript = useMemo(() => {
    if (!transcriptSearchTerm) return transcript
    return transcript.filter((segment) =>
      (segment.text || '').toLowerCase().includes(transcriptSearchTerm)
    )
  }, [transcript, transcriptSearchTerm])

  const callSubtitle = callDetail
    ? `Last update: ${formatDateTime(callDetail.updated_at)} | Seq: ${callDetail.last_seq || 0}`
    : detailMessage

  const canLoadMoreCalls = Boolean(nextCursor)
  const canLoadMoreTranscript = Boolean(callDetail) && lastSeq < (callDetail?.last_seq || 0)

  useEffect(() => {
    selectedCallRef.current = selectedCallId
  }, [selectedCallId])

  useEffect(() => {
    lastSeqRef.current = lastSeq
  }, [lastSeq])

  useEffect(() => {
    nextCursorRef.current = nextCursor
  }, [nextCursor])

  useEffect(() => {
    const handler = () => {
      const mobile = window.matchMedia('(max-width: 900px)').matches
      setIsMobile(mobile)
      if (!mobile) {
        setMobileView('calls')
      }
    }
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])

  useEffect(() => {
    if (selectedCallId) {
      const url = new URL(window.location.href)
      url.hash = `call=${encodeURIComponent(selectedCallId)}`
      history.replaceState(null, '', url.toString())
    }
  }, [selectedCallId])

  useEffect(() => {
    void loadCalls(true)
    const poller = window.setInterval(() => {
      void loadCalls(true)
    }, 5000)
    return () => window.clearInterval(poller)
  }, [loadCalls])

  useEffect(() => {
    disconnectWebSocket()

    if (!selectedCallId) {
      setCallDetail(null)
      setTranscript([])
      setLastSeq(0)
      setPendingNewSegments(0)
      segmentSetRef.current.clear()
      setDetailMessage('Pick a call to see details.')
      return
    }

    if (isMobile) {
      setMobileView('transcript')
    }

    let cancelled = false
    setDetailMessage('Loading call details...')
    setCallDetail(null)
    setTranscript([])
    setLastSeq(0)
    setPendingNewSegments(0)
    segmentSetRef.current.clear()

    ;(async () => {
      try {
        await loadCallDetail(selectedCallId)
        if (cancelled) return
        await loadTranscriptPage(selectedCallId, 0)
        if (cancelled) return
        connectWebSocket(selectedCallId)
      } catch (err) {
        if (!cancelled) {
          setDetailMessage('Failed to load call details.')
          showToast(err instanceof Error ? err.message : 'Failed to load call details.', 'error')
        }
      }
    })()

    return () => {
      cancelled = true
      disconnectWebSocket()
    }
  }, [
    connectWebSocket,
    disconnectWebSocket,
    isMobile,
    loadCallDetail,
    loadTranscriptPage,
    selectedCallId,
    showToast,
  ])

  useEffect(() => {
    const el = transcriptRef.current
    if (!el) return
    const onScroll = () => {
      if (isNearBottom(el)) {
        clearPendingSegments()
      }
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [clearPendingSegments])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingElement(document.activeElement)) return
      if (event.key === '/') {
        event.preventDefault()
        const searchInput = document.getElementById('transcriptSearchInput')
        if (searchInput instanceof HTMLInputElement) {
          searchInput.focus()
        }
        return
      }
      if ((event.key === 'r' || event.key === 'R') && !event.metaKey && !event.ctrlKey) {
        event.preventDefault()
        if (selectedCallRef.current) {
          connectWebSocket(selectedCallRef.current)
          showToast('Reconnecting stream...', 'warning', 1600)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [connectWebSocket, showToast])

  useEffect(
    () => () => {
      disconnectWebSocket()
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current)
      }
    },
    [disconnectWebSocket]
  )

  return (
    <div className={`page ${isMobile ? (mobileView === 'transcript' ? 'view-transcript' : 'view-calls') : ''}`}>
      <header className="topbar">
        <div className="brand">
          <div className="logo-mark">CB</div>
          <div>
            <div className="brand-title">Callboard</div>
            <div className="brand-subtitle">Live call list + transcript console</div>
          </div>
        </div>
        <div className="controls">
          <label className="control">
            <span>API base</span>
            <input
              value={apiInput}
              onChange={(event) => setApiInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                const value = normalizeBase(apiInput.trim())
                localStorage.setItem(STORAGE_KEY, value)
                setApiBase(value)
              }}
              placeholder="https://your-worker.workers.dev"
            />
          </label>
          <label className="control">
            <span>Status</span>
            <select
              value={statusFilter}
              onChange={(event) => {
                const value = event.target.value
                setStatusFilter(value)
                nextCursorRef.current = null
                setNextCursor(null)
                void loadCalls(true, value)
              }}
            >
              <option value="live">Live</option>
              <option value="ended">Ended</option>
              <option value="all">All</option>
            </select>
          </label>
          <button className="button" onClick={() => void loadCalls(true)}>
            Refresh
          </button>
        </div>
      </header>

      {isMobile && (
        <div className="mobile-tabs">
          <button
            className={`button ghost ${mobileView === 'calls' ? 'active' : ''}`}
            onClick={() => setMobileView('calls')}
          >
            Calls
          </button>
          <button
            className={`button ghost ${mobileView === 'transcript' ? 'active' : ''}`}
            onClick={() => setMobileView('transcript')}
          >
            Transcript
          </button>
        </div>
      )}

      <main className="layout">
        <section className="panel list-panel">
          <div className="panel-header">
            <div>
              <h2>Calls</h2>
              <p className="muted">Select a call to stream transcripts in real time.</p>
            </div>
            <div className={`status-pill ${listStatus === 'Error' ? 'error' : ''}`}>{listStatus}</div>
          </div>

          <div className="list-toolbar">
            <input
              value={callSearchTerm}
              onChange={(event) => setCallSearchTerm(event.target.value.trim().toLowerCase())}
              placeholder="Search phone / call id"
            />
            <div className="summary-row">
              <span className="summary-pill">Live {callSummary.live}</span>
              <span className="summary-pill">Incoming {callSummary.incoming}</span>
              <span className="summary-pill">Ended {callSummary.ended}</span>
            </div>
          </div>

          <div className="call-list">
            {!filteredCalls.length ? (
              <div className="empty-state">
                {calls.length ? 'No calls match this filter.' : 'No calls yet. Incoming calls will appear here.'}
              </div>
            ) : (
              filteredCalls.map((call) => (
                <button
                  key={call.call_id}
                  className={`call-card ${selectedCallId === call.call_id ? 'active' : ''}`}
                  onClick={() => setSelectedCallId(call.call_id)}
                >
                  <span className={`badge ${call.status || 'unknown'}`}>{call.status || 'unknown'}</span>
                  <h3>{trimUri(call.from_uri)}</h3>
                  <div className="meta-line">Started {formatDateTime(call.started_at)}</div>
                  <div className="meta-line">Updated {formatDateTime(call.updated_at || call.started_at)}</div>
                </button>
              ))
            )}
          </div>

          <div className="panel-footer">
            <button
              className="button ghost"
              disabled={!canLoadMoreCalls || isLoadingCalls}
              onClick={() => void loadCalls(false)}
            >
              Load more
            </button>
            <div className="muted">
              {filteredCalls.length === calls.length
                ? `${calls.length} calls`
                : `${filteredCalls.length} shown · ${calls.length} total`}
            </div>
          </div>
        </section>

        <section className="panel detail-panel">
          <div className="panel-header">
            <div>
              <h2>Transcript</h2>
              <p className="muted">{callSubtitle}</p>
            </div>
            <div className="detail-actions">
              <input
                id="transcriptSearchInput"
                value={transcriptSearchTerm}
                onChange={(event) => setTranscriptSearchTerm(event.target.value.trim().toLowerCase())}
                placeholder="Search transcript"
              />
              <button className="button ghost" onClick={() => exportTranscript('json')}>
                Export JSON
              </button>
              <button className="button ghost" onClick={() => exportTranscript('csv')}>
                Export CSV
              </button>
            </div>
          </div>

          <div className="call-meta">
            <div className="meta-card">
              <div className="meta-label">Call ID</div>
              <div className="meta-value">{callDetail?.call_id || '-'}</div>
            </div>
            <div className="meta-card">
              <div className="meta-label">Status</div>
              <div className="meta-value">{callDetail?.status || '-'}</div>
            </div>
            <div className="meta-card">
              <div className="meta-label">From</div>
              <div className="meta-value">{trimUri(callDetail?.from_uri)}</div>
            </div>
            <div className="meta-card">
              <div className="meta-label">To</div>
              <div className="meta-value">{trimUri(callDetail?.to_uri)}</div>
            </div>
            <div className="meta-card">
              <div className="meta-label">Started</div>
              <div className="meta-value">{formatDateTime(callDetail?.started_at)}</div>
            </div>
            <div className="meta-card">
              <div className="meta-label">Ended</div>
              <div className="meta-value">{formatDateTime(callDetail?.ended_at)}</div>
            </div>
          </div>

          <div className="transcript-wrap">
            <div ref={transcriptRef} className="transcript">
              {!filteredTranscript.length ? (
                <div className="empty-state">No transcript segments yet.</div>
              ) : (
                filteredTranscript.map((segment) => (
                  <div key={`${segment.seq}-${segment.ts}`} className={`segment speaker-${segment.speaker || 'system'}`}>
                    <div className="segment-meta">
                      <span>
                        {segment.speaker || 'system'} · seq {segment.seq}
                      </span>
                      <span>{formatSegmentTime(segment.ts)}</span>
                    </div>
                    <div className="segment-text">{segment.text}</div>
                  </div>
                ))
              )}
            </div>
            {pendingNewSegments > 0 && (
              <button className="button jump-latest" onClick={scrollTranscriptToBottom}>
                Jump to latest ({pendingNewSegments})
              </button>
            )}
          </div>

          <div className="panel-footer detail-footer">
            <div className="footer-left">
              <button
                className="button ghost"
                disabled={!canLoadMoreTranscript || isLoadingTranscript || !selectedCallId}
                onClick={() => {
                  if (!selectedCallId) return
                  void loadTranscriptPage(selectedCallId, lastSeq)
                }}
              >
                Load more
              </button>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={(event) => {
                    setAutoScroll(event.target.checked)
                    if (event.target.checked) {
                      scrollTranscriptToBottom()
                    }
                  }}
                />
                <span>Auto-scroll</span>
              </label>
            </div>
            <div className="footer-right">
              <button
                className="button ghost"
                disabled={actionButtonsDisabled}
                onClick={() => {
                  const reason = window.prompt('Optional transfer reason:', '')
                  if (reason === null) return
                  const payload = reason.trim() ? { reason: reason.trim() } : {}
                  void triggerCallAction('transfer', payload)
                }}
              >
                Transfer
              </button>
              <button
                className="button danger"
                disabled={actionButtonsDisabled}
                onClick={() => {
                  const confirmed = window.confirm('End this call now?')
                  if (!confirmed) return
                  void triggerCallAction('hangup')
                }}
              >
                End call
              </button>
              <button
                className="button"
                disabled={!selectedCallId}
                onClick={() => {
                  if (!selectedCallId) return
                  connectWebSocket(selectedCallId)
                  showToast('Reconnecting stream...', 'warning', 1600)
                }}
              >
                Reconnect
              </button>
              <div className={`status-pill ${actionStatus.variant || ''}`}>{actionStatus.text}</div>
              <div className={`status-pill ${wsStatus === 'Error' ? 'error' : ''}`}>{wsStatus}</div>
            </div>
          </div>
        </section>
      </main>

      {toast && <div className={`toast ${toast.variant}`}>{toast.message}</div>}
    </div>
  )
}

export default App
