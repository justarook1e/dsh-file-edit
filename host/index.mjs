// dsh-file-edit — static host plugin.
// Persisted across DSH restarts: mounted from ~/.dsh/profiles/web/cordis.patch.yml.
// Browser RPC arrives at POST /dsh-file-edit/api (registered on ctx.webServer).
// Per-session review state (baseline + pending decisions) is persisted under
// ~/.dsh/dsh-file-edit-state/<sessionId>.json so accept/reject survives restarts.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'

const STATE_DIR = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-file-edit-state')
// v1.10.0 rename migration: the plugin used to live under dsh-files with its
// state in dsh-files-state/. Carry the old per-session review state (pending
// decisions, baselines, lastReject) over once so the rename does not reset
// every session's review state.
{
  const legacy = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-files-state')
  if (!existsSync(STATE_DIR) && existsSync(legacy)) {
    try { renameSync(legacy, STATE_DIR) } catch (e) {
      console.error('[dsh-file-edit] state migration failed:', e && e.message ? e.message : e)
    }
  }
}
mkdirSync(STATE_DIR, { recursive: true })

export default {
  // Hard dependencies: the loader waits for these host services to become
  // ACTIVE before apply runs (ctx.get is strict about fiber state and can
  // return undefined when the bundle layer is still settling).
  inject: ['fs', 'sandboxPolicy', 'sessions', 'webServer', 'shell'],
  apply(ctx) {
    const fs = ctx.fs
    const sandboxPolicy = ctx.sandboxPolicy
    const sessions = ctx.sessions
    const shell = ctx.shell
    const webServer = ctx.webServer
    if (!fs || !sandboxPolicy || !sessions || !webServer) {
      console.error('[dsh-file-edit] missing host services (fs, sandboxPolicy, sessions, webServer)')
      return
    }

    const MAX_CONTENT_BYTES = 512 * 1024
    const MAX_DIFF_LINES = 8000
    const MAX_ENTRIES = 8000
    const MAX_DEPTH = 16
    const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', '.dsh', '.idea', '.vscode', '.cache', '.turbo', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.eslintcache', '.DS_Store'])
    // shell/pwsh included: agent-side deletions (rm / Remove-Item) run through
    // the shell tool, not the fs write tools. Scans are lazy + coalesced by the
    // client's 6s poll, so the extra coverage costs at most one walk per poll.
    const MUTATING_TOOLS = new Set(['write', 'edit', 'shell', 'pwsh'])
    const knownSessions = new Set()
    // Undo safety: reject overwrites disk with baseline content, so every
    // reject snapshots the pre-reject bytes first (one undo level per
    // session). Binary baseline blobs and undo backups skip bigger files.
    const MAX_BACKUP_BYTES = 4 * 1024 * 1024
    // v1.9: markdown files render fully in the viewer (no line cap, no
    // preview truncation). Content beyond the 512KB scan cap is read ON
    // DEMAND when the file is opened, bounded by this payload ceiling
    // (32MB — shipping more than that as JSON would defeat the purpose).
    const MAX_MD_RENDER_BYTES = 32 * 1024 * 1024

    // ---------- text / path helpers ----------
    function splitLines(text) {
      if (!text) return []
      const t = text.replace(/\r\n/g, '\n')
      const parts = t.split('\n')
      if (t.endsWith('\n')) parts.pop()
      return parts
    }
    function joinLines(lines, trailingNL, crlf) {
      if (lines.length === 0) return ''
      const sep = crlf ? '\r\n' : '\n'
      return lines.join(sep) + (trailingNL ? sep : '')
    }
    function joinPath(root, rel) {
      const sep = root.indexOf('\\') >= 0 ? '\\' : '/'
      return root.replace(/[\\/]+$/, '') + sep + rel.split('/').join(sep)
    }
    // Normalize a tool-provided path (write/edit `file_path`) to a workspace-
    // relative path. Absolute paths must live under the session root;
    // relative paths are cleaned (`./` stripped, backslashes unified) and
    // `..`/empty segments rejected. Returns null when the path cannot be
    // attributed to a workspace file (caller falls back to window mode).
    function normalizeRelPath(root, raw) {
      if (!root || typeof raw !== 'string' || raw === '') return null
      let p = raw.replace(/\\/g, '/')
      if (/^[A-Za-z]:\//.test(p) || p.startsWith('/')) {
        const r = String(root).replace(/\\/g, '/').replace(/\/+$/, '')
        const cmp = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s
        if (cmp(p) === cmp(r)) p = ''
        else if (cmp(p).startsWith(cmp(r) + '/')) p = p.slice(r.length + 1)
        else return null
      } else {
        p = p.replace(/^\.\//, '')
      }
      if (p === '' || p.split('/').some((s) => s === '' || s === '.' || s === '..')) return null
      return p
    }
    // v1.9: markdown files get a full rendered view in the client. The flag
    // rides the entry so diffPayload can ship the whole document (no line
    // cap) without knowing the path at every call site.
    function isMarkdownPath(rel) {
      const base = String(rel || '').split('/').pop().toLowerCase()
      return base.endsWith('.md') || base.endsWith('.markdown')
    }
    function cloneEntry(e) {
      return { present: e.present, content: e.content, eol: e.eol, crlf: e.crlf === true, version: e.version, size: e.size, note: e.note, binRef: e.binRef ?? null, binSize: e.binSize ?? 0, md: e.md === true }
    }
    // "File was not in the baseline" as an explicit ABSENT entry instead of
    // null: every consumer (modifiedFiles / diffPayload / reject paths) then
    // treats it as a regular entry with present:false, which is what makes
    // newly created files render as one big "added" hunk and lets reject
    // restore the pre-file state (delete it).
    function absentEntry() {
      return { present: false, content: null, eol: false, crlf: false, version: null, size: 0, note: undefined, binRef: null, binSize: 0, md: false }
    }

    // ---------- line diff (Myers) ----------
    function myersOps(a, b) {
      const n = a.length, m = b.length
      let start = 0
      while (start < n && start < m && a[start] === b[start]) start++
      let endA = n, endB = m
      while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
      const na = endA - start, nb = endB - start
      if (na === 0 && nb === 0) return []
      if (na + nb > 6000) return null
      const max = na + nb
      const MAX_D = Math.min(400, max)
      const v = new Array(2 * max + 1).fill(0)
      const trace = []
      let found = -1
      outer: for (let d = 0; d <= MAX_D; d++) {
        trace.push(v.slice())
        for (let k = -d; k <= d; k += 2) {
          const idx = k + max
          let x
          if (k === -d || (k !== d && v[idx - 1] < v[idx + 1])) x = v[idx + 1]
          else x = v[idx - 1] + 1
          let y = x - k
          while (x < na && y < nb && a[start + x] === b[start + y]) { x++; y++ }
          v[idx] = x
          if (x >= na && y >= nb) { found = d; break outer }
        }
      }
      if (found < 0) return null
      let x = na, y = nb
      const rev = []
      for (let d = found; d >= 0; d--) {
        const vp = trace[d]
        const k = x - y
        const idx = k + max
        let prevK
        if (k === -d || (k !== d && vp[idx - 1] < vp[idx + 1])) prevK = k + 1
        else prevK = k - 1
        const prevX = vp[prevK + max]
        const prevY = prevX - prevK
        while (x > prevX && y > prevY) { rev.push({ t: 'e', i: start + x - 1, j: start + y - 1 }); x--; y-- }
        if (d > 0) {
          if (x === prevX) rev.push({ t: 'i', j: start + prevY })
          else rev.push({ t: 'd', i: start + prevX })
        }
        x = prevX; y = prevY
      }
      rev.reverse()
      return rev
    }

    function computeHunks(a, b) {
      const ops = myersOps(a, b)
      if (ops === null) {
        return [{ id: 'h0', oldStart: 0, oldLen: a.length, newStart: 0, newLen: b.length, newLines: b.slice() }]
      }
      const hunks = []
      let i = 0
      while (i < ops.length) {
        const op = ops[i]
        if (op.t === 'e') { i++; continue }
        const h = { oldStart: -1, oldLen: 0, newStart: -1, newLen: 0, newLines: [] }
        while (i < ops.length && ops[i].t !== 'e') {
          const o = ops[i]
          if (o.t === 'd') { if (h.oldStart < 0) h.oldStart = o.i; h.oldLen++ }
          else { if (h.newStart < 0) h.newStart = o.j; h.newLen++; h.newLines.push(b[o.j]) }
          i++
        }
        // The fallbacks below must NOT use eqA/eqB: the common prefix/suffix
        // is trimmed inside myersOps, so the ops array holds no equal ops
        // and eqA/eqB stay 0 for every trimmed diff. For a pure run the
        // missing coordinate equals the present one — the trimmed prefix
        // aligns both files up to the change point, so:
        //   pure deletion (oldStart set, newStart unset) → newStart = oldStart
        //   pure insertion (newStart set, oldStart unset) → oldStart = newStart
        // (The old `= eqA` / `= eqB` fallbacks produced 0 for ANY pure
        // deletion/insertion: a deleted line's hunk claimed newStart 0, so
        // the client rendered it at the very top; and an accepted insertion
        // hunk merged at the top of the file.)
        if (h.oldStart < 0) h.oldStart = h.newStart
        if (h.newStart < 0) h.newStart = h.oldStart
        hunks.push(h)
      }
      for (let k = 0; k < hunks.length; k++) hunks[k].id = 'h' + k
      return hunks
    }

    function mergeHunks(a, hunks, decisions) {
      const out = a.slice()
      for (let i = hunks.length - 1; i >= 0; i--) {
        const h = hunks[i]
        if (decisions.get(h.id) === 'reject') continue
        out.splice(h.oldStart, h.oldLen, ...h.newLines)
      }
      return out
    }

    // ---------- per-session state (with disk persistence) ----------
    function sidSafe(sid) {
      return sid.replace(/[^a-zA-Z0-9._-]/g, '_')
    }
    function stateFile(sid) {
      return join(STATE_DIR, sidSafe(sid) + '.json')
    }
    function undoRoot(sid) { return join(STATE_DIR, sidSafe(sid), 'undo') }
    function blobRoot(sid) { return join(STATE_DIR, sidSafe(sid), 'blobs') }
    function newUndoRec() {
      return { opId: 'op-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), files: [] }
    }
    // Publish (or drop) the reject-undo record. A reject that produced no
    // backups must also clear a stale previous record, otherwise the undo
    // toast would revert an older operation than the one just performed.
    function commitUndo(st, rec) {
      const root = undoRoot(st.sid)
      if (!rec || rec.files.length === 0) {
        st.lastReject = null
        if (rec) { try { rmSync(join(root, rec.opId), { recursive: true, force: true }) } catch (e) {} }
        return
      }
      st.lastReject = { opId: rec.opId, ts: Date.now(), files: rec.files }
      // Single undo level: drop any older backup dirs for this session.
      try {
        if (existsSync(root)) {
          for (const name of readdirSync(root)) {
            if (name !== rec.opId) { try { rmSync(join(root, name), { recursive: true, force: true }) } catch (e) {} }
          }
        }
      } catch (e) {}
    }
    function saveState(st) {
      try {
        const files = {}
        for (const entry of st.files) {
          files[entry[0]] = {
            base: entry[1].base,
            cur: entry[1].cur,
            rev: entry[1].rev,
            decisions: Object.fromEntries(entry[1].decisions),
          }
        }
        writeFileSync(stateFile(st.sid), JSON.stringify({ root: st.root, baseReady: st.baseReady, files, lastReject: st.lastReject ?? null }))
        // GC: drop binary blob files no longer referenced by any entry.
        try {
          const dir = blobRoot(st.sid)
          if (existsSync(dir)) {
            const refs = new Set()
            for (const entry of st.files) {
              const f = entry[1]
              if (f.base && f.base.binRef) refs.add(f.base.binRef)
              if (f.cur && f.cur.binRef) refs.add(f.cur.binRef)
            }
            for (const name of readdirSync(dir)) {
              if (!refs.has(name)) { try { rmSync(join(dir, name), { force: true }) } catch (e) {} }
            }
          }
        } catch (e) {}
      } catch (e) {
        console.error('[dsh-file-edit] saveState failed:', e)
      }
    }
    function loadState(sid) {
      try {
        const raw = readFileSync(stateFile(sid), 'utf8')
        const data = JSON.parse(raw)
        if (!data || typeof data !== 'object') return null
        const files = new Map()
        for (const key of Object.keys(data.files ?? {})) {
          const f = data.files[key]
          // Heal legacy states: base === null meant "not in baseline" but
          // every consumer expected a present:false entry.
          const base = f.base ?? absentEntry()
          if (base.crlf === undefined) base.crlf = false
          if (typeof base.binRef !== 'string') base.binRef = null
          const cur = f.cur ?? null
          if (cur && cur.crlf === undefined) cur.crlf = false
          if (cur && typeof cur.binRef !== 'string') cur.binRef = null
          files.set(key, {
            base: base,
            cur: cur,
            rev: f.rev ?? 0,
            decisions: new Map(Object.entries(f.decisions ?? {})),
          })
        }
        const lr = data.lastReject
        const lastReject = lr && typeof lr.opId === 'string' && Array.isArray(lr.files)
          ? { opId: lr.opId, ts: lr.ts ?? 0, files: lr.files }
          : null
        return { root: data.root ?? null, baseReady: data.baseReady === true, files, lastReject }
      } catch (e) {
        return null
      }
    }

    function bumpTree(st) { st.treeStamp = (st.treeStamp || 0) + 1 }

    function newState(sid) {
      const restored = loadState(sid)
      return {
        sid,
        root: restored?.root ?? null, policy: null, error: null,
        files: restored?.files ?? new Map(),
        scanning: null, dirty: false, scannedAt: 0,
        baseReady: restored?.baseReady ?? false,
        lastReject: restored?.lastReject ?? null,
        // v1.8 change attribution (direction B): the review covers changes
        // that flowed through the AGENT's tool channel, not the file system
        // as a whole. `touched` = explicit paths from write/edit tool calls
        // that the next scan should review; `shellWindow` = an opaque shell/
        // pwsh command ran, so every non-pending change found by the next
        // scan is conservatively attributed to it. Both are process-local
        // (persisting attribution across restarts would be wrong: a fresh
        // page/turn should not re-review already-folded user files).
        touched: new Set(),
        shellWindow: false,
        // Monotonic counter bumped by every mutating tool result. The scan
        // snapshots it at entry and clears `dirty` only when no mutation
        // landed mid-scan (a mid-scan write must not be swallowed by the
        // scan's own dirty=false).
        mutationStamp: 0,
        // Monotonic per-session notification counter: bumped whenever the FILE
        // SET (not just content) changed. The client polls it via getModified
        // and reloads the sidebar file tree on change. Process-local only —
        // persistence is unnecessary (a fresh page reload re-fetches the tree).
        treeStamp: 0,
      }
    }
    const states = new Map()
    function stateFor(sid) {
      let s = states.get(sid)
      if (!s) { s = newState(sid); states.set(sid, s) }
      return s
    }

    // ---------- long-poll change wake-ups ----------
    // The client polls getModified every 6s as its fallback, but an agent
    // tool result only SETS the dirty flag — diff stats then lag until the
    // next poll. These waiters let a long-polled `wait` request resolve the
    // moment a mutation event lands (bursts are coalesced by a short timer),
    // so the client refreshes the stats immediately.
    const waiters = new Map()
    function notify(sid) {
      const set = waiters.get(sid)
      if (!set || set.size === 0) return
      waiters.delete(sid)
      for (const resolve of set) { try { resolve({ ok: true, changed: true }) } catch (e) {} }
    }
    const notifyTimers = new Map()
    function scheduleNotify(sid, delay) {
      const existing = notifyTimers.get(sid)
      if (existing) clearTimeout(existing)
      notifyTimers.set(sid, setTimeout(() => { notifyTimers.delete(sid); notify(sid) }, delay))
    }
    function requireState(args) {
      const sid = args && args.sessionId ? String(args.sessionId) : ''
      if (!sid) return null
      knownSessions.add(sid)
      return stateFor(sid)
    }
    function resolveSession(sid) {
      const session = sessions.get(sid)
      if (!session) return { error: 'session-not-found' }
      const cwd = session.header && session.header.cwd
      if (!cwd) return { error: 'no-workspace' }
      // Policy resolution must never take the scan down: a transient policy
      // failure is a retryable scan error, not a fatal one.
      let policy
      try { policy = sandboxPolicy.resolve({ session }) } catch (e) { policy = {} }
      return { session, policy, root: cwd }
    }

    // ---------- scanning ----------
    async function loadFileEntry(st, rel) {
      const md = isMarkdownPath(rel)
      const target = await fs.resolve(joinPath(st.root, rel))
      let info
      try { info = await fs.stat(target) } catch (e) { info = undefined }
      if (!info) return { present: false, content: null, eol: false, crlf: false, version: null, size: 0, binRef: null, binSize: 0, md: md }
      if (info.size > MAX_CONTENT_BYTES) {
        return { present: true, content: null, eol: false, crlf: false, version: info.version, size: info.size, note: 'large', binRef: null, binSize: 0, md: md }
      }
      try {
        const text = await fs.readText(target)
        return { present: true, content: text.replace(/\r\n/g, '\n'), eol: text.endsWith('\n'), crlf: /\r\n/.test(text), version: info.version, size: info.size, binRef: null, binSize: 0, md: md }
      } catch (e) {
        // Binary content (readText refused it): snapshot the raw bytes (up to
        // MAX_BACKUP_BYTES) into the per-session blob dir so a later reject
        // can restore the baseline. Bigger binaries stay unrestorable.
        let binRef = null
        let binSize = 0
        if (info.size <= MAX_BACKUP_BYTES) {
          try {
            const bytes = await fs.readBytes(target, undefined, MAX_BACKUP_BYTES)
            const hash = createHash('sha1').update(rel).update(String(info.version)).digest('hex')
            const blobPath = join(blobRoot(st.sid), hash)
            if (!existsSync(blobPath)) {
              mkdirSync(blobRoot(st.sid), { recursive: true })
              writeFileSync(blobPath, bytes)
            }
            binRef = hash
            binSize = bytes.length
          } catch (e2) { binRef = null }
        }
        return { present: true, content: null, eol: false, crlf: false, version: info.version, size: info.size, note: 'binary', binRef: binRef, binSize: binSize, md: md }
      }
    }

    async function refreshOne(st, rel, w) {
      let f = st.files.get(rel)
      if (!f) { f = { base: null, cur: null, rev: 0, decisions: new Map() }; st.files.set(rel, f) }
      if (f.cur && f.cur.present && f.cur.version === w.version && f.cur.size === w.size) {
        return f
      }
      if (f.decisions.size > 0) { f.decisions.clear(); f.rev++ }
      f.cur = await loadFileEntry(st, rel)
      f.rev++
      return f
    }

    async function scan(sid) {
      const st = stateFor(sid)
      if (st.scanning) return st.scanning
      const task = (async () => {
        try {
          const res = resolveSession(sid)
          if (res.error) {
            // Session/workspace temporarily unavailable (session-not-found,
            // no-workspace, policy hiccup). Record the error and keep dirty
            // set: the pending mutation survives and the next scan retries.
            st.error = res.error
            return
          }
          st.root = res.root
          st.policy = res.policy
          try {
          const stamp = st.mutationStamp || 0
          const rootTarget = await fs.resolve(res.root)
          const walked = []
          await walkFiles(rootTarget, '', walked, 0, { n: 0 })
          const seen = new Set()
          const firstScan = !st.baseReady
          // v1.8 attribution: a change belongs to the review iff the agent's
          // tool channel caused it. `shellWindow` is the conservative whole-
          // window fallback for opaque shell/pwsh commands; `touched` is the
          // precise per-path set from write/edit calls. Files already pending
          // review keep their pending state regardless of attribution (never
          // silently fold a decision the user has not made).
          const shellWindow = st.shellWindow === true
          const attrib = (rel) => shellWindow || st.touched.has(rel)
          const wasPending = (f) => !!(f && f.base && f.cur &&
            (f.base.present !== f.cur.present || f.base.version !== f.cur.version))
          let treeChanged = false
          for (const w of walked) {
            seen.add(w.rel)
            const before = st.files.get(w.rel)
            // refreshOne mutates the SAME entry object, so the pre-refresh
            // values must be captured first — comparing before.cur against
            // f.cur afterwards would compare the object with itself.
            const beforeCur = before && before.cur ? before.cur : null
            const pending = !!(before && before.base && beforeCur &&
              (before.base.present !== beforeCur.present || before.base.version !== beforeCur.version))
            const f = await refreshOne(st, w.rel, w)
            if (!before || !beforeCur || beforeCur.present !== f.cur.present) treeChanged = true
            // First scan: baseline = current content (everything is baseline,
            // nothing is reviewed). Later scans decide by attribution.
            if (f.base === null) {
              f.base = firstScan ? cloneEntry(f.cur) : (attrib(w.rel) ? absentEntry() : cloneEntry(f.cur))
            }
            // A non-pending file whose content changed outside the agent
            // channel (the user's own edit in an editor, a git checkout, a
            // copied file): fold the new content into the baseline silently
            // instead of opening a review.
            if (!firstScan && before && beforeCur && beforeCur.present && f.cur.present &&
                beforeCur.version !== f.cur.version && !pending && !attrib(w.rel)) {
              f.base = cloneEntry(f.cur)
              if (f.decisions.size > 0) f.decisions.clear()
              f.rev++
            }
          }
          for (const entry of st.files) {
            const rel = entry[0], f = entry[1]
            if (!seen.has(rel) && f.cur && f.cur.present) {
              treeChanged = true
              const pending = wasPending(f)
              if (f.decisions.size > 0) { f.decisions.clear(); f.rev++ }
              f.cur = { present: false, content: null, eol: false, version: null, size: 0 }
              f.rev++
              // User-side deletion (not through the agent channel, file was
              // not pending): fold the deletion into the baseline silently.
              if (!pending && !attrib(rel)) f.base = absentEntry()
            }
          }
          st.baseReady = true
          // A mutation that landed while this scan walked must keep the flag
          // so the next scan picks it up (mutationStamp guarded).
          if ((st.mutationStamp || 0) === stamp) {
            st.dirty = false
            st.shellWindow = false
          }
          // Consume only the touched paths this scan actually saw; a path
          // added mid-scan (or skipped by walk caps) survives to the next.
          for (const rel of seen) st.touched.delete(rel)
          st.scannedAt = Date.now()
          st.error = null
          if (treeChanged && !firstScan) bumpTree(st)
          saveState(st)
          } catch (e) {
            st.error = e && e.message ? String(e.message) : String(e)
          }
        } catch (e) {
          st.error = e && e.message ? String(e.message) : String(e)
        }
      })()
      // CRITICAL: assign the promise first, then await it, and only clear the
      // flag when it is still ours. The old `st.scanning = (async () => {...}
      // finally { st.scanning = null })()` form raced: a scan that failed
      // SYNCHRONOUSLY (resolveSession error before the first await) ran its
      // finally BEFORE the assignment landed, so st.scanning ended up holding
      // a settled promise — truthy forever — and every later scan() returned
      // it without scanning. getModified then failed forever (adds/deletes
      // never appeared) while getDiff's single-file path kept working
      // (edits updated instantly).
      st.scanning = task
      try { await task } finally { if (st.scanning === task) st.scanning = null }
      return task
    }

    async function walkFiles(dirTarget, rel, out, depth, count) {
      if (depth > MAX_DEPTH || count.n >= MAX_ENTRIES) return
      let entries
      try { entries = await fs.listDir(dirTarget) } catch (e) { return }
      for (const e of entries) {
        if (count.n >= MAX_ENTRIES) return
        if (e.type === 'directory') {
          if (SKIP_DIRS.has(e.name)) continue
          await walkFiles(e.target, rel ? rel + '/' + e.name : e.name, out, depth + 1, count)
        } else if (e.type === 'file') {
          count.n++
          let version = e.version !== undefined ? e.version : null
          let size = e.size !== undefined ? e.size : 0
          if (version === null) {
            try {
              const info = await fs.stat(e.target)
              if (info) { version = info.version; size = info.size !== undefined ? info.size : size }
            } catch (err) {}
          }
          out.push({ rel: rel ? rel + '/' + e.name : e.name, version: version, size: size })
        }
      }
    }

    async function treeNode(dirTarget, rel, depth, count) {
      if (depth > MAX_DEPTH || count.n >= MAX_ENTRIES) return null
      let entries
      try { entries = await fs.listDir(dirTarget) } catch (e) { return null }
      const node = { name: rel === '' ? '.' : rel.split('/').pop(), type: 'directory', children: [] }
      for (const e of entries) {
        if (count.n >= MAX_ENTRIES) break
        if (e.type === 'directory') {
          if (SKIP_DIRS.has(e.name)) continue
          const child = await treeNode(e.target, rel ? rel + '/' + e.name : e.name, depth + 1, count)
          if (child) node.children.push(child)
        } else if (e.type === 'file') {
          count.n++
          node.children.push({ name: e.name, type: 'file', size: e.size !== undefined ? e.size : 0, path: rel ? rel + '/' + e.name : e.name })
        }
      }
      return node
    }

    // ---------- analysis ----------
    function entryLines(entry) {
      return entry.present && entry.content !== null ? splitLines(entry.content) : []
    }
    function modifiedFiles(st) {
      const files = []
      for (const entry of st.files) {
        const rel = entry[0], f = entry[1]
        // Version-axis listing: content comparison alone cannot see binary
        // changes (content is null on both sides) and misses nothing for
        // text. A fresh mtime with identical text is a touch, not a change.
        if (!f.cur || !isChanged(f)) continue
        if (f.base && f.base.content !== null && f.base.content === f.cur.content) continue
        const status = !f.base || !f.base.present ? 'added' : (!f.cur.present ? 'deleted' : 'modified')
        const note = (f.base && f.base.note) || f.cur.note || null
        if (note) {
          files.push({ path: rel, status: status, note: note, pending: 1, added: 0, removed: 0 })
          continue
        }
        const baseLines = entryLines(f.base)
        const curLines = entryLines(f.cur)
        if (baseLines.length > MAX_DIFF_LINES || curLines.length > MAX_DIFF_LINES) {
          files.push({ path: rel, status: status, note: 'large', pending: 1, added: 0, removed: 0 })
          continue
        }
        const hunks = computeHunks(baseLines, curLines)
        let added = 0, removed = 0, pending = 0
        for (const h of hunks) {
          if (f.decisions.has(h.id)) continue
          pending++
          added += h.newLen
          removed += h.oldLen
        }
        files.push({ path: rel, status: status, pending: pending, added: added, removed: removed })
      }
      files.sort(function (x, y) { return x.path < y.path ? -1 : (x.path > y.path ? 1 : 0) })
      return files
    }

    // "There is a reviewable diff" for the file view: presence or on-disk
    // version differs from the baseline. Content-only comparison cannot see
    // binary/large changes (content is null), so the version axis is the
    // single truth that also covers those.
    function isChanged(f) {
      return !f.base || !f.cur || f.base.present !== f.cur.present || f.base.version !== f.cur.version
    }

    function diffPayload(f, prevRev) {
      const status = !f.base || !f.base.present ? 'added' : (!f.cur.present ? 'deleted' : 'modified')
      if (prevRev !== undefined && prevRev !== null && prevRev === f.rev) {
        return { ok: true, same: true, rev: f.rev }
      }
      const changed = isChanged(f)
      // Deleted files: no line diff — the whole old content as red hunks was
      // noise. Ship a banner payload; the client offers accept (confirm the
      // deletion) / reject (restore from baseline) instead.
      if (status === 'deleted') {
        return { ok: true, rev: f.rev, status: status, changed: changed, deleted: true, hunks: [], current: null, baseline: null }
      }
      // Created and deleted again within the session: nothing on disk now,
      // nothing in the baseline — net zero vs the baseline. Banner payload
      // instead of an empty "editable" file.
      if (status === 'added' && !f.cur.present) {
        return { ok: true, rev: f.rev, status: status, changed: false, zero: true, hunks: [], current: null, baseline: null }
      }
      // v1.9: a clean markdown file renders in full (no line cap, no preview
      // truncation). Review states (changed) keep the diff/note paths below —
      // pending edits must stay visible for accept/reject.
      const md = (f.base && f.base.md) || (f.cur && f.cur.md)
      if (md && !changed && f.cur.content !== null) {
        const curLines = entryLines(f.cur)
        return { ok: true, rev: f.rev, status: status, changed: false, hunks: [], current: curLines, baseline: null }
      }
      const note = (f.base && f.base.note) || f.cur.note || null
      if (note) {
        // Large-but-text files (≤512KB, >8000 lines): content is already in
        // memory (loadFileEntry reads anything ≤512KB), so ship a read-only
        // preview head instead of nothing. Binary / oversized (>512KB) files
        // keep the plain note payload (no content loaded).
        if (note === 'large' && f.cur.content !== null) {
          const curLines = entryLines(f.cur)
          if (curLines.length > 0) {
            return {
              ok: true, rev: f.rev, status: status, changed: changed, note: note,
              hunks: [], current: null, baseline: null,
              preview: curLines.slice(0, 4000),
              lineCount: curLines.length,
            }
          }
        }
        return { ok: true, rev: f.rev, status: status, changed: changed, note: note, hunks: [], current: null, baseline: null }
      }
      const baseLines = entryLines(f.base)
      const curLines = entryLines(f.cur)
      if (baseLines.length > MAX_DIFF_LINES || curLines.length > MAX_DIFF_LINES) {
        return { ok: true, rev: f.rev, status: status, changed: changed, note: 'large', hunks: [], current: null, baseline: null }
      }
      const all = computeHunks(baseLines, curLines)
      const hunks = []
      for (const h of all) if (!f.decisions.has(h.id)) hunks.push(h)
      return {
        ok: true, rev: f.rev, status: status, changed: changed, hunks: hunks,
        baseline: hunks.length > 0 ? baseLines : null,
        current: curLines,
      }
    }

    // ---------- mutations ----------
    async function writeFile(st, rel, content) {
      const target = await fs.resolve(joinPath(st.root, rel))
      const outcome = await fs.writeText(target, content, undefined, undefined, st.policy)
      return outcome
    }
    async function deleteFile(st, rel) {
      if (!shell) throw new Error('shell 服务不可用，无法删除文件')
      const target = await fs.resolve(joinPath(st.root, rel))
      const p = fs.processPath(target)
      const isWin = process.platform === 'win32'
      const bashQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"
      const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'"
      // The shell executor on Windows is PowerShell (pwsh-local/sandbox): the
      // bash idiom `rm -f -- path` fails there ("-f is ambiguous"). Pick the
      // dialect by platform and fall back to the other one once.
      const primary = isWin
        ? 'Remove-Item -LiteralPath ' + psQuote(p) + ' -Force'
        : 'rm -f -- ' + bashQuote(p)
      const alternate = isWin
        ? 'rm -f -- ' + bashQuote(p)
        : 'Remove-Item -LiteralPath ' + psQuote(p) + ' -Force'
      let result
      try {
        result = await shell.run(shell.resolve({ command: primary, sandboxPolicy: st.policy }))
      } catch (e) {
        result = undefined
      }
      if (!result || result.exitCode !== 0) {
        try {
          result = await shell.run(shell.resolve({ command: alternate, sandboxPolicy: st.policy }))
        } catch (e) {
          result = undefined
        }
      }
      if (!result || result.exitCode !== 0) {
        const stderr = result && result.stderr && result.stderr.text !== undefined ? String(result.stderr.text) : String((result && result.stderr) || '')
        throw new Error('删除失败: ' + stderr)
      }
      // The plugin itself removed a file from disk: notify the client so the
      // sidebar file tree reloads (rejecting an added file = delete).
      bumpTree(st)
    }
    // Copy the file's current bytes into the undo dir before a reject
    // overwrites or deletes them. Returns the record entry (afterVersion is
    // filled by the caller once the reject write/delete has settled), or
    // null when there is nothing to back up (absent / too large / bad path).
    async function snapshotForUndo(st, path, rec) {
      try {
        const segs = path.split('/')
        if (segs.some(function (s) { return s === '..' || s === '.' || s === '' })) return null
        const target = await fs.resolve(joinPath(st.root, path))
        const info = await fs.stat(target)
        if (!info || info.size > MAX_BACKUP_BYTES) return null
        const bytes = await fs.readBytes(target, undefined, MAX_BACKUP_BYTES)
        const dir = join(undoRoot(st.sid), rec.opId, ...segs.slice(0, -1))
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, segs[segs.length - 1]), bytes)
        return { path: path, afterVersion: null }
      } catch (e) {
        return null
      }
    }
    async function doReject(st, f, path, rec) {
      const wasAbsent = !f.cur || !f.cur.present
      if (!f.base || !f.base.present) {
        // Added file: reject = delete. If it is already gone (agent deleted
        // it after our scan), converge idempotently instead of making the
        // shell fail on a nonexistent path.
        let info
        try { info = await fs.stat(await fs.resolve(joinPath(st.root, path))) } catch (e) { info = undefined }
        if (!info) {
          f.base = cloneEntry(f.cur)
          f.decisions.clear()
          f.rev++
          return
        }
        const snap = rec ? await snapshotForUndo(st, path, rec) : null
        await deleteFile(st, path)
        f.cur = { present: false, content: null, eol: false, crlf: false, version: null, size: 0, binRef: null, binSize: 0 }
        if (snap) { snap.afterVersion = null; rec.files.push(snap) }
      } else if (f.base.content === null) {
        // Binary / oversized baseline: restore the byte snapshot taken at
        // baseline time (binaries up to MAX_BACKUP_BYTES only).
        const blobPath = f.base.binRef ? join(blobRoot(st.sid), f.base.binRef) : null
        if (!blobPath || !existsSync(blobPath)) throw new Error('无法还原：文件过大或非文本')
        const snap = rec ? await snapshotForUndo(st, path, rec) : null
        const target = await fs.resolve(joinPath(st.root, path))
        writeFileSync(fs.processPath(target), readFileSync(blobPath))
        const info = await fs.stat(target)
        f.cur = { present: true, content: null, eol: false, crlf: false, version: info.version, size: info.size, note: 'binary', binRef: f.base.binRef, binSize: f.base.binSize }
        // Restored content IS the baseline again: align versions so
        // isChanged() reports no diff (binary has no content comparison).
        f.base = { ...cloneEntry(f.base), version: info.version, size: info.size }
        if (snap) { snap.afterVersion = info.version; rec.files.push(snap) }
      } else {
        const snap = rec ? await snapshotForUndo(st, path, rec) : null
        // Write back with the ORIGINAL line endings: normalizing to LF here
        // used to rewrite CRLF files wholesale (one giant spurious diff).
        const writeContent = f.base.crlf ? f.base.content.split('\n').join('\r\n') : f.base.content
        const outcome = await writeFile(st, path, writeContent)
        f.cur = { present: true, content: f.base.content, eol: f.base.eol, crlf: f.base.crlf, version: outcome.version, size: outcome.size !== undefined ? outcome.size : writeContent.length, binRef: null, binSize: 0 }
        // Restored content IS the baseline: align versions so isChanged()
        // reports no diff (matters for large files where content comparison
        // is unavailable).
        f.base = { ...cloneEntry(f.base), version: outcome.version, size: outcome.size !== undefined ? outcome.size : writeContent.length }
        if (snap) { snap.afterVersion = outcome.version; rec.files.push(snap) }
      }
      f.decisions.clear()
      f.rev++
      // A deleted file came back to disk: notify the client so the sidebar
      // file tree reloads (scan-only detection would miss this write).
      if (wasAbsent) bumpTree(st)
    }
    async function doAccept(st, f, path) {
      // A binary baseline needs its bytes for a future reject; snapshot them
      // now that this content becomes the new baseline.
      if (f.cur && f.cur.present && f.cur.note === 'binary' && !f.cur.binRef) {
        try {
          const target = await fs.resolve(joinPath(st.root, path))
          const info = await fs.stat(target)
          if (info && info.size <= MAX_BACKUP_BYTES) {
            const bytes = await fs.readBytes(target, undefined, MAX_BACKUP_BYTES)
            const hash = createHash('sha1').update(path).update(String(info.version)).digest('hex')
            const blobPath = join(blobRoot(st.sid), hash)
            if (!existsSync(blobPath)) {
              mkdirSync(blobRoot(st.sid), { recursive: true })
              writeFileSync(blobPath, bytes)
            }
            f.cur.binRef = hash
            f.cur.binSize = bytes.length
          }
        } catch (e) {}
      }
      f.base = cloneEntry(f.cur)
      f.decisions.clear()
      f.rev++
    }

    // ---------- RPC API ----------
    const api = {
      async listTree(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        const rootOverride = args && args.root ? String(args.root) : null
        if (rootOverride) {
          try {
            const rootTarget = await fs.resolve(rootOverride)
            const tree = await treeNode(rootTarget, '', 0, { n: 0 })
            return { ok: true, root: rootOverride, tree: tree }
          } catch (e) {
            return { ok: false, error: e && e.message ? String(e.message) : String(e) }
          }
        }
        await scan(sid)
        if (st.error) return { ok: false, error: st.error }
        try {
          const rootTarget = await fs.resolve(st.root)
          const tree = await treeNode(rootTarget, '', 0, { n: 0 })
          return { ok: true, root: st.root, tree: tree }
        } catch (e) {
          return { ok: false, error: e && e.message ? String(e.message) : String(e) }
        }
      },

      async getModified(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        if (!st.baseReady) {
          await scan(sid)
        } else if (st.dirty) {
          await scan(sid)
        }
        if (st.error) return { ok: false, error: st.error }
        return { ok: true, root: st.root, files: modifiedFiles(st), treeStamp: st.treeStamp, undo: st.lastReject ? { opId: st.lastReject.opId, count: st.lastReject.files.length, ts: st.lastReject.ts } : null }
      },

      // Long-poll wake-up: resolves as soon as an agent mutation (write/edit/
      // shell/pwsh tool result) dirties the session — or immediately when it
      // is already dirty — otherwise after WAIT_MS. The client chains these
      // calls so diff stats update the moment a tool result lands instead of
      // waiting for its 6s fallback poll.
      async wait(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        if (st.baseReady && st.dirty) return { ok: true, changed: true }
        const WAIT_MS = 15000
        const MAX_WAITERS = 4
        return await new Promise((resolve) => {
          let set = waiters.get(sid)
          if (!set) { set = new Set(); waiters.set(sid, set) }
          if (set.size >= MAX_WAITERS) { resolve({ ok: true, changed: false }); return }
          let settled = false
          let h = null
          const finish = (payload) => {
            if (settled) return
            settled = true
            if (h) clearTimeout(h)
            set.delete(finish)
            resolve(payload)
          }
          set.add(finish)
          h = setTimeout(() => finish({ ok: true, changed: false }), WAIT_MS)
        })
      },

      async getDiff(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        const path = args && args.path ? String(args.path) : ''
        if (!st.baseReady) {
          await scan(sid)
        } else if (st.dirty) {
          try {
            const f = st.files.get(path)
            if (f && f.cur) {
              const target = await fs.resolve(joinPath(st.root, path))
              const info = await fs.stat(target)
              const changed = !f.cur.present || !info || f.cur.version !== info.version || f.cur.size !== info.size
              if (changed && f.decisions.size > 0) { f.decisions.clear(); f.rev++ }
              if (changed) {
                const pending = !!(f.base && (f.base.present !== f.cur.present || f.base.version !== f.cur.version))
                f.cur = await loadFileEntry(st, path)
                f.rev++
                // v1.8 attribution: a non-pending file changed outside the
                // agent channel (the user's own edit) folds into the baseline
                // right away, so the open viewer never flashes a diff that the
                // next scan would silently accept.
                if (!pending && !st.touched.has(path) && st.shellWindow !== true && f.cur.present) {
                  f.base = cloneEntry(f.cur)
                  f.decisions.clear()
                  f.rev++
                }
              }
            }
            // NOTE: dirty deliberately stays set. Only a full scan() clears it
            // (getModified's poll triggers that scan). Clearing it here used to
            // swallow files created/deleted after the last scan — they never
            // entered the map and the UI showed "file unavailable" forever.
          } catch (e) {}
        }
        if (st.error) return { ok: false, error: st.error }
        let f = st.files.get(path)
        // Files that never went through a scan (created after the last one,
        // or skipped by walk caps) load on demand. Attribution decides their
        // baseline: agent-created → "added" review hunk (reject deletes the
        // file); everything else → folded baseline, plain content view.
        if (!f || !f.cur) {
          try {
            const entry = await loadFileEntry(st, path)
            if (!entry.present) return { ok: true, missing: true }
            if (!f) {
              f = { base: null, cur: null, rev: 0, decisions: new Map() }
              st.files.set(path, f)
              // The map did not know this file: the sidebar tree may not show
              // it yet, so notify the client to reload (a later scan would see
              // no "new" presence change and would not bump again).
              bumpTree(st)
            }
            f.cur = entry
            // v1.8 attribution on demand: agent-created files (in the touched
            // set) enter the review as "added"; anything else — the user's own
            // copy, a build artifact, a download — folds into the baseline
            // silently and just renders its content.
            if (f.base === null) {
              if (st.touched.has(path)) {
                f.base = absentEntry()
                st.touched.delete(path)
              } else {
                f.base = cloneEntry(entry)
              }
            }
            f.rev++
            saveState(st)
          } catch (e) {
            return { ok: true, missing: true }
          }
        }
        if (!f.cur) return { ok: true, missing: true }
        // v1.9: large markdown (>512KB scan cap) loads its content ON DEMAND
        // when the file is opened, so the viewer renders the whole document
        // (bounded by MAX_MD_RENDER_BYTES). The entry keeps note:'large' for
        // every other consumer; only the diff payload treats it as renderable.
        if (f.cur.md && f.cur.note === 'large' && f.cur.content === null && f.cur.size <= MAX_MD_RENDER_BYTES) {
          try {
            const target = await fs.resolve(joinPath(st.root, path))
            const text = await fs.readText(target)
            if (typeof text === 'string') {
              f.cur.content = text.replace(/\r\n/g, '\n')
              f.cur.crlf = /\r\n/.test(text)
              f.cur.eol = text.endsWith('\n')
              f.rev++
            }
          } catch (e) {}
        }
        const prev = args && args.rev !== undefined && args.rev !== null ? Number(args.rev) : undefined
        return diffPayload(f, prev)
      },

      async applyHunk(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        const path = args && args.path ? String(args.path) : ''
        const hunkId = args && args.hunkId ? String(args.hunkId) : ''
        const action = args && args.action === 'reject' ? 'reject' : 'accept'
        await scan(sid)
        const f = st.files.get(path)
        if (!f || !f.cur) return { ok: false, code: 'not-found', message: '文件不存在' }
        if (f.rev !== Number(args.rev)) return { ok: false, code: 'stale', message: '文件已变化，请刷新后重试' }
        const baseLines = entryLines(f.base)
        const curLines = entryLines(f.cur)
        const all = computeHunks(baseLines, curLines)
        let hunk = null
        for (const h of all) if (h.id === hunkId) hunk = h
        if (hunk === null) return { ok: false, code: 'stale', message: '修订已变化，请刷新后重试' }
        f.decisions.set(hunkId, action)
        if (action === 'reject') {
          const rec = newUndoRec()
          if (!f.base || !f.base.present) {
            const snap = await snapshotForUndo(st, path, rec)
            await deleteFile(st, path)
            f.cur = { present: false, content: null, eol: false, crlf: false, version: null, size: 0, binRef: null, binSize: 0 }
            if (snap) { snap.afterVersion = null; rec.files.push(snap) }
          } else {
            const snap = await snapshotForUndo(st, path, rec)
            const merged = mergeHunks(baseLines, all, f.decisions)
            const text = joinLines(merged, f.base.eol, f.base.crlf)
            const outcome = await writeFile(st, path, text)
            f.cur = { present: true, content: text.replace(/\r\n/g, '\n'), eol: f.base.eol, crlf: f.base.crlf, version: outcome.version, size: outcome.size !== undefined ? outcome.size : text.length, binRef: null, binSize: 0 }
            if (snap) { snap.afterVersion = outcome.version; rec.files.push(snap) }
          }
          commitUndo(st, rec)
        }
        let pendingCount = 0
        for (const h of all) if (!f.decisions.has(h.id)) pendingCount++
        if (pendingCount === 0) {
          f.base = cloneEntry(f.cur)
          f.decisions.clear()
        }
        f.rev++
        saveState(st)
        return diffPayload(f, undefined)
      },

      // User edit from the file view's inline editor. One line at a time;
      // idx addresses the CURRENT content line (0-based; idx === length
      // appends, which is how the empty-file placeholder types its first
      // line). Semantics: the edit is written to disk immediately. Context
      // lines fold the same edit into the baseline (user edits are NOT
      // counted into the diff and do not disturb pending hunks); edits to
      // agent-ADDED lines stay inside their pending hunk (still counted).
      async applyEdit(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        const path = args && args.path ? String(args.path) : ''
        const idx = Number(args.idx)
        const text = args && typeof args.text === 'string' ? args.text.replace(/\r/g, '') : ''
        if (!Number.isInteger(idx) || idx < 0) return { ok: false, code: 'stale', message: '编辑位置无效' }
        await scan(sid)
        const f = st.files.get(path)
        if (!f || !f.cur || !f.cur.present) return { ok: false, code: 'not-found', message: '文件不存在' }
        if (f.rev !== Number(args.rev)) return { ok: false, code: 'stale', message: '文件已变化，请刷新后重试' }
        const baseLines = entryLines(f.base)
        const curLines = entryLines(f.cur)
        if (idx > curLines.length) return { ok: false, code: 'stale', message: '文件已变化，请刷新后重试' }
        // Edited lines address cur lines only, so they can never be diff OLD
        // (deleted) lines — the client renders those read-only.
        const all = computeHunks(baseLines, curLines)
        let container = null
        for (const h of all) {
          if (idx >= h.newStart && idx < h.newStart + h.newLen) { container = h; break }
        }
        const nextCur = curLines.slice()
        if (idx === curLines.length) nextCur.push(text)
        else nextCur[idx] = text
        if (!container && f.base && f.base.present) {
          // Context line: fold the identical edit into the baseline at the
          // aligned index. Alignment shift = sum of (newLen - oldLen) over
          // hunks at or before this position in cur coordinates.
          let shift = 0
          for (const h of all) { if (h.newStart <= idx) shift += h.newLen - h.oldLen }
          const baseIdx = idx - shift
          if (baseIdx >= 0 && baseIdx <= baseLines.length) {
            baseLines.splice(baseIdx, baseIdx < baseLines.length ? 1 : 0, text)
            f.base = { ...cloneEntry(f.base), content: joinLines(baseLines, f.base.eol) }
          }
        }
        // container !== null: the line belongs to a hunk (pending added line,
        // or a decided-accepted line). Either way the edit updates cur only —
        // pending hunks keep counting it, decided hunks stay hidden.
        const newAll = computeHunks(baseLines, nextCur)
        // If the hunk topology changed (merged/split hunks), drop stale
        // decisions rather than misapplying them to reshaped hunks.
        const shapeOf = (h) => h.oldStart + ':' + h.oldLen + ':' + h.newStart + ':' + h.newLen
        if (all.map(shapeOf).join('|') !== newAll.map(shapeOf).join('|')) f.decisions.clear()
        const textOut = joinLines(nextCur, f.cur.eol, f.cur.crlf)
        let outcome
        try {
          outcome = await writeFile(st, path, textOut)
        } catch (e) {
          return { ok: false, error: e && e.message ? String(e.message) : String(e) }
        }
        f.cur = { present: true, content: textOut.replace(/\r\n/g, '\n'), eol: f.cur.eol, crlf: f.cur.crlf, version: outcome.version, size: outcome.size !== undefined ? outcome.size : textOut.length }
        // changed-flag hygiene: with no pending hunks the file IS the
        // baseline now — align versions so the toolbar hides.
        const newPending = newAll.filter((h) => !f.decisions.has(h.id))
        if (newPending.length === 0 && f.base && f.base.present) {
          f.base = { ...cloneEntry(f.base), version: outcome.version, size: outcome.size !== undefined ? outcome.size : textOut.length }
        }
        f.rev++
        saveState(st)
        return diffPayload(f, undefined)
      },

      async acceptFile(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        const path = args && args.path ? String(args.path) : ''
        await scan(sid)
        const f = st.files.get(path)
        if (!f || !f.cur) return { ok: false, code: 'not-found', message: '文件不存在' }
        await doAccept(st, f, path)
        saveState(st)
        return { ok: true }
      },

      async rejectFile(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        const path = args && args.path ? String(args.path) : ''
        await scan(sid)
        const f = st.files.get(path)
        if (!f || !f.cur) return { ok: false, code: 'not-found', message: '文件不存在' }
        try {
          const rec = newUndoRec()
          await doReject(st, f, path, rec)
          commitUndo(st, rec)
          saveState(st)
          return { ok: true }
        } catch (e) {
          return { ok: false, error: e && e.message ? String(e.message) : String(e) }
        }
      },

      async acceptAll(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        await scan(sid)
        const list = modifiedFiles(st)
        let applied = 0
        for (const item of list) {
          const f = st.files.get(item.path)
          if (!f) continue
          await doAccept(st, f, item.path)
          applied++
        }
        saveState(st)
        return { ok: true, applied: applied, files: modifiedFiles(st) }
      },

      async rejectAll(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        await scan(sid)
        const list = modifiedFiles(st)
        const failed = []
        const rec = newUndoRec()
        let applied = 0
        for (const item of list) {
          const f = st.files.get(item.path)
          if (!f) continue
          try {
            await doReject(st, f, item.path, rec)
            applied++
          } catch (e) {
            failed.push({ path: item.path, error: e && e.message ? String(e.message) : String(e) })
          }
        }
        commitUndo(st, rec)
        saveState(st)
        return { ok: true, applied: applied, failed: failed, files: modifiedFiles(st) }
      },

      // Undo the last reject batch: rewrite the pre-reject bytes for every
      // file in the record, unless the file changed again on disk since the
      // reject (version guard — never clobber newer agent work).
      async undoReject(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        if (!st.root) { await scan(sid); if (st.error) return { ok: false, error: st.error } }
        const rec = st.lastReject
        if (!rec) return { ok: false, code: 'no-undo', message: '没有可撤销的拒绝操作' }
        const restored = []
        const skipped = []
        for (const item of rec.files) {
          const segs = item.path.split('/')
          if (segs.some(function (s) { return s === '..' || s === '.' || s === '' })) {
            skipped.push({ path: item.path, reason: 'invalid' })
            continue
          }
          const src = join(undoRoot(st.sid), rec.opId, ...segs)
          if (!existsSync(src)) {
            skipped.push({ path: item.path, reason: '备份丢失' })
            continue
          }
          const target = await fs.resolve(joinPath(st.root, item.path))
          let info
          try { info = await fs.stat(target) } catch (e) { info = undefined }
          const expectAbsent = item.afterVersion === null || item.afterVersion === undefined
          if (expectAbsent ? !!info : (!info || info.version !== item.afterVersion)) {
            skipped.push({ path: item.path, reason: '文件已再次变化' })
            continue
          }
          try {
            const bytes = readFileSync(src)
            writeFileSync(fs.processPath(target), bytes)
            restored.push(item.path)
            let f = st.files.get(item.path)
            if (!f) {
              f = { base: absentEntry(), cur: null, rev: 0, decisions: new Map() }
              st.files.set(item.path, f)
            }
            f.cur = await loadFileEntry(st, item.path)
            if (f.decisions.size > 0) f.decisions.clear()
            f.rev++
            // Recreated file: let the sidebar tree know right away; the full
            // scan (dirty) reconciles everything else on the next poll.
            if (expectAbsent) bumpTree(st)
            st.dirty = true
          } catch (e) {
            skipped.push({ path: item.path, reason: e && e.message ? String(e.message) : String(e) })
          }
        }
        try { rmSync(join(undoRoot(st.sid), rec.opId), { recursive: true, force: true }) } catch (e) {}
        st.lastReject = null
        saveState(st)
        return { ok: true, restored: restored, skipped: skipped }
      },
    }

    // ---------- HTTP carrier ----------
    const route = webServer.register({
      kind: 'prefix',
      path: '/dsh-file-edit',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST' || req.url !== '/dsh-file-edit/api') {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'not found' }))
            return
          }
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          let body
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'bad json' }))
            return
          }
          const method = body && typeof body.method === 'string' ? body.method : ''
          const handler = api[method]
          if (typeof handler !== 'function') {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'no such method: ' + method }))
            return
          }
          const result = await handler(body.args && typeof body.args === 'object' ? body.args : {})
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result ?? { ok: true }))
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: e && e.message ? String(e.message) : String(e) }))
        }
      },
    })
    ctx.effect(() => route, 'dsh-file-edit: web route')

    // Wake pending long-polls on teardown so no held request outlives the
    // plugin fiber, and drop coalescing timers.
    ctx.effect(() => () => {
      for (const [, set] of waiters) {
        for (const resolve of set) { try { resolve({ ok: true, changed: false }) } catch (e) {} }
        set.clear()
      }
      waiters.clear()
      for (const [, h] of notifyTimers) clearTimeout(h)
      notifyTimers.clear()
    }, 'dsh-file-edit: wait cleanup')

    // ---------- change triggers ----------
    ctx.on('tools/result', (exec, result) => {
      const agent = exec && exec.agent
      const sid = agent && agent.session ? agent.session.id : undefined
      if (!sid || !knownSessions.has(sid)) return
      const name = exec && exec.name ? exec.name : ''
      if (!MUTATING_TOOLS.has(name)) return
      const st = stateFor(sid)
      if (!st.baseReady) return
      st.dirty = true
      st.mutationStamp = (st.mutationStamp || 0) + 1
      // v1.8 change attribution (direction B): only changes that flowed
      // through the agent's tool channel enter the review. write/edit carry
      // an explicit file_path — attribute exactly that file. shell/pwsh
      // commands are opaque text, so they fall back to a session-wide window
      // the next scan consumes (conservative: everything non-pending found
      // by that scan is attributed). An unparseable write/edit path also
      // falls back to the window so agent work is never silently folded.
      let attributed = false
      if (name === 'write' || name === 'edit') {
        const raw = exec.args && typeof exec.args.file_path === 'string' ? exec.args.file_path : ''
        const rel = normalizeRelPath(st.root, raw)
        if (rel) { st.touched.add(rel); attributed = true }
      }
      if (!attributed) st.shellWindow = true
      // Wake any long-polling client right away (bursts of tool results in
      // one agent turn coalesce into a single wake-up).
      scheduleNotify(sid, 300)
    })
  },
}
