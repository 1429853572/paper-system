# AGENTS.md — paper-system

基于 MinerU 的学术论文阅读 / 双语翻译 / 证据问答 / 科研导读系统。
FastAPI + SQLite(FTS5 + 向量) + 原生 JS 前端，MinerU(vLLM) 与 Ollama(BGE-M3) 共享单 GPU。

## 架构与目录

```
caddy(:7861 反代+SSE) → app(:8001 FastAPI) → mineru(:8000 GPU) / ollama(:11434 GPU)
```

| 路径 | 作用 |
|---|---|
| `app/server/main.py` | 全部 HTTP 路由（约 90 个端点）+ 静态挂载。**单文件，无路由拆分** |
| `app/core/` | 业务模块：`db` `auth` `llm` `jobs` `ingest` `retrieval` `translator` `qa` `summarizer` `meta` `mineru_client` `glossary` `config` `journal` |
| `app/webui/` | 无构建步骤的原生前端：`index.html` + `viewer.js`(2300行) + `styles.css`；`vendor/` 内置 pdf.js、KaTeX |
| `app/cli.py` + `./psys` | HTTP API 命令行客户端（宿主机 wrapper 走容器内 python） |
| `config.yaml` / `config.example.yaml` | 非敏感调优项（限额/调度/RAG/回收站） |
| `.env` | 敏感项：`SECRET_KEY` `FERNET_KEY` `ADMIN_INITIAL_PASSWORD` `PAPERSYS_API_TOKEN` `POOL_*` |
| `data/` | `papersys.db` + `papers/<paper_id>/`（论文与解析产物）——**不入 git** |
| `compose.yml` / `docker/mineru.Dockerfile` | 四容器编排（mineru/ollama/app/caddy），镜像版本已锁 |

## 运行与验证

```bash
docker compose --profile app ps          # app 与 caddy 在 profile "app" 下，必须带 --profile 才管
docker compose restart app               # app/ 已卷挂载进容器：改完代码 = 刷新浏览器；改动 py 文件后重启
docker compose logs -f app
curl -s localhost:8001/api/health        # {db, mineru, ollama}
./psys list / ./psys ask "..." --papers pXXX
```

本地直跑（不用容器）：`cd app && SECRET_KEY=x FERNET_KEY=<fernet key> uvicorn server.main:app --port 8001`
——`core/config.py` 在 `SECRET_KEY`/`FERNET_KEY` 缺失时直接抛 `RuntimeError`，导入即失败。

**本仓库没有自动化测试**（`tests/` 只有一个 fixture PDF，无 pytest）。验证靠手工：API 用 curl/./psys，前端靠浏览器实测（浏览器自动化可用 `browser-use:control-browser` skill 打 `http://localhost:7861`）。

## 必须遵守的架构边界

- **写库一律走 `with db.write() as c:`**（单写者锁 + 显式事务）；读走 `db.one() / db.all() / db.read()`。不要自己 `sqlite3.connect` 写库。
- **schema 改动流程**：`app/core/db.py` 的 `SCHEMA_VERSION` 递增 → `_migrate()` 里加 `if from_v < N:` 分支 → 同时改 `_SCHEMA` 建表语句。已发布分支不要改写历史迁移。
- **备份只能用 `VACUUM INTO`**（`db.backup_to`），禁止 `cp` 运行中的库。
- **鉴权**：路由用 `require(request)` / `require_admin(request)` 依赖拿当前用户；`current_user` 兼作可选依赖。越权可见性由 `_require_visible(u, paper)` + `visibility`(shared/private) 控制。
- **LLM key 解析顺序**在 `core/llm.py:resolve_llm`：用户 BYOK > 公共池（`POOL_*`，admin 在设置页开启）> 抛 `NoKeyError`。改动调用方需同时处理 `NoKeyError`。
- **调度**在 `core/jobs.py`：两层优先级（interactive > background）+ 层内按用户 round-robin；解析 worker 单个（GPU 串行）；翻译每用户并发上限 `limits.translate_concurrency`；翻译处理器由 `main.py` 的 `_translate_handler` 注入 `scheduler.translate_handler`。
- **SSE**：任务进度 `/api/jobs/stream`、问答 `/api/chat/stream`。Caddy 已设 `flush_interval -1`，别在中间层加缓冲。

## 代码约定

- Python：`from __future__ import annotations`；类型注解齐全；模块 docstring 说明设计决策（现有模块都这么写）；日志用 `log = logging.getLogger("xxx")` + `%s` 占位，不用 f-string 进日志。
- 注释、日志、报错文案一律**中文**。
- 前端：无框架、无打包，原生 JS；DOM id 一律 `#kebab-case`，class 用 `.blk` `.pair` 等短名；改 UI 要同步 `app/webui/styles.css`，不要内联一堆 style 属性。
- **视觉 token**：字号用 `--fs-*`（xs11/sm12/base13/md14/lg15/xl17/h1 22）、圆角 `--r-*`（xs4/sm6/md8/lg10/pill）、颜色用 `:root` 语义变量（含 `--tint-*` 系列）——新样式禁止硬编码 px 字号/颜色（v1.2 已归一 146 处字号、161 处颜色）。
- **图标一律走 `icon('name')` / `ICONS`**（viewer.js，线条 SVG、currentColor）：新 UI 不再引入 emoji 图标；toast 消息文本里可保留 emoji。给 `textContent` 赋含 icon 的 HTML 会转义显示——用 `innerHTML`。
- **内联 onclick 的函数必须挂到 window**：`viewer.js` 是 `type="module"`，模块顶层函数不在全局作用域，而内联 `onclick="fn()"` 在全局求值 → 引用模块函数会抛 ReferenceError，按钮表现为"点了没反应"。写法：`window.fn = fn;`。改完跑 `node scripts/check-inline-handlers.mjs` 复查（这坑已出现 4 次）。
- **问答交互**：统一无模式——范围 = 已添加的文档 chips（`renderQaScope`，恒含虚线「＋添加论文」chip 即面板入口）；打开论文时自动挂载（size≤1 → 替换为新论文），≥2 篇后端自动检索取证对比 + `COMPARE_ADDENDUM` 附加对比提示词，上限 6 篇。多轮上下文：chat_stream 注入最近 2 轮问答（每则 400 字、总预算 1600）；≥2 篇的库级对比工作台是规划中的独立功能。
- **材料注入策略**（对齐 ChatGPT/DeepSeek 的文件问答做法）：全文直读优先（整体理解最好），`fulltext_max_tokens`（默认 200000，config.yaml）为总预算——多篇总量超预算才降级检索；`_build_context` 的 fulltext 构建预算 = 该值 ×3.5 字符。**注意两处预算联动**：模式判定与构建都看它，改一个要改全。
- **证据引用规则**：`_CITE` 支持 1-4 位编号（全文模式证据数百条）；evidence 的 `text` 保留全文（数字接地/补引需要），UI 只渲染被引用项；`renderCites` 按 `evidence_id` 匹配（数组下标 ≠ 编号，校验过滤后会错位）。
- **冒烟测试**：部署后跑 `bash scripts/smoke-test.sh`（只读，15 项：health/静态/登录/关键端点/401 保护）。
- **按钮巡检**：`node scripts/audit-buttons.mjs` —— 浏览器逐页点击（跳过改数据/花钱的按钮），抓「onclick 函数缺失」「点击抛异常」「接口 4xx/5xx」。静态审计（check-inline-handlers）查不到 `addEventListener` 绑的按钮，巡检能查到。跑之前会自动备份数据库。
- **上传入口**：没有独立大拖放框——直接把文件拖到**论文列表区**（`.paper-list`）即上传；工具条右侧的 📄 弹层里是「选择文件 / URL 导入」，🔓 图标切换上传可见性（仅自己可见）。
- **侧栏可折叠**：顶栏 « 收起侧栏，收起后左侧留 `#side-rail` 窄边（占位式，顶栏标题自动让位），» 展开。
- **筛选与排序**：工具条 ▾ 一个菜单里分两组（筛选 / 排序），状态存 `ps-filter`、`ps-sort`。改这块时注意：**只做 UI 不写状态回写是历史教训**（`state.filter` 曾长期只读不写，按钮点了没反应）。
- **PDF 渲染**：canvas 位图按 `CSS 尺寸 × devicePixelRatio` 渲染（`viewer.js:dprFor()`），显示尺寸用 `style.width/height` 钉回 CSS 尺寸。退回 1× 位图 = HiDPI 屏整体发虚，别改回去。
- **PDF 面板结构**：左侧工具条是**冻结顶栏**（in-flow，`styles.css:.pdf-toolbar`），PDF 内容滚在 `#pdf-host` 里；不要改回绝对定位浮层（会遮挡正文）。
- **倍率变化走 `_pdfRescale()`**：只改占位高度 + 重绘视口内页面，DOM 骨架不动、滚动位置保持。别再 `host.innerHTML=''` 全量重建（拖拽分栏时会闪）。
- 提交信息：中文 conventional commits（`feat:` `fix:` `ux:`），历史上大量 `fix(critical):` / `fix:` 回归修复——**改动前后都跑一次实测**，前端改动尤其容易出白屏（曾有 TDZ 崩溃）。

## 已知坑（改相关代码前必读）

- **bbox 坐标系**：MinerU 输出为**左上原点**归一化 bbox，全链（高亮/hover/图表裁剪/布局框）**不翻转**。历史上在此翻错过 4 处。
- **bbox 数据格式**：`blocks.bbox` 存的是**扁平 4 元组** `[x0,y0,x1,y1]`；**跨栏合并的块**存**多框列表** `[[框1],[框2]]`。一律用 `viewer.js:parseBoxes()` 解析（两种都兼容）。**别直接 `JSON.parse(bbox).forEach(b => b[0]...)`**——扁平数组会被当 4 个数字迭代，算出 `NaNpx` 尺寸，框只剩 2px 边框 → 表现为"PDF 上不高亮显示块"。
- **跨栏续文合并**：MinerU 用 `block.continues_prev` 标记"本块是上一段的续文"（双栏排版把一段切开）。官网 markdown 渲染层据此合并成一段；`core/ingest.py:build_blocks()` 同样在入库时合并（文本拼接 + bbox 变多框）。不改这段会导致同一段显示成两段、与官网不一致。
- **改块结构后要重建**：`POST /api/papers/{id}/reindex` 会用已存的 `middle.json` 重建 blocks+chunks（不占 GPU），并清掉 source_hash 失效的旧译文。改 `build_blocks` 后用它刷新存量论文。
- **图裁剪只用 `union_bbox`**：子块 bbox 是组图内的局部坐标，用它会截错。
- **原始文件统一存为 `original.<真实扩展名>`**（`ingest.store_pdf`）：解析/预览端按 `original.` 前缀定位文件；存成用户原始文件名会导致"原始文件缺失"。
- **MinerU 远程 task_id 只存服务端内存**：容器重启后轮询 404，调度器 `recover()` 会清 `remote_task_id` 重新排队——这是预期行为，不是 bug。
- **翻译幂等**：`translations` 有唯一索引 `(paper_id, cache_key, block_id)`，重跑用 `INSERT ... ON CONFLICT REPLACE`；cache_key = sha256(source_hash + model + prompt_version + glossary_version + lang)。改翻译提示词要改 `translator.PROMPT_VERSION`，否则命中旧缓存。
- **Anthropic 协议请求体必须带 `thinking: {type: "disabled"}`**：GLM 等兼容端点默认开思维链，会吞掉 text 块。
- **登录限速**：每 IP 10 分钟最多 8 次失败（`auth.check_login_rate`）。
- **备份**：每日 janitor 同时备份 DB 快照与 papers/ 目录 tar（backups/ 各保留 backup_keep 份，含审计快照）——DB 与文件必须配套才有完整备份。
- **会话吊销**：users.token_ver（v12）——改密/登出所有设备时 +1，current_user 逐请求比对（auth.check_token_ver）。**给 current_user 增加鉴权语义时记得 ver 校验在 auth 层**。
- **错误处理**：全局 exception_handler 统一 JSON 500（勿在前端假设 500 是纯文本）；SSE 收尾已包 try（error 事件而非断流）。
- **安全头**：中间件统一 nosniff/DENY/CSP（CSP 允许 inline style 与 blob——KaTeX/pdf.js 依赖；改前端加载方式时同步 CSP）。
- **回收站**：软删除 30 天，janitor 每小时清理；"清空回收站"按用户隔离（admin 才全量）。
- **上传存储/限额**：member 限额来自 `config.yaml limits.*` + `user_quotas.overrides`（管理页可按人覆盖），admin 全豁免。

## 敏感区 & 文档

- 改 `core/db.py`（schema）、`core/jobs.py`（调度）、`core/llm.py`（协议）、`core/mineru_client.py`（MinerU 契约）、`webui/viewer.js`（联动/渲染）前先读对应模块顶部的 docstring——那里写明了设计定稿理由。
- 部署/迁移/备份看 `DEPLOY.md`；功能地图看 `README.md`；调优项看 `config.example.yaml`。
- MinerU 源码在 `MinerU/`（不入 git，仅用于查 bbox 坐标系等上游事实）。
