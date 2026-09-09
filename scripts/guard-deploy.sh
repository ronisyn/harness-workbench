#!/bin/bash
# scripts/guard-deploy.sh —— 安全部署(服务器侧执行)：孤儿/未推送提交防护
# 用法：在 /srv/harness-workbench 下运行：
#   bash scripts/guard-deploy.sh /tmp/<bundle>.bundle
# 行为：
#   1) 检查本仓库是否有未推送的本地提交(git log origin/main..HEAD)——有则中止并提示先处理(防"重置覆盖丢失提交"重演)
#   2) 检查工作树是否干净
#   3) fetch bundle 的 HEAD
#   4) 仅当 bundle 目标可 fast-forward 到当前 main 时才 reset；否则中止提示人工合并
#   5) push origin main
set -e
cd /srv/harness-workbench
BUNDLE="${1:?用法: guard-deploy.sh <bundle路径>}"
echo "== guard-deploy: $BUNDLE =="

# 1) 未推送本地提交检查(孤儿防护核心)
UNPUSHED=$(git log --oneline origin/main..HEAD 2>/dev/null || true)
if [ -n "$UNPUSHED" ]; then
  echo "❌ 中止：当前分支有未推送本地提交，直接部署会覆盖丢失："
  echo "$UNPUSHED"
  echo "处理：先 git push origin main（或人工确认合并）后再部署。"
  exit 3
fi
echo "✓ 无未推送本地提交"

# 2) 工作树干净检查
if [ -n "$(git status --porcelain)" ]; then
  echo "❌ 中止：工作树有未提交改动："
  git status --porcelain | head -20
  exit 4
fi
echo "✓ 工作树干净"

# 3) fetch bundle
git fetch "$BUNDLE" HEAD 2>/dev/null || { echo "❌ fetch 失败"; exit 5; }
TIP=$(git rev-parse FETCH_HEAD)
echo "→ bundle HEAD = $(git log -1 --format='%h %s' $TIP)"

# 4) 仅 fast-forward 可用才重置
if git merge-base --is-ancestor HEAD "$TIP"; then
  echo "✓ 可 fast-forward：重置到 $TIP"
  git reset --hard "$TIP"
else
  echo "❌ 中止：bundle 目标与当前 main 分叉(非 fast-forward)，需人工合并；不做强制重置"
  exit 6
fi

# 5) 推送
git push origin main || { echo "❌ push 失败(本地已前进，需处理)"; exit 7; }
echo "✓ 已推送 origin/main = $(git log -1 --format='%h' main)"
echo "== guard-deploy 完成 =="
