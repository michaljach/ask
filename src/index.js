import { ALIASES, ALIAS_WIDTH, HttpError, apiKeyFor, ask, defaultAlias, defaultModel, resolveModel, searchCapable } from "./providers.js";
import { clientScript } from "./client.js";
import { palette, wantsColor } from "./color.js";
import { formatResults, searchEngine, webSearch } from "./search.js";
import { TURN_MARK, buildChatMessages, buildMessages } from "./prompt.js";
import { replScript } from "./repl.js";
import { help, rootScript, scriptOrigin } from "./help.js";

const MAX_QUESTION = 4_000;
const MAX_CONTEXT = 20_000;
const MAX_BODY = 200_000;
const DEFAULT_MAX_TOKENS = 800;
const MAX_MAX_TOKENS = 4_000;

const RESERVED = new Set(["", "help", "health", "models", "sh", "repl", "s", "favicon.ico", "robots.txt"]);

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      if (err instanceof HttpError) return text(`ask: ${err.message}\n`, err.status);
      if (err.name === "AbortError") return text("ask: upstream request aborted\n", 504);
      return text(`ask: ${err.message}\n`, 500);
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const slug = decodeSlug(url.pathname.slice(1));
  const params = url.searchParams;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors() });
  }
  if (slug === "robots.txt") return text("User-agent: *\nDisallow: /\n");
  if (slug === "favicon.ico") return new Response(null, { status: 404 });
  if (slug === "health") return text("ok\n");
  if (slug === "sh") return text(clientScript(scriptOrigin(url)));
  // /s is the short alias; typing it is the whole point.
  if (slug === "repl" || slug === "s") {
    const canSearch = Boolean(searchEngine(env)) || searchCapable(resolveModel("", env).model);
    return text(replScript(scriptOrigin(url), defaultModel(env), canSearch));
  }
  const c = palette(wantsColor(request, params));

  if (slug === "models") {
    const current = defaultAlias(env);
    const lines = Object.entries(ALIASES).map(([n, a]) => {
      const id = `${a.provider}:${a.model}`;
      return `${c.cmd(n.padEnd(ALIAS_WIDTH))} ${id}${n === current ? c.note("  (default)") : ""}`;
    });
    return text(lines.join("\n") + "\n");
  }

  const body = await readBody(request);
  const chat = params.get("c") === "1";
  const { question, source } = chat
    ? { question: "", source: "chat" }
    : pickQuestion({ params, request, slug, body });
  // If the question itself came from the body there is no separate context.
  const context = source === "body" ? "" : body;

  // Bare root is the short page, and is also a runnable session script.
  if (!chat && !question) {
    const model = defaultModel(env);
    return text(slug === "help" ? help(url, model, c) : rootScript(url, model, c));
  }
  if (!chat && slug === "help") return text(help(url, defaultModel(env), c));

  // A private deployment can require a shared token. Unset by default.
  if (env.ASK_TOKEN) {
    const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!secretsMatch(given, env.ASK_TOKEN)) {
      return text("ask: this instance is private (send -H \"Authorization: Bearer <token>\")\n", 401);
    }
  }

  const byoKey = request.headers.get("x-ask-key") || "";
  if (!byoKey) {
    const allowed = await underRateLimit(request, env);
    if (!allowed) return text("ask: rate limited, wait a minute (or send your own -H \"X-Ask-Key: ...\")\n", 429);
  }

  // Trim the oldest turns of a long session, or the head of a long paste. In both
  // cases the recent end is what matters; the parser ignores a partial leading turn.
  let notice = "";
  const source_text = chat ? body : context;
  let trimmed = source_text;
  if (source_text.length > MAX_CONTEXT) {
    trimmed = source_text.slice(-MAX_CONTEXT);
    notice = chat
      ? `ask: session trimmed to the last ${MAX_CONTEXT} chars\n\n`
      : `ask: context trimmed to the last ${MAX_CONTEXT} of ${source_text.length} chars\n\n`;
  }

  const messages = chat ? buildChatMessages(trimmed) : buildMessages(question, trimmed);

  // The pending question is the last turn of a session, or the plain question
  // otherwise - never the pasted context, which has its own (much larger) limit.
  const pending = messages[messages.length - 1];
  if (chat && (!pending || pending.role !== "user")) {
    return text(`ask: no question found - a session transcript needs a line starting with "${TURN_MARK}"\n`, 400);
  }
  const asked = chat ? pending.content : question;
  if (asked.length > MAX_QUESTION) {
    return text(`ask: question is ${asked.length} chars, max is ${MAX_QUESTION}\n`, 413);
  }

  // Searching here keeps the search budget separate from the token budget, so it is
  // preferred when a key is configured - and it means the default model answers
  // rather than web=1 having to switch to one that can search for itself.
  const askedForSearch = params.get("web") === "1";
  const engine = searchEngine(env);
  const spec = params.get("m") || (askedForSearch && !engine ? "web" : "");
  const { provider, base, model, effort, search } = resolveModel(spec, env);

  const useSearch = Boolean(search || askedForSearch);
  const nativeSearch = useSearch && searchCapable(model);
  const hereSearch = useSearch && !nativeSearch && Boolean(engine);
  if (useSearch && !nativeSearch && !hereSearch) {
    return text(`ask: ${model} cannot search the web, and no search key is set; use m=web\n`, 400);
  }
  const key = apiKeyFor(provider, env, byoKey);
  const stream = !(params.get("n") === "1" || params.get("s") === "0");
  const showThinking = params.get("think") === "1";
  const maxTokens = clampTokens(params.get("t"));

  // Search on the pending question, then hand the snippets to the model as context.
  // A failed search should degrade to an unsearched answer with a note, not a 502:
  // an answer from memory beats no answer at a terminal.
  let searched = false;
  if (hereSearch && pending) {
    try {
      const results = await webSearch(engine, pending.content, env, request.signal);
      const block = formatResults(pending.content, results, new Date());
      if (block) {
        pending.content = `${pending.content}\n\n${block}`;
        searched = true;
      } else {
        notice += `ask: ${engine} found nothing, answering without it\n\n`;
      }
    } catch (err) {
      notice += `ask: ${err.message}, answering without it\n\n`;
    }
  }

  const result = await ask({
    provider,
    base,
    model,
    effort,
    messages,
    stream,
    maxTokens,
    key,
    signal: request.signal,
    showThinking,
    search: nativeSearch,
    promptMode: nativeSearch ? "tool" : searched ? "results" : null,
    prefix: notice,
  });

  if (result.text) {
    const out = result.text.endsWith("\n") ? result.text : result.text + "\n";
    return text(notice + out);
  }

  return new Response(result.stream, { headers: textHeaders() });
}

// A hand-typed URL can easily carry a stray % ("/50%+cpu+usage"); a decode failure
// should not be a 500, so fall back to the raw path.
function decodeSlug(raw) {
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return raw.trim();
  }
}

// Constant-time compare so a shared token cannot be guessed a byte at a time.
// crypto.subtle.timingSafeEqual is a Workers extension; the loop covers everywhere else.
function secretsMatch(given, expected) {
  const enc = new TextEncoder();
  const a = enc.encode(given);
  const b = enc.encode(expected);
  if (a.length !== b.length) return false;
  if (typeof crypto?.subtle?.timingSafeEqual === "function") return crypto.subtle.timingSafeEqual(a, b);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function pickQuestion({ params, request, slug, body }) {
  const fromQuery = (params.get("q") || "").trim();
  if (fromQuery) return { question: fromQuery, source: "query" };

  const fromHeader = (request.headers.get("x-ask") || "").trim();
  if (fromHeader) return { question: fromHeader, source: "header" };

  // /how+do+i+mount+a+usb+stick  ->  "how do i mount a usb stick"
  if (slug && !RESERVED.has(slug)) {
    // /why+wont+pacstrap+work -> spaces. But if the decoded path already has spaces
    // (it was sent as %20) then a + is a real plus sign, as in "what is c++".
    const question = slug.includes(" ") ? slug : slug.replace(/\+/g, " ");
    return { question: question.trim(), source: "path" };
  }

  return { question: body.trim(), source: "body" };
}

async function readBody(request) {
  if (request.method === "GET" || request.method === "HEAD") return "";
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY) throw new HttpError(413, `body is ${declared} bytes, max is ${MAX_BODY}`);

  const raw = await request.text();
  if (raw.length > MAX_BODY) throw new HttpError(413, `body is ${raw.length} bytes, max is ${MAX_BODY}`);

  // curl -d "q=..." posts a form; treat that like the query parameter.
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/x-www-form-urlencoded") && /^q=/.test(raw)) {
    return new URLSearchParams(raw).get("q") || "";
  }
  return raw;
}

async function underRateLimit(request, env) {
  if (!env.ASK_RATE_LIMIT) return true; // binding not configured (e.g. plain `wrangler dev`)
  const ip = request.headers.get("cf-connecting-ip") || "anonymous";
  const { success } = await env.ASK_RATE_LIMIT.limit({ key: ip });
  return success;
}

function clampTokens(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_TOKENS;
  return Math.min(Math.floor(n), MAX_MAX_TOKENS);
}

function textHeaders() {
  return {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store, no-transform",
    "x-content-type-options": "nosniff",
    ...cors(),
  };
}

function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization, x-ask, x-ask-key",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}

function text(bodyText, status = 200) {
  return new Response(bodyText, { status, headers: textHeaders() });
}
