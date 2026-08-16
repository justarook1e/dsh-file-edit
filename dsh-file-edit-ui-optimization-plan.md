# dsh-file-edit 文件编辑器视图 UI 流畅性优化方案

> 状态：**方案已实施（v1.16.0，本地完成，未推送 GitHub）**——第 1–4 步（A-1/A-2/B-1/C-1）已落地并过集成测试；A-3、C-2 与第 4 节 Worker 化留待 Profiler 复测后决定。实施记录见 `dsh-file-edit-plugin-status.md` §28.4。
> 关联：`dsh-file-edit-plugin-status.md` §24 / §27 / §28.3；代码位置一律以 `client/dist/client.js` **v1.15.3 原行号**为准（v1.16.0 已偏移，行号仅作参考）。
> 目标：① 修改条（ModifiedBar）展开/收起卡顿 ② 文件编辑器视图下键入卡顿（约 1000 行即卡）。

---

## 0. 问题根因速览（已在前序分析中确认）

| 症状 | 根因 | 主线程位置 |
|---|---|---|
| ① 展开/收起卡顿 | 5 行上限把 `.dsh-fe-body-inner` 变成 `overflow-y:auto` 滚动容器，叠加在 `grid-template-rows` 逐帧 layout 动画上；滚动条出现/消失引发条高抖动，经 `dockH` 通道放大编辑器 `padding-bottom` 的 reflow | 主线程 layout |
| ② 键入卡顿 | **A**：`FileView` 顶层 `useStore()` → 任何 `store.emit()` 连带非 memo 的 `<DiffPane>` 重渲染 → 千行树 reconcile；**B**：`syncHl` 每击键整行 tokenize + 全量重建高亮 span；**C**：Sticky Scroll 的 scroll/resize 监听 + `elementFromPoint` 探测在主线程跑 | 主线程 React render / DOM 重建 / 布局探测 |

**关于"单独线程"的结论（已确认）**：视图渲染（DOM / React / contentEditable / CSS 布局）**无法离开浏览器主线程**，这是 Web 平台硬限制，插件无法突破。**可以**离主线程的是纯计算：语法高亮 `tokenize`/`buildOutline`/`renderMarkdown`（markdown-it）。因此正确组合拳 = **先 memo 化阻断不必要的千行树重渲染（治 A）→ 再把纯计算投递到 Web Worker（治 B/C 的计算部分）**。

---

## 1. 改动点 1（治 A，性价比最高）：阻断 FileView → DiffPane 的全量重渲染

### 现状

- `FileView(props)` 顶层调用 `useStore()`（`client/dist/client.js` L4267），订阅 store 全局 `emit`。
- `<DiffPane sid path>` 是 FileView 的**非 memo 化直接子组件**（L4421）。
- React 默认父组件重渲染必带动子组件重渲染，因此任何一次 `store.emit()`（打字**首击键**的 `setDirty`、`requestRefresh`、`setSessionId`、`setFileViewActive` 等）都触发 DiffPane 重新执行 `renderModelRow`/`renderRoRow` 循环，重建千行 React 元素树并 reconcile。

### 方案 A-1（首选，最小侵入）：给 DiffPane 套 `React.memo`

把 DiffPane 的导出包裹为 memo，仅当对当前视图真正有影响的 prop 变化时才重渲染：

```js
const DiffPane = React.memo(function DiffPane(props) {
  // ...原 DiffPane 函数体不变（L3118–4263）...
})
```

**关键点**：DiffPane 的 props 是 `{ sid, path }`。memo 后，FileView 因 `store.emit()` 重渲染时，只要 `sid`/`path` 相等（同一文件打开期间恒等），`React.memo` 浅比较就**跳过 DiffPane 子树**，千行树不再被连带 reconcile。

**必须同时处理的两个内部订阅**（否则 memo 化后会漏更新）：
1. DiffPane 内部已有 `useStore()`（L3630），它**自身**订阅了 store，`refreshTick` 变化等仍会触发自己重渲染——这正确，无需改。
2. DiffPane 的 `onDockH` 订阅（L4303–4307 在 FileView 里，通过 `viewerRef.node.style.setProperty` 写 CSS 变量）本身就是**命令式、不经过 React 渲染**的，与 memo 无关，保持原样。

**风险与验证**：
- 风险低。唯一要确认的是 DiffPane 是否隐式依赖 FileView 渲染时传入的某个变化值——当前 props 只有 `sid`/`path`，无其它隐式依赖。
- 验证：打开 1000+ 行文件，聚焦某行打字，用 React DevTools Profiler 确认「打字的后续击键不再触发 DiffPane 重渲染」；首击键 `setDirty` 的 emit 仍会触发一次（见 A-2）。

### 方案 A-2（叠加，消除首击键的那一次重渲染）：`setDirty` 走独立通道

打字**首击键**的 `markTyping`（L3092）调用 `store.setDirty(m.path, true)`（L3095）——它走 `store.emit()`（全局），即便 A-1 上了 memo，也会让 FileView 顶层 force 一次（虽然 DiffPane 被 memo 挡住，但 FileView 自身 + 标签条仍重渲染，且 emit 会让 ModifiedBar/WorkspaceSidebar 也 force）。

**改动**：仿照 `dockH` 的独立通道（L106–122），给 dirty 集合单独建 `dirtySubs`，`setDirty` 不再走全局 `emit`：

```js
// store 内新增（仿 dockH 模式）：
dirtyFiles: new Set(),
dirtySubs: new Set(),
setDirty(path, v) {
  const on = !!v
  if (on === this.dirtyFiles.has(path)) return
  if (on) this.dirtyFiles.add(path); else this.dirtyFiles.delete(path)
  for (const f of Array.from(this.dirtySubs)) { try { f() } catch (e) {} }
},
onDirty(f) { this.dirtySubs.add(f); return () => { this.dirtySubs.delete(f) } },
```

然后把**只有标签条白点**需要的订阅收窄到 `onDirty`，其它组件（ModifiedBar / WorkspaceSidebar / DiffPane 自身 `useStore`）不再因 dirty 变化被强制刷新。

**风险**：需排查现有代码里是否有组件**间接依赖** `store.emit()` 在 dirty 变化时的副作用。目前 `dirtyFiles` 仅用于标签条白点（L62 注释已写明）。需确认 `ModifiedBar` 是否读取 `dirtyFiles` —— 若有，需改为订阅 `onDirty`。

### 方案 A-3（可选，进一步）：行/端组件 memo

若 A-1 + A-2 后，DiffPane **自身**因 `refreshTick`/`modelVersion` 变化重渲染仍感卡，可对 `renderRoRow`/`renderModelRow` 产出的行做细粒度 memo（`React.memo` 包裹行组件 + 稳定 key）。但**行组件 memo 的收益有限、风险更高**（行内容随模型/高亮 state 变化，comparator 易漏），建议作为最后手段，不优先实施。

---

## 2. 改动点 2（治 B）：每击键的高亮重建优化

### 现状

`onInput`（L3970）→ `syncHl(el)`（定义 L2244）：

```js
const syncHl = (el) => {
  // 1) lineTokensCached(text, langId, {mode:null}) —— 正在编辑的行文本每次变，缓存 miss
  // 2) hl.textContent = '' 后循环 createElement 重铺所有 token span
}
```

对 1000 行文件，逐击键对**当前行**做完整 tokenize + DOM 重建。行本身不长时成本可控，但长行/复杂语法（三引号、正则、嵌套注释、markdown 围栏）时 tokenize 开销放大，并与病根 C 的滚动探测叠加。

### 方案 B-1（首选，简单有效）：限制 syncHl 为「仅活跃行 + 输入节流」

- `syncHl` 本身已经是「仅当前行」（操作的是 `el.parentNode` 里那个 `.dsh-fe-hl`），这点正确，不用改范围。
- 增加**输入节流**：用 `requestAnimationFrame` 合并同一帧内的多次 `onInput`，只在下一帧真正重建一次高亮。当前实现是每次 `onInput` 同步重建，快速击键会连续多次触发。

```js
let hlFlushRaf = 0
const syncHl = (el) => {
  if (hlFlushRaf) return            // 合并同一帧内的连续输入
  hlFlushRaf = requestAnimationFrame(() => {
    hlFlushRaf = 0
    // ...原重建逻辑（读 el.textContent 最新值）...
  })
}
```

注意：rAF 回调里要重新读 `el.textContent`（而不是闭包捕获旧值），否则高亮滞后一个字符。

### 方案 B-2（治本，与线程方案联动）：tokenize 迁 Web Worker

见第 4 节。这是把「每击键 tokenize」和「千行初始高亮」的 CPU 成本彻底移出主线程的正解，但实现量最大，建议在 A/B-1 落地且仍不够时再上。

---

## 3. 改动点 3（治 C，症状 1 的收尾）：Sticky Scroll 与展开/收起解耦

### 现状

- Sticky Scroll 在 `window` 捕获阶段挂了 scroll + resize 监听，25ms 闸门（L3232 起 `updateScopeBar`，含 `elementFromPoint` 探测、向上遍历 scrollport）。
- 展开/收起动画（`.dsh-fe-body` 的 `grid-template-rows` 过渡，L614–615）+ 5 行上限滚动容器（`.dsh-fe-bar-scroll .dsh-fe-body-inner { overflow-y:auto; max-height:… }`，L837）引发的布局抖动会触发上述监听，进而在主线程额外跑 outline 探测。

### 方案 C-1（治症状 1 的核心）：展开/收起动画与滚动容器解耦

5 行上限的滚动容器不应直接包在 `grid-template-rows` 动画元素里。两种等价改法，任选其一：

**改法①（推荐）**：`.dsh-fe-body` 保持 `grid-template-rows:1fr↔0fr` 动画，但 `.dsh-fe-body-inner` 的 `overflow-y:auto` 滚动改挂到**动画元素之外的固定高度容器**，滚动条的出现/消失不参与动画帧的布局重算。

**改法②（更简单）**：放弃 `grid-template-rows` 过渡，改为对 `.dsh-fe-bar` 整体做 `max-height` 过渡（`max-height: 6*rowH ↔ 0` + `overflow:hidden`），滚动容器放在内部且 `overflow-y:auto` 只在展开完成后才生效（或直接用固定 5 行高度，不动态插拔滚动条）。

关键点：**滚动条必须在动画落定后才出现/隐藏**，避免高度跳变透传 `dockH` → 编辑器 `padding-bottom`。

### 方案 C-2（治 C 的辅助）：scroll 监听加「布局稳定闸门」

`updateScopeBar` 的 25ms 闸门已合并 scroll 突发，但未区分「用户滚动」与「布局抖动触发的 scroll/resize」。可在 `setDockH`（L113）和展开/收起动画的 transitionend 之后，短暂（~150ms）标记 `layoutSettling = true`，`updateScopeBar` 在该窗口内直接早退，避免动画期间的无效探测。

---

## 4. 改动点 4（真·离主线程）：Web Worker 化纯计算

> 这是对你「单独线程」想法的**正确落地边界**：只迁纯计算，渲染留在主线程。

### 可迁移清单（均为纯函数，无 DOM 依赖）

| 函数 | 位置 | 输入 | 输出 |
|---|---|---|---|
| `tokenize` + `HL_LANGS`/`HL_SCANNERS`（24 语言扫描器） | L1435 起、L1672 起 | 文本行 + 语言配置 + 跨行 state | token 数组 + 新 state |
| `buildOutline`（Sticky Scroll） | v1.14 区块 | 行数组 + lang | 定义链 |
| `renderMarkdown` / `mdParser`（markdown-it） | v1.9 vendored 区块 | md 文本 | HTML 字符串 |

### 关键难点：tokenize 的跨行 state 不允许「单行投递」

现有 `tokenize(text, cfg, state)` **原地突变 `state`**（`state.mode`/`state.mlq`/`state.codeLang` 等，L1440–1523 等多处），用于贯通多行字符串/块注释/围栏。因此 Worker 化**不能**一次只传一行，必须：

1. **整段投递**：把当前文件的**整段行数组**（初始渲染）Post 到 Worker，Worker 端连续扫描所有行、返回 `tokens[][]`，主线程按行铺 span。这解决「千行初始高亮」的卡顿。
2. **增量策略（键入场景）**：打字属于低延迟交互，不能每击键都 Post 整段数组等往返。正确做法是**双轨**：
   - 活跃行（正在输入）用主线程同步 `syncHl` 即时高亮（沿用 B-1 + 现状）；
   - 后台 Worker 对「从活跃行之后受影响的范围」做增量重算，异步回填——由于多行 state 只向前传递，活跃行改动**只会影响其后续仍在多行 state 内的行**，通常很短（一个块注释/字符串的剩余几行），增量窗口极小。

### Worker 化的工程约束（务必遵守）

- bundle 是**单文件 classic script**（`__ModuleLoader__.load`），无 import/bundler（状态文件 §7/§17 多次强调）。因此 Worker 代码需走 **Blob URL / `data:` URL `new Worker(...)` + `self.onmessage`** 的内联方式，或**内嵌成字符串经 `URL.createObjectURL(new Blob([...]))` 构造**。
- tokenize 代码约 700 行 + keyword 表，需在 Worker 侧重发一份（复制到 worker 字符串里），无法与主线程共享函数作用域。
- Worker 输入输出必须**纯 JSON**（行数组、token 结构 `{t,c}`），符合 lossless JSON 要求。
- `ctx.effect` 生命周期：Worker 的创建/`terminate()` 必须挂到 fiber（`ctx.effect(() => { const w = ...; return () => w.terminate() })`），停止/更新时回收。
- **不建议**用 SharedArrayBuffer / transferable（复杂且收益边际）。

### 建议落地顺序

Worker 化放在**最后**（A-1 → A-2 → B-1 → C-1 → 再评估 → B-2/第4节），因为 A-1 的 memo 化可能已解决 80% 卡顿，Worker 的复杂度（双轨增量、代码重发、生命周期）与收益需在 A/B-1 落地后重新用 Profiler 验证是否仍有必要。

---

## 5. 实施顺序与验收标准

### 推荐实施顺序（按「见效/风险比」）

1. **改动点 1-A-1**（DiffPane 套 `React.memo`）—— 一行改动，预期解决大部分键入卡顿。
2. **改动点 1-A-2**（`setDirty` 独立通道）—— 消除首击键与 dirty 变化的全局重渲染。
3. **改动点 2-B-1**（syncHl rAF 节流）—— 消除快速击键的重复高亮。
4. **改动点 3-C-1**（展开/收起动画解耦滚动条）—— 解决症状 1。
5. **改动点 3-C-2**（layout 稳定闸门）—— 辅助，可选。
6. **Profiler 复测** → 若键入仍卡，再上 **改动点 4**（Worker 化）。

### 每步验收

| 改动 | 验收标准 |
|---|---|
| A-1 | React DevTools Profiler：同文件打字后续击键，DiffPane 子树不再重渲染；1000 行文件键入顺滑 |
| A-2 | 首击键不再触发 ModifiedBar / WorkspaceSidebar / 标签条以外的 force；白点仍正常 |
| B-1 | 快速连打字符时高亮不闪烁、不滞后超 1 字符；长行输入帧率提升 |
| C-1 | 反复展开/收起流畅、CPU 平稳；滚动条在动画落定后才出现/消失；编辑器 bottom 避让无抖动 |
| C-2 | 展开/收起动画期间无 Sticky Scroll 探测开销 |
| 4（Worker） | 千行大文件初始高亮不再阻塞主线程；键入仍即时；停止/更新插件后 Worker 正确回收 |

### 回归清单（每步后跑一遍）

- 行内编辑：打字 / Ctrl+Z/Y / Ctrl+S / Enter 换行 / Tab 缩进 / Esc 还原
- 接受/拒绝/全部接受拒绝/撤销
- hunk 头 + 跳转 pill + Sticky Scroll 共存
- 展开/收起 + 5 行滚动条 + 行出现/消失动画
- MD 编辑/阅读滑块 + 渲染视图
- 深色模式 + `prefers-reduced-motion`

---

## 6. 待确认事项（实施前请拍板）

1. **是否先只做 1–4 步（React/CSS 层），Worker 化（第 4 节）留待复测后再决定？** 我强烈建议此顺序——A-1 一行 memo 大概率已解决主症状，避免过早引入 Worker 复杂度。
2. **若实施，改动集中在 `client/dist/client.js`（仅刷新页面生效，无需重启 DSH）**；本轮无 Host 端改动。
3. 状态文件里多次强调 bundle 是**手工维护的单文件 classic script**，实施时需沿用「EXTRA_CSS 追加覆盖层、不改旧规则」的既有惯例，并同步 `guard` 横幅版本号 + `package.json` 版本 + 更新本方案/状态文档。
