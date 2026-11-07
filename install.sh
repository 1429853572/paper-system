#!/usr/bin/env bash
# paper-system 一键安装（在线模式）
# 用法: ./install.sh            # 在线安装（国内加速）
#       ./install.sh --offline  # 离线安装（导入镜像tar，跳过一切外网）
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
    # 生成随机密钥：SECRET_KEY(session签名) / FERNET_KEY(用户API key加密) / CLI token
    SECRET_KEY=$(python3 -c "import secrets;print(secrets.token_hex(32))")
    FERNET_KEY=$(python3 -c "from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())" 2>/dev/null \
        || openssl rand -base64 32)
    ADMIN_PW=$(python3 -c "import secrets;print(secrets.token_urlsafe(9))")
    CLI_TOKEN=$(python3 -c "import secrets;print(secrets.token_hex(16))")
    RENDER_TOKEN=$(python3 -c "import secrets;print(secrets.token_hex(16))")
    sed -i "s|^SECRET_KEY=.*|SECRET_KEY=${SECRET_KEY}|" .env
    sed -i "s|^FERNET_KEY=.*|FERNET_KEY=${FERNET_KEY}|" .env
    sed -i "s|^ADMIN_INITIAL_PASSWORD=.*|ADMIN_INITIAL_PASSWORD=${ADMIN_PW}|" .env
    sed -i "s|^PAPERSYS_API_TOKEN=.*|PAPERSYS_API_TOKEN=${CLI_TOKEN}|" .env
    grep -q "^PAPERSYS_RENDER_TOKEN=" .env || echo "PAPERSYS_RENDER_TOKEN=${RENDER_TOKEN}" >> .env
    # 采集服务 token（驱动宿主浏览器访问外网，必须鉴权；缺 token 则服务拒绝启动）
    grep -q "^PAPERSYS_ACQUIRE_TOKEN=" .env || echo "PAPERSYS_ACQUIRE_TOKEN=${ACQUIRE_TOKEN}" >> .env
    chmod 600 .env
    info ".env 已生成（SECRET/FERNET/初始admin密码/CLI token/渲染服务token 已随机化）"
fi
# 旧 .env 补渲染服务 token（render-service 与 app 共享，防局域网匿名调用宿主 Chrome）
if ! grep -q "^PAPERSYS_ACQUIRE_TOKEN=" .env; then
  echo "PAPERSYS_ACQUIRE_TOKEN=$(openssl rand -hex 16)" >> .env
  echo "已补写采集服务 token（PAPERSYS_ACQUIRE_TOKEN）"
fi
if ! grep -q "^PAPERSYS_RENDER_TOKEN=" .env; then
    echo "PAPERSYS_RENDER_TOKEN=$(python3 -c "import secrets;print(secrets.token_hex(16))")" >> .env
    info ".env 补写 PAPERSYS_RENDER_TOKEN"
fi
# app/caddy 带 profiles: ["app"]——无 COMPOSE_PROFILES 时 `docker compose up -d` 不会启动它们
if ! grep -q "^COMPOSE_PROFILES=" .env; then
    echo "COMPOSE_PROFILES=app" >> .env
    info ".env 补写 COMPOSE_PROFILES=app（app/caddy 随 compose up 启动）"
fi

# ---------- 3. 前端依赖（pdf.js / KaTeX） ----------
# vendor/ 已随仓库提供（git 内 41 个文件）。若被误删或裁剪，这里自动补齐，
# 否则前端会因 pdf.js 缺失而白屏。版本与仓库内文件逐字节一致（sha256 已核对）。
echo "== 前端依赖检查 =="
VENDOR="app/webui/vendor"
PDFJS_VER="4.10.38"
KATEX_VER="0.16.47"
# 国内优先 npmmirror，回退 jsdelivr
MIRRORS_PDF=("https://registry.npmmirror.com/pdfjs-dist/${PDFJS_VER}/files"
             "https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VER}")
MIRRORS_KA=("https://registry.npmmirror.com/katex/${KATEX_VER}/files"
            "https://cdn.jsdelivr.net/npm/katex@${KATEX_VER}")

# 需要的文件：<目标相对路径>|<包内源路径>
PDFJS_FILES=(
    "pdfjs/pdf.min.mjs|build/pdf.min.mjs"
    "pdfjs/pdf.worker.min.mjs|build/pdf.worker.min.mjs"
    "pdfjs/pdf_viewer.css|web/pdf_viewer.css"
    "pdfjs/standard_fonts/LiberationSans-Regular.ttf|standard_fonts/LiberationSans-Regular.ttf"
    "pdfjs/standard_fonts/LiberationSans-Bold.ttf|standard_fonts/LiberationSans-Bold.ttf"
    "pdfjs/standard_fonts/LiberationSans-Italic.ttf|standard_fonts/LiberationSans-Italic.ttf"
    "pdfjs/standard_fonts/LiberationSans-BoldItalic.ttf|standard_fonts/LiberationSans-BoldItalic.ttf"
    "pdfjs/standard_fonts/FoxitFixed.pfb|standard_fonts/FoxitFixed.pfb"
    "pdfjs/standard_fonts/FoxitFixedBold.pfb|standard_fonts/FoxitFixedBold.pfb"
    "pdfjs/standard_fonts/FoxitFixedItalic.pfb|standard_fonts/FoxitFixedItalic.pfb"
    "pdfjs/standard_fonts/FoxitFixedBoldItalic.pfb|standard_fonts/FoxitFixedBoldItalic.pfb"
    "pdfjs/standard_fonts/FoxitSerif.pfb|standard_fonts/FoxitSerif.pfb"
    "pdfjs/standard_fonts/FoxitSerifBold.pfb|standard_fonts/FoxitSerifBold.pfb"
    "pdfjs/standard_fonts/FoxitSerifBoldItalic.pfb|standard_fonts/FoxitSerifBoldItalic.pfb"
    "pdfjs/standard_fonts/FoxitSerifItalic.pfb|standard_fonts/FoxitSerifItalic.pfb"
    "pdfjs/standard_fonts/FoxitSymbol.pfb|standard_fonts/FoxitSymbol.pfb"
    "pdfjs/standard_fonts/FoxitDingbats.pfb|standard_fonts/FoxitDingbats.pfb"
    "pdfjs/standard_fonts/LICENSE_FOXIT|standard_fonts/LICENSE_FOXIT"
    "pdfjs/standard_fonts/LICENSE_LIBERATION|standard_fonts/LICENSE_LIBERATION"
)
KATEX_FILES=(
    "katex/katex.mjs|dist/katex.mjs"
    "katex/katex.min.css|dist/katex.min.css"
)
KATEX_FONT_NAMES=(
    KaTeX_AMS-Regular KaTeX_Caligraphic-Bold KaTeX_Caligraphic-Regular
    KaTeX_Fraktur-Bold KaTeX_Fraktur-Regular
    KaTeX_Main-BoldItalic KaTeX_Main-Bold KaTeX_Main-Italic
    KaTeX_Main-Regular KaTeX_Math-BoldItalic KaTeX_Math-Italic
    KaTeX_SansSerif-Bold KaTeX_SansSerif-Italic KaTeX_SansSerif-Regular
    KaTeX_Script-Regular
    KaTeX_Size1-Regular KaTeX_Size2-Regular KaTeX_Size3-Regular
    KaTeX_Size4-Regular KaTeX_Typewriter-Regular
)
for f in "${KATEX_FONT_NAMES[@]}"; do
    KATEX_FILES+=("katex/fonts/${f}.woff2|dist/fonts/${f}.woff2")
done

fetch_to() {   # fetch_to <目标相对路径> <源相对路径> <源base>...；成功返回 0
    local dest_rel="$1" src_rel="$2"; shift 2
    local dest="$VENDOR/$dest_rel"
    [[ -s "$dest" ]] && return 0
    mkdir -p "$(dirname "$dest")"
    local base
    for base in "$@"; do
        if curl -fsSL --retry 2 --connect-timeout 15 --max-time 120 "$base/$src_rel" -o "$dest" 2>/dev/null \
           && [[ -s "$dest" ]]; then
            return 0
        fi
        rm -f "$dest"
    done
    return 1
}

ensure_vendor() {
    local missing=0 spec dest src
    for spec in "${PDFJS_FILES[@]}" "${KATEX_FILES[@]}"; do
        dest="${spec%%|*}"; src="${spec##*|}"
        [[ -s "$VENDOR/$dest" ]] || missing=$((missing + 1))
    done
    if (( missing == 0 )); then
        info "前端依赖已就位（pdf.js ${PDFJS_VER} / KaTeX ${KATEX_VER}）"
        return 0
    fi
    if (( OFFLINE )); then
        fail "离线模式且前端依赖缺失 ${missing} 个文件——请从旧机打包 app/webui/vendor 一并迁移"
    fi
    warn "前端依赖缺失 ${missing} 个文件 → 自动下载（pdf.js ${PDFJS_VER} / KaTeX ${KATEX_VER}）"
    local ok=1
    for spec in "${PDFJS_FILES[@]}"; do
        dest="${spec%%|*}"; src="${spec##*|}"
        fetch_to "$dest" "$src" "${MIRRORS_PDF[@]}" || { ok=0; break; }
    done
    if (( ok )); then
        for spec in "${KATEX_FILES[@]}"; do
            dest="${spec%%|*}"; src="${spec##*|}"
            fetch_to "$dest" "$src" "${MIRRORS_KA[@]}" || { ok=0; break; }
        done
    fi
    if (( ok )); then
        info "前端依赖已补齐（$(find "$VENDOR" -type f | wc -l) 个文件）"
    else
        fail "前端依赖下载失败——pdf.js/KaTeX 缺失会导致前端白屏。
     请手动补齐后重试（源：npmmirror / jsdelivr 的 ${PDFJS_VER}、${KATEX_VER}）：
       pdf.js  ${PDFJS_VER}  → $VENDOR/pdfjs/   (build/pdf.min.mjs, build/pdf.worker.min.mjs, web/pdf_viewer.css, standard_fonts/*)
       KaTeX   ${KATEX_VER}  → $VENDOR/katex/   (dist/katex.mjs, dist/katex.min.css, dist/fonts/*.woff2)"
    fi
}

ensure_citeproc() {
  # 引用样式引擎（citeproc-js + CSL 官方样式）：仓库 vendor/ 已自带，这里只做缺失修复
  local V="app/webui/vendor/citeproc" C="app/webui/vendor/csl" VER="2.4.63"
  local STYLES=(china-national-standard-gb-t-7714-2015-numeric china-national-standard-gb-t-7714-2015-author-date
                apa modern-language-association chicago-author-date ieee nature science cell plos mdpi frontiers
                american-chemical-society american-institute-of-physics american-medical-association
                the-new-england-journal-of-medicine the-lancet elsevier-harvard springer-basic-author-date
                harvard-cite-them-right sage-harvard taylor-and-francis-chicago-author-date
                american-political-science-association)
  if [[ ! -s "$V/citeproc.js" ]]; then
    mkdir -p "$V"
    curl -fsSL --retry 2 -o /tmp/citeproc.tgz "https://registry.npmmirror.com/citeproc/-/citeproc-${VER}.tgz" \
      && { { echo '/* citeproc-js UMD 壳（npm citeproc@'"${VER}"'）*/';
             echo '(function (global) { var module = { exports: {} }; var exports = module.exports;';
             tar -xOzf /tmp/citeproc.tgz package/citeproc_commonjs.js; echo '';
             echo 'global.citeproc = module.exports; })(typeof window !== "undefined" ? window : globalThis);'; } > "$V/citeproc.js"; } \
      || warn "citeproc.js 下载失败——引用预览将走后端兜底样式"
    rm -f /tmp/citeproc.tgz
  fi
  for L in en-US zh-CN; do
    [[ -s "$V/locales-$L.xml" ]] || curl -fsSL --retry 2 -o "$V/locales-$L.xml" \
      "https://cdn.jsdelivr.net/gh/citation-style-language/locales@master/locales-$L.xml" || true
  done
  mkdir -p "$C"
  for S in "${STYLES[@]}"; do
    [[ -s "$C/$S.csl" ]] || curl -fsSL --retry 2 -o "$C/$S.csl" \
      "https://cdn.jsdelivr.net/gh/citation-style-language/styles@master/$S.csl" || warn "CSL 样式缺失: $S"
  done
}
ensure_citeproc
ensure_vendor

# ---------- 4. 构建镜像 ----------
echo "== 镜像准备 =="
if (( OFFLINE )); then
    # 离线：导入 deploy/offline/*.tar（由旧机 psys export-images 生成）
    if ls deploy/offline/*.tar >/dev/null 2>&1; then
        for tar in deploy/offline/*.tar; do
            info "导入镜像 $tar"
            docker load -i "$tar"
        done
    else
        fail "deploy/offline/ 下无镜像 tar——先在旧机执行镜像导出（见 DEPLOY.md 迁移章节）"
    fi
else
    docker image inspect mineru:4.1.6 >/dev/null 2>&1 \
        && info "mineru:4.1.6 已存在，跳过构建" \
        || { info "开始构建 mineru:4.1.6（1~3小时，含模型下载）；可另开终端 tail -f build.log"; \
             docker build -t mineru:4.1.6 -f docker/mineru.Dockerfile docker/ 2>&1 | tee build.log | tail -3; }
    docker compose pull --ignore-pull-failures caddy || true
fi

# ---------- 4.5 systemd 单元（宿主渲染服务 + 重启自检） ----------
echo "== systemd 单元 =="
if command -v systemctl >/dev/null; then
    SH=$PWD
    mkdir -p deploy/systemd
    cat > deploy/systemd/papersystem-render.service <<EOF
[Unit]
Description=paper-system host PDF render service (Chrome headless)
After=network.target

[Service]
EnvironmentFile=${SH}/.env
ExecStart=/usr/bin/python3 ${SH}/scripts/render-service.py --port 8801
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
    cat > deploy/systemd/paper-system-postboot.service <<EOF
[Unit]
Description=paper-system postboot verify (driver/services/models self-check)
After=docker.service nvidia-persistenced.service
Wants=docker.service

[Service]
Type=oneshot
ExecStart=${SH}/scripts/postboot-verify.sh
TimeoutStartSec=1800

[Install]
WantedBy=multi-user.target
EOF
    # 采集服务单元（中文文献获取；需宿主 playwright + 系统 Chrome）
    cat > deploy/systemd/papersystem-acquire.service <<EOF
[Unit]
Description=paper-system host browser acquisition service (Chinese literature)
After=network.target

[Service]
EnvironmentFile=${SH}/.env
ExecStart=/usr/bin/python3 ${SH}/scripts/acquire-service.py --port 8802
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
    if [ -x /usr/bin/google-chrome ] || command -v google-chrome >/dev/null; then
        cp -f deploy/systemd/papersystem-render.service /etc/systemd/system/
        cp -f deploy/systemd/papersystem-acquire.service /etc/systemd/system/
        systemctl daemon-reload
        systemctl enable --now papersystem-render 2>/dev/null || true
        info "papersystem-render 已安装并启动（PDF 导出依赖）"
        # 采集服务需宿主 playwright（复用系统 Chrome，无需再下 Chromium）
        if python3 -c "import playwright.sync_api" 2>/dev/null; then
            systemctl enable --now papersystem-acquire 2>/dev/null || true
            info "papersystem-acquire 已安装并启动（中文文献采集）"
        else
            info "宿主未装 playwright——采集服务未启用（pip install playwright 可开启）"
        fi
    else
        cp -f deploy/systemd/papersystem-render.service /etc/systemd/system/ 2>/dev/null || true
        systemctl daemon-reload
        warn "宿主未装 google-chrome——PDF 导出不可用（其余正常）。安装 Chrome 后: systemctl enable --now papersystem-render"
    fi
    cp -f deploy/systemd/paper-system-postboot.service /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable paper-system-postboot 2>/dev/null || true
    info "paper-system-postboot 已注册（服务器重启后自动自检/拉起模型）"
else
    warn "无 systemd——渲染服务与重启自检需手动维护（见 DEPLOY.md）"
fi

# ---------- 5. 启动与健康检查 ----------
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

# ---------- 6. xinference 模型加载 + 备份 crontab ----------
# xinference 健康检查只探测 /v1/models 端点——零模型也 healthy，必须显式启动模型
echo "== 加载 embedding/rerank 模型 =="
if bash scripts/setup-xinference.sh; then
    info "BGE-M3 / bge-reranker-v2-m3 已加载"
else
    warn "模型加载失败——问答检索不可用（docker compose logs xinference 排查后重跑 scripts/setup-xinference.sh）"
fi

echo "== 备份 crontab =="
if ! crontab -l 2>/dev/null | grep -q "cron-backup.sh"; then
    (crontab -l 2>/dev/null; echo "17 3 * * * /bin/bash $PWD/scripts/cron-backup.sh >> $PWD/data/backups/cron.log 2>&1") | crontab -
    info "每日 03:17 自动备份已写入 crontab"
else
    info "备份 crontab 已存在"
fi

# ---------- 7. 完成提示 ----------
echo
info "安装完成！"
echo -e "  访问地址:  ${G}http://$(hostname -I | awk '{print $1}'):7861${N}"
echo -e "  初始管理员: ${G}admin${N} / 密码见 .env 的 ADMIN_INITIAL_PASSWORD"
echo -e "  后续步骤:  登录 → 管理页生成邀请码 → 各用户在设置页配置自己的 LLM key"
