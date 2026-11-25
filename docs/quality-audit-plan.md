# 全量质量检查任务书（交接文档）

> 本文档是跨会话交接的执行任务书。目标：用新装的两个工具（chrome-devtools MCP + modern-web-guidance）对整个项目做一次**数字化**的全面质量检查，产出 `docs/web-quality-report.md`，随后修复实锤 bug 与有数据支撑的性能问题。
> 已确认的执行深度：**报告 + 实锤 bug 修复 + 性能优化（必须有修前后数据对比）**；模式现代化重构只列路线图不动手。
> 关联文档：`docs/architecture.md` §6（20 项已知弱点）、`docs/multi-perspective-review.md`（四视角评审 P0-P2）——本检查不重复它们，只补**运行时实测**与**前端模式**两个盲区，产出与两者互引。

## 0. 工具状态（已就绪，勿重装）

| 工具 | 状态 | 用法 |
|---|---|---|
| chrome-devtools MCP | 已配 `~/.zcode/cli/config.json` → `mcp.servers.chrome-devtools`，command=`chrome-devtools-mcp --browser-url http://127.0.0.1:9222`；已实测握手（33 工具） | 新会话直接可用：`mcp__chrome-devtools__*` 工具组（navigate_page / performance_start_trace / take_heapsnapshot / list_network_requests / list_console_messages / lighthouse_audit / take_screenshot 等） |
| 常驻 CDP 浏览器 :9222 | headless Chrome，已登录 paper-system（admin 会话在 cookie 里） | MCP 工具直接复用；若连接失败先 `curl -s http://127.0.0.1:9222/json/version` 检查 |
| modern-web-guidance CLI | 全局安装 v1.0.0，`/usr/local/bin/modern-web-guidance` | `search <query>` / `retrieve <ids>` / `legacy-scan <path>` / `list` |

- 站点：`http://127.0.0.1:7861`（caddy）；API 直连 `localhost:8001`。admin 密码在 `.env` 的 `ADMIN_INITIAL_PASSWORD`。
- 服务操作：`docker compose --profile app ps` / `docker compose restart app`。改 py 后需重启。

## 1. 检查范围与步骤

### A. 静态扫描（modern-web-guidance CLI）

1. `modern-web-guidance legacy-scan app/webui/ --top 30`——15 个 JS 分片（约 8000 行）+ styles.css + index.html 的过时模式全量清单。
2. 场景检索（`search` → 对高分场景 `retrieve`），覆盖本项目高价值点：
   - `responsive data table` / 大列表渲染（虚拟化 vs content-visibility）
   - `dialog focus management`（对照手写 `_uiDialog`，01-core.js:215 附近）
   - `dark mode`（对照 styles.css `[data-theme=dark]` 方案）
   - `form validation accessibility`（对照各弹层裸 input）
   - `scroll performance content-visibility`（对照卡片墙/正文流）

### B. 浏览器实测（chrome-devtools 工具组，逐项留证据）

测试素材（已核实存在）：
- 大论文：`pa71a3722188b2158`（MetroGS，15 页 217+ blocks）、`p8795e063b8a8ae29`（已翻译，177 对双语）
- 最宽表：`tb83dad1d25a7ef74a`（102 列，实测时先查 `ORDER BY` 确认仍是它）
- 表格列表满页：60 卡/页（admin 名下 600+ 张）

3. **阅读页大论文**：`navigate_page` → 打开论文 → `performance_start_trace` 记录开篇全程 → 滚动到底 → `take_heapsnapshot` 量化 canvas 位图驻留。关注：首屏渲染耗时、布局抖动次数、内存增长是否随滚动线性涨（canvas 永不卸载疑点，见 §2-3）。
4. **表格工作台**：60 卡满页滚动 trace；打开 26 列宽表 + 横向滚动（应能看到常显滚动条，v1.11.4 已修）；对照工作台三态切换（both/img/grid）。
5. **网络行为**：三场景各 `list_network_requests`——①图表墙/表格卡片墙滚动 ②阅读页翻页与切视图（原文/双语/中文）③任务中心轮询。验证：`/api/papers/*/images/*` 与 `/pdf` 是否每次重复下载（no-store 疑点 §2-2）、bilingual 是否重复全量请求、statuses 轮询频率。
6. **console 全景**：三页面全程 `list_console_messages`——未捕获错误/资源 4xx/弃用警告（此前只有「JS 异常抛出」级检查，没查过 console 面）。
7. **Lighthouse 基线**：登录页、阅读页（打开大论文后）、表格页各跑 `lighthouse_audit` → 记录 Performance/Accessibility/Best-Practices 分数（首份基线；aria 薄 §2-6 的量化后果就在这里）。
8. **SSE 实测**：打开任务页 + 多标签，观察 `/api/jobs/stream` 事件频率与 keepalive 间隔（节流修复后应 <10% 进度变化不广播；keepalive 周期 10s）。

### C. 后端模式级复查（静态，Grep + 逐个核对）

9. `scheduler.enqueue(` 全部调用点逐个核对 kwargs——上次 `POST /api/tables/tidy-batch` 把 `batch_id` 误作关键字参数 500（存量 bug，backend-test 已补断言），**同款模式全库排查**。
10. `openPop(` 全部调用点：持有未保存状态的弹层是否传了 `beforeClose`（工作台已传；其余弹层大多是表单即填即用，核对即可）。
11. async 端点上残余同步重活：`async def` 端点内直接 `db.write()` / 同步 httpx / CPU 密集（评审 P1-5 只修了 translate-selection / summary / import-identifier / 上传 preflight 四处重的，grep 复核剩余）。
12. `docs/multi-perspective-review.md` §3 P2 清单逐项复核：仍成立 / 已失效 / 新恶化（toast 透英文 36 处、引导卡不可回看、bilingual、no-store、批量缺可见性/重译、MCP 全局令牌、术语表全局、审计无翻页、暂停按钮 403、aria、字号偏好等）。

### D. 修复轮（数据齐后）

- **实锤 bug**（检查暴露的 P0）：当场修 + 回归。
- **性能优化**：候选按实测数据排优先级（预判清单见 §2）；**每项修前后跑同场景 trace/网络对比**，数字贴进报告。
- **不做**（只列路线图进报告）：`<dialog>` 替换 30+ 手写弹层、虚拟滚动全套、aria 全量补齐、内联 onclick 外置（P4 既定重构项）——这些是模式现代化重构，你点哪个另开一轮。

## 2. 已知疑点清单（交接核心——逐项验证，不必重新推理）

| # | 疑点 | 位置 | 验证方法 |
|---|---|---|---|
| 1 | bilingual 每次请求全量构建 pairs 再切片（滚动每翻 40 段重读全部 blocks+translations） | `main.py` bilingual 端点 → `translator.py` `_bilingual_pairs` | 步骤 B5 场景②：看翻页时每次请求耗时与响应体大小 |
| 2 | `/api/*` 一律 `Cache-Control: no-store`（中间件 main.py:57-87）——不可变的论文图片/PDF 每次重下 | `main.py` `_cache_policy` | B5 场景①：滚动图表墙看图片请求量与字节数 |
| 3 | 渲染过的 PDF canvas 永不卸载（`wrap.dataset.rendered` 永存；每页上限 ~48MB RGBA） | `03-reader.js` `_ensureRendered` 附近 | B3：滚到底 heapsnapshot 看内存曲线 |
| 4 | `_pdfRescale` 每次 zoom 串行 `getPage` 全部页 O(N) | `03-reader.js` | B3：连续缩放 trace 看长任务 |
| 5 | 中文视图每次追加全量重建整列 DOM | `12-reader-ui.js`（注释自认「全量重建」） | B3：中文视图滚动 trace |
| 6 | aria 很薄：index.html 36 处 + src 6 处；对话框无 role/焦点圈禁；toast 无 aria-live；41 处 onclick 挂 div/span 不可键盘达；8 处 img 无 alt；无 skip-link；无 prefers-reduced-motion | 全局 | B7 Lighthouse a11y 分数量化 |
| 7 | 内联 onclick 70+ 处依赖 CSP `script-src-attr unsafe-inline`（外置是 P4 既定项，本次不动） | 全局 | 不验证，报告引用即可 |
| 8 | 上传端点、批量入队端点缺真机 smoke 断言（两次 500 的共同盲区：py_compile 查不出运行时错） | `scripts/smoke-test.sh` | C9 排查时顺带评估补断言成本 |
| 9 | `_vec_cache`/`_tb_cache` 已改 LRU-32（v1.11.3）；`smoke` 只测 API 不测前端性能；`check-inline-handlers` 的 `if`/`remove` 报错是**存量误报**（复合内联表达式解析缺陷） | — | 背景知识，勿当 bug |

## 3. 产出与验收

- `docs/web-quality-report.md`：性能基线数字（trace 关键指标）、Lighthouse 三页分数、网络行为结论、过时模式清单、后端复查结果——**每项发现带证据**（工具输出摘录/截图引用/请求 URL+字节数），按 P0（bug）/P1（性能，有数字）/P2（模式现代化）分级。
- 修复项：修前后同场景数据对比 + 回归全绿（`bash scripts/smoke-test.sh` 50 项 / `node scripts/tables-page-test.mjs` 16 项 / `node scripts/ui-regression.mjs` / `docker exec paper-system-app python3 -u /app/scripts/backend-test.py` 95 项）。
- 报告与 `architecture.md` §6、`multi-perspective-review.md` 互引，不另立权威清单。
- 边界：不动 `data/`；不改测试夹具来凑通过；存量误报不当 bug 修。
