# Web 质量检查报告（运行时实测 + 前端模式）

> 2026-11-16 全量质量检查轮。执行依据：`docs/quality-audit-plan.md`（交接任务书）。
> 定位：补 `docs/architecture.md` §6「已知弱点」（20 项权威清单）与 `docs/multi-perspective-review.md`（四视角评审 P0-P2）留下的两个盲区——**运行时实测**与**前端模式现代化**。三份文档互引，不另立权威清单：本文所有发现要么是它们未覆盖的增量，要么是对其定性结论的数字量化。
> 执行深度（任务书已确认）：报告 + 实锤 bug 修复 + 有数据支撑的性能优化；模式现代化重构只列路线图（§6）。

## 0. 工具与环境

| 工具 | 用途 | 结果 |
|---|---|---|
| chrome-devtools MCP（33 工具） | trace / 堆快照 / 网络行为 / console / Lighthouse | 导航模式 Lighthouse 受 MCP 工具 30s 超时限制改走 CLI；snapshot 模式与 Chrome 146 协议不兼容（`Network.emulateNetworkConditionsByRule` 反序列化错）→ 用 DOM 审计替代 |
| Lighthouse CLI 13.6.0 | 三页基线（导航模式） | 连接 CDP :9222（带会话）+ 独立实例（无 cookie 测登录页） |
| modern-web-guidance CLI v1.0.0 | legacy-scan + 场景检索 | 22 处发现 / 4 类规则 |
| 素材 | MetroGS 15 页 217+ blocks（`pa71a3722188b2158`）、双语论文（`p8795e063b8a8ae29`，202 对）、102 列宽表（`tb4e28cb825bccf07a`，任务书里的 `tb83dad1d25a7ef74a` 已不是最宽，实测时按 `ORDER BY LENGTH(cells)` 重新确认）、表格墙 100 卡/页（admin 名下 636 张） | |

测试账号 admin（cookie 会话）；环境四容器 healthy；改动经 `docker compose restart app` 生效。

---

## 1. 性能基线（trace 关键指标，修复前）

### 1.1 阅读页·大论文开篇（trace 全程 27.4s，含 openPaper + 滚动到底）

- 首页 canvas 出现：openPaper 后 **1192ms**（含 /blocks /summary /assets 并行拉取）。
- **DOM 7706 元素、深度 24**（KaTeX span 树），pdf.js textLayer 单页 877 子节点。
- **9 次全文档级 layout，43–85ms/次**，且每次**全部节点参与**（2921→5131 随渲染增长）——无 containment 隔离，任何占位高度变化触发全文重排。
- ForcedReflow 罪魁：`fitPdf` 46ms、`figCropPass` 28ms、`_qaScrollUI` 20ms、`applyVsplit` 5ms（合计 ~99ms，非系统性抖动）。
- CLS 0.16（trace 窗口内）。

### 1.2 缩放（疑点 #4 实测）

- 6 步连续缩放窗口：**14 个长任务（>50ms），最重一对背靠背 346ms + 251ms ≈ 600ms 冻结**。
- 346ms 任务分解：UpdateLayoutTree 103ms + Layout 91ms + pdf.js 渲染 83ms + Paint/PrePaint 42ms——大头是**全文档重排**（缩放改占位高度 → 7.7k 元素全部重新布局），pdf.js 本身只占 1/4。
- 6 步期间 Layout 合计 399ms + Style 583ms。

### 1.3 canvas 驻留（疑点 #3 实锤）

- 15 页翻完：**15/15 canvas 全部驻留**（`data-rendered` 永存），位图合计 **18.1MB @dpr=1**（495×640/页）；HiDPI（dpr=2）下同场景 ≈ 72MB，且随页数线性增长无上限。
- 位图不在 JS 堆（usedJSHeap 仅 8.2MB），在 renderer/GPU 侧——堆快照查不出，须按 canvas 尺寸×4 字节计。

### 1.4 表格墙（100 卡满页）

- 滚动到底：**仅 1 个长任务（111ms）**，Layout 合计仅 18ms——布局健康；成本在图片：**ImageDecode 1119ms + Paint 763ms**，一次滚动全程下载 **11.1MB** 截图（lazy 生效但 no-store 使重复滚动再次全量下载）。
- 103 列宽表（16 行）：工作台打开 **253ms**，横向滚动流畅（scrollWidth 9306px），常显滚动条 `scrollbar-width: thin` 生效（v1.11.4 修复确认有效）；三态切换（并排/仅截图/仅表格）正常。
- 100 卡重渲染（纯客户端路径）：**222ms**。

---

## 2. 网络行为结论（三场景）

### 2.1 图片重复下载（疑点 #2 实锤 → 已修）

- 响应头实测：`Cache-Control: no-store` **且 ETag/Last-Modified 已在发**（`etag: "061ae9…"`）——服务端已具备条件请求能力，只差中间件放行。
- 实测重复度：同一阅读会话内 18 张不同图片重复下载 **2–4 次**（`page_6_table_2.jpg` ×4）；切视图（原文→双语→中文）一轮就把 `page_0_image_*.jpg` 各拉 3 次。
- 根因：`main.py` 中间件对 `/api/*` 一刀切 `no-store`（历史注释：浏览器启发式缓存事故）。图片是不可变解析产物，一刀切误伤。

### 2.2 bilingual 全量构建（疑点 #1 → 量化后降级）

- 实测：202 对 / **141KB / 服务端 36–41ms**；每次请求全量重建（源码确认 `translator._bilingual_pairs` 无缓存），滚动每翻 40 段重拉全量 141KB。
- **结论：仍成立但当前量化影响低**（41ms << 翻译请求秒级耗时；141KB × 5 页滚动 ≈ 700KB/篇冗余）。规模风险在千级 blocks（pairs 构建 O(blocks)、传输 O(pairs)），列路线图 §6-R2，不动手。

### 2.3 轮询与 SSE（疑点清单外补充）

- `/api/jobs/count`：每 **~10s** 1 次（20s 窗口 2 次，badge 专用端点只回 2 个数字，idle 流量可忽略）；`/api/health`：每 ~15–20s。频率克制，无需改。
- `/api/jobs/stream`（容器内直连逐字节计时）：空闲期**精确每 10.0s 一条 `: keepalive` 注释**、零数据事件——节流修复（multi-perspective-review P0-4）与 keepalive 设计均按预期工作。注：keepalive 是 SSE 注释行，`EventSource.onmessage` 收不到属正常。

---

## 3. Console 全景

| 页面 | 结果 |
|---|---|
| 阅读页（大论文全程） | **0 条**（无错误 / 无资源 4xx / 无弃用警告） |
| 表格页 | **0 条**（含 preserved） |
| 登录页 | 2 类：①注册密码框缺 `autocomplete="new-password"`（浏览器 [DOM] 提示，与 legacy-scan 互证→已修）；②`401 (Unauthorized)` 资源错误（login.js 会话探测，符合设计但留噪音——根治需 /api/me 返回 200 匿名态，涉及 API 语义，不动） |

---

## 4. Lighthouse 基线与修复后（CLI 导航模式）

| 页面 | Performance | Accessibility | Best-Practices | SEO |
|---|---|---|---|---|
| 登录页（修复前） | 100 | **89** | 96 | 90 |
| 登录页（修复后） | 100 | **100** | 96 | **100** |
| 文库页 `/`（修复前） | 67 | 95 | 100 | 90 |
| 文库页 `/`（修复后，a11y 复测） | — | **100** | — | — |
| 阅读页 / 表格页 | — | — | — | — |

- 登录页 a11y 修复明细：color-contrast 3 处（#7a8199 白底 3.87:1、#4a6cf7 白字 4.39:1）、`landmark-one-main`、`meta-description`。
- 文库页 67 分的缺口全在性能类：LCP 2.2 分 / TBT 0.74 / unminified-js 0 / unused-css 0 / source-maps 0——**结构性**（8452 行原生 viewer.js 无构建压缩、无 sourcemap；这是「无打包」架构的既定取舍，`architecture.md` §6-3），列路线图 §6-R5。
- 阅读页/表格页无法用导航模式测（SPA 无深链，reload 丢状态；MCP snapshot 模式与 C146 不兼容）→ 用 §5 DOM 审计量化 a11y。

---

## 5. 前端模式（A 步：静态扫描 + DOM 审计）

### 5.1 legacy-scan 清单（22 处 / 4 类）

| 规则 | 处数 | 判定 |
|---|---|---|
| **ime-safe-enter-submit** | src 5 处（02-library ×2 / 06-topic / 12-reader-ui / 15-tables） | **实锤 bug（已修，P0-1）**：中文 IME 选词回车会误触发提交/发送/移动单元格。13-cmd.js:107 命令面板是全库唯一做对的先例（`!e.isComposing`）——同款防护推广到其余 5 处 |
| autofill-sign-up-form | login.html 2 处 | 注册表单密码框缺 `autocomplete="new-password"`（浏览器 console 亦提示；登录表单本身已做对）→ 已修 |
| dark-mode-toggle | 1 处（`ps-theme` + `data-theme`） | 缺 `color-scheme` 声明：原生控件（checkbox/select/滚动条）在深色模式下仍按浅色渲染 → 已修（`:root{color-scheme:light}` / `[data-theme=dark]{color-scheme:dark}`） |
| dialog（backdrop 手写关闭） | src 4 处 | 属「30+ 手写弹层 → `<dialog closedby>`」既定路线图（任务书 §D 不做清单），不改 |

### 5.2 DOM 级 a11y 审计（阅读页·大论文打开态；Lighthouse 不可达场景的替代量化）

| 指标 | 实测 | 对照 multi-perspective-review §3 的记录 |
|---|---|---|
| img 无 alt | **37/37 全缺** | 「8 处无 alt」→ **恶化/口径更全**（运行时 DOM 含图表/截图） |
| onclick 挂 div/span（不可键盘达） | **143 处**（onclick 属性共 323） | 「41 处」→ 同上（列表渲染的行内卡片占大头：`jumpEvidence`/`asset-badge` 等） |
| `role="dialog"` | **0**（30+ 手写弹层无一声明） | 仍成立 |
| `aria-live`（toast） | **0** | 仍成立 |
| 无 label 的 input | 12/34 | 增量数据 |
| skip-link | 无 | 仍成立 |
| `main` landmark | 1（阅读/文库页）✓；登录页缺 → 已修 | 增量 |
| `prefers-reduced-motion` | 无 | 仍成立 |

**结论：a11y 是本项目前端最薄的一层**（与 architecture.md §6-19「无障碍覆盖低」一致并给出量化基数），属模式现代化重构，列路线图 §6-R1。

---

## 6. 后端复查（C 步：静态，逐点核对）

### C-9 `scheduler.enqueue` 调用点（21 处）——✅ 全部合规

签名 `enqueue(user_id, job_type, paper_id, payload, priority=, progress_total=)`。全部 21 处（main.py 18 / urlimport / mcpserver / backend-test）kwargs 仅 `priority`/`progress_total`，`batch_id` 一律走 payload（`main.py:3929` 处保留着上次 500 bug 的修复注释）。**同款模式全库排查无残留。**

### C-10 `openPop` 调用点（12 处）——✅ 核对通过

仅 `tb-compare-pop` 传 `beforeClose`（持有未保存编辑，`15-tables.js:535`，关闭统一收口含自动保存）；其余 11 处均为即填即用表单（collect-panel / syn-launch / adm-quota / tk-form / md-tbl / tb-harvest / tb-settings / tb-zoom / tb-upload / 07-meta / 08-qa）——关闭丢弃未提交表单文本，符合设计预期，不需要 beforeClose。

### C-11 async 端点残余同步重活——✅ 无新阻塞点

69 个 async 端点全量扫描：`chat_stream` 重活（检索+上下文构建）已 `anyio.to_thread.run_sync`；LLM 流式与导出 zip 为同步 generator → Starlette 线程池迭代（导出注释自证「每 4MB 吐一次、内存恒定」）；`retrieval` 的 sync httpx 只在已 offload 的 `search()` 与后台线程路径。剩余已知项：上传 `await f.read()` 整文件进内存（multi-perspective-review §2 P1 备选已记录，未修，维持）。

### C-12 multi-perspective-review §3 P2 清单逐项复核

| 项 | 复核结果 |
|---|---|
| toast 透英文 | **39 处**（原记 36，+3 略增，仍成立） |
| 引导卡不可回看 | 仍成立（`ps-onboarded` 只弹一次，无重放入口） |
| Ctrl+Shift+L 无文档 | 仍成立 |
| qaHistory 刷新即丢 | 仍成立 |
| 批量缺可见性/重译/重建索引 | 仍成立（`/api/batch/{action}` 仅 translate/meta/summary/parse 四分支） |
| 审计无翻页 | 仍成立（`limit=100` 无 offset，前端固定 50 条） |
| 暂停按钮 403 | 仍成立（`#tk-pause-toggle` 无 admin 条件渲染 vs 后端 `require_admin`；GET 状态接口成员可读 → 按钮有态可点、点了 403） |
| 无 OpenAPI/response_model | 仍成立（`docs_url=None`） |
| no-store 图片/PDF | **本轮实测证实并修复图片侧**（PDF 维持 no-store，§4-修复-3 决策记录） |
| bilingual 全量构建 | **本轮量化**：41ms/141KB/202 对（§2.2，降级为路线图） |
| /api/jobs 无 offset、chat/sessions LIMIT 50 | 仍成立 |
| MCP 全局令牌 | 仍成立（单一 `PAPERSYS_API_TOKEN`） |
| 术语表全局可写 | 仍成立（`require` 登录即可改全局） |
| aria 薄 | **量化更新**：img alt 0/37、onclick-on-div/span 143 处（§5.2） |
| 字号偏好 / prefers-reduced-motion | 仍成立 |

---

## 7. 修复记录（修前后同场景数据对比）

### P0-1 中文 IME 回车误触发（5 处）——bug 修复

- 位置与症状：`02-library.js`（文献库命名回车建库、URL 导入回车导入）、`06-topic.js`（专题采集搜索回车触发）、`12-reader-ui.js`（论文讨论区回车发送）、`15-tables.js`（表格编辑回车下移单元格）——中文输入法选词回车（composition 确认键）被当作提交。
- 修法：统一加 `e.isComposing` 防护（与 `13-cmd.js:107` 既有先例同款，一处风格）。
- 验证：ui-regression 全过 + tables-page-test 16/16（表格编辑路径覆盖）；`check-inline-handlers` 仅存量误报 `if`（任务书 §2-9 已定性，未新增）。

### P0-2 注册表单 autocomplete 缺失——修

`login.html` 注册表单：`password`/`password2` → `autocomplete="new-password"`，`invite_code` → `off`，`username` → `username`。浏览器 console 的 [DOM] 提示消除。

### P1-1 解析产物图片 `no-store` → `private, no-cache` + 中间件 304（性能）

- 修法（`main.py` `_cache_policy`）：匹配 `^/api/papers/[^/]+/images/[^/]+$` 的 200 响应改发 `private, no-cache`；命中 `If-None-Match`（FileResponse 自带 etag）由中间件直接回 **304 空体**。Starlette 0.50 的 FileResponse 确认**不处理**条件请求，必须中间件做。
- 决策记录：**只修图片，`/pdf` 维持 no-store**——实测 PDF 一次会话只拉一次（42MB/975ms，无浪费），且 Range 请求 + 304 语义对 pdf.js 有险，收益/风险比不划算。
- 修前后（同场景：切视图三连 + 图表墙）：
  - 修前：同一图片重复**全量下载 2–4 次**（182KB/111KB/…），一次滚动全程图片字节 11.1MB；
  - 修后：重复请求 **0.3KB（304）**，首见图片照常 200 全量；重复滚动全程（warm cache + D5-2）Paint 763→**21ms**、ImageDecode 1119→**1ms**、Layout 18→6ms。
  - 正确性：no-cache = 浏览器可存但每次校验 → 重解析后同名图片内容变化即时生效，**零陈旧风险**（历史启发式缓存事故的前提是「不校验」，本修不引入该窗口）。

### P1-2 PDF 远页位图释放（性能，疑点 #3）

- 修法（`03-reader.js`）：懒渲染观察器加 `!isIntersecting` 分支 → `releasePdfWrap()`：`_pageObj.cleanup()` + 退回等高占位（`pgHeights` 精确高度）+ 清 `data-rendered`；`renderOneWrap` 包 `_rendering` 竞态标记。架构零改动——`_pdfRescale` 本就跳过未渲染页、`jumpEvidence` 等路径本就按需重渲染（设计预留，只差释放动作）。
- 修前后（同场景：15 页翻到底 + 回滚，dpr=1 headless）：
  - 修前：**15/15 canvas 驻留，18.1MB**，永不释放；
  - 修后：稳定收敛 **8 张 / 9.7MB（-46%）**；HiDPI 真机同比例（≈72MB→39MB），且从「随页数线性增长无上限」变为「O(视口页数) 有界」——大论文（百页级）收益数量级放大。
  - 正确性实测：回滚后可见页（14/15）全部自动重渲染、画面完整（截图核验）；连续缩放/跨页高亮路径回归通过；屏内页零布局跳动（占位等高）。

### P1-3 表格卡片墙 `content-visibility: auto`（性能）

- 修法（styles.css）：`.tb-wall .tb-card { content-visibility: auto; contain-intrinsic-size: auto 122px }`（估高 122 = 实测真实中位数 122，min 122 / max 153）。
- 修前后：100 卡重渲染 **222ms → 161ms（-27%）**；与 P1-1 叠加后重复滚动全程渲染耗时趋近于零（§P1-1 数据）。
- 无障碍核查（指南 MANDATORY 项）：屏外卡 checkbox 程序化聚焦成功（`activeElement` 命中、卡高正常）——键盘可达性保持。滚动完整性：13 屏滚到底无长任务新增、CLS 0.00；滚动条高度首次渲染略虚高（估高 vs grid 行合成），随滚动自纠正，无跳动。
- 图表墙 `.fig-grid` 未加（非本轮实测场景），列路线图。

### P2-1 深浅主题 `color-scheme` 声明——修

`:root{color-scheme:light}` / `[data-theme=dark]{color-scheme:dark}`——深色模式下 checkbox/select/滚动条等原生控件改按深色原生渲染（modern-web-guidance dark-mode 指南 MANDATORY 项）。实测切换后 `getComputedStyle(html).colorScheme` 正确翻转。

### P2-2 对比度达标（Lighthouse a11y 主扣分项）——修

浅色主题两 token 加深（全局生效，深色主题自有 token 不动）：
- `--muted: #7a8199 → #6b7280`（白底 3.87 → **4.83**:1）
- `--primary: #4a6cf7 → #3d5ce0`（白字 4.39 → **5.52**:1）
- 深色残留：`--primary #6b85f7` 白字 3.32:1 不达 4.5——候选色「白字达标」与「深底区分度」互斥（实测 7 档无两全解），为避免全深色主题视觉回归，记录为残留不冒进。

### P2-3 登录页 landmark + meta description——修

`.login-card` 容器 `div→main`；两页补 `<meta name="description">`。

### 修复后回归总账

| 套件 | 结果 |
|---|---|
| `bash scripts/smoke-test.sh` | **50/50** |
| `node scripts/tables-page-test.mjs` | **16/16** |
| `node scripts/ui-regression.mjs` | **全部通过** |
| `docker exec paper-system-app python3 -u /app/scripts/backend-test.py` | **95/95**（含 enqueue batch_id 回归项） |
| 浏览器实测 | 阅读页/表格页/console 全程 **0 异常**；深浅主题切换、缩放、宽表横滚、三态切换复核通过 |

---

## 8. 疑点清单结案（对照任务书 §2）

| # | 疑点 | 结案 |
|---|---|---|
| 1 | bilingual 全量构建 | **证实但量化影响低**（41ms/141KB/202 对）→ 路线图 R2 |
| 2 | `/api/*` 一律 no-store | **实锤并修复图片侧**（×2–4 重复 → 304/0.3KB）；/pdf 无浪费维持原状 |
| 3 | canvas 永不卸载 | **实锤并修复**（15→8 张、18.1→9.7MB @dpr1；线性增长 → 有界） |
| 4 | `_pdfRescale` 串行 O(N) | **部分证实**：缩放冻结实为全文档重排为主（346ms 中 Layout+Style 194ms vs pdf.js 83ms）；串行 getPage 是次因 → 路线图 R3（缩放节流 + absolute 定位隔离），本轮不动 |
| 5 | 中文视图全量重建 | **证实存在，未量化到痛**（202 对规模追加重建毫秒级）→ 路线图 R4（千级 blocks 才必要） |
| 6 | aria 薄 | **量化更新并部分修复**（登录页 a11y 89→100）；阅读/表格页 aria 属 R1 全量项 |
| 7 | 内联 onclick 70+ / CSP unsafe-inline | 不验证，维持（P4 既定） |
| 8 | 上传/批量端点缺 smoke 断言 | 维持（评审 P1 备选已记录；本轮 backend-test 已有 batch_id 回归项） |
| 9 | 存量误报（check-inline-handlers `if`/`remove`） | 复现确认，未当 bug 修 ✓ |

---

## 9. 路线图（本轮不做——模式现代化重构，另开轮次点单）

| # | 项 | 依据（本轮量化） |
|---|---|---|
| R1 | **a11y 全量**：37 img alt、143 onclick-on-div 键盘化、30+ 弹层 `role=dialog`+焦点圈禁、toast `aria-live`、skip-link、`prefers-reduced-motion` | §5.2 基数；登录页修复证明单点收益可量化（89→100） |
| R2 | bilingual pairs 服务端缓存（翻译完成事件失效） | §2.2：当前 41ms 无痛，千级 blocks 才必要 |
| R3 | 缩放性能：`_pdfRescale` 页面 absolute 定位/contain 隔离 + zoom 节流 | §1.2：346ms 冻结 = 全文档重排 194ms 占大头 |
| R4 | 中文视图增量追加渲染 | 疑点 #5：当前规模毫秒级 |
| R5 | 构建链取舍：viewer.js 压缩 + sourcemap（文库页 Perf 67 的主要缺口） | §4；与「无打包」架构约束冲突，需专项决策 |
| R6 | `<dialog closedby>` 替换 30+ 手写弹层 | 任务书既定不做项；legacy-scan 4 处 backdrop 模式归此 |
| R7 | 图表墙 `.fig-grid` content-visibility | 同 P1-3 模式，未实测不冒进 |
| R8 | 登录页 401 会话探测的 console 噪音（/api/me 匿名 200 化） | §3；涉及 API 语义 |
| R9 | 上传整文件 `f.read()` 流式化 | 评审 P1 备选，维持 |

## 10. 第二轮：工具增量复查（2026-11-16 下午）

> 同日第二轮，按「结合 chrome-devtools + modern-web-guidance 再挖一轮」执行。范围：上一轮未覆盖的场景 + 路线图项的工具化探边。**新实测 3 项，落地 3 项快赢**，其余证实无需动。

### 10.1 新实测（补盲区）

| 场景 | 结果 | 结论 |
|---|---|---|
| 文库页首载导航 trace（热缓存 reload 全程） | LCP **356ms**（TTFB 9ms + 渲染延迟 347ms）；RenderBlocking 估省 **FCP 0 / LCP 0ms**；LegacyJS 9.3KB | 本机热载无阻塞收益；**文库页 Perf 67 缺口实为 Lighthouse 4x CPU 节流下的 viewer.js 编译+boot**（R5 构建链决策的量化依据）——不是 CSS/请求链问题，defer KaTeX 类微调无收益 |
| 文库列表 95 卡滚动（内部容器 5518px，全 traversal） | **0 长任务**、0 图片、纯文本卡 | 健康，无需 content-visibility（R7 仅限图表墙） |
| 任务中心页（idle：0 任务 / 6 综述节点 / DOM 1843） | console **0 消息** | 健康，无发现 |

### 10.2 MWG 新场景检索（view-transitions / 资源优先级 / 焦点管理）

落地 3 项快赢（全部前端，零 py 改动）：

1. **后台轮询降级 `priority:'low'`**（`deprioritize-background-fetches` 指南）：`/api/jobs/count` 与 `/api/health` 两个轮询 fetch 加 `priority:'low'`——badge/健康轮询让位于用户触发的请求；不支持的浏览器忽略该选项无副作用。构建产物 viewer.js:396/1789。
2. **toast 语义化**：`#toast` 加 `role="status"`（隐式 aria-live=polite + atomic）——读屏器可听到操作反馈，此前 toast 对读屏完全静默（§5.2 aria-live=0 的最小闭环）。
3. **弹层语义化 + 焦点移交**（`dialog` 指南「Accessible name and initial focus」的 80% 切片）：`openPop` 统一 `role="dialog"` + `aria-modal="true"` + `tabindex=-1` + 打开时 `focus({preventScroll:true})`——30+ 手写弹层全部自动受益；实测 openCollectPanel 三属性 + 焦点全部生效。完整焦点圈禁仍属 R1。

核实不落地：View Transitions（`same-document-transitions`）——纯视觉平滑，非优化项，SPA 页切换 DOM 替换路径各异，收益/扰动比不划算，留作体验类候选。

### 10.3 第二轮回归

smoke 50/50、tables-page-test 16/16、ui-regression 全过；浏览器实测 toast/弹层语义 + 焦点行为无副作用（Esc 关闭、单元格编辑、工作台 beforeClose 均正常）。

## 12. 专项轮：R1（a11y 全量）/ R3（缩放性能）/ R5（构建链）

> 2026-11-16 第三轮，按第二轮路线图点单执行三项专项。全部落地并带前后数据；回归全绿。

### R3 缩放性能（`_pdfRescale` 串行 getPage 消除）

- **修法**：构建时缓存每页基准宽 `pgW` 与高宽比 `pgRatio`，缩放时占位几何改纯算术——消除 O(N) 串行 `getPage+getViewport`；顺带删除只写不读的死存储 `pgvp_*`。剩余的缩放成本是占位高度变化引发的全文档重排（结构性，需 absolute 定位级重构，维持路线图）。
- **前后（同口径 6 步缩放 trace）**：长任务 **14 → 7**；Layout 合计 **399 → 85ms（-79%）**；Style 重算 **583 → 97ms（-83%）**。最重单步仍 ~346ms（首次缩放：全文档重排 + 可见页重渲染），后续步峰值 251 → **114ms**。

### R1 a11y 全量（hydration 收口，不逐模板改）

- **键盘可达（143 处 onclick-on-div/span）**：全局 hydration（MutationObserver + rAF 去抖，~1ms/帧）给非交互 onclick 元素补 `tabindex=0`（tr/td 保持 row 语义不加 role）+ `role="button"`，一条 document 级 keydown 委托把 Enter/Space 派发成 click。排除：原生交互元素、contenteditable 网格、纯 stopPropagation 的 td。**实测 117/117 全部 hydrated，Enter 触发 click 且 preventDefault 生效**。
- **焦点圈禁 + 还焦**：`openPop` Tab 循环圈禁（含 contenteditable 单元格），关闭还焦给触发者（detached 安全跳过）。实测：末按钮 Tab → 绕回首个；Esc/遮罩/按钮三路关闭均走圈禁清理。
- **img alt**：阅读页图表首图 alt=figcaption、组图其余 `alt=""`；PDF 裁剪图（懒加载生成路径）alt 取 figcaption；表格缩略图/组图子图装饰性 `alt="" aria-hidden`。审计前 37/37 无 alt → 图表 pane 视图 0 残留。
- **input 命名**：hydration 把 placeholder 复制为 aria-label（扩展到 textarea）；4 个无 placeholder 控件（dir-select / file-input / qa-pick-sort / m-collection-add）模板补显式 aria-label。审计 12/34 无名 → 0 残留。
- **skip-link**：`跳到主内容` 首站直达 `#main`（聚焦即显）。
- **prefers-reduced-motion**：全局降级动画/过渡到不可感知。

### R5 构建链（可选压缩，不动「无打包」工作流）

- **决策**：不加打包器；`build-webui.py` 增加可选 terser 步骤——terser 可用才产出 `viewer.min.js + sourcemap`，不可用则行为与从前完全一致（优雅跳过）。**viewer.js 可读版仍是权威产物**（`--check` 同步校验、jsdom 测试、人工排障都不变）。
- **服务端协商**：`/` 路由仅在 `viewer.min.js` 比 `viewer.js` **新**时改指压缩版——杜绝 terser 缺席环境里 stale min 上线。
- **实施**：viewer.js **460KB → 307KB（-33%）**；mangle 安全性已核（源内无 eval/new Function，内联 onclick 走 window.* 属性名不受影响）。
- **顺手挖出的真瓶颈（trace 机会清单指引）**：
  - **citeproc.js 967KB 未压缩、阻塞每页首屏**，仅引用格式化在用 → 压缩到 **373KB（-61%）** + 从 index.html 摘除 + 首次使用时按需注入（`ensureCiteproc`，Promise 复用防重复）；`_renderCiteBox` 的 `!window.citeproc` 兜底分支同步修正。**实测：boot 时不加载 → 打开引用卡片自动加载 → GB/T 7714 渲染成功**。
  - **pdf_viewer.css 100KB** 仅阅读页 textLayer 用 → 从全局 head 摘除，`openPaper` 首开时注入（在 getDocument 之前调用，无样式闪跳）。
- **效果（节流 Lighthouse，文库页）**：**Performance 67 → 82**。FCP 94（1.6s）/ TTI 92（3.5s）/ TBT 91（180ms，原 ~350ms）/ LCP 64（**5.3 → 3.5s**）；unused-js 441→257KiB（剩余为 katex/pdf.js 本体，按需化涉及面大，留后续）、unminified 159→61KiB。
  - 注：改前 LCP 实为 5.3s（score 22），第二轮报告中「LCP 4.4s 恶化」一说是分数/秒值误读，实际方向一致向好。

### 专项轮回归总账

smoke 50/50、tables-page-test 16/16、ui-regression 全过、backend-test 95/95（min 包 + 全部改动下四套全绿）；浏览器实测：键盘激活/焦点圈禁/skip-link/citeproc 懒加载/pdf_viewer.css 注入全链路通过。

## 11. 与既有文档的互引

- **architecture.md §6**：本轮为 §6-3（前端全局 state）、§6-19（无障碍）补量化基数；§6-2/写并发、§6-10（无指标）经 C 步复核无新增。阅读页 DOM 规模（7706 元素/深度 24）可补入 §6-3 证据。
- **multi-perspective-review.md**：§3 P2 清单 15 项复核结论见 §6-C-12；其「bilingual 全量构建」「no-store」「aria 薄」三项由定性升级为带数字；P1-4/P1-5 修复效果经本轮运行时复核确认未回归。
