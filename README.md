# Tavern Resource Hub (典藏工坊 · 预设 / 角色卡 / 世界书管理器)

兼容 **SillyTavern** 与 **TauriTavern** 的独立全屏现代化资源管理扩展，支持自动检测并联动 **酒馆助手（Tavern Helper / JS-Slash-Runner）**。

## 核心能力

1. **三合一独立全屏工作台**
   - 集中浏览与筛选酒馆内的**角色卡**、**对话补全预设**与**世界书（World Info / Lorebooks）**。
   - 在酒馆扩展设置面板（`#extensions_settings2`）及左下角魔法棒菜单（`#extensionsMenu`）均提供一键启动入口。
2. **输入链接一键更新与源地址绑定**
   - 支持直接输入 `.png` / `.json` 直链，或粘贴 **GitHub (`blob`)**、**GitHub Gist**、**GitLab**、**HuggingFace** 网页链接（自动转换为 Raw 下载直链，支持配置 GitHub Raw 加速镜像前缀）。
   - 自动嗅探远端载荷类型（PNG 角色卡、V2/V3 JSON 角色卡、预设 JSON、世界书 JSON）并计算 SHA-256 指纹。
   - 每个资源均可保存专属“更新源链接”，支持一键单资源拉取更新或批量检查全部已绑定资源的远端更新。
3. **原地无损更新（不丢聊天记录与本地绑定）**
   - **角色卡原地更新**：锁定原 `avatar` 文件名与 `chat` 会话指针原地写盘，不产生 `_1.png` 重复角色，**完整保留历史聊天记录、收藏状态与本地绑定的世界书**；支持自动同步提取卡内自带的内置世界书（`character_book`），并保留酒馆助手脚本变量（`extensions.tavern_helper.variables`）。
   - **预设原地更新**：原地覆盖同名预设并同步内存，**默认保护本地 API 连接地址、来源与模型字段**（防止导入他人预设导致当前 API 断连），可选保留本地提示词开关状态与酒馆助手脚本变量。
   - **世界书原地更新**：支持标准酒馆世界书与 V2 `character_book` 格式自动转换，原地更新词条并保持全局/角色绑定不断裂。
   - **更新前快照一键回滚**：每次执行原地更新前自动保存本地备份快照，支持随时一键回滚至更新前状态。

## 安装方式

- **通过酒馆扩展管理一键安装（推荐）**：
  在 SillyTavern 或 TauriTavern 的「扩展 (Extensions) → 安装扩展 (Install Extension)」中输入仓库地址：
  ```text
  https://github.com/JinSheng-oam/Tavern-Resource-Hub
  ```
- **TauriTavern 本地目录安装**：将 `Tavern-Resource-Hub` 文件夹复制到数据目录下的 `data/default-user/extensions/Tavern-Resource-Hub` 或 `data/extensions/third-party/Tavern-Resource-Hub`，刷新或重启窗口。
- **SillyTavern 本地目录安装**：将 `Tavern-Resource-Hub` 文件夹放置于 `public/scripts/extensions/third-party/Tavern-Resource-Hub`（或用户级 `extensions/` 目录），刷新网页并在扩展管理中启用。

## 本地验证与测试

在 PowerShell 7 中进入插件目录运行：

```powershell
# 运行单元测试（链接转换、PNG/JSON 编解码、原地无损更新与回滚）
npm test

# 运行无头 Chromium 模拟宿主端到端交互与多分辨率渲染回归
npm run test:browser
```
