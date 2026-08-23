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

cat > /dev/tty <<'ASK_BANNER_END'
${BANNER}ASK_BANNER_END
printf 'session on %s\\n' "$HOST" > /dev/tty
printf 'answering with ${model} - follow-ups remember what was said\\n' > /dev/tty
printf 'blank line or ctrl-d quits\\n\\n' > /dev/tty

while :; do
  printf 'ask> ' > /dev/tty
  IFS= read -r q < /dev/tty || { printf '\\n' > /dev/tty; break; }
  [ -z "$q" ] && break
  printf '%s\\n' "${TURN_MARK}$q" >> "$T"
  curl -sN "$HOST/?c=1" --data-binary @"$T" | tee -a "$T"
done
`;
}
