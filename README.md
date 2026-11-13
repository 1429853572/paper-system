# paper-system

基于 MinerU 的学术论文阅读 / 双语翻译 / 证据问答 / 科研导读 / 批量综述系统。

## 快速开始

1. **访问**: `http://<服务器IP>:7861`（初始管理员 `admin`，密码见 `.env` 的 ADMIN_INITIAL_PASSWORD）
2. **配 key**: 登录 → 设置页 → 填自己的 GLM/OpenAI 兼容 API（聊天+翻译各一路，可测试连接）
3. **建账号**: 管理员在「管理」页生成邀请码 → 其他人凭邀请码注册 → 各自配 key
4. **用起来**: 拖 PDF 上传（或粘贴 DOI/arXiv/BibTeX 自动抓元数据+OA PDF）→ 解析完成自动建索引 → 点开阅读（双栏：左 PDF / 右原文|双语|中文）→ 💬问答 / 导读

## 功能地图

| 页面 | 功能 |
|---|---|
| 阅读双栏 | pdf.js 原 PDF ‖ 原文/双语对照/中文三视图（JSON 调试视图与版面框默认隐藏，`?debug=1` 唤出）；点段落跳页+bbox 高亮；正文选中弹「AI 解读/提问/翻译/文献入库」浮条 |
| 问答 | 单篇全文直读、多篇对比（≤6 篇自动检索取证）、引用[n]点击跳 PDF 页+源句闪烁；命令标签排（总结本篇/解读选中/就选中提问/检索相似，长按自定义）；↑↓ 历史、`/` 快选论文 |
| 找相关 | 🔍 三页签排卡（S2 相关推荐/参考文献/引证），勾选一键导入自动查重 |
| 导读 | 9 字段科研模板（问题/核心思想/方法/数据集/基线/指标/消融/复杂度/局限），带页码证据 |
| 文献追踪 | 顶栏「追踪」：订阅关键词/分类/期刊 → 定时巡逻 arXiv+顶刊 → 收件箱审阅（分区/被引/中文摘要）→ 一键收进文献库；邮件日报（管理员配一次全局 SMTP） |
| 表格工作台 | 顶栏「表格」：从已解析论文批量收割表格 → 左原图右数据对照 → LLM 批量整理（表头拍平/数字规范，预算闸可续跑）→ 取舍/编辑 → 一键 xlsx |
| 采集与专题 | 文库管理工具条「采集文献」→ 浮层：快速采集（一次性检索入库）/ 专题跟踪（可中断可恢复 + 一键综述）；综述唯一入口在「文库管理」勾选后用批量条「综述」发起；综述历史与批次进度在任务中心 |
| 综述报告 | 文库管理勾选 → 批量条「综述」发起（2~90 篇自动聚类分组 → 组内精读比对 → 跨组综合），历史与进度在任务中心「我的综述」，导出 MD + 对比矩阵 CSV；正文引用为作者-年份样式（内部证据编号已剥离），引用校验 PASS 才交付 |
| 元数据 | 联网校准五源级联（arXiv → S2 → CrossRef → OpenAlex → DBLP）改前→改后确认制；PDF 原件本地提取年份兜底；中文论文知网候选人工确认；AI 补全缺失字段 |
| 上传 | 多文件+进度/重试；URL 直链导入；DOI/arXiv/BibTeX 标识符导入（OA PDF 自动获取）；解析过滤器（页数上限+文件名排除） |
| 任务中心 | 解析/翻译进度（段级）、重试/取消、批量暂停恢复、MCP 写操作待确认区、已结束任务一键清理、token 用量（按用户） |
| 管理页 | 邀请码（3/7/14/30 天）、结构化按用户限额、用户表（论文/磁盘/30d token/禁用-启用-注销）、审计日志、公共额度池开关（默认关） |
| 设置 | 页签分组：账号安全 / AI 模型（BYOK，加密存储、测试可测已存配置）/ 翻译术语表 / 我的用量（解析配额·磁盘·**本月花费**·月预算闸）/ 管理；解析过滤默认值 |
| 回收站 | 软删除（默认 30 天，可配）可恢复、整站清空 |

## 中文文献获取（三条路，按需选）

| 路径 | 适用 | 前提 |
|---|---|---|
| **📥 采集**（文库管理工具条） | 关键词检索 → 勾选 → 浏览器下载入库 | 宿主 `acquire-service`（Playwright + 宿主 Chrome） |
| **📁 目录导入**（上传弹层） | 已下载到 `data/inbox/` 的整目录批量入库（PDF 直通、CAJ 自动转 PDF） | 无 |
| **🔗 标识符导入** | 已知 DOI/arXiv/BibTeX | 无 |

- 知网/预印本普遍软封（403/滑块验证码/CAJ 私有格式），**必须真实浏览器 + 人工过一次验证码**（Cookie 存 `~/.cnki_acquire_state.json` 复用）
- 中文期刊在 CrossRef/Unpaywall 几乎无覆盖 → 现有英文链路对中文期刊无效，这是采集链路的意义
- 采集入库的论文会记录 `meta_source`（来源站点）与作者/摘要/年份，来源可追溯

## 专题采集任务（文库管理 → 采集文献 → 📚 专题跟踪）

一条可中断可恢复的科研采集流水线：**关键词 → 检索候选 → 勾选 → 浏览器下载入库 → 解析 → 一键综述**。

- 任务持久化在库里：关掉页面继续跑、重启后自动续传（每篇候选单独记下载状态）
- 下载走任务队列（不占 web worker），串行 + 每篇 1.5~3s 随机间隔 + 失败退避（知网有风控，不能猛刷）
- **专题名作为综述的「研究问题先验」**：模型据此区分主线工作与外围工作，而不是靠 embedding 硬聚类
- 论文全部解析完成后可一键生成综述（缺导读会现场补齐）

## MCP（让 ZCode / Claude 直连你的文献库）

`.env` 的 `PAPERSYS_API_TOKEN` 即访问令牌，任意 MCP 客户端以 JSON-RPC POST `/api/mcp` 接入：

```json
{"mcpServers": {"paper-system": {"type": "http", "url": "http://<服务器IP>:7861/api/mcp",
  "headers": {"Authorization": "Bearer <PAPERSYS_API_TOKEN>"}}}}
```

- 读工具直接执行：`search_papers` / `read_paper` / `search_text` / `get_summary` / `cite` / `search_cnki`（中文文献检索）
- 采集类：`search_cnki`（中文检索，read 模式可用）；`create_topic_task` / `list_topic_tasks` / `acquire_cnki`（入库类，需 write 模式）
- 写操作（`acquire_cnki` / `undo_last_action` 等）需开 `PAPERSYS_MCP_TOOLSETS=read,write`
- 写工具默认关闭：`.env` 设 `PAPERSYS_MCP_TOOLSETS=read,write` 开放 `update_meta` / `import_by_doi` / `undo_last_action`——写动作生成待确认卡片，在网页「队列」浮层人工执行/丢弃，执行后可撤销（最近 10 条）

## 调度规则（GPU 共享）

- 手动上传的任务**插队**（interactive），批量导入排后台（background），层内按用户轮转——单人批量不阻塞他人
- 解析 GPU 串行；翻译每用户并发 2；embedding 回填后台批处理；综述单并发长任务
- member 限额：100MB/500页/200篇每天（admin 全豁免，管理页可按人调整）

## 文献库（多对多）

一篇论文可同时挂多个分库（Zotero 式）：上传/导入=挂进当前所在库；重复内容自动复用记录并挂进目标库（不重复解析/翻译）；「移动」拆成「加入库…」与「从本库移出」两个动作；删除分库只摘链——**不再属于任何库的论文才进回收站**。侧栏计数按子树去重。

## 前端回归

`node scripts/ui-regression.mjs`（总）｜ `batch-page-test.mjs`（批量+综述+任务中心+勾选面板+任务清理+删除撤销）｜ `topic-acquire-test.mjs`（采集弹层+专题流+综述费用预估）｜ `discover-test.mjs`（找相关）｜ `qa-ux-test.mjs`（命令标签/选中浮条/历史/标识符导入）｜ `cite-jump-test.mjs`｜ `trash-btn-test.mjs`｜ `cite-csl-test.mjs`｜ `user-test.mjs`（多用户：用量页/归属标识/限额编辑/禁用启用）｜ `permission-test.sh`（权限边界 39 项：未认证/member 越权/属主/配额 429/邀请码/会话吊销，需 docker 做造数与清理）｜ `backend-test.py`（后端：容器内 `docker exec paper-system-app python3 /app/scripts/backend-test.py`）｜ `smoke-test.sh`（部署后 40 项，含「viewer.js 与 src/ 同步」校验）

## 前端开发

源码在 `app/webui/src/*.js`（15 个功能域分片），`app/webui/viewer.js` 是**拼接产物**：

```bash
python3 scripts/build-webui.py           # 改完 src/ 后重建
python3 scripts/build-webui.py --check   # 只校验产物是否最新（smoke-test 也会查）
```

## 数据维护脚本

`scripts/cleanup-test-residue.py`（清理测试残留账号及其附属数据）｜ `scripts/backfill-synthesis-titles.py`（回填存量综述标题）｜ `scripts/backfill-llm-user.py`（回填匿名用量归属）——均支持 `--dry-run`。

## 技术栈

FastAPI + SQLite(FTS5+向量) + numpy ｜ MinerU 4.1.6 (vLLM, GPU) ｜ xinference (GPU: BGE-M3 + bge-reranker-v2-m3) ｜ Caddy ｜ 原生 JS + pdf.js

详见 `DEPLOY.md`（部署/迁移/备份）与 `config.example.yaml`（调优项）。

## Roadmap（二期备忘）

重复条目检测+合并 ｜ Scite 引证计数+撤稿警示 ｜ Obsidian/Markdown 笔记包导出 ｜ PDF 手工书签树 ｜ Tavily 联网问答 ｜ >90 篇分卷综述
