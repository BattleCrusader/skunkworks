#!/usr/bin/env bash
# Asserts that .gitignore produces the intended verdicts — judged by git itself,
# not by re-implementing the pattern rules.
#
#   scripts/verify-gitignore.sh     exit 0 = every rule behaves as intended
#
# Two classes are checked: paths that must be ignored (secrets, build output,
# tenant runtime data) and paths that must stay tracked (source, docs, the
# .env.example template, and *.astro source files that share a name with the
# ignored .astro/ build directory).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

IGNORED=(
  node_modules/pdf-lib/index.js
  dist/app.js
  .astro/types.d.ts
  .output/server.js
  .env
  .env.local
  .env.production
  data/site.db
  content/media/ab/abcd.webp
  content/public/hero.webp
  content/protected/wm/x.pdf
  .DS_Store
  npm-debug.log
)

KEPT=(
  IDEA.md
  .gitignore
  .env.example
  package.json
  src/pages/index.astro
  src/components/Hero.astro
  content/pages/home.html
)

is_ignored() {
  git -C "$REPO" check-ignore --no-index -q -- "$1"
}

fails=0

for path in "${IGNORED[@]}"; do
  if ! is_ignored "$path"; then
    echo "FAIL  expected IGNORED, but git would track: $path"
    fails=$((fails + 1))
  fi
done

for path in "${KEPT[@]}"; do
  if is_ignored "$path"; then
    echo "FAIL  expected TRACKED, but git would ignore: $path"
    fails=$((fails + 1))
  fi
done

total=$(( ${#IGNORED[@]} + ${#KEPT[@]} ))

if [ "$fails" -eq 0 ]; then
  echo "PASS  ${#IGNORED[@]} must-ignore + ${#KEPT[@]} must-keep = $total paths behave as intended"
  exit 0
fi

echo "FAIL  $fails of $total path verdicts wrong"
exit 1
