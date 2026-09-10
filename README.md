# dsh-file-edit

> 本项目全部代码由 DeepSeek-V4-Pro 与 DeepSeek-V4-Flash 生成。

> ⚠️ **测试版声明**：本插件目前处于**测试阶段**（含实验性的文件编辑、撤销/重做与自动保存功能），可能存在未知缺陷。请谨慎使用，重要文件与重要会话数据请提前备份。

> **适配 DSH 版本**：当前版本（v1.29.0）适配 **DSH（deepseek-harness）`dsh-v0.1.5-rc.1`**（已在 rc.1 上实机核验：宿主 5 个服务契约、客户端 4 个槽位注册与终端/运行 RPC 全部正常）。

DSH WebUI 工作区文件插件，核心功能有三块：

1. **工作区文件浏览与编辑**：文件树浏览、多标签打开、语法高亮、Markdown 渲染，并可在浏览器里直接编辑文件内容；
2. **Diff 视图**：对发生变化的文件展示行级 diff，可逐块或整文件接受/拒绝，拒绝后可撤销；
3. **集成终端**：顶栏「终端」标签内直接运行命令并查看流式输出（ANSI 颜色），文件视图工具栏右侧的「运行」按钮可自动识别项目入口并一键启动。

## 功能

- **工作区侧边栏**（替换原生浏览器）：项目文件夹两层展开——会话历史（点开会话 / 新建会话；按最近活动时间倒序排列、每行右侧显示「2 min / 1 hr / 1 day」式相对时间标签；**最多同时显示 5 个会话，其余经「展开其余 N 个会话 / 收起」一行展开与收起**，与原生侧边栏同款控制；**悬浮会话行时右侧时间标签渐变为「⋮」三点菜单——删除（不可恢复，二次确认）与置顶/取消置顶，置顶的会话固定在列表最上方、多个置顶按最后活动时间排序并持久化；「会话历史」栏头悬浮出现管理按钮，进入管理后会话左侧出现勾选框，可勾选后批量删除（删除前确认，未勾选时勾选框会橙黄警示闪烁两下），取消即恢复**）与项目文件树（双击/单击打开、手动 ⟳ 刷新、文件集合变化自动刷新；**文件夹在上、文件在下，各自按字母排序**）。
- **Git 版本控制着色（VCS Annotations）**：项目文件树基于 Git 状态显示彩色字母徽标——`M` 已修改（黄）/ `U` 未跟踪（绿）/ `A` 已新增（绿）/ `D` 已删除（红）/ `R` 已重命名（蓝），文件夹聚合显示其内部最强的状态；被 `.gitignore` 排除的文件与文件夹显示为灰色，且**不参与 8000 条目扫描预算**（仍照常进入 DIFF 审阅）。徽标即时刷新：agent 改文件、插件拒绝/撤销拒绝、本地保存后立即重查；agent 执行 `git add/commit/checkout/reset/...` 等命令也即时刷新；**外部终端/编辑器造成的变更（含外部 git commit）在「项目文件」展开期间每 20 秒自动重查一次**（展开区块时也会立即重查），故徽标最多落后 20 秒。
- **顶栏「文件」标签**：与「对话/轨迹」并排；内容区是浏览器式标签条（切换 / ✕ 关闭 / ✕ 全部 / 拖拽排序 / 未保存编辑的白色圆点）。
- **修改文件列表**（输入框上方）：会话中经 agent 工具通道（write/edit/shell/pwsh）产生的修改/新增/删除，带 +/− 统计、逐文件接受/拒绝、全部接受/拒绝、撤销上次拒绝。
- **内联 Diff**：红/绿行级 diff、24 语言语法高亮、块级/文件级接受与拒绝、跳转控件、大文件只读预览、二进制还原。
- **Sticky Scroll（粘性滚动）**：代码视图滚动时，当前作用域的定义行（类/函数/结构体/接口/标题等，覆盖全部 24 种语法高亮语言）固定在头部，显示嵌套作用域链（如 `类 › 方法`）；点击链上任意一级即跳转定位到该定义行。
- **基线制审阅**：接受 = 当前内容成为新基线；拒绝 = 把基线写回磁盘（新增文件拒绝 = 删除文件）；拒绝可撤销（单层）。
- **完整的文件编辑**：文件视图内直接输入/删除、Enter 换行（行首 Backspace / 行尾 Delete 合并行）、Ctrl+C/V 复制粘贴（跨行复制/多行粘贴）、Tab / Shift+Tab 缩进与反缩进、↑↓ 跨行移动插入点、Esc 还原当前行。
- **独立撤销/重做**：Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z 使用插件自己的撤销栈（与网页其他区域完全隔离），只撤销**用户的编辑**、绝不撤销 AI 的 DIFF；撤销后新编辑会按 Word 惯例抛弃重做分支；AI 修改/删除文件、拒绝/撤销拒绝还原文件时自动重置该文件的编辑记录。
- **编辑记录持久化**：按（工作区, 文件路径）存于浏览器 localStorage——关闭并重开标签、切换 SESSION、重启 DSH 服务后都能继续撤销/重做。
- **保存时点**：Ctrl+S 主动保存；切换会话 / 关闭文件标签时弹窗确认（保存 / 不保存 / 取消）；AI 编辑文件后自动保存（用户编辑与 AI 修改冲突的部分保留 AI 版本并提示）；保存后标签上的白点消失。
- **文件内编辑语义**：Ctrl+S 保存时用户的编辑（包括 hunk 区域内的改动）全部折入基线、不进入待审 hunks——保存后的内容只保留 agent 尚未碰过的改动仍待审；空文件可直接输入首行。
- **Markdown 渲染视图**：`.md`/`.markdown` 无待审修改时直接渲染（GFM 表格、围栏代码高亮、无行数上限）。
- **即时更新**：agent 改/增/删文件后约 1.5s 内主动出现在界面（SSE/长轮询唤醒），无需手动刷新。
- **精准 DIFF 检查（v1.18）**：agent 使用 `write`/`edit`（带明确文件路径）或可解析出文件路径的 shell/pwsh 命令（如 `Set-Content -Path ...`、`Remove-Item ...`、`git checkout -- ...`）时，只对**被操作的文件**做检查与归属，不再每次触发都全量扫描工作区；无法从命令文本定位目标文件（通配符、变量、目录级操作、`git reset --hard` 等）时回退为全量扫描。全量扫描仅保留在**首扫、无法定位文件时的回退、以及每 20 秒的兜底轮询**三种情况。
- **大规模审阅性能（v1.18）**：状态保存改为防抖合并（连续接受/拒绝共享一次落盘，响应先于序列化返回）、已审阅文件不再重复持久化 `cur` 内容（状态文件体积约减半）、修改列表统计按文件版本缓存——文件数量很大时，单文件接受/全部接受不再卡顿。
- **文件内搜索（v1.22）**：代码视图中 Ctrl+F 弹出搜索框——固定在「上一处/下一处变更」跳转控件左侧（同一粘性条），若按 Ctrl+F 前选中了文本则自动填入搜索框；命中文本以琥珀色高亮（当前命中更强高亮 + 描边），搜索框右端一体化背景内提供 ▲/▼箭头上一处/下一处（或 Enter/Shift+Enter/↑/↓），Esc 关闭并清除高亮；支持多行查询（按显示行拼接匹配）。
- **多行鼠标选择与粘贴修复（v1.22）**：鼠标拖拽可跨行选择（每行是独立 contentEditable，浏览器原生拖选被限制在单行内——插件改为跨行补全 DOM 选区）；Ctrl+V 粘贴改走 Paste 事件（原实现在 keydown 上读 `clipboardData` 恒为空导致粘贴失效），多行文本粘贴自动分行。
- **DSH 版本兼容（v1.23 / v1.24 核验）**：适配 DSH `dsh-v0.1.5-alpha.1` 移除的 workspace 客户端 API——「新建会话」「添加工作区」「新建会话守卫（未决修订拦截）」改经新版 `uiWorkspace` 服务（`startSession` / `pickDirectory`，懒探测、非硬依赖）。该适配在 `dsh-v0.1.5-rc.1` 上**原样继续成立**（rc.1 新增的 keyed 根槽 `main` / `main.conversation`、`ctx.layout.selectPanel`、`sidebar.panellist` 均不影响本插件注册的 `sidebar.workspaces`、`conversation.view`、`conversation.input.dock`）。
- **集成终端（v1.24）**：顶栏新增「终端」标签（在「文件」右侧）——工作目录 = 会话工作区，逐条命令在独立进程中执行（`cd` 由插件接管并保持，因此 `cd src` 后 `ls` 仍然生效），流式输出支持 ANSI 颜色（16 色 / 256 色 / 真彩色、加粗、下划线、反显）、`\r` 进度条重写与 `\x1b[K` 清除；运行中的进程可用「中断」按钮（等同 Ctrl+C，整棵进程树一起结束），输入行在进程运行时直接写入该进程 stdin（可回答 y/N、`input()`、`Read-Host` 等交互提示）；支持 ↑↓ 命令历史、Ctrl+L 清空、回车执行。**注意：终端命令不受 agent 沙箱策略限制**（等同本机终端），执行产生的文件变化按「用户改动」折叠进基线，不进入 DIFF 审阅。
- **项目运行按钮（v1.24 / v1.25 / v1.29）**：文件标签页下方那行（文件工具栏）右侧新增运行按钮——自动识别项目入口并按**项目本地环境优先、全局兜底**排序：`package.json` scripts（pnpm/yarn/bun/npm 按锁文件判定，`node_modules/.bin/<pm>` 存在时优先本地）与 `main` 字段、Python（本地解释器优先，`manage.py runserver`、`main.py`/`app.py`、`pyproject [project.scripts]`）、Rust（`cargo run`）、Go（`go run .`）、.NET（`dotnet run`）、Java（`gradlew bootRun`/`run`、Spring Boot 的 `mvn spring-boot:run`）、Makefile（`make run`）、PHP（Laravel `artisan serve`、内置服务器）、Ruby（`rackup`）、Docker Compose、`run.ps1`/`run.sh` 脚本，最后是当前文件（`node`/`python`/`bash`/PowerShell）。唯一候选一键直跑，多个候选弹出选择列表（带「本地/全局」标记，并标注命中的本地解释器路径）；点击后自动切到终端标签并执行，运行期间图标变为「停止」。**v1.29 起按钮只用一个图标**（不再有「运行」文字，也没有右侧的下拉箭头）：
  - **左键**：只有一个候选 → 直接运行；多个候选 → 弹出选择列表；
  - **右键**：始终弹出选择列表（即使只有一个候选，也可以先看清它要用哪个解释器）；
  - **运行中**：左键 = 中断当前进程（图标变为方块），右键不响应（此时本来也没有第二个目标可选）；
  - 文字信息移入悬浮提示（`title`）与无障碍标签（`aria-label`），按钮尺寸 22×22，与工具栏其它图标按钮一致。
  - 注意：**只有一个候选时左键会直接运行**，想先确认命令/解释器请用**右键**打开选择列表；未识别到入口时右键列表会给出提示（可直接到「终端」手敲）。
- **文件树显示范围与 DIFF 排除范围分离（v1.27）**：侧边栏「项目文件」以前会**完全隐藏**依赖/运行时/产物目录（`python`、`node_modules`、`build`、`vendor`、`playwright_browsers` 等 45 个名字，任意层级生效），理由是它们不是人写的源码、不该进审阅。问题是这样连**正常的目录布局**也一起隐藏了（例如打包结构 `dist_package/python/`、`dist_package/playwright_browsers/` 在侧边栏里根本不存在）。现在拆成两件事：
  - **文件树只隐藏真正的元数据目录**（`.git`、`.dsh`、`.idea`、`.vscode`），其余目录**一律正常显示、可展开、可打开文件**；
  - **DIFF 审阅扫描仍按原 45 项清单排除**（`walkFiles` 不变）——这些目录里的改动**不会**出现在「修改文件」列表 / DIFF / 接受拒绝流程里。
  - 这些目录里的文件**可以正常打开与编辑**：走「按需加载」通道（`getDiff` 的 lazy 分支，v1.8 起就有），用户自己的改动直接折入基线、不进审阅。
  - 树的上限也与审阅预算解耦：审阅仍是 8000 条（覆盖上限），**树另有 20000 节点上限**（纯序列化保护）。注意 **`.gitignore` 里的条目不计入这两个上限**，所以被忽略的运行时目录（如 `dist_package/python/`，15,690 个文件）会**完整**进入树——代价是这一棵树的 JSON 可能达到数 MB、构建耗时数百毫秒（本机实测：17,335 节点 / 2.6 MB / 约 660ms，属一次性构建，仅在树变化时重建）。
- **本地运行时优先（v1.25 / v1.26）**：「本地优先」指的是**运行时本身**，不只是脚本——项目内解析到的解释器/工具链一律以**绝对路径**调用（`& "C:\...\项目\python.exe" main.py`），不再交给 PATH 解析。搜索顺序（先命中者胜）：①`.venv` / `venv` / `env`（含其 `Scripts`、`bin` 子目录——携带项目已装依赖的虚拟环境最优先）②**项目根目录本身**（便携版 / embeddable 的 `python.exe`、`node.exe` 直接放在项目里的情形）③`bin` / `Scripts` / `tools` / `runtime` / `.python` / `node_modules/.bin` / `vendor` ④根目录下形如 Python 发行版的文件夹（`python/`、`python3.12/`、`pyenv/`、`miniconda3/`、`anaconda3/`、`winpython/`、`pypy/`，连同其 `Scripts`、`bin`）⑤**「打包目录」形状**（v1.26）：上面这套名字启发式会跟着目录走——凡是根目录下的子文件夹、**或当前打开文件所在目录及其上层目录**里出现上述形状的 Python 发行版文件夹，同样纳入搜索。典型场景是打包发布结构 `dist_package/python/python.exe` + `dist_package/src/xxx.py`（仓库名与运行时文件夹名都看不出「python」，只靠根目录清单找不到）。Python、Node、Cargo、Go、.NET、Make、PHP、Ruby、Docker、bash 全部适用；项目内确实没有时才回退到全局命令（下拉标记「全局 PATH」）。

- **搜索框 Esc 关闭（v1.24）**：文件内搜索框打开后，无论焦点在搜索框、编辑区还是工具栏，按 Esc 都会关闭搜索框并清除高亮（此前只有焦点在搜索框内时 Esc 才生效）。
- **「文件」/「终端」界面不再出现对话区宽度拖拽条（v1.28）**：DSH `dsh-v0.1.5-rc.1` 在会话列里加了一对宽度拖拽条（鼠标悬浮出现竖直光条、光标变 `col-resize`，拖动调整对话内容宽度）。这对居中的「对话」转写区是有意义的，但「文件」与「终端」是整幅应用式面板——拖拽条只会悬浮出光标与光条、并可能把并不显示转写区的视图宽度悄悄改掉。插件现在在这两个界面里**隐藏这对拖拽条**（命中区域也一并消失，原本被 40px 拖拽条盖住的编辑器/终端表面重新可直接点击）：
  - 只隐藏拖拽条本身，**不动宽度轴**——切回「对话」仍是用户此前设定/拖出来的宽度；
  - 「对话」的拖拽照常可用、照常持久化（`dsh.conversation.contentWidth`），「轨迹」的抑制是 DSH 自己的行为，与本插件无关；
  - 纯客户端 CSS 实现（`client/dist/client.js` 的 `EXTRA_CSS`），不注册额外 DOM/服务，也不改 DSH 侧文件；DSH 若改了这两处标记（`[data-width-handle]`、`[data-conversation-scroll]`）则退化为「拖拽条重新出现」，不会影响插件本身的功能。
- **CRLF/LF 换行符变化不再进 DIFF（v1.29）**：以前「判断文件是否变化」用的是 DSH `fs` 服务的 **stat 身份**（`FsVersion`＝`dev:ino:size:mtimeNs:ctimeNs`），而它**不是内容哈希**——把 CRLF 换成 LF（或反过来）每行少/多一个字节，`size` 立刻变了，于是插件认定"文件被改了"：文件进入「修改文件」列表、工具栏出现接受/拒绝按钮并显示"已修改"，点开却是"无未决定修改"（行级对比其实一行都没动）。任何**内容完全相同的重写**（agent 用 `write` 写回同样的文本、编辑器"保存"但没改东西）也同样中招。现在判断改成**内容优先**：
  - 文本文件比较**行数组**（就是 diff 本身比较的东西）——因此对 CRLF/LF **以及文件末尾换行符的有无**都不敏感（两者都不改变任何一行）；二进制/超大文件（内存里没有内容）仍只能靠 stat 身份判断；
  - 纯换行符变化**不会**产生审阅条目、不会让工具栏变成"已修改"、不会让文件树/徽标误刷新，也不会再触发重读重算；
  - 真正的内容变化（含"换行符变了、同时也改了行"的混合情况）判断与行数统计完全不变；接受/拒绝/撤销拒绝、二进制变更、新增/删除文件的行为均未受影响。

## 一条命令安装（推荐）

需要本机已装 DSH（`~/.dsh/profiles/web` 存在）且能访问 GitHub。PowerShell 中执行：

```powershell
irm https://raw.githubusercontent.com/justarook1e/dsh-file-edit/main/install.ps1 | iex
```

完成后：**重启 DSH**（加载宿主插件与挂载项），然后 **Ctrl+F5 刷新页面**（加载客户端 bundle）。

> 备选（clone 方式，凭据走 Git Credential Manager）：
> `git clone https://github.com/justarook1e/dsh-file-edit.git "$env:TEMP\dsh-file-edit"; & "$env:TEMP\dsh-file-edit\install.ps1"`

## 手动安装

1. 把本仓库的 `package.json`、`host/`、`client/` 复制到 `~/.dsh/profiles/web/node_modules/dsh-file-edit/`；
2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 末尾追加：

   ```yaml
   - insert:
       - id: dsh-file-edit
         name: dsh-file-edit
   ```

3. 重启 DSH + Ctrl+F5 刷新页面。

`install.ps1` 做的正是这两步（幂等，可重复执行；`-Uninstall` 反向移除）。

## 更新

再次运行安装脚本即可（幂等，覆盖已安装的包）：

```powershell
irm https://raw.githubusercontent.com/justarook1e/dsh-file-edit/main/install.ps1 | iex
```

或（clone 方式）：`cd "$env:TEMP\dsh-file-edit"; git pull; & .\install.ps1`

## 卸载

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/justarook1e/dsh-file-edit/main/install.ps1))) -Uninstall
```

或（clone 方式）：`& "$env:TEMP\dsh-file-edit\install.ps1" -Uninstall`

或手动删除 `node_modules/dsh-file-edit/` 与 patch 里的 insert 块。重启后生效。

## 仓库结构

```
dsh-file-edit/
├── package.json          # dsh.client: {platform:'web'} + exports["./client"]
├── host/index.mjs        # 宿主插件：扫描/基线/diff/接受拒绝/终端/运行识别/RPC（POST /dsh-file-edit/api）
├── client/dist/client.js # 浏览器 bundle（__ModuleLoader__.load + factory）
└── install.ps1           # 一键安装/卸载脚本
```

## 运行期数据

- 每会话审阅状态（基线、待决定项、撤销记录）存在 `~/.dsh/dsh-file-edit-state/`，由插件自动创建与维护；重启后自动恢复。
- 用户编辑历史（撤销/重做栈）存在浏览器 localStorage（key 前缀 `dsh-fe-edit-v1:`），按（工作区根, 相对路径）组织，与 DSH 服务端状态相互独立。
- 从旧名 `dsh-files` 升级时，宿主首次启动会把旧的 `~/.dsh/dsh-files-state/` 自动迁移过来，待审状态不丢。

## 已知限制

- 替换了原生 WorkspaceBrowser：没有搜索、分组/排序菜单、重命名/删除/归档对话框（保留了添加工作区、打开/新建会话）。
- 跳过目录：`.git` `node_modules` `.venv` `venv` `__pycache__` `.next` `.dsh` `.idea` `.vscode` `.cache` `.turbo` `.pytest_cache` `.mypy_cache` `.ruff_cache` `.eslintcache` `.DS_Store`；树上限 8000 条目 / 16 层。**被 `.gitignore` 排除的文件/目录（`git ls-files --others --ignored --exclude-standard` 判定）不占用 8000 条目预算，但仍照常进入扫描与 DIFF 审阅**（修改/新增/删除照常出现在修改列表），文件树中灰显、可照常展开浏览；`!` 否定规则由 git 自身语义保证；非 git 工作区行为不变。注意：工作区存在大量被忽略文件时（如内嵌 Python 运行时），扫描覆盖全部条目，状态文件与树负载会相应变大。
- 大文件不做行级 diff：>512KB 或 >8000 行标为 `large`（≤512KB 的文本可只读预览前 4000 行）；二进制 ≤4MB 可拒绝还原。
- shell/pwsh 命令不透明，执行期间的变更会保守地全部归入审阅（无法区分同窗口内的手动操作）。
- 基线随插件重启重建（待审状态本身持久化）。
- **终端（v1.24）**：每条命令在独立进程中执行，因此只有 `cd` 会跨命令保持（环境变量、别名、函数等 shell 状态不保持）；不带 PTY，全屏 TUI（vim/htop 等）无法正常显示，交互提示通过输入行写入 stdin；输出滚动缓冲上限约 400KB（超出丢弃最旧部分）；终端进程随插件卸载（DSH 重启 / 插件停止）一起结束。**在终端里手动输入的命令仍按宿主 PATH 解析**：v1.25 / v1.26 的本地优先只作用于「运行」按钮识别出的候选（它们带绝对路径），不会改写终端的 PATH，也不会拦截手敲的 `python`——即 `$ python xxx.py` 这类手敲命令仍会用到全局解释器。
- **运行按钮（v1.24 / v1.25 / v1.26 / v1.29）**：项目识别是启发式的，覆盖常见语言/框架（Node、Python、Rust、Go、.NET、Java、Make、PHP、Ruby、Docker Compose、脚本）；未识别到入口时选择列表会给出提示，可直接在终端中手动输入命令。除「项目内是否有本地运行时」外不做可用性探测（如 `cargo` 未安装时会在终端里报 command not found）。本地运行时搜索只看**固定候选目录 + 「打包目录」形状的同层/上层目录**（见上），不做全树递归——把 `python.exe` 放在 `a/b/c/` 这类既非约定名、又与当前文件无关的深路径下仍不会被找到（此时列表里不会出现本地候选，可用终端手敲绝对路径）。按钮自 v1.29 起只有一个图标（无文字、无下拉箭头），**左键直跑唯一候选、右键总是打开选择列表**（见上）。

## 许可证

本项目以 **MIT License** 发布（见 [LICENSE](LICENSE)）。

客户端 bundle（`client/dist/client.js`）内嵌了 [markdown-it](https://github.com/markdown-it/markdown-it) v15.0.0 的浏览器 UMD 构建，其中包含 linkify-it、mdurl、uc.micro。这些依赖同样以 MIT 发布，其版权声明与完整许可证文本见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。
