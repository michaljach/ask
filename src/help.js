import { ALIASES, ALIAS_WIDTH } from "./providers.js";
import { BANNER } from "./banner.js";

// Generated scripts always talk https to a public host. Someone typing
// "curl ai.example.com" arrives over http, and the session that script starts
// would then carry questions and pasted logs in cleartext. Local dev keeps its
// scheme so http://127.0.0.1:8787 still works.
export function scriptOrigin(url) {
  const isLocal =
    /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(url.host) || url.hostname.endsWith(".local");
  return isLocal ? url.origin : `https://${url.host}`;
}

// The root serves two audiences from one response: a person running `curl host`
// who reads it, and `curl -s host | sh` which runs a session. The docs sit in a
// quoted heredoc fed to the `:` no-op, so a shell skips them (nothing expands
// inside, so the $* and | in the examples survive) and runs the last line. The
// two shell markers are unavoidable - the request is identical either way.
// Keep this short: it is the first thing anyone sees. Everything else is /help.
export function rootScript(url, model, c) {
  const h = url.host || "ask.example.workers.dev";
  const origin = scriptOrigin(url);
  return `: <<'___'

${c.banner(BANNER)}

ask an LLM from a terminal that has nothing but curl
${c.note(`answering with ${model}`)}

  ${c.cmd(`curl -s ${h} | sh`)}                       ${c.note("a session, until you quit")}
  ${c.cmd(`curl ${h} -d "why wont pacstrap work"`)}   ${c.note("one question")}

  ${c.cmd(`curl ${h}/help`)}    ${c.note("models, options, bring-your-own-key, everything else")}

${c.note("Answers come from an LLM and will sometimes be wrong. Read any command that")}
${c.note("touches a disk before you run it.")}
___
curl -s ${origin}/s | sh
`;
}

export function help(url, model, c) {
  const h = url.host || "ask.example.workers.dev";
  const origin = scriptOrigin(url);
  const aliases = Object.entries(ALIASES)
    .map(([name, a]) => `  ${name.padEnd(ALIAS_WIDTH)} ${a.provider}:${a.model}`)
    .join("\n");

  return `
${c.banner(BANNER)}

ask - ask an LLM from a terminal that has nothing but curl
${c.note(`answering with ${model}`)}

${c.head("A SESSION")} - one line, nothing installed

  curl -s ${h} | sh

  Then just type. Follow-ups remember what was already said, so "and then how do
  i format it" works. Blank line or ctrl-d quits. This runs a short shell script
  served by this host - read it first with: curl ${h}/s

${c.head("ONE QUESTION")}

  curl ${h} -d "why wont pacstrap work"
  curl -G ${h} --data-urlencode "q=why wont pacstrap work"
  curl ${h} -H "X-Ask: why wont pacstrap work"

  A question can also go in the path, but curl rejects literal spaces in a URL,
  so it needs + or %20: ${h}/why+wont+pacstrap+work

${c.head("PIPE IN CONTEXT")}

  Anything you POST alongside a question is read as terminal output:

  curl ${h} --data-binary @/etc/fstab -H "X-Ask: is this fstab valid"
  journalctl -xb | curl ${h} --data-binary @- -H "X-Ask: why did boot fail"

${c.head("OPTIONS  (query string)")}
  q=...     the question
  m=...     model: an alias below, provider:model, or a bare model id
  n=1       no streaming, wait and print the whole answer at once
  t=800     max tokens in the answer
  web=1     let the model search the web before answering
  think=1   also print the model's reasoning, if it exposes any
  c=1       the body is a session transcript, not terminal output

${c.head("MODELS")}
${aliases}

  curl "${h}/why+wont+pacstrap+work?m=smart"
  curl "${h}/?web=1" -d "what is the latest stable kernel"

${c.head("BRING YOUR OWN KEY")}
  Skips this instance's rate limit and bills your own account:
  curl ${h} -d "explain inodes" -H "X-Ask-Key: gsk_..."

${c.head("OPTIONAL")} - a client script, if you would rather not type curl at all
  curl ${h}/sh > /usr/local/bin/ask && chmod +x /usr/local/bin/ask
  ask why wont pacstrap work

  Or for this shell only, no file, no root:
  ask() { curl -sN -G ${origin} --data-urlencode "q=$*"; }

${c.head("OTHER")}
  curl ${h}/s         just the session script (this page runs it for you)
  curl ${h}/help      this text without the shell wrapper
  curl ${h}/sh        the one-shot client script
  curl ${h}/models    list the aliases above
  curl ${h}/health    liveness check

${c.note("Answers come from an LLM. It will be confidently wrong sometimes. Read any")}
${c.note("command that touches a disk before you run it.")}
`;
}
