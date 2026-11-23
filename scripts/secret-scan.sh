#!/bin/sh
# Blocks a commit that adds a secret. Run before every commit: sh scripts/secret-scan.sh
# Staged source changes get the broad patterns; the generated bundle (third-party library code, full of words
# like require_additionalProperties and PEM handling code) gets only exact key formats.
set -u

GENERATED='action/bundle/index.js'
BROAD='sk-(proj|ant|or)-|gh[psu]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|PRIVATE KEY-----|re_[A-Za-z0-9]{20,}|npg_[A-Za-z0-9]{10,}|rzp_(live|test)_|postgres://[^ ]*@'
EXACT='sk-(proj|ant|or)-[A-Za-z0-9_-]{20,}|gh[psu]_[A-Za-z0-9]{36}|AIza[0-9A-Za-z_-]{35}|re_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}|npg_[A-Za-z0-9]{10,}|rzp_(live|test)_[A-Za-z0-9]{10,}|postgres(ql)?://[^:@ "]+:[^@ "]+@'

if git diff --cached --name-only | grep -E '(^|/)\.env' >/dev/null; then
  echo "secret-scan: a .env file is staged. Unstage it." >&2
  exit 1
fi
# The script itself is skipped: its own patterns would match.
if git diff --cached -U0 -- . ":(exclude)$GENERATED" ":(exclude)scripts/secret-scan.sh" | grep '^+' | grep -E "$BROAD"; then
  echo "secret-scan: possible secret in the staged changes above. Commit blocked." >&2
  exit 1
fi
if git diff --cached -U0 -- "$GENERATED" | grep '^+' | grep -oE "$EXACT"; then
  echo "secret-scan: key-shaped value in $GENERATED. Commit blocked." >&2
  exit 1
fi
echo "secret-scan: clean"
