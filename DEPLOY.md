# paper-system 部署手册

本机（3090 服务器）已部署完成。本手册用于**迁移到其他服务器**复现。

## 架构

```
用户 → caddy(:7861, 反代+SSE) → app(:8001, FastAPI)
                                 ├→ mineru(:8000,   GPU, MinerU 4.1.6 + vLLM, 解析)
                                 ├→ xinference(:9997, GPU, BGE-M3 embedding + bge-reranker-v2-m3 rerank)
                                 └→ 宿主 render-service(:8801, Chrome headless, 导出 PDF)
存储: ./data/ (论文+SQLite, 备份对象)   ./models/xinference/ (BGE-M3/reranker 权重)
MinerU 模型内嵌镜像内 (docker save 自带, 无需单独迁移)
```

端口暴露面：仅 `7861`（web 入口）面向局域网；`8000/8001/9997` 只绑 `127.0.0.1`；
`8801`（渲染服务）带 token 鉴权（`.env` 的 `PAPERSYS_RENDER_TOKEN`）。

## 从零部署（新服务器）

### 前置要求
- NVIDIA 驱动 ≥ 580（570.x 需改 `docker/mineru.Dockerfile` 基础镜像为 cu129 变体行）
- docker + compose plugin + nvidia-container-toolkit
- 磁盘 ≥ 60GB 余量
- 宿主 google-chrome（导出 PDF 用；没有也能装完，仅 PDF 导出不可用）

### 在线安装（约 1~3 小时，主要是构建 mineru 镜像）
```bash
cd paper-system
./install.sh
```
脚本完成：环境预检 → .env 初始化（自动生成全部密钥）→ vendor 前端依赖补齐 → 构建/导入镜像 →
安装 systemd 单元（渲染服务 + 重启自检）→ `docker compose up -d`（含 `COMPOSE_PROFILES=app`）→
健康检查 → **加载 xinference 模型**（`scripts/setup-xinference.sh`，零模型时 healthcheck 也是过的）→
**写入备份 crontab**（每日 03:17）→ 打印 admin 初始密码。

> Docker Hub 不通时先配镜像加速（本机已配：docker.1ms.run / docker.m.daocloud.io）。

### 离线安装（推荐，本服务器 Docker Hub 已实测不通）
```bash
# ① 在已部署的机器上导出（docker save 四镜像 tar，含模型 ~45GB）
docker save mineru:4.1.6 papersys-app:v1 caddy:2.11.7-alpine \
  -o deploy/offline/images-main.tar
docker save docker.1ms.run/xprobe/xinference@sha256:da75082f... \
  -o deploy/offline/images-xinference.tar   # 67GB，可单独 rsync
# ② 打包数据与权重
tar czf data-bundle.tar.gz data/ config.yaml .env   # .env 含 FERNET_KEY——丢了用户 API key 无法解密
rsync -avP deploy/offline/ models/ data-bundle.tar.gz new-server:/path/paper-system/

# ③ 新服务器上
./install.sh --offline    # 自动 docker load deploy/offline/*.tar + 起服务 + 载模型
```

### 迁移清单（手工核对）
- `data/`（papersys.db + papers/ + backups/）
- `.env`（全部密钥，`chmod 600`）
- `config.yaml`、`models/xinference/`（可再生，可省）
- systemd：`install.sh` 自动安装 `papersystem-render` 与 `paper-system-postboot`
- crontab：`install.sh` 自动写入（`scripts/cron-backup.sh` 每日 03:17）

## 宿主依赖：PDF 渲染服务（导出 PDF 用）

容器内不装 Chrome（apt 太慢、镜像膨胀），改用**宿主渲染服务**：

```bash
# 宿主需有 google-chrome（PDF 打印）+ 该服务（install.sh 已装）
systemctl status papersystem-render.service   # 监听 :8801
```

- 服务脚本：`scripts/render-service.py`（POST /render {"html": ...} → application/pdf）
- 鉴权：读取 `.env` 的 `PAPERSYS_RENDER_TOKEN`（systemd `EnvironmentFile` 注入），
  app 容器经 `host.docker.internal:8801/render` 调用时带 `X-Render-Token` 头
- **迁移到新服务器时**：装 google-chrome + `install.sh` 自动注册 systemd 服务
- 公式渲染用容器内 node + vendored KaTeX（`app/tools/katex_render.mjs`）

## 重启后自检

服务器重启后自动执行 `paper-system-postboot.service`（install.sh 已 enable）：
起服务 → 加载 xinference 模型 → 重算向量 → 检索自检 → 报告写入 `data/verify-report.txt`

## 日常运维

```bash
docker compose ps                # 状态
docker compose logs -f app       # 应用日志（json-file 已限 50m×3 轮转）
docker compose restart app       # 更新代码后重启（app/ 目录已卷挂载）
docker compose down / up -d      # 全栈停/起
bash scripts/setup-xinference.sh # 重载 embedding/rerank 模型
```

## 备份与恢复

```bash
./scripts/backup.sh              # DB 快照（在线一致性）+ papers/ 归档，7 份轮转
./scripts/restore.sh 2026-11-07  # 按日期恢复（db 与 papers 同日配对；覆盖前自动留存现网数据）
# crontab 已装每日 03:17 自动备份；定期把 data/backups/ 拷到外部存储（模型可再生不用备份）
```

## 升级

- MinerU：改 `docker/mineru.Dockerfile` 版本号 → `docker build` → compose.yml image tag → `up -d`
- app 代码：更新 `app/` → `docker compose restart app`（生产建议同时重建 papersys-app:v1 镜像）
- 数据库 schema：`core/db.py` SCHEMA_VERSION 递增 + `_migrate` 加分支（列变更统一走 `_ensure_columns`）

## 故障排查

| 症状 | 处置 |
|---|---|
| 解析任务全部"等待GPU" | mineru 容器 /health 不过，`docker compose logs mineru`（vLLM 加载需几分钟） |
| 任务卡 running | mineru 重启导致远程任务丢失属预期，调度器 404 后自动重排队；app 重启也会恢复 |
| database is locked | 确认数据目录在本机文件系统（非 NFS）；busy_timeout 已内置 5s |
| embedding 报错 | `curl localhost:9997/v1/models` 应列出 bge-m3 / bge-reranker-v2-m3；没有就跑 `bash scripts/setup-xinference.sh` |
| 导出 PDF 失败 | `systemctl status papersystem-render`；`curl -H "X-Render-Token: $(grep ^PAPERSYS_RENDER_TOKEN .env \| cut -d= -f2)" -X POST localhost:8801/health` 鉴权是否一致 |
| 翻译/问答 401 | 各用户设置页测试连接；公共池需 admin 开启 |
