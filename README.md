# dsh-file-edit

> 本项目全部代码由 DeepSeek-V4-Pro 与 DeepSeek-V4-Flash 生成。

DSH WebUI 工作区文件插件，核心功能有两块：

1. **工作区文件浏览与编辑**：文件树浏览、多标签打开、语法高亮、Markdown 渲染，并可在浏览器里直接编辑文件内容；
2. **Diff 视图**：对发生变化的文件展示行级 diff，可逐块或整文件接受/拒绝，拒绝后可撤销。

## 功能

- **工作区侧边栏**（替换原生浏览器）：项目文件夹两层展开——会话历史（点开会话 / 新建会话）与项目文件树（双击/单击打开、手动 ⟳ 刷新、文件集合变化自动刷新）。
- **顶栏「文件」标签**：与「对话/轨迹」并排；内容区是浏览器式标签条（切换 / ✕ 关闭 / ✕ 全部 / 拖拽排序 / ● 修改标记）。
- **修改文件列表**（输入框上方）：会话中经 agent 工具通道（write/edit/shell/pwsh）产生的修改/新增/删除，带 +/− 统计、逐文件接受/拒绝、全部接受/拒绝、撤销上次拒绝。
- **内联 Diff**：红/绿行级 diff、24 语言语法高亮、块级/文件级接受与拒绝、跳转控件、大文件只读预览、二进制还原。
- **基线制审阅**：接受 = 当前内容成为新基线；拒绝 = 把基线写回磁盘（新增文件拒绝 = 删除文件）；拒绝可撤销（单层）。
- **文件内编辑**：文件视图中直接编辑（contentEditable），用户编辑折入基线、不打扰 agent 的待审 hunks；空文件可直接输入首行。
- **Markdown 渲染视图**：`.md`/`.markdown` 无待审修改时直接渲染（GFM 表格、围栏代码高亮、无行数上限）。
- **即时更新**：agent 改/增/删文件后约 1.5s 内主动出现在界面（会话运行中自适应快轮询 + 长轮询唤醒双通道），无需手动刷新。

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
├── host/index.mjs        # 宿主插件：扫描/基线/diff/接受拒绝/RPC（POST /dsh-file-edit/api）
├── client/dist/client.js # 浏览器 bundle（__ModuleLoader__.load + factory）
└── install.ps1           # 一键安装/卸载脚本
```

## 运行期数据

- 每会话审阅状态（基线、待决定项、撤销记录）存在 `~/.dsh/dsh-file-edit-state/`，由插件自动创建与维护；重启后自动恢复。
- 从旧名 `dsh-files` 升级时，宿主首次启动会把旧的 `~/.dsh/dsh-files-state/` 自动迁移过来，待审状态不丢。

## 已知限制

- 替换了原生 WorkspaceBrowser：没有搜索、分组/排序菜单、重命名/删除/归档对话框（保留了添加工作区、打开/新建会话）。
- 跳过目录：`.git` `node_modules` `.venv` `venv` `__pycache__` `.next` `.dsh` `.idea` `.vscode` `.cache` `.turbo` `.pytest_cache` `.mypy_cache` `.ruff_cache` `.eslintcache` `.DS_Store`；树上限 8000 条目 / 16 层。
- 大文件不做行级 diff：>512KB 或 >8000 行标为 `large`（≤512KB 的文本可只读预览前 4000 行）；二进制 ≤4MB 可拒绝还原。
- shell/pwsh 命令不透明，执行期间的变更会保守地全部归入审阅（无法区分同窗口内的手动操作）。
- 基线随插件重启重建（待审状态本身持久化）。

## 许可证

本项目以 **MIT License** 发布（见 [LICENSE](LICENSE)）。

客户端 bundle（`client/dist/client.js`）内嵌了 [markdown-it](https://github.com/markdown-it/markdown-it) v15.0.0 的浏览器 UMD 构建，其中包含 linkify-it、mdurl、uc.micro。这些依赖同样以 MIT 发布，其版权声明与完整许可证文本见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。
