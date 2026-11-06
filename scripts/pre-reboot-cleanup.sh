#!/usr/bin/env bash
# 重启前清理：停掉临时 CPU 测试容器
set -uo pipefail
docker rm -f xinf-cpu >/dev/null 2>&1 && echo "已清理临时 CPU 测试容器"
docker ps -a --filter name=xinf-cpu --format '{{.Names}}' | head -1
