# 已迁移

本项目已迁移至 **[justarook1e/dsh-ide-lite](https://github.com/justarook1e/dsh-ide-lite)**，并改用 npm 发版：**`@justarook1e/dsh-ide-lite`**。

本仓库**停止维护**，仅保留历史。原有安装方式（`install.ps1` 与 `raw` 直链）经 GitHub 重定向仍可用，但请尽快迁移。

迁移只改分发包名，运行期标识符（`/dsh-file-edit/...` 路由、`~/.dsh/dsh-file-edit-state/` 状态目录、浏览器偏好）均未变，**旧状态无需迁移**。

## 卸载

```powershell
# 通过 npm 安装的
pnpm dsh plugin --profile web remove @justarook1e/dsh-ide-lite

# 通过 git / install.ps1 安装的（旧版依赖键名）
pnpm dsh plugin --profile web remove dsh-file-edit
```

或运行 `install.ps1 -Uninstall`。**重启 DSH 后生效。**

可选：删除运行期审阅状态目录 `~\.dsh\dsh-file-edit-state`（会丢历史「拒绝」基线，不影响任何代码文件）。
