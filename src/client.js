// The script served at /sh. It embeds whatever host it was fetched from, so there
// is nothing to edit after downloading it.
export function clientScript(origin) {
  return `#!/bin/sh
# ask - ask an LLM from a terminal.
# Installed from ${origin}. To update:
#   curl ${origin}/sh > /usr/local/bin/ask && chmod +x /usr/local/bin/ask

HOST="${origin}"

# ask -m smart <question>   picks a different model
URL="$HOST"
case "$1" in
  -m) URL="$HOST/?m=$2"; shift 2 ;;
esac

# No question: print the usage screen.
[ $# -eq 0 ] && exec curl -sN "$HOST/help"

# Read piped or redirected input as context, with the question in a header:
#   journalctl -xb | tail -50 | ask why did boot fail
# Testing the file type rather than "not a tty" matters: under a command
# substitution or cron, stdin is not a tty but has nothing to read, and
# --data-binary @- would block forever waiting for an EOF that never comes.
if [ -p /dev/stdin ] || [ -f /dev/stdin ]; then
  exec curl -sN "$URL" -H "X-Ask: $*" --data-binary @-
fi

exec curl -sN -G "$URL" --data-urlencode "q=$*"
`;
}
