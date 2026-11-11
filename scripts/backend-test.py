#!/usr/bin/env python3
"""薄包装：真正实现在 app/scripts/backend-test.py（容器只挂载 app/，测试须容器内跑）。
用法: python3 scripts/backend-test.py   # 等价于 docker exec paper-system-app python3 /app/scripts/backend-test.py
"""
import subprocess, sys
sys.exit(subprocess.call([
    "docker", "exec", "paper-system-app", "python3", "/app/scripts/backend-test.py"
]))
