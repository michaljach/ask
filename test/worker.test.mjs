import worker from "../src/index.js";

let pass = 0, fail = 0;
const captured = [];

function sse(chunks) {
  return new ReadableStream({
    start(c) {
      const enc = new TextEncoder();
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

function stub(handler) {
  globalThis.fetch = async (url, init) => {
    const rec = { url: String(url), init, body: init?.body ? JSON.parse(init.body) : null };
    captured.push(rec);
    return handler(rec);
  };
}

const okStream = (chunks) => () => new Response(sse(chunks), { status: 200 });

function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? "  -> " + extra : ""}`); }
}

const ENV = { GROQ_API_KEY: "k-groq", ANTHROPIC_API_KEY: "k-ant", ASK_RATE_LIMIT: { limit: async () => ({ success: true }) } };
const get = (path, env = ENV) => worker.fetch(new Request("https://ask.dev" + path), env);

// ---- routing ----
console.log("routing");
let r = await get("/");
let body = await r.text();
check("GET / is short", body.split("\n").length < 28, `${body.split("\n").length} lines`);
check("GET / is runnable shell", body.startsWith(": <<'___'") && body.trimEnd().endsWith("/s | sh"));
check("GET / heredoc is closed", body.includes("\n___\n"));
check("GET / shows the banner", body.includes("\u2588\u2588\u2588\u2588"));
check("banner uses no half blocks", !/[\u2580\u2584]/.test(body), "half blocks fuse in some fonts");
check("GET / is readable text", body.includes("ask an LLM from a terminal"));
check("GET / names the model in use", body.includes("answering with groq openai/gpt-oss-20b"), body.split("\n").find((l) => l.startsWith("answering")));
check("banner has blank lines above and below", /\n\n \u2588\u2588\u2588\u2588\u2588\u2588/.test(body) && /\u2588\n\nask an LLM/.test(body));

r = await get("/help");
body = await r.text();
check("GET /help is the long form", !body.startsWith(":") && body.includes("BRING YOUR OWN KEY") && body.includes("ask - ask an LLM"));
r = await get("/health");
check("GET /health", (await r.text()) === "ok\n");
r = await get("/models");
body = await r.text();
check("GET /models lists aliases", body.includes("groq:openai/gpt-oss-20b"));
check("GET /models marks the default", /fast\s+groq:openai\/gpt-oss-20b\s+\(default\)/.test(body), body.split("\n")[0]);
r = await get("/robots.txt");
check("robots.txt disallows", (await r.text()).includes("Disallow: /"));
r = await get("/favicon.ico");
check("favicon 404s without burning a call", r.status === 404);
r = await get("/", { ASK_RATE_LIMIT: ENV.ASK_RATE_LIMIT });
check("root works with no keys configured", r.status === 200);

// ---- missing key ----
console.log("\nconfig errors");
r = await get("/?q=hi", { ASK_RATE_LIMIT: ENV.ASK_RATE_LIMIT });
body = await r.text();
check("no key -> 501 with the wrangler command", r.status === 501 && body.includes("wrangler secret put GROQ_API_KEY"), body.trim());

// ---- streaming, openai-compatible ----
console.log("\ngroq streaming");
stub(okStream([
  'data: {"choices":[{"delta":{"content":"lsblk"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":" -f\\n"}}]}\n\n',
  "data: [DONE]\n\n",
]));
r = await get("/?q=how+do+i+list+disks");
body = await r.text();
check("streams plain text", body === "lsblk -f\n\n", JSON.stringify(body));
check("content-type is text/plain", r.headers.get("content-type").startsWith("text/plain"));
let sent = captured.at(-1);
check("hits groq chat/completions", sent.url === "https://api.groq.com/openai/v1/chat/completions");
check("bearer auth", sent.init.headers.authorization === "Bearer k-groq");
check("default model is gpt-oss-20b", sent.body.model === "openai/gpt-oss-20b");
check("stream: true", sent.body.stream === true);
check("reasoning_effort low for gpt-oss", sent.body.reasoning_effort === "low");
check("system prompt is sent", sent.body.messages[0].role === "system" && sent.body.messages[0].content.includes("terminal oracle"));
check("system prompt carries the current time", /current date and time is \d{4}-\d{2}-\d{2}T[\d:.]+Z \(UTC\)/.test(sent.body.messages[0].content),
  sent.body.messages[0].content.slice(-70));
check("question reaches the model", sent.body.messages[1].content === "how do i list disks");
check("max_tokens default 800", sent.body.max_tokens === 800);

// ---- SSE split across chunk boundaries ----
console.log("\nSSE robustness");
stub(okStream([
  'data: {"choices":[{"delta":{"content":"par'.slice(0),
  'tition"}}]}\n\ndata: {"choices":[{"delta":{"content":" table"}}]}',
  "\n\ndata: [DONE]\n\n",
]));
r = await get("/?q=x");
body = await r.text();
check("reassembles a JSON payload split mid-chunk", body === "partition table\n", JSON.stringify(body));

stub(() => new Response(sse(['data: {"choices":[{"delta":{"content":"no trailing newline"}}]}']), { status: 200 }));
r = await get("/?q=x");
body = await r.text();
check("flushes a final line with no terminator", body === "no trailing newline\n", JSON.stringify(body));

// ---- thinking suppressed by default ----
stub(okStream(['data: {"choices":[{"delta":{"reasoning":"hmm","content":"answer"}}]}\n\n']));
r = await get("/?q=x");
check("reasoning hidden by default", (await r.text()) === "answer\n");
stub(okStream(['data: {"choices":[{"delta":{"reasoning":"hmm"}}]}\n\n']));
r = await get("/?q=x&think=1");
check("think=1 shows reasoning", (await r.text()) === "hmm\n");

// ---- non-streaming ----
console.log("\nnon-streaming + options");
stub(() => Response.json({ choices: [{ message: { content: "mount /dev/sda1 /mnt" } }] }));
r = await get("/?q=x&n=1");
check("n=1 returns whole answer with trailing newline", (await r.text()) === "mount /dev/sda1 /mnt\n");
check("n=1 sets stream:false upstream", captured.at(-1).body.stream === false);

stub(okStream(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n']));
await get("/?q=x&t=99999");
check("t is clamped to 4000", captured.at(-1).body.max_tokens === 4000);
await get("/?q=x&t=50");
check("t=50 honored", captured.at(-1).body.max_tokens === 50);
await get("/?q=x&m=groq:openai/gpt-oss-120b");
check("m=provider:model works", captured.at(-1).body.model === "openai/gpt-oss-120b");
await get("/?q=x&m=smart");
check("m=smart alias -> 120b, medium effort", captured.at(-1).body.model === "openai/gpt-oss-120b" && captured.at(-1).body.reasoning_effort === "medium");
r = await get("/?q=x&m=nope:some-model");
check("unknown provider -> 400", r.status === 400 && (await r.text()).includes('unknown provider "nope"'));

// ---- path + header + body question sources ----
console.log("\nquestion sources");
stub(okStream(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n']));
await get("/how+do+i+mount+a+usb+stick");
check("path question decoded", captured.at(-1).body.messages[1].content === "how do i mount a usb stick");
await worker.fetch(new Request("https://ask.dev/", { method: "POST", body: "why is wifi down" }), ENV);
check("POST body as question", captured.at(-1).body.messages[1].content === "why is wifi down");
await worker.fetch(new Request("https://ask.dev/", {
  method: "POST", headers: { "x-ask": "why did wifi fail" }, body: "wlan0: deauthenticated\n",
}), ENV);
let content = captured.at(-1).body.messages[1].content;
check("X-Ask header + piped body becomes question + context",
  content.startsWith("why did wifi fail") && content.includes("wlan0: deauthenticated"), JSON.stringify(content));
await worker.fetch(new Request("https://ask.dev/", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "q=explain+inodes",
}), ENV);
check("curl -d 'q=...' form body is unwrapped", captured.at(-1).body.messages[1].content === "explain inodes");

// ---- limits ----
console.log("\nlimits");
r = await worker.fetch(new Request("https://ask.dev/", { method: "POST", body: "x".repeat(200_001) }), ENV);
check("oversized body -> 413", r.status === 413);
r = await get("/?q=" + encodeURIComponent("y".repeat(4001)));
check("oversized question -> 413", r.status === 413);
const bigCtx = "L".repeat(25_000);
await worker.fetch(new Request("https://ask.dev/", { method: "POST", headers: { "x-ask": "why" }, body: bigCtx }), ENV);
content = captured.at(-1).body.messages[1].content;
check("context trimmed to last 20000 chars", content.length < 21_000 && content.includes("L"));
r = await worker.fetch(new Request("https://ask.dev/", { method: "POST", headers: { "x-ask": "why" }, body: bigCtx }), ENV);
check("trim notice reaches the user first", (await r.text()).startsWith("ask: context trimmed to the last 20000 of 25000 chars"));

// ---- rate limit + auth ----
console.log("\nrate limit + auth");
const limited = { ...ENV, ASK_RATE_LIMIT: { limit: async () => ({ success: false }) } };
r = await get("/?q=x", limited);
check("rate limited -> 429", r.status === 429 && (await r.text()).includes("X-Ask-Key"));
r = await worker.fetch(new Request("https://ask.dev/?q=x", { headers: { "x-ask-key": "gsk_mine" } }), limited);
check("BYO key bypasses the rate limit", r.status === 200);
check("BYO key is what gets forwarded", captured.at(-1).init.headers.authorization === "Bearer gsk_mine");
r = await get("/?q=x", { ...ENV, ASK_TOKEN: "s3cret" });
check("ASK_TOKEN gate -> 401 without it", r.status === 401);
r = await worker.fetch(new Request("https://ask.dev/?q=x", { headers: { authorization: "Bearer s3cret" } }), { ...ENV, ASK_TOKEN: "s3cret" });
check("ASK_TOKEN gate passes with the token", r.status === 200);
r = await get("/", { ...ENV, ASK_TOKEN: "s3cret" });
check("help is readable on a private instance", r.status === 200);

// ---- anthropic adapter ----
console.log("\nanthropic adapter");
stub(okStream([
  'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"secret"}}\n\n',
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"pacstrap /mnt base"}}\n\n',
]));
r = await get("/?q=x&m=claude");
body = await r.text();
check("only text_delta is printed", body === "pacstrap /mnt base\n", JSON.stringify(body));
sent = captured.at(-1);
check("hits /v1/messages", sent.url === "https://api.anthropic.com/v1/messages");
check("x-api-key header", sent.init.headers["x-api-key"] === "k-ant");
check("anthropic-version header", sent.init.headers["anthropic-version"] === "2023-06-01");
check("server-side-fallback beta header", sent.init.headers["anthropic-beta"] === "server-side-fallback-2026-07-01");
check("model is claude-opus-5", sent.body.model === "claude-opus-5");
check("effort low via output_config", sent.body.output_config.effort === "low");
check("fallbacks default", sent.body.fallbacks === "default");
check("no temperature (400 on opus 5)", !("temperature" in sent.body));
check("no thinking.budget_tokens (400 on opus 5)", !sent.body.thinking);
check("system is top-level, not a message", typeof sent.body.system === "string" && sent.body.messages[0].role === "user");

stub(() => Response.json({ stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] }));
r = await get("/?q=x&m=claude&n=1");
check("refusal surfaces as one readable line", (await r.text()).includes("declined to answer that (cyber)"));

// ---- upstream errors ----
console.log("\nupstream errors");
stub(() => new Response(JSON.stringify({ error: { message: "model_decommissioned" } }), { status: 400 }));
r = await get("/?q=x");
body = await r.text();
check("400 passthrough with provider message", r.status === 400 && body.includes("groq said 400: model_decommissioned"), body.trim());
stub(() => new Response("nope", { status: 401 }));
r = await get("/?q=x");
check("upstream 401 becomes 502 (our key, not theirs)", r.status === 502);
stub(() => { throw new Error("connection reset"); });
r = await get("/?q=x");
check("thrown fetch error -> 500 plain text", r.status === 500 && (await r.text()) === "ask: connection reset\n");

stub(() => new Response("data: {\"choices\":[]}\n\n", { status: 200 }));
r = await get("/?q=x&n=1");
body = await r.text();
check("non-JSON body on n=1 -> readable 502", r.status === 502 && body.includes("returned a non-JSON response"), body.trim());

stub(okStream(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n']));
r = await worker.fetch(new Request("https://ask.dev/why+is+cpu+at+50%+idle"), ENV);
check("stray % in the path does not 500", r.status === 200, String(r.status));
check("malformed escape falls back to the raw path", captured.at(-1).body.messages[1].content.includes("cpu at 50%"));

// ---- sessions ----
console.log("\nsessions (c=1)");
stub(okStream(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n']));
const transcript = ">>> how do i partition sda\nfdisk /dev/sda\n\n>>> and then format it\n";
r = await worker.fetch(new Request("https://ask.dev/?c=1", { method: "POST", body: transcript }), ENV);
check("session returns 200", r.status === 200, String(r.status));
let msgs = captured.at(-1).body.messages;
check("system prompt still first", msgs[0].role === "system");
check("prior turns become real messages", msgs.length === 4 && msgs[1].content === "how do i partition sda");
check("prior answer becomes an assistant turn", msgs[2].role === "assistant" && msgs[2].content === "fdisk /dev/sda");
check("follow-up is the last user turn", msgs[3].role === "user" && msgs[3].content === "and then format it");

r = await worker.fetch(new Request("https://ask.dev/?c=1", { method: "POST", body: "no marker here" }), ENV);
check("transcript with no question -> 400", r.status === 400 && (await r.text()).includes("no question found"));

r = await worker.fetch(new Request("https://ask.dev/?c=1", { method: "POST", body: ">>> hi\nanswer\n" }), ENV);
check("transcript ending in an answer -> 400", r.status === 400);

await worker.fetch(new Request("https://ask.dev/?c=1&m=claude", { method: "POST", body: transcript }), ENV);
msgs = captured.at(-1).body.messages;
check("anthropic gets alternating roles, no system in messages",
  msgs.map((m) => m.role).join(",") === "user,assistant,user" && typeof captured.at(-1).body.system === "string");

const longSession = ">>> old question\n" + "x".repeat(25_000) + "\n>>> what now\n";
r = await worker.fetch(new Request("https://ask.dev/?c=1", { method: "POST", body: longSession }), ENV);
body = await r.text();
check("long session trimmed from the oldest end", body.startsWith("ask: session trimmed"), body.slice(0, 60));
check("the pending question survives trimming",
  captured.at(-1).body.messages.at(-1).content === "what now", JSON.stringify(captured.at(-1).body.messages.at(-1)));

// A public host reached over http must still hand out an https script.
r = await worker.fetch(new Request("http://ask.example.com/"), ENV);
body = await r.text();
check("root script forces https for a public host", body.includes("curl -s https://ask.example.com/s | sh"), body.trimEnd().split("\n").pop());
r = await worker.fetch(new Request("http://ask.example.com/s"), ENV);
check("session script forces https", (await r.text()).includes('HOST="https://ask.example.com"'));
r = await worker.fetch(new Request("http://ask.example.com/sh"), ENV);
check("client script forces https", (await r.text()).includes('HOST="https://ask.example.com"'));
r = await worker.fetch(new Request("http://127.0.0.1:8787/s"), ENV);
check("local dev keeps http", (await r.text()).includes('HOST="http://127.0.0.1:8787"'));

r = await get("/s");
check("/s is the short alias for /repl", (await r.text()).startsWith("#!/bin/sh"));
r = await get("/repl");
body = await r.text();
check("/repl serves a sh script", body.startsWith("#!/bin/sh") && body.includes("ask> "));
check("/repl banner names the model", body.includes("answering with groq openai/gpt-oss-20b"));
check("/repl prints the banner via a quoted heredoc", body.includes("ASK_BANNER_END"));
check("/repl embeds the host it was fetched from", body.includes('HOST="https://ask.dev"'));
check("/repl marker matches the parser", body.includes('">>> $q"') || body.includes(">>> "), "marker mismatch");
r = await get("/sh");
check("/sh still serves the client", (await r.text()).startsWith("#!/bin/sh"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
