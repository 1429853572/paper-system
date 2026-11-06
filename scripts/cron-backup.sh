#!/usr/bin/env bash
# 供 crontab 调用的包装（相对定位，不绑定安装路径；PATH 由 backup.sh 自理）
cd "$(dirname "$0")/.." || exit 1
mkdir -p data/backups
exec bash scripts/backup.sh >> data/backups/cron.log 2>&1
