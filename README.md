# Claude-DSH-Memory

把 Claude Code 的**项目记忆目录**（`MEMORY.md` + 主题 `.md` 文件）直接复用给 DeepSeek Harness（DSH）会话的原生 Cordis 插件。

同一个项目，Claude Code 和 DSH 读同一份记忆：在 DSH 里聊出来的结论会落回 Claude 下次能读到的文件，反过来也一样。

## 它做什么

| 能力 | 行为 |
|---|---|
| 会话开始注入 | 每个主会话开始时注入一次 `MEMORY.md` 索引与维护约定 |
| 8 个工具 | `claude_memory_status / index / manifest / search / read / write / forget / repair_index` |
| 写保护 | DSH 内用 `write`/`edit` 等工具直接改记忆目录会被**拒绝**，必须走 `claude_memory_*`；读取不受限 |
| 显式意图提醒 | 用户说"记住/忘掉"时追加一行操作指引（默认开启） |
| 后台提取 | 回合结束后可选地用当前模型补录记忆（默认开启，只补录、不删除、不阻塞回合） |

## 安装

在 DSH 里用 Plugin Manager 安装本目录（bundle 形态，Host-only）：

```text
plugin_manager install_bundle target="D:\work\Claude-DSH-Memory"
```

安装后对当前 profile 全量生效。首次安装通过 HMR 即可激活；替换已安装的包需要重启。

## 工具一览

| 工具 | 作用 |
|---|---|
| `claude_memory_status` | 解析到的记忆目录、是否已核对、条目/类型统计、提取与保护计数、告警 |
| `claude_memory_index` | 读 `MEMORY.md`（受注入预算限制） |
| `claude_memory_manifest` | 列出所有条目元数据，标出 `indexed:false` 的孤儿条目 |
| `claude_memory_search` | 词法检索，任一关键词命中即可（OR） |
| `claude_memory_read` | 读完整正文 + `revision`（更新/删除前必须先读） |
| `claude_memory_write` | `create` / `update` / `upsert`，同步维护索引 |
| `claude_memory_forget` | 移入私有 `trash/`，从索引移除；**不真删** |
| `claude_memory_repair_index` | 对齐索引与磁盘（默认 `dryRun`） |

冲突检测：`revision = sha256(文件字节)`。`update`/`forget` 必须带 `expected_revision`，不匹配即报 `CM_REVISION_MISMATCH`，**不自动合并**。

## 配置

`cordis.patch.yml` 里的 `config` 全部可选，默认值即可工作：

```yaml
- insert:
    - id: claude-dsh-memory
      name: 'claude-dsh-memory'
      config:
        projectMemoryDirs:
          'D:/work/demo-app': 'C:/Users/you/.claude/projects/D--work-demo-app/memory'
        createMissing: true
        autoExtract: true
        extract:
          provider: deepseek
          model: deepseek-chat
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `claudeConfigDir` | `$CLAUDE_CONFIG_DIR` 或 `~/.claude` | Claude 配置根 |
| `projectMemoryDirs` | `{}` | 项目路径 → 记忆目录；**最可靠**的方式 |
| `createMissing` | `true` | 记忆目录不存在时允许写工具创建（读永远不创建） |
| `injectBaseline` | `true` | 会话开始注入索引 |
| `indexMaxLines` / `indexMaxChars` | 200 / 12000 | 索引注入预算 |
| `injectMaxChars` | 16000 | 整条注入的硬上限 |
| `intentReminder` | `pre-step` | `pre-step` \| `claimed` \| `off` |
| `guardEnabled` | `true` | DSH 内写保护 |
| `autoExtract` | `true` | 回合结束后后台提取 |
| `extract.provider` / `.model` | 空 | 空则用当前默认模型路由 |
| `extract.timeoutMs` | 120000 | 单次提取超时 |
| `extract.maxOperations` | 10 | 单批最多 10 个操作（≤10） |
| `extract.excludeProjects` | `[]` | 不做提取的项目路径前缀 |
| `stateRoot` | `<DSH_HOME>/claude-memory` | 插件私有状态（不能落在记忆目录内） |
| `lockTimeoutMs` / `lockStaleMs` | 5000 / 30000 | 目录锁 |
| `logLevel` | `info` | `silent` \| `error` \| `info` \| `debug` |

## 记忆目录怎么定位

顺序（首个成功即用）：

1. `projectMemoryDirs` 里最长的路径前缀匹配
2. Git 仓库根（`git rev-parse --git-common-dir` 的父目录）再匹配一次
3. 仓库内 `.claude/settings*.json` 有 `autoMemoryDirectory` → **拒绝猜测**，要求显式映射（`CM_DIR_NEEDS_MAPPING`）
4. 用户级 `~/.claude/settings.json` 的 `autoMemoryDirectory`
5. 环境变量 `CLAUDE_CODE_PROJECT_DIR_NAME`
6. slug 推断：`<claudeConfigDir>/projects/<非字母数字→->/memory`，标记 `confirmed:false`

例：`D:\work\demo-app` → `D--work-demo-app`。

推断出来的目录会在 `status` 和注入里注明"尚未在 Claude Code 中核对"。**最省事的做法是显式配置 `projectMemoryDirs`。**

## 保护语义（重要）

- 被拦的是**工具路径**：任何非只读工具的参数里出现记忆目录下的路径（含相对路径）都会被拒绝，覆盖 `write`、`edit`、`apply_patch` 以及未来的写类工具。
- **shell 只能提示性拦截**：命令文本里出现记忆目录会被拒绝，但字符串拼接、编码、子进程、其它插件直调 `ctx.fs` 都能绕过。**这不是安全边界**，只是防误操作。
- Claude Code 自己不受影响：它不在 DSH 里，也不经过这些工具。两边同时写靠"目录锁 + revision + 发布前整目录指纹"检测，检测到就以报错结束，不自动合并。

## 后台提取

回合正常结束（`completed`）后，若满足资格，插件把"本轮用户消息（≤12k）+ 助手最终消息（≤20k）+ 记忆元数据 manifest"发给当前模型，要求返回最多 10 个 `create`/`update` 操作：

- **禁止 delete**（schema 层就不接受）
- 校验不过 → 整批丢弃，材料进 `<stateRoot>/projects/<key>/review/`
- 发布前比对整目录指纹，期间目录变了 → 整批放弃（`CM_EXTRACT_STALE`），不重放
- 全局并发 1、不重试、输入无变化时零模型调用

**隐私**：这一步会把上述对话内容发送到当前配置的 provider。介意就把 `autoExtract` 设为 `false`。日志只记文件名与错误码，不记正文。

## 状态目录

插件的私有状态（队列、备份、回收站、日志）在 `<DSH_HOME>/claude-memory`，可用 `stateRoot` 改位置。

## 开发

```powershell
node --test "test/*.test.js"   # 82 个单测，纯 node:test，无依赖
```

## 许可

Apache-2.0，见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
