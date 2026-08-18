/**
 * The files window's tree surface: a global file-name search box on top
 * (300ms debounce; an in-flight search is aborted by the next keystroke)
 * over either the shared controlled FileTree (empty query) or the flat
 * result list (relative paths; click opens through the caller's mode-aware
 * open). Owns its refresh tick: the icon next to the search input clears
 * the tree cache. EditorHost docks it as the tab's right panel (wrapped in
 * a drag-resize handle) and provides the file context-menu open escapes.
 */
import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { IconRefreshOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { api } from './api.ts'
import { FileTree } from './FileTree.tsx'
import { t } from './locales.ts'
import { resolveSidebarPath } from './produced-files.ts'
import css from './sidebar.module.css'

export function TreePanel(props: {
  sessionId: string
  cwd: string | undefined
  expanded: string[]
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  /** File context-menu "open in a new tab" (passed through to FileTree). */
  onOpenFileNewTab?: (path: string) => void
  /** File context-menu "open to the side" (passed through to FileTree). */
  onOpenFileSide?: (path: string) => void
  onReferenceFile: (path: string) => void
  /** Full-window presentation: the panel fills its host instead of docking
   *  at a fixed width. */
  full?: boolean
  /** Whether the host workspace watcher should push refresh signals here
   *  (the "auto-refresh file tree" setting lives with the editor settings). */
  autoRefresh?: boolean
}) {
  const { sessionId, cwd, expanded, onToggle, onOpenFile, onOpenFileNewTab, onOpenFileSide, onReferenceFile, full, autoRefresh } = props
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ matches: string[]; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)

  // The host workspace watcher pushes a lightweight `change` signal whenever
  // the session's working directory changes on disk. Only enabled by the
  // user-facing `autoRefreshFiles` setting; the socket reconnects on drops
  // and follows cwd changes (the host resolves the authoritative cwd). The
  // watcher is intentionally lazy: it starts only once the tree actually has
  // a working directory to render, so a slow session-cwd lookup never makes
  // the host scan a workspace just to paint the sidebar shell.
  useEffect(() => {
    if (autoRefresh !== true) return
    if (cwd === undefined || cwd === '') return
    let socket: WebSocket | null = null
    let retry: number | undefined
    let closed = false
    const connect = (): void => {
      if (closed) return
      const url = new URL('/sidebar/ws/fs-events', location.origin)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const params = new URLSearchParams({ sessionId })
      if (cwd !== undefined && cwd !== '') params.set('cwd', cwd)
      url.search = params.toString()
      socket = new WebSocket(url.toString())
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return
        try {
          const message = JSON.parse(event.data) as { type?: string }
          if (message.type === 'change') setRefreshTick(tick => tick + 1)
        } catch {
          // Malformed push: ignore (the next push will refresh).
        }
      }
      socket.onclose = () => {
        if (closed) return
        retry = window.setTimeout(connect, 2000)
      }
      socket.onerror = () => { socket?.close() }
    }
    connect()
    return () => {
      closed = true
      window.clearTimeout(retry)
      socket?.close()
    }
  }, [autoRefresh, sessionId, cwd])

  const needle = query.trim()
  useEffect(() => {
    if (needle === '') {
      setResults(null)
      setError(null)
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      api.fsSearch({ sessionId, cwd }, needle, controller.signal).then((found) => {
        setResults(found)
        setError(null)
      }).catch((failure: unknown) => {
        if (controller.signal.aborted) return
        setResults(null)
        setError(failure instanceof Error ? failure.message : String(failure))
      })
    }, 300)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [sessionId, cwd, needle])

  return (
    <div className={clsx(css.editorTreePanel, full === true && css.editorTreePanelFull)}>
      <div className={css.editorTreeSearch}>
        <input
          className={css.editorSearchInput}
          value={query}
          placeholder={t('editorSearchPlaceholder')}
          spellCheck={false}
          onChange={(event) => { setQuery(event.target.value) }}
        />
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('refresh')}
          title={t('refresh')}
          onClick={() => { setRefreshTick(tick => tick + 1) }}
        >
          <IconRefreshOutline16 size={14} />
        </button>
      </div>
      {needle === '' ? (
        <FileTree
          sessionId={sessionId}
          cwd={cwd}
          expanded={expanded}
          onToggle={onToggle}
          onOpenFile={onOpenFile}
          onOpenFileNewTab={onOpenFileNewTab}
          onOpenFileSide={onOpenFileSide}
          onReferenceFile={onReferenceFile}
          refreshTick={refreshTick}
        />
      ) : (
        <div className={css.explorerBody}>
          {error !== null && <div className={clsx(css.editorSearchHint, css.editorError)}>{error}</div>}
          {error === null && results === null && <div className={css.editorSearchHint}>{t('loading')}</div>}
          {error === null && results !== null && results.matches.length === 0 && (
            <div className={css.editorSearchHint}>{t('editorSearchNoResults')}</div>
          )}
          {error === null && results !== null && results.matches.map(rel => (
            <button
              key={rel}
              type="button"
              className={css.editorSearchResult}
              title={rel}
              onClick={() => { onOpenFile(resolveSidebarPath(cwd, rel)) }}
            >
              {rel}
            </button>
          ))}
          {error === null && results?.truncated === true && (
            <div className={css.editorSearchHint}>{t('editorSearchTruncated')}</div>
          )}
        </div>
      )}
    </div>
  )
}
