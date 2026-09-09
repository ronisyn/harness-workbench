#!/bin/bash
# scripts/orphan-scan.sh —— 孤儿/未推送提交扫描（只读，不修改任何东西）
# 用途：发现"只提交未推送"或"被 reset 剥离但仍可达"的提交，防丢失。
# 用法：在仓库内运行 bash scripts/orphan-scan.sh
cd "$(dirname "$0")/.."
echo "== 1) 未推送本地提交（origin/main..HEAD）=="
git log --oneline origin/main..HEAD 2>/dev/null || echo "（无 origin 或无差异）"
echo
echo "== 2) 未引用提交（git fsck，含被 reset 剥离的对象）=="
git fsck --no-reflogs --unreachable 2>/dev/null | grep commit | head -30 || true
echo
echo "== 3) reflog 中最近 15 个移动（人工核查是否有"消失"的提交）=="
git reflog -15 --format='%h %gd %gs' | head -15
echo
echo "完成：若第 2/3 步发现可疑提交，可用 git show <hash> 查看、git branch recover-<hash> <hash> 建档，再决定合并。"
