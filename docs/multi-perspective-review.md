# 多视角系统评审（专家 × 用户水平 × 用户规模 × 并发）

> 2026-11 评审轮。配套阅读：`docs/architecture.md` §6「已知弱点」（20 项权威清单）——本文**不重复**已记录项，只列增量发现与按并发视角的重新加权。所有 P0 项均已逐行验证成因；修复记录见文末。

## 0. 评审方法

四视角矩阵交叉审视：

| 维度 | 取值 |
|---|---|
| 领域专家 | 安全 / 性能与容量 / 数据完整性 / 前端 UX / 运维可观测 / 科研工作流 |
| 用户水平 | 新手（首次进入）/ 熟练重度（快捷键、批量、大论文）/ 管理员 / API 消费方（MCP、CLI） |
| 用户规模 | 1–10（现状设计点）/ 10–50 / 50+ |
| 并发场景 | SSE 常驻连接 / LLM 流式调用 / 并发上传 / 并发检索 / 写锁竞争 / GPU 排队 |

事实基线：单进程 uvicorn（无 `--workers`）+ anyio 线程池 120 token（`main.py:124-128`）+ 10 个后台 daemon 线程调度器（`jobs.py:93-104`）+ SQLite 单写者锁（`db.py:448`）+ 单 GPU（MinerU 解析串行 + xinference embedding）。

## 1. P0 实锤 bug（本轮全部修复）

### P0-1 FTS 搜索回退越权（信息泄漏）【安全】

`main.py:683-698`：`/api/papers` 的 FTS 回退把 ` OR p.id IN (fts_ids)` 拼在 `vis` 末尾，而 SQL 中 AND 优先级高于 OR，实际 WHERE 变成 `(deleted_at IS NULL AND 可见性 AND 标题/作者命中) OR (p.id IN fts_ids)`——**FTS 命中的论文完全绕过 visibility 与回收站过滤**。任何登录用户搜到他人 private / 已软删论文正文里的词，即可看到其标题、作者、年份。两位评审独立发现 + 第三方验证确认。对照组：`/api/statuses`（`main.py:2648`）同模式用了 `AND id IN`（正确），可见属漏括号笔误。

### P0-2 `EMBED_BASE_URL` 未导入 → 裸跑时向量检索静默失效【正确性】

`retrieval.py:125` 引用 `EMBED_BASE_URL`，但 import 列表（:23）只有 `EMBED_DIMS, EMBED_MODEL, config`，模块内无定义。容器内 compose 设了 env 故短路无事；**本地直跑（AGENTS.md 记载路径）一旦不设 env 即 NameError**，被 `search()` 的 except 吞掉 → 向量检索静默降级为纯 FTS，embed 回填任务持续失败重试。违反「错误要显式」原则。

### P0-3 管理页审计卡片渲染死文本【UX/实锤】

`10-settings.js:324-325`：模板字符串里残留断裂的三元表达式——`renderAuditTable(auditRows)` 后跟着 `: '<p class="muted">暂无记录…</p>'}`，冒号分支成为死文本，**任何状态下**（有/无记录）都在表格下方渲染出 ` : 暂无记录——…}` 字样。构建产物 viewer.js 同样存在。

### P0-4 解析进度节流是死代码（节流从未生效）【性能】

`jobs.py:308-319`：`_last = getattr(self, "_last_prog", {})` 每轮拿到临时空 dict（`_last_prog` 从未 setattr 到 self），写入的进度状态随局部变量丢弃 → `small` 恒 False → 注释里担心的「每 5s UPDATE + SSE 全量广播、89 篇批量时 badge 雪上加霜」**正在发生**。叠加 `/api/jobs/stream` 对全部连接做 O(N) 事件扇出（`jobs.py:45-52`），批量解析时的无效广播被放大 N 倍。

## 2. P1 并发与容量薄弱点（10–50 用户会痛，本轮加固核心 6 项）

### 容量分档结论

- **1–10 用户**：现状设计自洽（写锁压测 ≤21ms、GPU health gate、每用户翻译并发 2 + 全局信号量 4、检索缓存 TTL 600s）。
- **10–50 用户**：线程池被 SSE+流式 LLM 吃紧；事件循环阻塞点开始被高频踩中；parse 吞吐 = 1/篇均解析时长；积压超 400 后优先级失效。
- **50+ 用户**：线程池 120 打满 → 整站假死（含健康检查 → compose 重启 → recover 重排队 → 重启风暴）；内存 OOM 三连（向量缓存/块缓存/整文件上传）；单写者 fsync 成为硬顶。

### P1 修复项（本轮做）

| # | 问题 | 位置 | 修法 |
|---|---|---|---|
| 1 | MinerU 轮询无终态超时：单任务卡 running = 唯一 parse worker 被占死，全站解析停摆 | `jobs.py:301-325` | 任务时长上限（config `limits.parse_task_timeout`，默认 30min），超时 → cancel + failed |
| 2 | SSE 无连接上限：每 tab 1 条常驻占 1 线程 token，50 用户×2 tab ≈ 打满 anyio 120 池 = 整站假死 | `main.py:1280-1302`（jobs/stream），chat/导读流同理 | per-user（默认 4）+ 全局（默认 200）连接计数上限，超限 429 |
| 3 | 调度单窗口 `ORDER BY created_at LIMIT 400`：积压超 400 后新入队 interactive 任务不可见，两层优先级 + round-robin 全失效（饿死） | `jobs.py:163-167` | interactive / background 分桶取任务，interactive 桶非空不看 background 桶 |
| 4 | `_vec_cache`（每问答论文组合一份全量矩阵，万级 chunks ≈ 40MB）与 `translator._tb_cache`（每 run 缓全篇 blocks）只增不删 → 数 GB 内存 | `retrieval.py:166-192`、`translator.py:40` | 简易 LRU（config 上限，默认 32 份）+ TTL 过期惰性删除 |
| 5 | 事件循环阻塞点：`translate-selection` 同步 `complete()` 最坏 ~20min、summary 同步 generate、import_identifier 同步 httpx 三源、上传 pypdf 页数解析——任一触发全站请求停摆（含健康检查） | `main.py:3138-3156 / 4148 / 3063 / 505-524` | `run_in_threadpool` 包裹（仓内先例：`main.py:1780-1786` search offload） |
| 6 | 每日备份把 papers tar 整个 `read_bytes` 进内存算 sha256——库到几十 GB 时 janitor 制造内存尖峰 | `jobs.py:898-906` | 1MB 分块流式哈希 |

### P1 备选（记录未做）

- **测试缺口（本轮 NameError 事故暴露）**：smoke-test 不覆盖带文件的上传路径（唯一不设防的核心写路径），py_compile 查不出运行时 NameError——评审期 offload 改动首版漏 `import anyio` 即由此漏网，靠真机回归抓到。建议 smoke 补最小 PDF 上传断言。
- `costing.check_budget`（`costing.py:57-66/128-141`）check-then-act 非原子，4 个翻译线程并发可超支；未收录模型单价记 0 元永不过闸；**预算默认 0 = 完全无闸**；公共池无全站预算/速率限制。
- `/api/jobs/stream` 非管理员事件取出后才按 user_id 过滤 + O(N) 全连接扇出（`main.py:1293-1295`、`jobs.py:45-52`）——per-user 队列可消除，随 P1-2 落地后再评估。
- 重试「指数退避」名义化：job 置 queued 后实际 ≤poll_interval(10s) 即重试（`jobs.py:365-369`）。
- 上传 `await f.read()` 整文件进内存（`main.py:505`），20 人并发传 100MB ≈ 2GB 峰值；无并发上传闸。
- httpx 共享连接池上限 100（`llm.py:68`），第 101 个并发 LLM 调用开始等连接；embedding/rerank 对单 GPU xinference 无并发上限。

## 3. P2 体验与 API 改进（仅报告，不动手）

### 新手
- 引导卡只弹一次（`ps-onboarded`）且**无入口回看**（`13-cmd.js:181-206`）；无分步交互 tour。
- 隐藏手势不可发现：`Ctrl+Shift+L` 联动诊断（`12-reader-ui.js:533`）完全无文档、`?debug=1` 仅代码注释、命令标签长按 550ms 编辑仅一句 tooltip。
- **约 36 处 toast 直接透英文技术原文**（`xx失败: e.message`）：06-topic(12)/07-meta(5)/10-settings(5)/02-library(5)/08-qa 等——`friendlyError()`（`01-core.js:165`）已具备翻译能力但覆盖不全。

### 熟练/重度
- 大论文：PDF 侧懒渲染 ✅，但 `_pdfRescale` 每次 zoom 串行 `getPage` 全部页 O(N)（`03-reader.js:179-186`）；渲染过的画布永不卸载（每页上限 ~48MB RGBA）；中文视图每次追加全量重建整列（`12-reader-ui.js:643` 自认）。
- 问答输入历史 `state.qaHistory` 仅内存，刷新即丢（`08-qa.js:618`）；会话本身已在服务端 ✅。
- 批量操作缺：批量改可见性、批量强制重译、批量重建索引（`/api/batch/{action}` 只认 translate/meta/summary/parse，`main.py:1067`）。
- 键盘导航缺阅读器内 j/k 块级导航、上/下一篇；表格审阅快捷键未进 `?` 帮助层。

### 管理员
- 无全局用量趋势（只有当月快照 + 上月对比，`main.py:1306-1326`）；任务积压视图仅两个数字，无按类型排队时长/失败聚类。
- 审计日志无筛选无翻页（`main.py:1450-1456`，前端固定 50 条）。
- 「暂停/恢复队列」按钮对**所有用户可见**但后端 admin-only（`05-tasks.js:48` vs `main.py:974`）——成员点击只得 403 toast。

### API 消费方
- `docs_url=None` 无 OpenAPI、全库无 `response_model`——CLI/MCP 消费方只能读源码。
- 中间件对**所有 `/api/*` 一律 `no-store`**（`main.py:57-87`），论文图片/PDF 原件这类不可变资源每次重下；只有 vendor 享受 immutable。
- `/api/papers/{id}/bilingual` 每次请求全量构建 pairs 再切片（`main.py:3220-3233`）——滚动每翻 40 段重读全部 blocks+translations。
- `/api/jobs` 无 offset、`/api/chat/sessions` 固定 LIMIT 50、`/api/admin/audit` 无翻页。
- MCP token 是**全局 admin 令牌**（`main.py:93-99`），无 per-user token、无细粒度 scope（写确认队列设计是好的）。
- 术语表全局单份：任何成员可改全局术语表影响所有人翻译，写接口仅 require 登录、无审计（`main.py:3243-3258`）。

### 无障碍与个性化
- aria 很薄：对话框无 `role="dialog"`/焦点圈禁、toast 无 `aria-live`、约 41 处 onclick 挂 div/span 不可键盘达、8 处 img 无 alt、无 skip-link。
- 无 `prefers-reduced-motion` 降级；字号/行距/阅读宽度无用户偏好（只有主题）。

## 4. 已知悬置项的并发视角重新加权

对 `architecture.md` §6 已记录项，本轮按「多用户并发」视角补充定性：

| §6 编号 | 已知定性 | 本轮加权 |
|---|---|---|
| #2 SQLite 写并发上限 1 | 「500 篇压测 ≤21ms，非瓶颈」 | 在 50+ 用户成立的前提是写路径短平快；P1-5（循环上 db.write）与 P0-4（无效进度 UPDATE）落地前，该结论偏乐观——修后回归此定性 |
| #6 无 CSRF | 中风险悬置 | 并发不改变其评级，维持 |
| #7 rate limit 仅登录 | 低 | SSE 上限（P1-2）落地后，全局限流的最痛缺口已被覆盖大半 |
| #10 无指标导出 | 悬置 | 50+ 用户下「线程池水位 / SSE 连接数 / 队列深度」三个指标是容量规划刚需，建议升优先级 |

## 5. 修复记录

| 项 | 状态 | 验证 |
|---|---|---|
| P0-1 FTS 越权 | ✅ 已修复 | 双账号实测（造数：A 的 private + B 的 shared 正文含同一特异词）：B 搜索只见 shared 不见 A 的 private；A 自见两篇；private 论文软删后 owner 也不可搜出（软删本身会移除 FTS 行 main.py:866，叠加括号修复双保险） |
| P0-2 EMBED_BASE_URL | ✅ 已修复 | config 补默认值 localhost:9997；health 检查同步弃用旧名 OLLAMA_BASE_URL；容器内 env 路径行为不变 |
| P0-3 审计卡死文本 | ✅ 已修复 | src 与构建产物 viewer.js:4703-4704 均为完整三元；ui-regression 全过（浏览器自动化后端本环境不可用，以产物形态 + 回归套件验证） |
| P0-4 节流死代码 | ✅ 已修复 | 节流状态持久化到 scheduler 实例（self._last_prog）；实测解析全链路（见 P1-1 行）不回归 |
| P1-1 MinerU 超时 | ✅ 已落地 | fixture PDF（attention，15 页）真机解析跑通到 parsed；超时路径为代码审查 + 配置默认 30min |
| P1-2 SSE 上限 | ✅ 已落地 | 实测：同账号第 5 条连接 429、其他用户 200 不受牵连、连接断开后计数在 keepalive 周期内释放（10s）；chat/summary 流同样接入 |
| P1-3 调度分桶 | ✅ 已落地 | 代码层：interactive 桶非空不看 background 桶；permission/backend 回归全过 |
| P1-4 缓存 LRU | ✅ 已落地 | _vec_cache 命中 touch + 容量 32 + 过期惰性删；_tb_cache 同款；backend-test 94/94 |
| P1-5 事件循环 offload | ✅ 已落地 | translate-selection / summary / import-identifier / 上传 preflight 四处 to_thread 化 |
| P1-6 备份流式哈希 | ✅ 已落地 | 1MB 分块流式 sha256，行为等价（哈希值不变） |

**回归总账**：smoke 50/50、permission 39/39、backend 94/94、ui-regression 全过、e2e 解析链路正常。check-inline-handlers 的 `if`/`remove` 报错确认为存量误报（复合内联表达式解析缺陷，stash 对照排除本次引入）。
