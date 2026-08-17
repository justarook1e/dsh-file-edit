// dsh-file-edit — static host plugin.
// Persisted across DSH restarts: mounted from ~/.dsh/profiles/web/cordis.patch.yml.
// Browser RPC arrives at POST /dsh-file-edit/api (registered on ctx.webServer).
// Per-session review state (baseline + pending decisions) is persisted under
// ~/.dsh/dsh-file-edit-state/<sessionId>.json so accept/reject survives restarts.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, readdirSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'
import { spawn } from 'node:child_process'
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
    // v1.13.3: change triggers are event-driven and NARROW — the client no
    // longer fast-polls (its fixed 20s arm is only a failsafe), so a trigger
    // here must be both precise and cheap. write/edit always mutate and carry
    // an explicit file_path. shell/pwsh are opaque text, so instead of
    // "any shell call dirties the session" only commands that can actually
    // change the workspace get through: read-only traffic (Get-ChildItem,
    // node --version, git status, ...) now costs nothing.
    const MUTATING_SHELL_RE = /Remove-Item|Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Rename-Item|del\s|rm\s|rmdir/i
    // v1.15.1: git commands that change the worktree↔HEAD relationship (the
    // thing the VCS badges answer). commit/checkout/reset/... never touch a
    // worktree byte the scanner could see, so they need their own trigger
    // that bumps the tree stamp directly. Read-only git (status/log/diff/...)
    // stays untriggered. Substring false positives (echo 'git commit') cost
    // one extra walk — same acceptable trade as MUTATING_SHELL_RE.
    const MUTATING_GIT_RE = /\bgit\s+(?:add|commit|checkout|co|reset|clean|restore|stash|rm|mv|merge|rebase|pull|cherry-pick|apply|am|switch|init)\b/i
    // v1.18: git commands that change ONLY the index/HEAD relationship (never
    // a worktree byte the scanner could see). They still bump the tree stamp
    // so the VCS badges re-ask git, but they must NOT set dirty — a full
    // walk after every `git add`/`git commit` was pure waste on big
    // workspaces. Worktree-mutating git (checkout/reset/clean/restore/rm/mv/
    // merge/rebase/pull/cherry-pick/apply/am/switch/stash) keeps the dirty
    // path, resolved precisely when the command names its files.
    const GIT_INDEX_ONLY_RE = /\bgit\s+(?:add|commit|init)\b/i
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
    // v1.18: the client's failsafe poll runs every 20s, and the whole-workspace
    // walk is now reserved for exactly that cadence (plus the first scan and
    // the "could not locate the changed file" fallback). Every getModified/
    // getDiff/listTree/mutation RPC re-checks freshness: a session whose last
    // full scan is older than this TTL gets one full walk, otherwise precise
    // per-path refreshes (or nothing) keep the state current.
    const FULL_SCAN_TTL = 20000

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
    // ---------- precise path extraction from shell/pwsh/git commands (v1.18) ----------
    // The whole-workspace walk is reserved for the 20s failsafe and for
    // mutations whose file targets cannot be located. For the others we
    // extract the target paths from the command TEXT so the review state can
    // be refreshed per file. This is best-effort: anything ambiguous
    // (wildcards, `$` variables, cmd %vars%, unquoted weirdness, paths that
    // do not resolve under the workspace root) makes the extractor return
    // null and the caller fall back to the full scan — false fallbacks are
    // safe (one walk), false precision would silently miss agent changes.
    const PS_PARAM_RE = /-(?:Path|LiteralPath|FilePath|Destination|NewName)\s+((?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')|[^\s;|&]+)/gi
    const PS_CMDLET_RE = /\b(?:Remove-Item|Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Rename-Item|rm|rmdir|del)\b([^;|&]*)/gi
    // PowerShell value-taking parameters on the cmdlets above (a following
    // token is that flag's value, not a positional path); switches do not
    // consume a value. A flag outside both lists conservatively consumes its
    // next token (avoids misreading a value as a path).
    const PS_VALUE_FLAGS = new Set(['path', 'literalpath', 'filepath', 'destination', 'newname', 'value', 'itemtype', 'encoding', 'filter', 'include', 'exclude', 'name', 'indent', 'width', 'delimiter', 'noheader', 'inputobject'])
    const PS_SWITCHES = new Set(['force', 'recurse', 'confirm', 'whatif', 'append', 'noclobber', 'passthru', 'quiet', 'compress', 'verbose', 'debug'])
    function tokenizeWords(rest) {
      return String(rest || '').match(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s]+/g) || []
    }
    function unquoteCmd(raw) {
      const s = String(raw || '').replace(/,$/, '')
      if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'")
      if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1).replace(/\\(.)/g, '$1')
      return s
    }
    function splitCommas(raw) {
      if (raw.length >= 2 && (raw[0] === "'" || raw[0] === '"') && raw[raw.length - 1] === raw[0]) return [raw]
      return String(raw).split(',')
    }
    // Validate one unquoted, comma-split token into a workspace-relative
    // path. Returns the rel path or null (suspect token: wildcard, variable,
    // empty, or outside the workspace root). Degenerate separators ('' or
    // ',') are SKIPPED by the callers, not treated as suspects.
    function cmdPathToRel(root, s) {
      if (s === '') return null
      // Trailing slashes (`rm -rf build/`) are directory noise, not path
      // segments; the backtick is PowerShell's escape character (a literal
      // backtick in a path is vanishingly rare, and misreading an escaped
      // token as a path would be a false-precision bug).
      s = s.replace(/\/+$/, '')
      if (s === '') return null
      if (/[*?[\]$%~`]/.test(s)) return null
      return normalizeRelPath(root, s)
    }
    // PowerShell forms: `-Path/-LiteralPath/-FilePath/-Destination/-NewName
    // <value>` plus positional tokens. Positional scanning skips a token
    // right after a value-taking flag (its value), and skips switch flags
    // entirely. Bash forms (rm/del/rmdir) never consume a value after a flag,
    // so every non-flag token is a target. Returns null when no target can be
    // reliably enumerated.
    function extractCommandPaths(cmd, root) {
      if (typeof cmd !== 'string' || cmd === '') return null
      const out = new Set()
      let m
      PS_PARAM_RE.lastIndex = 0
      while ((m = PS_PARAM_RE.exec(cmd))) {
        for (const part of splitCommas(m[1])) {
          const s = unquoteCmd(part)
          if (s === '' || s === ',') continue
          const rel = cmdPathToRel(root, s)
          if (!rel) return null
          out.add(rel)
        }
      }
      PS_CMDLET_RE.lastIndex = 0
      while ((m = PS_CMDLET_RE.exec(cmd))) {
        const name = m[0].split(/\s+/)[0].toLowerCase()
        const bashForm = name === 'rm' || name === 'rmdir' || name === 'del'
        const tokens = tokenizeWords(m[1])
        let i = 0
        while (i < tokens.length) {
          const raw = tokens[i]
          if (raw === '--') { i++; continue }
          const flag = /^[-/][A-Za-z]/.test(raw)
          if (flag) {
            if (!bashForm) {
              const flagName = raw.replace(/^[-/]/, '').toLowerCase()
              if (!PS_SWITCHES.has(flagName)) i++ // value-taking flag: skip its value
            }
            i++
            continue
          }
          for (const part of splitCommas(raw)) {
            const s = unquoteCmd(part)
            if (s === '' || s === ',') continue
            const rel = cmdPathToRel(root, s)
            if (!rel) return null
            out.add(rel)
          }
          i++
        }
      }
      return out.size > 0 ? out : null
    }
    // git worktree-mutating commands with explicit file targets:
    //   git rm|mv <path...>            — positional paths
    //   git checkout|co|restore|reset -- <path...>  — paths after `--`
    // Anything else (merge/rebase/pull/switch/clean/reset without `--`,
    // checkout without `--`, revisions as targets) returns null → fallback.
    function extractGitPaths(cmd, root) {
      if (typeof cmd !== 'string' || cmd === '') return null
      const m = /\bgit\s+(rm|mv|checkout|co|restore|reset)\b([^;|&]*)/i.exec(cmd)
      if (!m) return null
      const sub = m[1].toLowerCase()
      const rest = m[2]
      const out = new Set()
      let tokens
      if (sub === 'checkout' || sub === 'co' || sub === 'restore' || sub === 'reset') {
        // Paths come after a STANDALONE `--` separator. A `--` glued to a
        // flag (`git reset --hard`) is not a separator — `--hard` is the
        // reset mode, so no paths can be located → fallback.
        const sep = /(?:^|\s)--(?=\s|$)/.exec(rest)
        if (!sep) return null
        tokens = tokenizeWords(rest.slice(sep.index + sep[0].length))
      } else {
        tokens = tokenizeWords(rest)
      }
      for (const t of tokens) {
        if (/^[-/][A-Za-z]/.test(t)) continue
        for (const part of splitCommas(t)) {
          const s = unquoteCmd(part)
          if (s === '' || s === ',') continue
          const rel = cmdPathToRel(root, s)
          if (!rel) return null
          out.add(rel)
        }
      }
      return out.size > 0 ? out : null
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
      let shift = 0
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
        // Pure runs borrow the counterpart coordinate, corrected by the
        // CUMULATIVE shift accumulated from every earlier hunk (each prior
        // change moves the new file's indices by newLen − oldLen). The naive
        // mirror (newStart = oldStart) was only right for the FIRST hunk —
        // later pure hunks drifted by one per preceding change (live payload
        // with three deletions reported 101/197 instead of 100/195, which
        // also starved the last hunk of its trailing context block and broke
        // the jump caret chain). Op-derived coordinates (o.i/o.j) are already
        // absolute full-array indices and need no shift.
        if (h.oldStart < 0) h.oldStart = h.newStart - shift
        if (h.newStart < 0) h.newStart = h.oldStart + shift
        shift += h.newLen - h.oldLen
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
          const base = entry[1].base
          const cur = entry[1].cur
          // v1.18: a clean file (base === cur on every axis) needs only its
          // baseline persisted — loadState reconstructs cur as a clone of it.
          // Big workspaces (15K entries, BM_automation) used to serialize
          // EVERY file's content twice; halving the state blob is what makes
          // per-file accept/reject saves tolerable on the debounced path.
          const redundantCur = !!(base && cur && base.present === cur.present &&
            base.version === cur.version && base.size === cur.size &&
            (cur.content === null || base.content === cur.content))
          files[entry[0]] = {
            base: base,
            cur: redundantCur ? undefined : cur,
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
    // v1.18: state saves are DEBOUNCED (250ms per session). Serializing the
    // whole review map can take seconds on big workspaces; a user clicking
    // accept on several files in a row (or accept-all) must not block on a
    // full JSON.stringify per click — one save after the burst covers them
    // all, and the RPC response is sent before the timer fires. Destructive
    // paths (reject / undo-reject / hunk-reject) pass force=true: their undo
    // records must hit disk immediately. The teardown effect flushes any
    // pending save so a stop/update cannot drop the last accept.
    const saveTimers = new Map()
    function scheduleSave(st, force) {
      const sid = st.sid
      const existing = saveTimers.get(sid)
      if (existing) { clearTimeout(existing.t); saveTimers.delete(sid) }
      if (force) { saveState(st); return }
      saveTimers.set(sid, { st: st, t: setTimeout(() => { saveTimers.delete(sid); saveState(st) }, 250) })
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
          // v1.18: clean files persist only their baseline; reconstruct the
          // redundant cur as a clone of it.
          const cur = f.cur ?? (base ? cloneEntry(base) : null)
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
        // v1.18 precise DIFF refresh: `pendingTargets` is either a Set of
        // workspace-relative paths the next resolution should refresh
        // per-file (write/edit, or a shell/git command whose targets we could
        // extract), or null = the mutation could NOT be located precisely and
        // the next resolution must run the full walk (fallback). `targetTask`
        // dedups concurrent targeted refreshes (mirror of `scanning`).
        pendingTargets: new Set(),
        targetTask: null,
        // v1.18: git index-only commands (add/commit/init) change no worktree
        // byte, so they must not dirty the session — but the client still
        // needs to reload the tree (VCS badges re-ask git). getModified
        // consumes this flag without scanning.
        treeDirty: false,
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
      if (set && set.size > 0) {
        waiters.delete(sid)
        for (const resolve of set) { try { resolve({ ok: true, changed: true }) } catch (e) {} }
      }
      // v1.13.3: SSE push channel. The long-poll wait chain has proven
      // unreliable in the real browser (its self-managed loop can silently
      // die), so every wake also broadcasts to connected EventSource clients.
      // EventSource reconnects natively — nothing of ours has to stay alive.
      const sse = sseClients.get(sid)
      if (sse && sse.size > 0) {
        for (const res of sse) { try { res.write('data: changed\n\n') } catch (e) {} }
      }
    }
    const notifyTimers = new Map()
    function scheduleNotify(sid, delay) {
      const existing = notifyTimers.get(sid)
      if (existing) clearTimeout(existing)
      notifyTimers.set(sid, setTimeout(() => { notifyTimers.delete(sid); notify(sid) }, delay))
    }

    // ---------- SSE push channel ----------
    // GET /dsh-file-edit/events?sessionId=... holds a text/event-stream
    // connection; every coalesced mutation wake writes one `data: changed`
    // frame. Pattern mirrors the harness's own HMR SSE route
    // (packages/client/hmr): comment ping on connect, per-res close cleanup,
    // destroy on teardown.
    const sseClients = new Map()
    function handleSse(req, res) {
      let sid = ''
      try {
        const u = new URL(req.url, 'http://localhost')
        sid = u.searchParams.get('sessionId') || ''
      } catch (e) {}
      if (!sid) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'no-session' }))
        return
      }
      // The connection itself proves this session is being watched: register
      // it so tools/result wakes are not dropped for pages that have not
      // issued an API call yet.
      knownSessions.add(sid)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      try { res.write(': connected\n\n') } catch (e) {}
      let set = sseClients.get(sid)
      if (!set) { set = new Set(); sseClients.set(sid, set) }
      set.add(res)
      const cleanup = () => {
        clearInterval(hb)
        const s = sseClients.get(sid)
        if (s) { s.delete(res); if (s.size === 0) sseClients.delete(sid) }
      }
      // Heartbeat: keep proxies/browsers from closing an idle stream, and
      // surface dead sockets (the write throw routes into cleanup).
      const hb = setInterval(() => {
        try { res.write(': ping\n\n') } catch (e) { cleanup() }
      }, 20000)
      let closed = false
      const onClose = () => { if (!closed) { closed = true; cleanup() } }
      try { req.on('close', onClose) } catch (e) {}
      try { res.on('close', onClose) } catch (e) {}
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

    // "The file is under review" — presence or on-disk version differs from
    // the baseline. Used by the scan, the targeted refresh and the deletion
    // sweep to decide whether a change belongs to the review.
    function isPending(f) {
      return !!(f && f.base && f.cur &&
        (f.base.present !== f.cur.present || f.base.version !== f.cur.version))
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
          // v1.17: the gitignore-excluded set exempts ignored entries from
          // the walk budget (see walkFiles); one git call per scan burst
          // (TTL-cached together with the VCS decorations).
          const ignored = await ignoredInfoFor(res.root)
          const walked = []
          await walkFiles(rootTarget, '', walked, 0, { n: 0 }, ignored)
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
          let treeChanged = false
          // v1.15: content-only changes (no file set change) now bump the
          // tree stamp too — the sidebar reloads and the git VCS letters
          // (M/U/A/D/R) refresh right after an agent edit instead of waiting
          // for a manual ⟳.
          let contentChanged = false
          for (const w of walked) {
            seen.add(w.rel)
            const before = st.files.get(w.rel)
            // refreshOne mutates the SAME entry object, so the pre-refresh
            // values must be captured first — comparing before.cur against
            // f.cur afterwards would compare the object with itself.
            const beforeCur = before && before.cur ? before.cur : null
            const pending = isPending(before)
            const f = await refreshOne(st, w.rel, w)
            if (!before || !beforeCur || beforeCur.present !== f.cur.present) treeChanged = true
            else if (beforeCur.present && f.cur.present && beforeCur.version !== f.cur.version) contentChanged = true
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
              const pending = isPending(f)
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
            // v1.18: a full walk consumed every pending precise target (they
            // are all covered by it). When a fallback (pendingTargets = null)
            // landed mid-walk, the guard above leaves dirty set AND keeps
            // pendingTargets = null → the next resolution walks again.
            st.pendingTargets = new Set()
          }
          // Consume only the touched paths this scan actually saw; a path
          // added mid-scan (or skipped by walk caps) survives to the next.
          for (const rel of seen) st.touched.delete(rel)
          st.scannedAt = Date.now()
          st.error = null
          if (treeChanged || contentChanged) {
            if (!firstScan) bumpTree(st)
            // v1.18: only persist when something actually changed — a
            // no-change failsafe walk must not re-serialize a huge state blob.
            scheduleSave(st)
          }
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

    // ---------- precise per-path refresh (v1.18) ----------
    // The review state can be refreshed for exactly the files a mutation
    // named (write/edit file_path, or paths extracted from a shell/git
    // command), without walking the whole workspace. Semantics mirror the
    // full scan's per-file handling: reload changed content, mark deletions,
    // assign baselines by attribution, fold non-attributed changes, bump the
    // tree stamp on set/content changes. A target that is a DIRECTORY (e.g.
    // New-Item -ItemType Directory, rm -rf on a folder) cannot be enumerated
    // precisely → returns { fallback: true } and the caller runs the full
    // scan instead.
    function addTarget(st, rel) {
      if (st.pendingTargets instanceof Set) st.pendingTargets.add(rel)
      // pendingTargets === null (a fallback is already pending) stays null:
      // the full scan covers this path anyway.
    }
    function fallbackWindow(st) {
      st.pendingTargets = null
      st.shellWindow = true
    }
    async function targetedRefresh(sid) {
      const st = stateFor(sid)
      if (st.targetTask) return st.targetTask
      const task = (async () => {
        try {
          const res = resolveSession(sid)
          if (res.error) {
            // Same retry semantics as scan: keep dirty, resolve later.
            st.error = res.error
            return
          }
          st.root = res.root
          st.policy = res.policy
          const stamp = st.mutationStamp || 0
          const targets = st.pendingTargets instanceof Set ? Array.from(st.pendingTargets) : []
          st.pendingTargets = new Set()
          if (targets.length === 0) {
            if ((st.mutationStamp || 0) === stamp) { st.dirty = false; st.shellWindow = false }
            return
          }
          let treeChanged = false
          let contentChanged = false
          for (const rel of targets) {
            let info
            try {
              info = await fs.stat(await fs.resolve(joinPath(st.root, rel)))
            } catch (e) { info = undefined }
            if (info && info.type === 'directory') {
              // A directory target: the mutation's full footprint is unknown
              // (every file under it may be affected) → fall back to the walk.
              st.pendingTargets = null
              st.shellWindow = true
              st.dirty = true
              return { fallback: true }
            }
            const before = st.files.get(rel)
            const beforeCur = before && before.cur ? before.cur : null
            const pending = isPending(before)
            const attrib = st.touched.has(rel)
            if (!info) {
              // Target is gone from disk. Only entries we already tracked as
              // present become "deleted" review items; never-seen paths have
              // nothing to review (same as the scan's deletion sweep).
              if (before && before.cur && before.cur.present) {
                treeChanged = true
                if (before.decisions.size > 0) { before.decisions.clear(); before.rev++ }
                before.cur = { present: false, content: null, eol: false, crlf: false, version: null, size: 0, binRef: null, binSize: 0 }
                before.rev++
                if (!pending && !attrib) before.base = absentEntry()
              }
              continue
            }
            const f = before || { base: null, cur: null, rev: 0, decisions: new Map() }
            if (!f.cur || !f.cur.present || f.cur.version !== info.version || f.cur.size !== info.size) {
              if (f.decisions.size > 0) { f.decisions.clear(); f.rev++ }
              f.cur = await loadFileEntry(st, rel)
              f.rev++
            }
            if (!before) st.files.set(rel, f)
            if (!before || !beforeCur || beforeCur.present !== f.cur.present) treeChanged = true
            else if (beforeCur.present && f.cur.present && beforeCur.version !== f.cur.version) contentChanged = true
            // First sight of this file (never scanned): the agent channel
            // decides the baseline — touched → "added" review, otherwise fold.
            if (f.base === null) {
              f.base = attrib ? absentEntry() : cloneEntry(f.cur)
            }
            // Non-pending change outside the agent channel → fold silently
            // (mirror of the scan; prevents the open viewer flashing a diff
            // the next scan would accept anyway).
            if (before && beforeCur && beforeCur.present && f.cur.present &&
                beforeCur.version !== f.cur.version && !pending && !attrib) {
              f.base = cloneEntry(f.cur)
              if (f.decisions.size > 0) f.decisions.clear()
              f.rev++
            }
          }
          // Consume the touched entries we handled (mirror of the scan).
          for (const rel of targets) st.touched.delete(rel)
          if ((st.mutationStamp || 0) === stamp) {
            st.dirty = false
            st.shellWindow = false
          }
          st.scannedAt = Date.now()
          st.error = null
          if (treeChanged || contentChanged) {
            bumpTree(st)
            scheduleSave(st)
          }
        } catch (e) {
          st.error = e && e.message ? String(e.message) : String(e)
        }
      })()
      st.targetTask = task
      try { await task } finally { if (st.targetTask === task) st.targetTask = null }
      return task
    }

    // The freshness rule shared by every RPC that needs the review state:
    //  * not scanned yet            → full scan (first scan builds the baseline);
    //  * dirty with precise targets → targeted per-file refresh;
    //  * dirty without targets      → full scan (the mutation could not be
    //    located precisely — the fallback the user asked to keep);
    //  * treeDirty (git add/commit) → consume the flag, no scan at all;
    //  * last full scan older than FULL_SCAN_TTL → one full walk (the 20s
    //    failsafe the client's poll rides on).
    async function ensureFresh(st, sid) {
      if (!st.baseReady) { await scan(sid); return }
      if (st.dirty) {
        if (st.pendingTargets instanceof Set && st.pendingTargets.size > 0) {
          const r = await targetedRefresh(sid)
          if (r && r.fallback) await scan(sid)
        } else {
          await scan(sid)
        }
        return
      }
      if (st.treeDirty) st.treeDirty = false
      if (st.scannedAt === 0 || Date.now() - st.scannedAt >= FULL_SCAN_TTL) await scan(sid)
    }

    async function walkFiles(dirTarget, rel, out, depth, count, ignored) {
      if (depth > MAX_DEPTH || count.n >= MAX_ENTRIES) return
      let entries
      try { entries = await fs.listDir(dirTarget) } catch (e) { return }
      for (const e of entries) {
        if (count.n >= MAX_ENTRIES) return
        const childRel = rel ? rel + '/' + e.name : e.name
        const repoRel = ignored && ignored.prefix ? ignored.prefix + '/' + childRel : childRel
        if (e.type === 'directory') {
          if (SKIP_DIRS.has(e.name)) continue
          // v1.17: wholly-ignored directories still descend — their files
          // stay reviewable. Only the budget accounting skips them.
          await walkFiles(e.target, childRel, out, depth + 1, count, ignored)
        } else if (e.type === 'file') {
          // v1.17: gitignored files stay fully in the review map (baseline +
          // diff) — they simply don't consume the MAX_ENTRIES budget.
          const isIgnored = !!(ignored && ignored.files.has(repoRel))
          if (!isIgnored) count.n++
          let version = e.version !== undefined ? e.version : null
          let size = e.size !== undefined ? e.size : 0
          if (version === null) {
            try {
              const info = await fs.stat(e.target)
              if (info) { version = info.version; size = info.size !== undefined ? info.size : size }
            } catch (err) {}
          }
          out.push({ rel: childRel, version: version, size: size })
        }
      }
    }

    async function treeNode(dirTarget, rel, depth, count, paths, ignored) {
      if (depth > MAX_DEPTH || count.n >= MAX_ENTRIES) return null
      let entries
      try { entries = await fs.listDir(dirTarget) } catch (e) { return null }
      const node = { name: rel === '' ? '.' : rel.split('/').pop(), type: 'directory', path: rel, children: [] }
      if (paths) paths.push(rel)
      for (const e of entries) {
        if (count.n >= MAX_ENTRIES) break
        const childRel = rel ? rel + '/' + e.name : e.name
        const repoRel = ignored && ignored.prefix ? ignored.prefix + '/' + childRel : childRel
        if (e.type === 'directory') {
          if (SKIP_DIRS.has(e.name)) continue
          // v1.17: ignored directories keep their full children in the tree
          // (grayed) — only the budget accounting skips ignored entries.
          const child = await treeNode(e.target, childRel, depth + 1, count, paths, ignored)
          if (child) node.children.push(child)
        } else if (e.type === 'file') {
          // v1.17: gitignored files stay in the tree (grayed by annotateTree)
          // with the same budget exemption as the scan.
          const isIgnored = !!(ignored && ignored.files.has(repoRel))
          if (!isIgnored) count.n++
          const fileNode = { name: e.name, type: 'file', size: e.size !== undefined ? e.size : 0, path: childRel }
          if (isIgnored) fileNode.ignored = true
          node.children.push(fileNode)
          if (paths) paths.push(childRel)
        }
      }
      // v1.15: directories first, files after; each group alphabetical
      // (case-insensitive). The fs listing order is not guaranteed to be
      // alphabetical, so the tree used to render in arbitrary order.
      node.children.sort(function (x, y) {
        const dx = x.type === 'directory' ? 0 : 1
        const dy = y.type === 'directory' ? 0 : 1
        if (dx !== dy) return dx - dy
        return String(x.name).localeCompare(String(y.name), undefined, { sensitivity: 'base' })
      })
      return node
    }

    // ---------- git VCS annotations (v1.15) ----------
    // The sidebar tree gets VSCode-style version-control decorations: a git
    // status letter per file (M modified / U untracked / A added / D deleted /
    // R renamed — staged or unstaged, whichever is the "newer" side wins) and
    // gray styling for .gitignore-excluded files/folders. Status comes from
    // one `git status --porcelain=v2 -z` call per workspace (cached briefly so
    // tree reload bursts share it); exclusions come from a single batched
    // `git check-ignore --stdin -z` fed with every walked path. Both are
    // optional decorations: no git → no letters, no failure path breaks the
    // tree. The whole section is process-local (no state persistence needed).
    const GIT_TTL = 2000
    const GIT_CANDIDATES = ['git', 'C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe']
    const gitCache = new Map()
    // v1.17: cached gitignore-excluded path set (same TTL as the VCS cache) —
    // ignored entries still walk, scan and review; only MAX_ENTRIES skips them.
    const ignoredCache = new Map()
    const gitKeyOf = (root) => (process.platform === 'win32' ? String(root).toLowerCase() : String(root))
    // v1.15.1: the plugin's own disk writes (reject / undo-reject / user
    // save) change the worktree↔HEAD relationship directly, so the 2s cached
    // git snapshot for that workspace would be stale on the very next tree
    // load (which the same action just scheduled via a treeStamp bump). Drop
    // the cache entry so the reload re-asks git and the badges tell the truth
    // immediately.
    function invalidateGitCacheFor(root) {
      if (!root) return
      const key = gitKeyOf(root)
      gitCache.delete(key)
      // v1.17: the ignored set changes with .gitignore edits and git add/rm —
      // drop it together with the status snapshot so the next walk re-asks git.
      ignoredCache.delete(key)
    }
    function findRepoRoot(root) {
      let cur = root
      for (let i = 0; i < 10 && cur; i++) {
        if (existsSync(join(cur, '.git'))) return cur
        const parent = join(cur, '..')
        if (parent === cur) break
        cur = parent
      }
      return null
    }
    function runGit(bin, args, cwd, input) {
      return new Promise((resolve) => {
        let settled = false
        const out = []
        const err = []
        let child
        try {
          child = spawn(bin, args, { cwd: cwd, windowsHide: true, env: Object.assign({}, process.env, { GIT_OPTIONAL_LOCKS: '0' }) })
        } catch (e) {
          resolve({ ok: false, spawnError: e })
          return
        }
        const kill = setTimeout(() => { try { child.kill() } catch (e) {} }, 20000)
        child.on('error', (e) => {
          if (settled) return
          settled = true
          clearTimeout(kill)
          resolve({ ok: false, spawnError: e })
        })
        if (child.stdout) child.stdout.on('data', (d) => out.push(d))
        if (child.stderr) child.stderr.on('data', (d) => err.push(d))
        child.on('close', (code) => {
          if (settled) return
          settled = true
          clearTimeout(kill)
          resolve({ ok: true, code: code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) })
        })
        try { child.stdin.end(input === undefined ? '' : input) } catch (e) {}
      })
    }
    // XY pair → single letter. The worktree column (Y) wins when both are
    // set — it is the state the tree actually shows on disk. Untracked `?`
    // records (porcelain v2 lists them as a bare `? path` field) map to U;
    // copied/typechange/unmerged collapse to M (the closest review state).
    function gitLetterOf(xy) {
      const x = xy ? xy.charAt(0) : ''
      const y = xy ? xy.charAt(1) : ''
      const c = (y && y !== '.' && y !== ' ') ? y : x
      if (c === '?') return 'U'
      if (c === 'A') return 'A'
      if (c === 'D') return 'D'
      if (c === 'R') return 'R'
      if (c === 'C' || c === 'T' || c === 'M' || c === 'U') return 'M'
      return null
    }
    // porcelain v2 + -z: RECORDS are NUL-terminated but the fields INSIDE a
    // record stay space-separated (verified against git 2.55); a pathname
    // containing spaces arrives C-quoted (`"my file.txt"`). This unquotes the
    // minimal C-escape set git's quote.c uses.
    function gitUnquote(s) {
      if (typeof s !== 'string' || s.charAt(0) !== '"') return s
      let out = ''
      for (let k = 1; k < s.length - 1; k++) {
        const ch = s.charAt(k)
        if (ch === '\\' && k + 1 < s.length - 1) {
          k++
          const n = s.charAt(k)
          if (n === 'n') out += '\n'
          else if (n === 't') out += '\t'
          else out += n
        } else out += ch
      }
      return out
    }
    async function gitInfoFor(root, relPaths) {
      // relPaths: workspace-relative paths of every walked file AND directory
      // ('' = the workspace root itself). Cached per root with a short TTL so
      // a burst of tree reloads shares one status computation.
      const key = gitKeyOf(root)
      const hit = gitCache.get(key)
      if (hit && Date.now() - hit.t < GIT_TTL) return hit.p
      const p = (async () => {
        const repoRoot = findRepoRoot(root)
        if (!repoRoot) return null
        let prefix = relative(repoRoot, root).replace(/\\/g, '/')
        if (prefix === '.') prefix = ''
        let statusOut = null
        for (const bin of GIT_CANDIDATES) {
          const r = await runGit(bin, ['-c', 'core.quotepath=false', '-c', 'status.renames=true', 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=none'], repoRoot)
          if (r.spawnError) continue
          if (!r.ok || r.code !== 0) return null // not a git repo (or git broken) → no decorations
          statusOut = r.stdout
          break
        }
        if (statusOut === null) return null
        const statuses = new Map()
        const records = statusOut.toString('utf8').split('\0')
        for (const rec of records) {
          if (rec === '') continue
          const t = rec.charAt(0)
          if (t === '1' || t === '2' || t === 'u') {
            // Split on spaces: every field up to the pathname is guaranteed
            // space-free, and the pathname is the rest of the record (so a
            // path containing spaces survives as one quoted tail element).
            const parts = rec.split(' ')
            const pathAt = t === '1' ? 8 : t === '2' ? 9 : 10
            const xy = parts.length > 1 ? parts[1] : ''
            const letter = gitLetterOf(xy)
            if (!letter) continue
            const path = gitUnquote(parts.slice(pathAt).join(' '))
            if (path) statuses.set(path, letter)
          } else if (t === '?') {
            // untracked: the whole record is `? <path>` (v2 quirk)
            const path = gitUnquote(rec.slice(2))
            if (path) statuses.set(path, 'U')
          }
          // anything else: unknown record shape — skip defensively
        }
        // .gitignore exclusions: one check-ignore process for the whole
        // tree. An ignored directory is reported itself AND each path under
        // it, so folders gray out with their contents; negation patterns
        // (`!keep.log`) are honored by git itself. Exit 0 = some ignored,
        // exit 1 = none ignored (empty set, not an error).
        const ignored = new Set()
        const repoPaths = relPaths.map((r) => (prefix ? prefix + '/' + r : r)).filter((r) => r !== '')
        if (repoPaths.length > 0) {
          for (const bin of GIT_CANDIDATES) {
            const r = await runGit(bin, ['check-ignore', '--stdin', '-z'], repoRoot, repoPaths.join('\0') + '\0')
            if (r.spawnError) continue
            if (r.ok && r.code === 0) {
              const s = r.stdout.toString('utf8')
              for (const p of s.split('\0')) if (p !== '') ignored.add(p)
            }
            // code 1 (nothing ignored) or any failure: leave the set empty
            break
          }
        }
        return { prefix: prefix, statuses: statuses, ignored: ignored }
      })().catch(() => null)
      gitCache.set(key, { t: Date.now(), p: p })
      return p
    }
    // v1.17: gitignore-excluded entries must not consume the walk budget.
    // The ignored set comes from ONE `git ls-files --others --ignored
    // --exclude-standard -z` call listing every ignored file individually
    // (negation patterns such as `!keep.log` are honored by git itself:
    // un-ignored files are simply absent from the list; tracked files are
    // never reported — git cannot ignore them). Ignored entries still walk,
    // scan and review exactly as before — only the MAX_ENTRIES accounting
    // skips them. Non-git workspaces and git failures return null = the
    // pre-v1.17 behavior.
    async function ignoredInfoFor(root) {
      const key = gitKeyOf(root)
      const hit = ignoredCache.get(key)
      if (hit && Date.now() - hit.t < GIT_TTL) return hit.p
      const p = (async () => {
        const repoRoot = findRepoRoot(root)
        if (!repoRoot) return null
        let prefix = relative(repoRoot, root).replace(/\\/g, '/')
        if (prefix === '.') prefix = ''
        let out = null
        for (const bin of GIT_CANDIDATES) {
          const r = await runGit(bin, ['-c', 'core.quotepath=false', 'ls-files', '-z', '--others', '--ignored', '--exclude-standard'], repoRoot)
          if (r.spawnError) continue
          if (!r.ok || r.code !== 0) return null // git broken / not a repo
          out = r.stdout
          break
        }
        if (out === null) return null
        const files = new Set()
        for (const part of out.toString('utf8').split('\0')) {
          if (part === '') continue
          files.add(part.replace(/\\/g, '/'))
        }
        return { prefix: prefix, files: files }
      })().catch(() => null)
      ignoredCache.set(key, { t: Date.now(), p: p })
      return p
    }

    // Post-order decoration pass: files take their own letter; a directory
    // takes the strongest letter among its descendants (D > A > R > M > U) so
    // a folder containing any change is itself flagged. Deleted files (D)
    // never appear as tree nodes (they are gone from disk), so their letters
    // reach ancestor directories through the status map instead. The ignored
    // flag is per node — every walked path was fed to check-ignore
    // individually.
    const GIT_PRIORITY = { U: 1, M: 2, R: 3, A: 4, D: 5 }
    function annotateTree(node, git) {
      const repoRel = (rel) => (git.prefix ? git.prefix + '/' + rel : rel)
      // Aggregate every status path's letter into each of its ancestor
      // directories (repo-relative keys) — O(entries × depth), depth ≤ 16.
      const dirAgg = new Map()
      for (const entry of git.statuses) {
        const letter = entry[1]
        const prio = GIT_PRIORITY[letter] || 1
        const segs = entry[0].split('/')
        for (let k = 0; k < segs.length; k++) {
          const d = segs.slice(0, k).join('/')
          const cur = dirAgg.get(d)
          if (!cur || cur.p < prio) dirAgg.set(d, { p: prio, letter: letter })
        }
      }
      const visit = (node, rel) => {
        let best = 0
        if (node.type === 'directory') {
          const agg = dirAgg.get(repoRel(rel))
          if (agg && agg.p > best) { best = agg.p; node.git = agg.letter }
          for (const c of node.children || []) {
            const r = visit(c, rel ? rel + '/' + c.name : c.name)
            if (r > best) { best = r; if (c.git) node.git = c.git }
          }
        } else {
          const l = git.statuses.get(repoRel(rel))
          if (l) { node.git = l; best = GIT_PRIORITY[l] || 1 }
        }
        if (git.ignored.has(repoRel(rel))) node.ignored = true
        return best
      }
      visit(node, '')
    }

    // ---------- analysis ----------
    function entryLines(entry) {
      return entry.present && entry.content !== null ? splitLines(entry.content) : []
    }
    // v1.18: per-entry review stats cache. Computing the stats runs the Myers
    // diff over the file's lines, which for a session with hundreds of
    // modified files made EVERY getModified (and acceptAll's list) pay the
    // full diff pass. The cache is keyed on f.rev — every mutation of
    // (base, cur, decisions) bumps rev, so a hit is exact. Not persisted
    // (saveState picks explicit fields only).
    function fileStats(f) {
      if (f.statsCache && f.statsCache.rev === f.rev) return f.statsCache
      const status = !f.base || !f.base.present ? 'added' : (!f.cur.present ? 'deleted' : 'modified')
      const note = (f.base && f.base.note) || f.cur.note || null
      let s
      if (note) {
        s = { status: status, note: note, pending: 1, added: 0, removed: 0 }
      } else {
        const baseLines = entryLines(f.base)
        const curLines = entryLines(f.cur)
        if (baseLines.length > MAX_DIFF_LINES || curLines.length > MAX_DIFF_LINES) {
          s = { status: status, note: 'large', pending: 1, added: 0, removed: 0 }
        } else {
          const hunks = computeHunks(baseLines, curLines)
          let added = 0, removed = 0, pending = 0
          for (const h of hunks) {
            if (f.decisions.has(h.id)) continue
            pending++
            added += h.newLen
            removed += h.oldLen
          }
          s = { status: status, note: null, pending: pending, added: added, removed: removed }
        }
      }
      f.statsCache = { rev: f.rev, ...s }
      return f.statsCache
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
        const s = fileStats(f)
        files.push({ path: rel, status: s.status, note: s.note, pending: s.pending, added: s.added, removed: s.removed })
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
    // v1.13.1: the cached st.policy can be null (state restored from disk and
    // no scan ran since the restart — getDiff serves from the restored map,
    // so resolveSession never refreshed it) or empty (resolve threw). Passing
    // null/empty to the fs service makes it fall back to the AGENTLESS policy
    // (deployment default + fallback root = the DSH process cwd), which denies
    // writes that are actually inside the session workspace — the observed
    // "file access denied under workspace-write mode" on Ctrl+S. Re-resolve
    // the session's CURRENT policy for every mutation; fall back to the cached
    // one only when the session is unavailable.
    function freshPolicy(st) {
      try {
        const session = sessions.get(st.sid)
        if (session) {
          const p = sandboxPolicy.resolve({ session })
          if (p && p.mode) return p
        }
      } catch (e) {}
      return st.policy ?? undefined
    }
    async function writeFile(st, rel, content) {
      const target = await fs.resolve(joinPath(st.root, rel))
      const outcome = await fs.writeText(target, content, undefined, undefined, freshPolicy(st))
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
      // v1.13.1: same null-policy hazard as writeFile — resolve fresh.
      const policy = freshPolicy(st)
      let result
      try {
        result = await shell.run(shell.resolve({ command: primary, sandboxPolicy: policy }))
      } catch (e) {
        result = undefined
      }
      if (!result || result.exitCode !== 0) {
        try {
          result = await shell.run(shell.resolve({ command: alternate, sandboxPolicy: policy }))
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
          f.justRejected = true
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
      // v1.13: reject rewrites disk content behind the client's back. The
      // next getDiff payload carries justRejected so the client resets the
      // per-file user edit history (unsaved user edits are discarded — their
      // base content was just reverted) instead of trying to reconcile.
      f.justRejected = true
      // v1.15.1: reject wrote disk (restored content or deleted the file),
      // which changes the worktree↔HEAD relationship the VCS badges answer.
      // Reload the tree unconditionally — not only for resurrected files —
      // and drop the cached git snapshot so the reload re-asks git. Note the
      // badge is NOT "cleared" here: baseline ≠ HEAD in general, so the
      // re-query may legitimately show an M (or remove one — when the
      // baseline equals HEAD, as after rejecting a committed-then-edited
      // file). Let git say what is true.
      bumpTree(st)
      invalidateGitCacheFor(st.root)
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
        // Build the tree and decorate it with git VCS annotations (v1.15).
        // The walk collects every visited path so one check-ignore batch can
        // gray out .gitignore-excluded entries; a non-git workspace simply
        // skips the decorations.
        const build = async (rootPath) => {
          const rootTarget = await fs.resolve(rootPath)
          // v1.17: the ignored set exempts gitignored entries from the tree
          // budget; they still render (grayed) with their full children.
          const ignored = await ignoredInfoFor(rootPath)
          const paths = []
          const tree = await treeNode(rootTarget, '', 0, { n: 0 }, paths, ignored)
          if (tree) {
            const git = await gitInfoFor(rootPath, paths)
            if (git) annotateTree(tree, git)
          }
          return tree
        }
        if (rootOverride) {
          try {
            const tree = await build(rootOverride)
            return { ok: true, root: rootOverride, tree: tree }
          } catch (e) {
            return { ok: false, error: e && e.message ? String(e.message) : String(e) }
          }
        }
        // v1.18: the tree walk itself reflects disk, so a full scan here is
        // only needed to keep the review state fresh (first scan / dirty /
        // 20s failsafe) — not on every tree expansion.
        if (!st.root) await scan(sid)
        else await ensureFresh(st, sid)
        if (st.error) return { ok: false, error: st.error }
        try {
          const tree = await build(st.root)
          return { ok: true, root: st.root, tree: tree }
        } catch (e) {
          return { ok: false, error: e && e.message ? String(e.message) : String(e) }
        }
      },

      async getModified(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        // v1.18: precise mutations refresh only their files; the full walk
        // runs on the first scan, the unlocatable-mutation fallback, and the
        // 20s failsafe cadence (ensureFresh).
        await ensureFresh(st, sid)
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
        // v1.18: resolve pending mutations precisely (targeted refresh) or by
        // the full-walk fallback, then the 20s failsafe cadence.
        if (!st.baseReady) {
          await scan(sid)
        } else if (st.dirty) {
          if (st.pendingTargets instanceof Set && st.pendingTargets.size > 0) {
            const r = await targetedRefresh(sid)
            if (r && r.fallback) await scan(sid)
          } else {
            await scan(sid)
          }
        } else if (st.scannedAt === 0 || Date.now() - st.scannedAt >= FULL_SCAN_TTL) {
          await scan(sid)
        }
        // Single-file freshness check for the OPEN file: one cheap stat that
        // keeps the viewer current even when the mutation targeted another
        // file or came from outside the agent channel (v1.8 fold semantics).
        try {
          const f = st.files.get(path)
          if (f && f.cur) {
            const target = await fs.resolve(joinPath(st.root, path))
            const info = await fs.stat(target)
            const changed = !f.cur.present || !info || f.cur.version !== info.version || f.cur.size !== info.size
            if (changed && f.decisions.size > 0) { f.decisions.clear(); f.rev++ }
            if (changed) {
              const pending = isPending(f)
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
        } catch (e) {}
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
            scheduleSave(st)
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
        const payload = diffPayload(f, prev)
        // v1.13: root lets the client key its per-file user edit history by
        // (workspace, relative path) — the history then survives closing/
        // reopening the tab and switching sessions within the workspace.
        payload.root = st.root
        // Transient reject marker (consumed once): a reject/undo-reject just
        // rewrote disk content, so the client should reset user edit history
        // for this file rather than reconcile against the new content.
        if (!payload.same) payload.justRejected = f.justRejected === true
        if (f.justRejected) f.justRejected = false
        return payload
      },

      async applyHunk(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        const path = args && args.path ? String(args.path) : ''
        const hunkId = args && args.hunkId ? String(args.hunkId) : ''
        const action = args && args.action === 'reject' ? 'reject' : 'accept'
        await ensureFresh(st, sid)
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
          // v1.15.1: hunk-reject wrote disk (merged content or deleted the
          // file) → reload the tree and drop the cached git snapshot so the
          // VCS badges re-ask git immediately (same reasoning as doReject).
          bumpTree(st)
          invalidateGitCacheFor(st.root)
        }
        let pendingCount = 0
        for (const h of all) if (!f.decisions.has(h.id)) pendingCount++
        if (pendingCount === 0) {
          f.base = cloneEntry(f.cur)
          f.decisions.clear()
        }
        f.rev++
        // v1.18: hunk-reject committed an undo record → persist immediately;
        // accept-only decisions can ride the debounced save.
        scheduleSave(st, action === 'reject')
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
        await ensureFresh(st, sid)
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
        // v1.15.1: user edit wrote disk → the worktree↔HEAD relationship may
        // have changed (editing a committed file makes it M). Reload the tree
        // and drop the cached git snapshot so the badges re-ask git.
        bumpTree(st)
        invalidateGitCacheFor(st.root)
        scheduleSave(st)
        return diffPayload(f, undefined)
      },

      // v1.13: whole-content user save. The client's line editor keeps its
      // own undo/redo model and sends the FULL current content (its own edits
      // applied on top of whatever the file held). Semantics extend v1.3's
      // applyEdit to arbitrary multi-line changes:
      //  * context edits (outside every pending hunk) fold into the baseline
      //    at the shift-aligned index — user edits never enter the review;
      //  * edits inside a pending hunk's new range update cur only, so they
      //    stay visible inside that hunk until accept/reject;
      //  * the write keeps the file's original EOL style (CRLF/eol flags).
      // The rev guard prevents clobbering an agent edit the client has not
      // seen yet; the stale response carries the fresh payload so the client
      // can merge its edits onto the new content and retry.
      async saveUserFile(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        const path = args && args.path ? String(args.path) : ''
        const rawLines = Array.isArray(args.lines) ? args.lines : null
        if (!rawLines) return { ok: false, code: 'bad', message: '无效的保存内容' }
        const lines = rawLines.map((s) => String(s).replace(/\r/g, ''))
        await ensureFresh(st, sid)
        if (st.baseReady) {
          // On-disk freshness check (mirrors getDiff's single-file refresh):
          // the editor may have been open across an agent edit the scan has
          // not absorbed yet — refresh this file first so the rev guard below
          // sees the true state instead of silently overwriting agent work.
          const f0 = st.files.get(path)
          if (f0 && f0.cur) {
            try {
              const target = await fs.resolve(joinPath(st.root, path))
              const info = await fs.stat(target)
              if (!info || !f0.cur.present || f0.cur.version !== info.version || f0.cur.size !== info.size) {
                if (f0.decisions.size > 0) { f0.decisions.clear(); f0.rev++ }
                f0.cur = await loadFileEntry(st, path)
                f0.rev++
              }
            } catch (e) {}
          }
        }
        if (st.error) return { ok: false, error: st.error }
        let f = st.files.get(path)
        if (!f || !f.cur) {
          // Never went through a scan: load on demand (same attribution rules
          // as getDiff — agent-created files stay reviewable as "added").
          try {
            const entry = await loadFileEntry(st, path)
            if (!f) {
              f = { base: null, cur: null, rev: 0, decisions: new Map() }
              st.files.set(path, f)
              bumpTree(st)
            }
            f.cur = entry
            if (f.base === null) {
              if (st.touched.has(path)) { f.base = absentEntry(); st.touched.delete(path) } else { f.base = cloneEntry(entry) }
            }
            f.rev++
            scheduleSave(st)
          } catch (e) {
            return { ok: false, code: 'not-found', message: '文件不存在' }
          }
        }
        if (!f.cur || !f.cur.present) return { ok: false, code: 'deleted', message: '文件已被删除' }
        f.justRejected = false
        const wantRev = args && args.rev !== undefined && args.rev !== null ? Number(args.rev) : NaN
        if (Number.isFinite(wantRev) && f.rev !== wantRev) {
          return { ok: false, code: 'stale', message: '文件已变化，请刷新后重试', payload: diffPayload(f, undefined) }
        }
        const baseLines = entryLines(f.base)
        const curLines = entryLines(f.cur)
        const all = computeHunks(baseLines, curLines)
        const canFold = !!(f.base && f.base.present && f.base.content !== null)
        let newBase = canFold ? baseLines.slice() : null
        if (newBase) {
          // inHunkAt[i] = cur index i sits inside a pending hunk's new range;
          // shiftAt[i] = Σ(newLen−oldLen) over hunks starting at or before i
          // (maps a cur index onto the aligned baseline index).
          const inHunkAt = new Array(curLines.length + 1).fill(false)
          const shiftAt = new Array(curLines.length + 1).fill(0)
          for (const h of all) {
            for (let k = h.newStart; k < h.newStart + h.newLen; k++) inHunkAt[k] = true
            shiftAt[h.newStart] += h.newLen - h.oldLen
          }
          for (let i = 1; i < shiftAt.length; i++) shiftAt[i] += shiftAt[i - 1]
          const ops = myersOps(curLines, lines)
          const ctxDel = []
          const ctxIns = []
          let insBefore = 0
          if (ops) {
            for (const op of ops) {
              if (op.t === 'e') continue
              if (op.t === 'd') {
                const curPos = op.i
                if (inHunkAt[curPos]) continue
                ctxDel.push({ idx: curPos - (shiftAt[curPos] || 0) })
              } else {
                const curPos = op.j - insBefore
                insBefore++
                if (curPos >= 0 && curPos < inHunkAt.length && inHunkAt[curPos]) continue
                ctxIns.push({ idx: curPos - (shiftAt[curPos] || 0), text: lines[op.j] })
              }
            }
          } else if (all.length === 0) {
            // Diff engine over budget on a user edit: no pending hunks to
            // protect, so the whole rewrite counts as a context edit — fold
            // everything into the baseline (the user owns the new content).
            newBase = lines.slice()
          }
          if (ops) {
            // Apply in reverse index order so earlier splices stay valid.
            ctxDel.sort((x, y) => y.idx - x.idx)
            for (const d of ctxDel) { if (d.idx >= 0 && d.idx < newBase.length) newBase.splice(d.idx, 1) }
            ctxIns.sort((x, y) => y.idx - x.idx)
            for (const ins of ctxIns) {
              const idx = Math.max(0, Math.min(newBase.length, ins.idx))
              newBase.splice(idx, 0, ins.text)
            }
          }
        }
        const textOut = joinLines(lines, f.cur.eol, f.cur.crlf)
        let outcome
        try {
          outcome = await writeFile(st, path, textOut)
        } catch (e) {
          return { ok: false, error: e && e.message ? String(e.message) : String(e) }
        }
        f.cur = { present: true, content: joinLines(lines, f.cur.eol), eol: f.cur.eol, crlf: f.cur.crlf, version: outcome.version, size: outcome.size !== undefined ? outcome.size : textOut.length, binRef: null, binSize: 0, md: f.cur.md === true }
        if (newBase !== null) f.base = { ...cloneEntry(f.base), content: joinLines(newBase, f.base.eol) }
        // Hunk topology changed (merged/split/vanished) → drop stale decisions
        // instead of misapplying them to reshaped hunks (v1.3 rule).
        const newAll = computeHunks(newBase !== null ? newBase : baseLines, lines)
        const shapeOf = (h) => h.oldStart + ':' + h.oldLen + ':' + h.newStart + ':' + h.newLen
        if (all.map(shapeOf).join('|') !== newAll.map(shapeOf).join('|')) f.decisions.clear()
        const newPending = newAll.filter((h) => !f.decisions.has(h.id))
        if (newPending.length === 0 && f.base && f.base.present) {
          // No pending hunks left: the file IS the baseline now — align
          // versions so isChanged() reports clean (same as applyEdit).
          f.base = { ...cloneEntry(f.base), version: outcome.version, size: outcome.size !== undefined ? outcome.size : textOut.length }
        }
        f.rev++
        // v1.15.1: user save wrote disk → the worktree↔HEAD relationship may
        // have changed. Reload the tree and drop the cached git snapshot so
        // the badges re-ask git immediately (same as applyEdit).
        bumpTree(st)
        invalidateGitCacheFor(st.root)
        scheduleSave(st)
        return diffPayload(f, undefined)
      },

      async acceptFile(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        const path = args && args.path ? String(args.path) : ''
        // v1.18: no unconditional walk — accept only needs the review state
        // fresh (first scan / dirty / 20s failsafe), not a disk re-sync.
        await ensureFresh(st, sid)
        const f = st.files.get(path)
        if (!f || !f.cur) return { ok: false, code: 'not-found', message: '文件不存在' }
        await doAccept(st, f, path)
        scheduleSave(st)
        return { ok: true }
      },

      async rejectFile(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        const path = args && args.path ? String(args.path) : ''
        await ensureFresh(st, sid)
        const f = st.files.get(path)
        if (!f || !f.cur) return { ok: false, code: 'not-found', message: '文件不存在' }
        try {
          const rec = newUndoRec()
          await doReject(st, f, path, rec)
          commitUndo(st, rec)
          // v1.18: reject is destructive (disk rewritten + undo record) —
          // persist immediately, never ride the debounced save.
          scheduleSave(st, true)
          return { ok: true }
        } catch (e) {
          return { ok: false, error: e && e.message ? String(e.message) : String(e) }
        }
      },

      async acceptAll(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        await ensureFresh(st, sid)
        const list = modifiedFiles(st)
        let applied = 0
        for (const item of list) {
          const f = st.files.get(item.path)
          if (!f) continue
          await doAccept(st, f, item.path)
          applied++
        }
        // v1.18: one debounced save covers the whole batch (and any accepts
        // that follow within 250ms); the response goes out before the
        // (potentially huge) state serialization runs in the background.
        scheduleSave(st)
        return { ok: true, applied: applied, files: modifiedFiles(st) }
      },

      async rejectAll(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        await ensureFresh(st, sid)
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
        scheduleSave(st, true)
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
            // v1.13: like reject, undoing a reject rewrites disk content —
            // tell the client to reset this file's user edit history.
            f.justRejected = true
            // v1.18: disk changed under the state → the next resolution must
            // run the full walk (the restore's footprint is unknown), not a
            // stale per-file refresh.
            st.dirty = true
            st.pendingTargets = null
          } catch (e) {
            skipped.push({ path: item.path, reason: e && e.message ? String(e.message) : String(e) })
          }
        }
        // v1.15.1: any restored file changed disk → reload the tree and drop
        // the cached git snapshot so the VCS badges re-ask git (undo-reject
        // restores the pre-reject bytes, which may differ from HEAD).
        if (restored.length > 0) {
          bumpTree(st)
          invalidateGitCacheFor(st.root)
        }
        try { rmSync(join(undoRoot(st.sid), rec.opId), { recursive: true, force: true }) } catch (e) {}
        st.lastReject = null
        // v1.18: undo clears a persisted record (lastReject) → force-save.
        scheduleSave(st, true)
        return { ok: true, restored: restored, skipped: skipped }
      },
    }

    // ---------- HTTP carrier ----------
    const route = webServer.register({
      kind: 'prefix',
      path: '/dsh-file-edit',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET' && req.url && req.url.startsWith('/dsh-file-edit/events')) {
            handleSse(req, res)
            return
          }
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
      for (const [, set] of sseClients) {
        for (const res of set) { try { res.destroy() } catch (e) {} }
        set.clear()
      }
      sseClients.clear()
      for (const [, h] of notifyTimers) clearTimeout(h)
      notifyTimers.clear()
      // v1.18: flush any debounced state saves so a stop/update cannot drop
      // the last accept/reject/scan changes.
      for (const [, rec] of saveTimers) { clearTimeout(rec.t); saveState(rec.st) }
      saveTimers.clear()
    }, 'dsh-file-edit: wait cleanup')

    // ---------- change triggers ----------
    ctx.on('tools/result', (exec, result) => {
      const agent = exec && exec.agent
      const sid = agent && agent.session ? agent.session.id : undefined
      if (!sid || !knownSessions.has(sid)) return
      const name = exec && exec.name ? exec.name : ''
      // v1.13.3 bugfix: the harness ToolExecution carries the parsed tool
      // arguments under `exec.arguments` (packages/core/tools: ToolExecution),
      // NOT `exec.args`. Reading `exec.args` yielded undefined, so shell/pwsh
      // command text was never inspected (Remove-Item never triggered) and
      // write/edit attribution always fell back to the whole-window sweep.
      const args = exec && (exec.arguments ?? exec.args)
      let mutating = false
      let cmd = ''
      if (name === 'write' || name === 'edit') mutating = true
      else if (name === 'shell' || name === 'pwsh') {
        // Only commands that can change the workspace trigger a refresh.
        // A command text we cannot inspect is treated as non-mutating
        // (strict per requirement: everything else must not trigger).
        // v1.15.1: mutating GIT commands count too — commit/checkout/... do
        // not match the shell-mutation list but still change the state the
        // VCS badges answer.
        cmd = args && typeof args.command === 'string' ? args.command : ''
        mutating = cmd !== '' && (MUTATING_SHELL_RE.test(cmd) || MUTATING_GIT_RE.test(cmd))
      }
      if (!mutating) return
      const st = stateFor(sid)
      if (!st.baseReady) return
      // v1.15.1: any agent mutation can change the VCS letters — drop the
      // cached git snapshot for this workspace so the next tree load re-asks
      // git (the 2s cache would otherwise serve a pre-mutation snapshot).
      invalidateGitCacheFor(st.root)
      // v1.18: git index-only commands (add/commit/init) change no worktree
      // byte — no dirty, no scan of any kind. The tree stamp + cache
      // invalidation refresh the VCS badges; getModified consumes treeDirty
      // without walking.
      if (MUTATING_GIT_RE.test(cmd) && GIT_INDEX_ONLY_RE.test(cmd)) {
        st.treeDirty = true
        bumpTree(st)
        scheduleNotify(sid, 300)
        return
      }
      st.dirty = true
      st.mutationStamp = (st.mutationStamp || 0) + 1
      // Worktree-mutating git commands bump the tree stamp directly (they can
      // change mostly .git or content the scanner may not attribute).
      if (MUTATING_GIT_RE.test(cmd)) bumpTree(st)
      // v1.8 change attribution (direction B): only changes that flowed
      // through the agent's tool channel enter the review.
      // v1.18: whenever the tool call NAMES its file targets, attribute and
      // refresh exactly those files (targeted refresh — no full walk).
      // write/edit carry an explicit file_path; mutating shell/pwsh/git
      // commands have their target paths extracted from the command text.
      // Anything unparseable falls back to the session-wide window (the full
      // scan) so agent work is never silently folded.
      let attributed = false
      if (name === 'write' || name === 'edit') {
        const raw = args && typeof args.file_path === 'string' ? args.file_path : ''
        const rel = normalizeRelPath(st.root, raw)
        if (rel) { st.touched.add(rel); addTarget(st, rel); attributed = true }
        else fallbackWindow(st)
      } else {
        // shell / pwsh / git: extract precise targets from the command text.
        // Both extractors run (a command can mix `git ... ; Set-Content ...`):
        // their targets UNION into the precise set. If EITHER extractor
        // cannot locate its targets (git reset --hard, wildcards, variables),
        // the whole command falls back to the session-wide window — a git
        // reset followed by a Set-Content still rewrote unknown files.
        const isGit = MUTATING_GIT_RE.test(cmd)
        const isShell = MUTATING_SHELL_RE.test(cmd)
        let rels = null
        let needFallback = false
        if (isGit) {
          const gr = extractGitPaths(cmd, st.root)
          if (gr) rels = gr
          else needFallback = true
        }
        if (isShell && !needFallback) {
          const sr = extractCommandPaths(cmd, st.root)
          if (sr) rels = rels ? new Set([...rels, ...sr]) : sr
          else needFallback = true
        }
        if (needFallback || !rels || rels.size === 0) {
          fallbackWindow(st)
        } else {
          for (const rel of rels) {
            const r = normalizeRelPath(st.root, rel)
            if (r) { st.touched.add(r); addTarget(st, r); attributed = true }
            else { attributed = false; break }
          }
          if (!attributed) fallbackWindow(st)
        }
      }
      // Wake any long-polling client right away (bursts of tool results in
      // one agent turn coalesce into a single wake-up). The woken client
      // pulls getModified once: precise targets refresh only those files,
      // fallbacks run exactly one full walk per mutation burst.
      scheduleNotify(sid, 300)
    })
  },
}
