# paper-system 架构文档（专家评估用）

> 配套阅读：`docs/evaluation-pack.md`（评估引导与背景）。本文描述代码的真实形态——所有数字来自当前代码库与运行库，非规划文档。

## 1. 系统定位

自托管的**多用户学术论文工作台**，覆盖「获取 → 解析 → 阅读 → 问答/翻译 → 知识提取（表格/标注）→ 跟踪 → 综述」全流程。单机部署（GPU 服务器），5 名真实用户日常使用。

**核心差异化**（与 Zotero/ReadPaper 等的边界）：
1. **证据溯源问答**：LLM 回答中的引用编号可点击 → PDF 跳页 + 源句闪烁，杜绝幻觉不可查
2. **表格→可用数据**：MinerU 表格 HTML + 原图对照 + LLM 整理（行列硬校验防漏）→ xlsx
3. **订阅巡逻**：arXiv/顶刊关键词订阅 → 收件箱审阅 → 一键入库（对比 Stork 的纯推送）
4. **中文文献链路**：知网/预印本浏览器采集（英文链路无法覆盖）

## 2. 组件拓扑

```
浏览器（原生 JS，15 分片拼接 viewer.js，无框架/无构建链）
   │ HTTPS（Caddy 反代，局域网 + frp 公网隧道）
   ▼
FastAPI（app/server/main.py，158 路由，单进程 + 10 worker 线程）
   │
   ├─ SQLite（WAL，31 表，FTS5 + 向量列）         ← 全部持久状态
   │    papers/blocks/chunks（解析产物）
   │    llm_calls/jobs/audit_log（运行账本）
   │    tracker_subs/table_extracts/...（业务模块）
   ├─ MinerU 4.1.6 容器（vLLM GPU）               ← PDF→结构化块（唯一重 CPU/GPU 环节）
   ├─ xinference 容器（BGE-M3 + reranker）        ← embedding/rerank
   ├─ acquire-service（宿主 Playwright+Chrome）   ← 知网/预印本采集（反爬需真浏览器）
   └─ LLM API（用户 BYOK 或公共池）               ← 问答/翻译/导读/综述/表格整理/追踪摘要
```

**运行数据**（2026-11-14）：95 篇论文 / 24K 块 / 635 表格条目 / 3 订阅 / 5 用户 / 数据盘 62%。

## 3. 调度模型

单进程内 10 个 daemon 线程（`app/core/jobs.py` Scheduler 类）：

| 线程 | 职责 | 并发 | 阻塞点 |
|---|---|---|---|
| parse | MinerU 提交+轮询 | GPU 门控（健康检查） | MinerU 慢（1-3min/篇） |
| translate | 段级翻译 | 信号量（可配） | LLM 限速 |
| summary | 科研导读 | 1（LLM 同步） | LLM |
| synthesis | 综述流水线 | 1 | LLM 长任务 |
| acquire | 浏览器采集 | 1（串行+礼貌间隔） | 知网风控 |
| tracker | 订阅巡逻（30min 醒） | 逐订阅 | 外部 API |
| table_tidy | 表格批量整理 | 1 | LLM（预算闸刹车） |
| meta | 元数据校准 | - | 五源级联 |
| embed | 索引回填 | - | xinference |
| janitor | 回收站清理/每日备份/健康告警 | - | - |

任务持久化在 `jobs` 表（queued→running→done/failed，retry+退避），应用重启自动恢复。SSE 广播进度（`/api/jobs/stream` + data 变更事件）。

## 4. 关键数据流

### 4.1 解析链路
PDF 上传 → preflight（页数/加密过滤）→ papers 行 + jobs 入队 → parse worker → MinerU API → zip 产物（middle_json + images/）→ `build_blocks`：块（text/title/table/image + bbox + section_path）入库 → chunks 切分 + embedding → FTS+向量双索引。

### 4.2 LLM 链路（统一入口 `core/llm.py`）
```
resolve_llm(user, purpose)   # BYOK 优先 → 公共池（admin 开关）→ NoKeyError
  → LLMClient.complete()     # 预算闸 costing.check_budget → 429/5xx 退避重试 → 用量记账 llm_calls
```
6 个消费方（问答/翻译/导读/综述/表格整理/追踪摘要）全部经此链路——**预算闸与记账无旁路**。用户 Fernet 加密存 key。

### 4.3 安全边界
- 会话 cookie（签名）+ token_ver 吊销；argon2 密码
- SSRF：URL 导入/采集/LLM 测试三处 `_assert_public_url`（手动逐跳重定向复检、IP 字面量/内网拦截）
- 权限：require/require_admin + 每资源 owner 校验（`_own_sub/_own_table` 模式）
- 配额：日解析篇数/文件大小/页数/磁盘/月预算/订阅数——per-user override + 全局默认
- 审计：`audit()` 29 处（敏感操作全留痕）
- Fernet：用户 LLM key、SMTP 授权码

## 5. 关键设计决策（ADR 摘要）

### ADR-1：SQLite 单库，不上 PostgreSQL
**决策**：所有状态（含 FTS5 全文索引、向量列）存单文件 SQLite，WAL 模式，读写锁分离（写锁非重入 + busy_timeout 5s）。
**理由**：单机自托管定位；运维成本为零（备份=拷文件）；500 篇压测全部查询 ≤21ms，余量 25×。
**代价**：无水平扩展；写并发上限单写者。
**复核点**：若用户数 >20 或论文 >5000，需要迁移评估（blocks 表已是最大表，24K 行）。

### ADR-2：前端原生 JS 无框架
**决策**：15 个功能域分片按序拼接为单个 `viewer.js`（构建脚本含 CSS 括号平衡闸），无 npm/打包链。
**理由**：部署面为零（容器内只有 Python）；团队维护无需前端工具链知识。
**代价**：无组件隔离（全局 state 单例）；DOM 重建式渲染在大列表需手动分页。
**复核点**：交互复杂度已接近上限（对照工作台/划词标注都做了）；再往上建议评估引入轻量框架。

### ADR-3：MinerU 作为唯一解析引擎
**决策**：PDF 结构化完全委托 MinerU 容器（vLLM），不自行实现版面分析。
**理由**：解析质量是全系统地基（问答/翻译/表格全部消费其产物）；MinerU 是开源中最优。
**代价**：强依赖（MinerU 挂 = 解析全停，但已解析内容不受影响）；GPU 需求。
**缓解**：解析任务 GPU 门控 + 失败重试 + 远程任务失效自动重排队。

### ADR-4：LLM 统一网关 + 预算闸前置
**决策**：所有 LLM 调用经 `resolve_llm` 单入口；预算检查在请求前（不是事后统计）；用户 BYOK 优先于公共池。
**理由**：多用户共享 GPU 服务器时成本可控；BYOK 让用户自担成本，公共池是管理员主动开启的赠予。
**代价**：预算闸对长任务（综述）是全有全无——预算中途烧尽则任务提前收工（表格整理已做续跑设计）。

### ADR-5：证据溯源作为问答的硬约束
**决策**：问答答案中的引用 `[n]` 必须对应真实检索到的证据块；校验不 PASS 不交付；引用可点击跳 PDF 源句。
**理由**：学术场景幻觉零容忍——「每个论断可溯源」是产品的信任基石。
**代价**：答案受限于一检索到的内容（不做开放生成）。

### ADR-6：表格整理的「防漏校验」而非「盲信 LLM」
**决策**：LLM 整理表格时硬校验列数严格相等、行数仅容许表头合并（≤2 行），数据行丢失即标 mismatch 转人工；AI 版本写 `ai_cells` 工作副本，原始 `cells` 永不覆盖。
**理由**：表格数据用于下游分析，错一个数比没有更糟——机器整理必须可核对、可回退。
**代价**：mismatch 率依赖模型能力（实测主流表 ~90% 通过）。

### ADR-7：追踪巡逻的「先验驱动」而非「embedding 聚类」
**决策**：订阅关键词/专题名作为 LLM 的研究问题先验（区分主线/外围工作），tier 分层用关键词加权而非向量相似度。
**理由**：嵌入聚类在论文跨主题时不可解释且不可控；关键词先验是研究者自己的心智模型。
**代价**：依赖用户写准关键词。

### ADR-8：备份双轨 + 哈希清单
**决策**：容器 janitor 与宿主 cron 各自备份（DB VACUUM INTO + papers/ tar.gz），manifest 含 SHA256；按 keep=7 轮转（按类别各自轮转）。
**代价**：磁盘占用 ~8GB（已纳入监控告警：>15GB 告警）。
**事故记录**：轮转曾因 db/papers 混排 mtime 漂移失效（papers 堆积 10 份）——已修并纳入健康检查。

## 6. 已知弱点（诚实清单）

按专家关注维度分组，全部有证据：

### 架构
1. **单进程单机**：所有 worker 在一个 FastAPI 进程内——进程崩 = 全停（虽有 restart:unless-stopped + 任务恢复）。无水平扩展路径
2. **SQLite 写并发上限 1**：写锁非重入（已有多处注释防嵌套死锁），高并发写会排队
3. **前端全局 state 单例**：无组件隔离，交互复杂度接近原生 JS 上限
4. **轮转双轨**：容器 janitor 与宿主 cron 各自备份——两套轮转逻辑并存（已各自修复，但两套并存本身是复杂度）

### 安全
5. **无自动化安全测试**：红队探针（越权/SSRF/注入）均为人工轮次，未纳入 CI
6. **session cookie 无 CSRF token**：写端点依赖 SameSite + CORS 隐式防护，未显式防 CSRF
7. **rate limit 只覆盖登录**：其他写端点无限速（配额闸部分弥补）

### 数据
8. **去重口径三套**：内容 hash（上传）/URL hash（URL 导入）/DOI+标题（标识符）——同一论文经不同入口可重复入库
9. **旧 parse_runs 永不清**：重解析累积旧 run 的 blocks（收割已按最新 run 过滤，但表仍在增长）

### 运维
10. **无指标导出**：健康数据只进管理后台卡 + 告警邮件，无 Prometheus/通用格式
11. **SMTP 密码换机风险**：Fernet key 随宿主生成——换机部署后已存 SMTP 授权码/用户 key 需重录（文档已注明）

### 角落扫描（2026-11-14 第二轮全盘清点新增）
12. **备份 tar 归档曾轮转失效**：papers tar 堆积 10 份（已修+回收 1.2G）；备份恢复演练**已补做**（DB integrity ok + 行数对账 + tar 解包抽查，均通过）
13. **data/inbox 1.3G 源 PDF 残留**：专题采集的源文件导入后未清理（不占 papers 配额但占磁盘）——建议在 README 标注手动清理，或提供 inbox 清理入口
14. **Docker build cache 1.85GB**（1.04GB 可回收）：定期 `docker builder prune` 即可
15. **邀请码过期不清**：过期码永久留在表里（数据量极小，无害；可选清理）
16. **登录失败记录含 IP**：audit_log 有 56 条 login-fail（含来源 IP）——审计需要但注意 IP 属个人信息，保留期建议明确
17. **access log 26MB 且有轮转**：json-file 50M×3 已配置 ✓ 无风险
18. **依赖版本**：fastapi 0.121 / httpx 0.28 / cryptography 46.0 全部较新，无已知 CVE 版本（建议季度复查）
19. **无障碍覆盖低**：aria-label 13 处、img alt 0 处——自托管小团队可接受，对外产品需补
20. **纯中文 UI**：定位明确（自用/团队），多语言不在范围

## 7. 上线前把关清单（专家请重点核查）

| # | 检查项 | 现状 | 风险 |
|---|---|---|---|
| 1 | CSRF 防护 | 仅 SameSite | 中——建议显式 token 或确认 SameSite=Lax 足够 |
| 2 | 去重统一 | 三套口径 | 中——同一论文多入口重复 |
| 3 | 备份恢复演练 | 备份在跑但未真恢复过 | 高——灾备未验证 |
| 4 | HTTPS 强制 | Caddy 局域网可 HTTP | 视部署环境 |
| 5 | LLM 供应商数据条款 | 用户 key 直连第三方 | 用户自担（BYOK 设计如此） |
| 6 | 单点故障 | 单机单进程 | 自托管定位可接受，需文档明示 |
| 7 | 速率限制覆盖 | 仅登录 | 低——配额闸已部分弥补 |
| 8 | 法律：知网采集 | 拟人化拖动滑块 | **合规灰区**——建议评估使用政策风险 |

## 8. 改进方向建议（供专家批判）

按投入产出排序，专家可推翻：

1. **备份恢复自动化验证**（高优先）：每月自动恢复最近备份到沙箱并跑完整性查询
2. **CSRF token**（中）：写端点加一次性 token header
3. **去重统一**（中）：全部入口统一走「DOI → 内容 hash → URL hash」级联判定
4. **table_tidy/parse 并发化**（低）：500 篇实测 21ms，当前瓶颈在 LLM 而非查询——并发化收益在 LLM 吞吐不在 DB
5. **标注数据结构化**（中期）：当前标注 quote 定位靠文本匹配，重解析后块文本变化会失配——可存 bbox 持久定位
6. **old parse_runs 清理**（低）：按 paper 保留最近 N 个 run
