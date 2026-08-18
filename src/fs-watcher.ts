/**
 * Host-side workspace watcher for the sidebar file manager. One chokidar
 * watcher per working directory is shared by every subscriber (multiple tabs
 * / sessions pointing at the same cwd). The watcher is started lazily on the
 * first subscriber and stopped when the last one disconnects, so an idle
 * sidebar does not hold file descriptors open.
 *
 * The watch is deliberately bounded: recursion is capped at a shallow depth
 * and heavyweight/generated/system directories are ignored. Without this a
 * session whose cwd is a large tree (a user home directory, a monorepo with
 * many nested packages, a cache-heavy project) can make chokidar scan tens of
 * thousands of directories on first subscribe, stalling the whole web server
 * for seconds while the browser is loading. Ignored entries remain visible in
 * the file tree and can still be refreshed manually.
 */
import { watch, type FSWatcher } from 'chokidar'

/** How deep below the watched cwd chokidar recurses (0 = the cwd itself). */
const WATCH_DEPTH = 4

/**
 * Common heavyweight/system/generated directories that do not need live
 * auto-refresh. The alternation is anchored to path separators so `dist`,
 * `build`, `node_modules` etc. are ignored at any depth without matching
 * unrelated names like `distribution` or `building`.
 */
const IGNORED = /(^|[/\\])(\.git|node_modules|dist|build|\.next|out|coverage|\.cache|\.local|\.config|\.vscode|\.idea|\.vs|\.svn|\.hg|AppData|Application Data|Local Settings|\.venv|venv|__pycache__|Temp|tmp)([/\\]|$)/

/** How long to batch a burst of fs events before notifying subscribers. */
const NOTIFY_DEBOUNCE_MS = 50

interface WatcherEntry {
  watcher: FSWatcher
  listeners: Set<() => void>
  timer: ReturnType<typeof setTimeout> | undefined
}

/** Manages shared chokidar watchers keyed by absolute working directory. */
export class FsWatcherManager {
  private readonly watchers = new Map<string, WatcherEntry>()

  /**
   * Subscribe to file-tree change notifications for one working directory.
   * @returns a disposer that removes this listener and stops the shared
   * watcher when it was the last one.
   */
  subscribe(cwd: string, listener: () => void): () => void {
    let entry = this.watchers.get(cwd)
    if (entry === undefined) {
      const watcher = watch(cwd, {
        ignoreInitial: true,
        ignored: IGNORED,
        persistent: true,
        // Bound the recursive scan: a 4-level watch covers normal project
        // nesting without letting chokidar enumerate a huge tree.
        depth: WATCH_DEPTH,
      })
      const created: WatcherEntry = { watcher, listeners: new Set(), timer: undefined }
      this.watchers.set(cwd, created)
      entry = created
      const notify = (): void => {
        if (created.timer !== undefined) return
        created.timer = setTimeout(() => {
          created.timer = undefined
          for (const listener of created.listeners) listener()
        }, NOTIFY_DEBOUNCE_MS)
      }
      watcher.on('all', notify)
      watcher.on('error', (error) => {
        console.error('[dsh-better-sidebar] workspace watcher error:', error)
      })
    }
    const current = entry
    current.listeners.add(listener)
    return () => {
      current.listeners.delete(listener)
      if (current.listeners.size > 0) return
      if (current.timer !== undefined) clearTimeout(current.timer)
      current.watcher.close().catch(() => { /* already closed */ })
      this.watchers.delete(cwd)
    }
  }

  /** Stop every watcher (plugin teardown). */
  dispose(): void {
    for (const entry of this.watchers.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      entry.watcher.close().catch(() => { /* already closed */ })
    }
    this.watchers.clear()
  }
}
