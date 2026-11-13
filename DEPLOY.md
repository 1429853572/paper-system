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
| 导出 PDF 失败 | `systemctl status papersystem-render`；存活 `curl localhost:8801/health`；鉴权 `curl -H "X-Render-Token: $(grep ^PAPERSYS_RENDER_TOKEN .env | cut -d= -f2)" -X POST localhost:8801/render -d '{\"html\":\"<p>t</p>\"}'` |
| 追踪邮件未发 | 管理后台 →「邮件发送」配置全局 SMTP（QQ 邮箱需授权码非密码）；测试发送按钮验证；tracker_loop 每 30 分钟巡逻到期订阅 |
| 表格批量整理卡住 | 任务中心看 table_tidy 批次；应用重启会自动把批内表回「待整理」重新入队 |
| 翻译/问答 401 | 各用户设置页测试连接；公共池需 admin 开启 |
| 阅读器 PDF 图表空白（图注在、图本体白/噪声条） | 原文内嵌 JPXDecode(JPEG2000) 图，pdf.js 解码器不完整 → 宿主 `python3 scripts/fix-jpx-images.py`（需 `pip install pymupdf`；先 `--dry-run` 看 scope）。脚本重编码为 JPEG 并做结构验证；已入库的 91 篇中 4 篇 206 张已修复（2026-11-13） |


## 宿主浏览器采集服务（中文文献获取）

与 `render-service` 同构的第二个宿主服务：Playwright 驱动宿主 Chrome 访问知网/预印本
（这些站点对纯 HTTP 软封，必须真实浏览器）。

```bash
# 0) 前置：宿主已装 google-chrome（install.sh 的 acquire 单元安装也以此为前提）
# 1) 宿主装 playwright（复用系统 Chrome，不必再下 300MB Chromium）
pip install playwright

# 2) 起服务（token 与 render-service 同款，.env 的 PAPERSYS_ACQUIRE_TOKEN）
python3 scripts/acquire-service.py --port 8802

# 3) 容器侧联通检查
curl -s http://127.0.0.1:8001/api/acquire/status
```

- 知网首次检索会遇滑块验证码：在有头模式人工过一次，Cookie 持久化到 `~/.cnki_acquire_state.json` 后复用
- `install.sh` 会自动装 `papersystem-acquire` systemd 单元（宿主无 playwright 时跳过并提示）
- 容器通过 `host.docker.internal:8802` 访问（compose 已配 extra_hosts 与 token 注入）


## 名字访问：局域网 `papers.local` + 外网域名 HTTPS

### 局域网（已配好）

- `http://papers.local`（80 口，免端口号）与 `http://<内网IP>:7861` 同后端
- 原理：宿主 `avahi-alias.service`（`avahi-publish -a -R papers.local 192.168.106.191`）
  发布 mDNS 记录 + Caddy 站点地址 `http://papers.local, :7861`（compose 绑宿主 80 口）
- 支持 mDNS 的设备（macOS/iOS/Windows10+/多数 Linux）直接用名字；部分安卓不支持 mDNS，用 IP:7861

### 外网 HTTPS（域名方案，一次性 10 分钟）

架构：`浏览器 → https://paper.<你的域名>（VPS Caddy 自动 HTTPS）→ 127.0.0.1:7862（现有 frp 隧道）→ 本机 caddy:7861 → app`
本机 frpc/frps **零改动**（7862 裸 TCP 透传，Host 头原样到达）。

1. **买域名**：腾讯云/阿里云任选（.top/.xyz 首年 ¥10~30，.com ¥60+/年），实名后加一条解析：
   `A | paper | 42.51.34.112 | TTL 默认`。以下假设得到 `paper.example.com`，替换成你的。
2. **VPS 装 Caddy**（42.51.34.112，Debian/Ubuntu；先 `ss -tlnp | grep -E ':80 |:443 '` 确认空闲）：
   ```bash
   apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
   apt update && apt install -y caddy    # systemd 自动拉起 + 开机自启
   ```
3. **VPS Caddyfile** `/etc/caddy/Caddyfile`（替换域名；`flush_interval -1` 是 SSE 流式必需）：
   ```caddyfile
   paper.example.com {
       reverse_proxy 127.0.0.1:7862 {
           flush_interval -1
       }
   }
   ```
   `systemctl reload caddy`。DNS 生效后 Caddy 自动申请 Let's Encrypt 证书（需 80/443 公网可达）。
4. **验证**（手机关 WiFi 走流量）：
   `https://paper.example.com` → 登录页且地址栏带锁；
   `nslookup paper.example.com` → 42.51.34.112。
5. **可选加固**（推荐：外网只能走 HTTPS，裸端口仅本机 Caddy 可碰）：
   ```bash
   iptables -A INPUT -p tcp --dport 7862 -s 127.0.0.1 -j ACCEPT
   iptables -A INPUT -p tcp --dport 7862 -j DROP
   apt install -y iptables-persistent && netfilter-persistent save   # 重启后仍生效
   ```
