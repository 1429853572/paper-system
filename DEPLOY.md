# paper-system 部署手册

本机（3090 服务器）已部署完成。本手册用于**迁移到其他服务器**复现。

## 架构

```
用户 → caddy(:7861, 反代+SSE) → app(:8001, FastAPI)
                                   ├→ mineru(:8000, GPU, MinerU 4.1.6 + vLLM)
                                   └→ ollama(:11434, GPU, BGE-M3 embedding)
存储: ./data/ (论文+SQLite, 备份对象)   ./models/ollama/ (BGE-M3 权重)
MinerU 模型内嵌镜像内 (docker save 自带, 无需单独迁移)
```

## 从零部署（新服务器）

### 前置要求
- NVIDIA 驱动 ≥ 580（570.x 需改 `docker/mineru.Dockerfile` 基础镜像为 cu129 变体行）
- docker + compose plugin + nvidia-container-toolkit
- 磁盘 ≥ 60GB 余量

### 在线安装（约 1~3 小时，主要是构建 mineru 镜像）
```bash
cd paper-system
./install.sh
```
脚本完成：环境预检 → .env 初始化（自动生成密钥）→ 构建镜像 → 启动 → 健康检查 → 打印 admin 初始密码。

> Docker Hub 不通时先配镜像加速（本机已配：docker.1ms.run / docker.m.daocloud.io）。

### 离线安装（推荐，本服务器 Docker Hub 已实测不通）
```bash
# ① 在已部署的机器上导出
./psys export-images --out offline-images   # 四镜像 tar（含模型，~45GB）
rsync -avP offline-images/ models/ new-server:/path/paper-system/

# ② 新服务器上（里程碑6: install.sh --offline 自动 docker load + 启动）
```

## 重启后自检

服务器重启后自动执行 `paper-system-postboot.service`（已 enable）：
起服务 → 加载 xinference 模型 → 重算向量 → 检索自检 → 报告写入 `data/verify-report.txt`

## 日常运维

```bash
docker compose ps                # 状态
docker compose logs -f app       # 应用日志
docker compose restart app       # 更新代码后重启（app/ 目录已卷挂载）
docker compose down / up -d      # 全栈停/起
```

## 备份与恢复

```bash
# 备份（VACUUM INTO 在线快照 + 论文文件），保留 7 份轮转
./psys backup                    # 里程碑6: 备份脚本封装

# 手动方式
sqlite3 data/papersys.db "VACUUM INTO 'data/backups/db-$(date +%F).db'"
tar czf data/backups/files-$(date +%F).tar.gz data/papers/
# → 定期把 data/backups/ 拷到外部存储（模型可再生不用备份）
```

恢复 = 停 app → 换回 papersys.db 与 papers/ → 起 app。

## 升级

- MinerU：改 `docker/mineru.Dockerfile` 版本号 → `docker build` → compose.yml image tag → `up -d`
- app 代码：更新 `app/` → `docker compose restart app`（生产建议同时重建 papersys-app:v1 镜像）
- 数据库 schema：`core/db.py` SCHEMA_VERSION 递增 + `_migrate` 加分支

## 故障排查

| 症状 | 处置 |
|---|---|
| 解析任务全部"等待GPU" | mineru 容器 /health 不过，`docker compose logs mineru`（vLLM 加载需几分钟） |
| 任务卡 running | mineru 重启导致远程任务丢失属预期，调度器 404 后自动重排队；app 重启也会恢复 |
| database is locked | 确认数据目录在本机文件系统（非 NFS）；busy_timeout 已内置 5s |
| embedding 报错 | `curl localhost:11434/api/tags` 查 ollama；`ollama pull bge-m3` 重拉 |
| 翻译/问答 401 | 各用户设置页测试连接；公共池需 admin 开启 |
