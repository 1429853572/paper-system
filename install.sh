#!/usr/bin/env bash
# paper-system 一键安装（在线模式）
# 用法: ./install.sh            # 在线安装（国内加速）
#       ./install.sh --offline  # 离线安装（里程碑6实现：导入镜像tar，跳过一切外网）
set -euo pipefail
cd "$(dirname "$0")"

OFFLINE=0
[[ "${1:-}" == "--offline" ]] && OFFLINE=1

# ---------- 颜色 ----------
G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
info()  { echo -e "${G}[✓]${N} $*"; }
warn()  { echo -e "${Y}[!]${N} $*"; }
fail()  { echo -e "${R}[✗]${N} $*"; exit 1; }

# ---------- 1. 环境预检 ----------
echo "== 环境预检 =="

command -v docker >/dev/null || fail "未安装 docker"
docker compose version >/dev/null 2>&1 || fail "未安装 docker compose plugin"
info "docker: $(docker --version | cut -d' ' -f3), compose: $(docker compose version --short)"

# nvidia-container-toolkit
docker info 2>/dev/null | grep -q "nvidia" || fail "docker 未注册 nvidia runtime（请安装 nvidia-container-toolkit 后重启 docker）"
info "nvidia runtime 已注册"

# GPU 驱动分支: >=580 用 CUDA 13.0 镜像; 570.x 需 cu129 变体; <570 拒绝
if command -v nvidia-smi >/dev/null; then
    DRIVER=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1 | cut -d. -f1)
    if (( DRIVER >= 580 )); then
        info "NVIDIA 驱动 ${DRIVER}.x — 使用 CUDA 13.0 镜像"
    elif (( DRIVER >= 570 )); then
        warn "NVIDIA 驱动 ${DRIVER}.x — 需改用 cu129 变体（编辑 docker/mineru.Dockerfile 基础镜像行）"
    else
        fail "NVIDIA 驱动 ${DRIVER}.x 过旧（需 >= 570），请先升级驱动"
    fi
    nvidia-smi --query-gpu=memory.total --format=csv,noheader | head -1 | grep -qE "2[0-9]{4}" \
        && info "GPU 显存充足" || warn "GPU 显存偏小，vLLM gpu_memory_utilization 需调低（compose.yml）"
else
    fail "未检测到 nvidia-smi"
fi

# 磁盘（构建需 ~60GB 余量：基础镜像20G+模型5G+构建层）
FREE_GB=$(df --output=avail -BG / | tail -1 | tr -dc '0-9')
(( FREE_GB >= 60 )) && info "磁盘余量 ${FREE_GB}G 充足" || fail "磁盘余量仅 ${FREE_GB}G，构建需 >= 60G"

# ---------- 2. 初始化 .env ----------
echo "== 初始化 .env =="
if [[ -f .env ]]; then
    warn ".env 已存在，跳过初始化（如需重新生成请备份后删除 .env）"
else
    cp .env.example .env
    # 生成随机密钥：SECRET_KEY(session签名) 与 FERNET_KEY(用户API key加密)
    SECRET_KEY=$(python3 -c "import secrets;print(secrets.token_hex(32))")
    FERNET_KEY=$(python3 -c "from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())" 2>/dev/null \
        || openssl rand -base64 32)
    ADMIN_PW=$(python3 -c "import secrets;print(secrets.token_urlsafe(9))")
    sed -i "s|^SECRET_KEY=.*|SECRET_KEY=${SECRET_KEY}|" .env
    sed -i "s|^FERNET_KEY=.*|FERNET_KEY=${FERNET_KEY}|" .env
    sed -i "s|^ADMIN_INITIAL_PASSWORD=.*|ADMIN_INITIAL_PASSWORD=${ADMIN_PW}|" .env
    chmod 600 .env
    info ".env 已生成（SECRET/FERNET/初始admin密码 已随机化）"
fi

# ---------- 3. 构建镜像 ----------
echo "== 镜像准备 =="
if (( OFFLINE )); then
    fail "离线模式在里程碑6实现（psys export-images / docker load）"
else
    docker image inspect mineru:4.1.6 >/dev/null 2>&1 \
        && info "mineru:4.1.6 已存在，跳过构建" \
        || { info "开始构建 mineru:4.1.6（1~3小时，含模型下载）；可另开终端 tail -f build.log"; \
             docker build -t mineru:4.1.6 -f docker/mineru.Dockerfile docker/ 2>&1 | tee build.log | tail -3; }
    docker compose pull --ignore-pull-failures caddy ollama || true
fi

# ---------- 4. 启动与健康检查 ----------
echo "== 启动服务 =="
docker compose up -d
info "等待健康检查（mineru vLLM 首次加载模型需数分钟）..."
for i in $(seq 1 60); do
    OK=$(docker inspect --format='{{.State.Health.Status}}' paper-system-app 2>/dev/null || echo starting)
    [[ "$OK" == "healthy" ]] && break
    sleep 10
done
[[ "${OK:-}" == "healthy" ]] || warn "app 未在 10 分钟内 healthy，请 docker compose logs app 排查"
docker compose ps

# ---------- 5. 完成提示 ----------
echo
info "安装完成！"
echo -e "  访问地址:  ${G}http://$(hostname -I | awk '{print $1}'):7861${N}"
echo -e "  初始管理员: ${G}admin${N} / 密码见 .env 的 ADMIN_INITIAL_PASSWORD"
echo -e "  后续步骤:  登录 → 管理页生成邀请码 → 各用户在设置页配置自己的 LLM key"
