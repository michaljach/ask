import { BANNER } from "./banner.js";
import { TURN_MARK } from "./prompt.js";

// The session loop served at /repl. Meant to be run straight out of curl:
//   curl -s <origin>/repl | sh
// Nothing is written to disk except a transcript in a temp file, removed on exit.
// Questions are read from /dev/tty because stdin is the pipe carrying this script.
export function replScript(origin, model) {
  return `#!/bin/sh
# ask - a question/answer session over curl. Quit with a blank line or ctrl-d.
HOST="${origin}"

if [ ! -r /dev/tty ]; then
  echo "ask: no terminal to read questions from" >&2
  exit 1
fi

T=$(mktemp 2>/dev/null) || T="\${TMPDIR:-/tmp}/ask.$$"
: > "$T" || exit 1
trap 'rm -f "$T"' EXIT HUP INT TERM

# The script can do what the server cannot: check whether stdout is a terminal.
if [ -t 1 ] && [ -z "$NO_COLOR" ]; then
  C_ART='\\033[1;31m'; C_ASK='\\033[1;31m'; C_DIM='\\033[2m'; C_OFF='\\033[0m'
else
  C_ART=; C_ASK=; C_DIM=; C_OFF=
fi

printf '%b' "$C_ART" > /dev/tty
cat > /dev/tty <<'ASK_BANNER_END'
${BANNER}
ASK_BANNER_END
printf '%b' "$C_OFF" > /dev/tty
printf 'session on %s\\n' "$HOST" > /dev/tty
printf '%banswering with ${model} - follow-ups remember what was said%b\\n' "$C_DIM" "$C_OFF" > /dev/tty
printf '%bblank line or ctrl-d quits%b\\n\\n' "$C_DIM" "$C_OFF" > /dev/tty

while :; do
  printf '%bask>%b ' "$C_ASK" "$C_OFF" > /dev/tty
  IFS= read -r q < /dev/tty || { printf '\\n' > /dev/tty; break; }
  [ -z "$q" ] && break
  printf '%s\\n' "${TURN_MARK}$q" >> "$T"
  curl -sN "$HOST/?c=1" --data-binary @"$T" | tee -a "$T"
done
`;
}
