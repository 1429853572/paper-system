#!/usr/bin/env bash
# 供 crontab 调用的包装（用绝对路径，避免 PATH 问题）
exec /home/root123/paper-system/scripts/backup.sh >> /home/root123/paper-system/data/backups/cron.log 2>&1
