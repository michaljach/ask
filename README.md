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
| `web=1` | let the model search the web before answering |
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
| `fast` | `groq:openai/gpt-oss-20b` |
| `smart` | `groq:openai/gpt-oss-120b` |
| `think` | `groq:openai/gpt-oss-120b`, high reasoning effort |
| `qwen` | `groq:qwen/qwen3.6-27b` |
| `web` | `groq:openai/gpt-oss-120b` with Groq's built-in `browser_search` |
| `compound` | `groq:groq/compound`, searches natively; slower and ~1.6x the tokens |
| `flash` | `google:gemini-3.6-flash`, slower and capped at 20 req/min |
| `lite` | `google:gemini-3.1-flash-lite` (default) |

`curl ask.example.com/models` lists them. `m=` also takes `provider:model`
directly, so you are not limited to the aliases:

```sh
curl -G ask.example.com --data-urlencode "q=hi" -d "m=groq:openai/gpt-oss-120b"
```

Model ids go stale. Ask the provider what it serves today:
`curl -H "Authorization: Bearer $GROQ_API_KEY" https://api.groq.com/openai/v1/models`

### Web search

`web=1` searches the web first, which is the whole point when the reason you are at a
bare terminal is that you have no browser:

```sh
curl "ask.example.com/?web=1" -d "what is the latest stable kernel"
```

There are two ways it can happen, and which one you get depends on what is configured.

**Searching here (preferred).** Set `EXA_API_KEY` or `TAVILY_API_KEY` and the Worker
runs the search itself, then hands the snippets to whichever model is default. This
keeps the two budgets apart: with a model-bundled search every query spends the same
tokens the answers come from — about 4,700 of Groq's 200,000 per day, so roughly 42
searches — whereas Exa's free tier is 20,000 requests a month and the model only pays
for the snippets it reads. It also means the default model answers, instead of `web=1`
having to switch to one that can search for itself.

```sh
npx wrangler secret put EXA_API_KEY      # free key from exa.ai, no card
```

Five results, 700 characters each, shown to the model with the source host and date
rather than a full URL — nobody can click a link in a terminal. A search that fails or
returns nothing degrades to an unsearched answer with a one-line note, because an
answer from memory beats no answer.

**The model searching for itself.** With no search key set, `web=1` falls back to
Groq's built-in `browser_search`, which only the `gpt-oss` family accepts — qwen
rejects built-in tools outright — so `web=1` switches model for you. Asking for search
on a model that cannot do it, with no key set either, returns a clear 400.

`m=web` always uses the provider's own tool even when a search key is set: naming a
model explicitly wins.

**Gemini cannot search at all.** Google Search grounding is not reachable on a free
key: the OpenAI-compatible layer rejects the tool outright, and the native endpoint
answers `429 quota exceeded` for a grounded call while ungrounded calls on the same key
succeed. That is why searching here matters — it gives Gemini's roomy free tier a way
to answer current questions.

## Providers

Set whichever secrets you want; the rest stay unavailable. All of these speak the
OpenAI `/chat/completions` shape except Anthropic, which has its own adapter.

| `provider:` | Secret |
|---|---|
| `groq` | `GROQ_API_KEY` |
| `google` | `GEMINI_API_KEY` (Gemini via its OpenAI-compatible layer) |
| `custom` | `CUSTOM_API_KEY` (optional) + `ASK_CUSTOM_BASE` |

Anything else that speaks the OpenAI shape — OpenRouter, Cerebras, Together,
DeepSeek, Mistral, an ollama box on your LAN — goes through `custom`, so reaching a
new provider is a secret and a base URL, not a code change.

Search engines, used by `web=1` when set (first match wins):

| Engine | Secret | Free tier |
|---|---|---|
| Exa | `EXA_API_KEY` | 20,000 requests/month, no card |
| Tavily | `TAVILY_API_KEY` | 1,000/month, no card |

No alias points at `google`: Gemini model ids move fast, so list what your key can
reach rather than trusting a hardcoded one, then use `m=google:<model>`.

```sh
curl -H "Authorization: Bearer $GEMINI_API_KEY" \
  https://generativelanguage.googleapis.com/v1beta/openai/models
```

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
src/search.js     web search done here, so it does not spend the answer budget
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
same-role neighbours so turns stay strictly alternating. A transcript that does not
end on a question is a 400. Long sessions are trimmed from the oldest end, and a
partial leading turn is discarded rather than misparsed.

## Caveats

Answers come from an LLM and will sometimes be confidently wrong. The system
prompt tells it to flag destructive commands with `WARNING:`, but read anything
that touches a disk before you run it.
