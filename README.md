# ask

Ask an LLM from a terminal that has nothing but curl.

Made for the situation where you are mid-install on Arch, on tty2, with no browser,
no man pages, and no idea what the flag was:

```
$ curl -sN ask.example.workers.dev/how+do+i+mount+the+efi+partition
mkdir -p /mnt/boot
mount /dev/sda1 /mnt/boot

Check the partition first:
lsblk -f
```

A single Cloudflare Worker that fronts Groq (or Anthropic, OpenRouter, Cerebras,
a box running ollama, ...). The API key lives in the Worker, so the client side is
plain curl with no auth, no JSON, and nothing to parse. Answers stream as text.

## Deploy

```sh
npm install
npx wrangler secret put GROQ_API_KEY     # free key from console.groq.com
npx wrangler deploy
```

That prints your URL: `https://ask.<your-subdomain>.workers.dev`. Curl it with no
question to get the usage screen.

Fits inside the Cloudflare free tier: 100,000 requests/day, and the per-IP rate
limit binding in `wrangler.toml` is free too. Streaming a proxied response is
almost entirely network wait, so the 10ms CPU limit per request is not a concern.

A short hostname makes this much nicer to type. Add a domain you own to
Cloudflare, then in the dashboard: Workers & Pages -> ask -> Settings -> Domains
& Routes -> add `ask.yourdomain.com`. Now it is `curl ask.yourdomain.com/...`.

## Using it

### A session

One line, nothing installed:

```sh
curl -s ask.example.com | sh
```

```
ask session on https://ask.example.com
follow-ups remember what was already said. blank line or ctrl-d quits.

ask> how do i partition sda
fdisk /dev/sda
ask> and then format it
mkfs.ext4 /dev/sda1
```

The follow-up works because the client keeps the transcript in a temp file and
sends it with each question, so no server-side session state exists — nothing to
store, nothing to expire, and the free tier never sees a write.

That command pipes a remote script into `sh`. It is short and it is served by
your own Worker, but read it before you trust it: `curl ask.example.com/s`.
To keep `sh` off the pipe, `curl -s ask.example.com/s > /tmp/r && sh /tmp/r`.

### One question

```sh
curl ask.example.com -d "why wont pacstrap work"
curl -G ask.example.com --data-urlencode "q=why wont pacstrap work"
curl ask.example.com -H "X-Ask: why wont pacstrap work"
```

A question can also go in the path — `ask.example.com/why+wont+pacstrap+work` —
but curl refuses literal spaces in a URL (`URL rejected: Malformed input to a URL
function`) and parses every non-flag argument as another URL, so the path form
needs `+` or `%20` and `curl host "why wont pacstrap work"` cannot work at all.
That is why the flag forms above are the documented ones.

### Pipe in context

Anything you POST *alongside* a question is treated as terminal output to read:

```sh
curl ask.example.com --data-binary @/etc/fstab -H "X-Ask: is this fstab valid"
journalctl -xb | tail -100 | curl ask.example.com --data-binary @- -H "X-Ask: why did boot fail"
```

### Optional client script

If you would rather not type `curl` at all:

```sh
curl ask.example.com/sh > /usr/local/bin/ask && chmod +x /usr/local/bin/ask
ask why wont pacstrap work
journalctl -xb | tail -50 | ask why did boot fail
```

It embeds the host it was downloaded from, so there is nothing to edit. For a
single shell session with no file and no root, paste the function instead:

```sh
ask() { curl -sN -G https://ask.example.com --data-urlencode "q=$*"; }
```

### Options

| Param | Meaning |
|---|---|
| `q=...` | the question |
| `m=...` | model: an alias, `provider:model`, or a bare model id |
| `n=1` | no streaming, print the whole answer at once |
| `t=800` | max tokens in the answer (capped at 4000) |
| `think=1` | also print the model's reasoning, if it exposes any |
| `c=1` | the body is a session transcript, not terminal output |

| Header | Meaning |
|---|---|
| `X-Ask: <question>` | question, so the body can be piped context |
| `X-Ask-Key: <key>` | use your own provider key, skipping the rate limit |
| `Authorization: Bearer <token>` | required only if the operator set `ASK_TOKEN` |

The installed client takes `-m` before the question: `ask -m smart why wont pacstrap work`.

### Model aliases

| Alias | Resolves to |
|---|---|
| `fast` | `groq:openai/gpt-oss-20b` (default) |
| `smart` | `groq:openai/gpt-oss-120b` |
| `think` | `groq:openai/gpt-oss-120b`, high reasoning effort |
| `claude` | `anthropic:claude-opus-5` |

`curl ask.example.com/models` lists them. `m=` also takes `provider:model`
directly, so you are not limited to the aliases:

```sh
curl -G ask.example.com --data-urlencode "q=hi" -d "m=groq:openai/gpt-oss-120b"
```

Model ids go stale. Ask the provider what it serves today:
`curl -H "Authorization: Bearer $GROQ_API_KEY" https://api.groq.com/openai/v1/models`

## Providers

Set whichever secrets you want; the rest stay unavailable. All of these speak the
OpenAI `/chat/completions` shape except Anthropic, which has its own adapter.

| `provider:` | Secret |
|---|---|
| `groq` | `GROQ_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `cerebras` | `CEREBRAS_API_KEY` |
| `together` | `TOGETHER_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY` |
| `mistral` | `MISTRAL_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `custom` | `CUSTOM_API_KEY` (optional) + `ASK_CUSTOM_BASE` |

`custom` points at any OpenAI-compatible endpoint — ollama, llama.cpp, vLLM,
LM Studio, a private gateway:

```sh
npx wrangler secret put ASK_CUSTOM_BASE     # e.g. https://ollama.yourdomain.com/v1
curl -G ask.example.com --data-urlencode "q=hi" -d "m=custom:llama3.2"
```

Change the default with the `ASK_PROVIDER` / `ASK_MODEL` vars in `wrangler.toml`.

## Keeping the bill at zero

- The rate limit in `wrangler.toml` is per IP, 20 requests per minute. `period`
  must be `10` or `60`; the limit is any integer.
- `t=` is capped at 4000 tokens, and the system prompt asks for short answers.
  Pasted context is trimmed to the last 20,000 characters (the end of a log is
  the interesting part) and the reply says so.
- `X-Ask-Key` lets heavy users bill their own account and skip the rate limit.
- To make the instance private, `npx wrangler secret put ASK_TOKEN`. Callers then
  need `-H "Authorization: Bearer <token>"`. The usage screen stays public.
- `npx wrangler tail` streams live logs.

## Layout

```
src/index.js      routing, question parsing, limits, rate limit, auth
src/providers.js  provider registry, both API adapters, SSE -> plain text
src/prompt.js     the system prompt that makes answers terminal-shaped
src/help.js       the usage screen you get when you curl it with no question
src/client.js     the shell client served at /sh
src/repl.js       the session loop served at /s (and /repl)
test/worker.test.mjs
```

`npm test` runs the suite against a stubbed upstream — no API key needed. It
covers routing, both adapters, SSE reassembly across chunk boundaries, the
limits, the rate limit, and the error paths.

`npm run dev` runs it locally on `127.0.0.1:8787` with secrets from `.dev.vars`
(copy `.dev.vars.example`).

## Writing your own session client

`c=1` says the body is a transcript rather than pasted terminal output. Lines
starting with `>>> ` are questions; everything between them is the answer that
came back. The last `>>> ` line is the question being asked now:

```
>>> how do i partition sda
fdisk /dev/sda
>>> and then format it
```

The worker turns that into proper alternating user/assistant turns, merging any
same-role neighbours so the Anthropic API stays happy. A transcript that does not
end on a question is a 400. Long sessions are trimmed from the oldest end, and a
partial leading turn is discarded rather than misparsed.

## Caveats

Answers come from an LLM and will sometimes be confidently wrong. The system
prompt tells it to flag destructive commands with `WARNING:`, but read anything
that touches a disk before you run it.
