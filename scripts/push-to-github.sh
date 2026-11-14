#!/bin/bash
# Commit everything in this folder and push it to GitHub.
#   bash scripts/push-to-github.sh "what changed"
# The first run links the folder to the repository; later runs just commit and push.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="https://github.com/advayc/space-apps.git"
BRANCH="${BRANCH:-landing-redesign}"
MESSAGE="${1:-Redesign landing page, add projections, exports and data sources}"

if [ ! -d .git ]; then
  git init -q -b main
  git remote add origin "$REPO"
  git fetch -q --depth 1 origin main
  # Adopt the repository's history but keep the files exactly as they are here.
  git reset -q --mixed origin/main
fi

# Annual grids replaced by smaller packed files (see dist/assets/catalog.json).
for file in temperature-4f981342db.bin precipitation-d8580654f9.bin sst-e486fadc5f.bin moisture-931dec067c.bin pressure-ed8e0b095e.bin wind-4bb1072f08.bin uwnd-4387a479df.bin vwnd-f76e094097.bin cloud-cc6260f77d.bin air-062b3e8573.bin skin-da1575b760.bin soil-71c25ddf16.bin soiltemp-46d2ea9e35.bin ice-56615876c5.bin shortwave-68b03f2b71.bin latent-317d7f4a6a.bin sensible-9cb1d7bad9.bin olr-62efb3c7c8.bin; do
  rm -f "dist/assets/$file"
done

git checkout -q -B "$BRANCH"
git add -A
if git diff --cached --quiet; then
  echo "Nothing new to commit."
else
  git commit -q -m "$MESSAGE" \
    -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BcBcfxVsHMStJQ6uVwWpWe"
fi

if git push -u origin "$BRANCH"; then
  echo
  echo "Pushed. Open a pull request:"
  echo "  https://github.com/advayc/space-apps/compare/main...$BRANCH?expand=1"
else
  echo
  echo "Push was refused. You need write access to advayc/space-apps, or sign in first with: gh auth login"
fi
