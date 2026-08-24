import { systemPrompt } from "./prompt.js";

// Every provider here speaks the OpenAI /chat/completions shape, so one adapter
// covers all of them. Anthropic uses /v1/messages and gets its own adapter below.
export const PROVIDERS = {
  groq:   { base: "https://api.groq.com/openai/v1", env: "GROQ_API_KEY" },
  // Gemini through Google's OpenAI-compatible layer, so one adapter covers it.
  // Model ids move fast; list what a key can reach rather than trusting one:
  //   curl -H "Authorization: Bearer $GEMINI_API_KEY" \
  //     https://generativelanguage.googleapis.com/v1beta/openai/models
  google: { base: "https://generativelanguage.googleapis.com/v1beta/openai", env: "GEMINI_API_KEY" },
  // Anything else that speaks the OpenAI shape: ollama, llama.cpp, vLLM, LM Studio,
  // OpenRouter, Cerebras, a private gateway. Base URL comes from ASK_CUSTOM_BASE and
  // the key is optional, so reaching a new provider needs a secret, not a code change.
  custom: { base: null, env: "CUSTOM_API_KEY", keyOptional: true },
};

// Short names people can actually remember at 2am with no browser open.
export const ALIASES = {
  fast:   { provider: "groq",      model: "openai/gpt-oss-20b",  effort: "low" },
  smart:  { provider: "groq",      model: "openai/gpt-oss-120b", effort: "medium" },
  think:  { provider: "groq",      model: "openai/gpt-oss-120b", effort: "high" },
  // qwen3 accepts only none or default here, unlike gpt-oss. Left thinking on, it
  // spends the whole answer budget deliberating and gets truncated mid-thought.
  qwen:   { provider: "groq",      model: "qwen/qwen3.6-27b",     effort: "none" },
  // Groq's built-in browser_search, which only the gpt-oss family accepts - qwen
  // rejects built-in tools outright, so asking for search switches model.
  web:    { provider: "groq",      model: "openai/gpt-oss-120b",  effort: "low", search: true },
  // Groq's agentic model searches natively - no tools parameter, and it must not be
  // sent one. Slower and roughly 1.6x the tokens of web, so it is not the default,
  // but it searches differently and is worth having for a second opinion.
  compound: { provider: "groq",    model: "groq/compound",        search: true },
  // Gemini's free tier is far roomier than Groq's 8k tokens/min, so it carries the
  // ordinary questions. It cannot search: Google Search grounding is not exposed
  // through the OpenAI-compatible layer at all, and the native endpoint answers
  // 429 quota-exceeded for a grounded call on a free key while ungrounded calls
  // succeed. So web=1 still routes to Groq.
  // Measured on the same question: flash took 14s and 429s at 20 requests/min,
  // flash-lite answered in 0.7s with the same answer, and follows the prompt just
  // as well. Speed is the whole point at a shell prompt, so lite is the default.
  flash:  { provider: "google",    model: "gemini-3.6-flash" },
  lite:   { provider: "google",    model: "gemini-3.1-flash-lite" },
};

// "lite" | "groq:openai/gpt-oss-120b" | "gemini-3.6-flash" (bare model, default provider)
export function resolveModel(spec, env) {
  const want = (spec || env.ASK_MODEL || "fast").trim();

  if (ALIASES[want]) return withBase(ALIASES[want], env);

  const sep = want.indexOf(":");
  if (sep > 0) {
    const provider = want.slice(0, sep);
    if (!PROVIDERS[provider]) throw new HttpError(400, `unknown provider "${provider}"`);
    return withBase({ provider, model: want.slice(sep + 1) }, env);
  }

  const provider = env.ASK_PROVIDER || "groq";
  if (!PROVIDERS[provider]) throw new HttpError(500, `ASK_PROVIDER "${provider}" is not a known provider`);
  return withBase({ provider, model: want }, env);
}

function withBase(resolved, env) {
  const base = PROVIDERS[resolved.provider].base || env.ASK_CUSTOM_BASE;
  if (!base) {
    throw new HttpError(501, `provider "${resolved.provider}" needs ASK_CUSTOM_BASE set to an OpenAI-compatible base url`);
  }
  return { ...resolved, base: base.replace(/\/+$/, "") };
}

// What this instance answers with when no m= is given, for the docs and the session
// banner. Never throws: a misconfigured default should not take down the help page.
export function defaultModel(env) {
  try {
    const { provider, model, search } = resolveModel("", env);
    return `${provider} ${model}${search ? " + web search" : ""}`;
  } catch {
    return "not configured";
  }
}

// Which alias name is the configured default, or null when the default is a raw
// model id. Compared by name, not by provider+model: smart and think resolve to
// the same model and differ only in reasoning effort.
export function defaultAlias(env) {
  const want = (env.ASK_MODEL || "fast").trim();
  return ALIASES[want] ? want : null;
}

// Two ways to reach the web on Groq: the gpt-oss family accepts the built-in
// browser_search tool, and compound searches on its own. Everything else 400s on a
// tools parameter, so say so up front rather than forwarding a cryptic upstream error.
export function searchCapable(model) {
  return /gpt-oss/.test(model) || /compound/.test(model);
}

// Only the gpt-oss family takes the tool; compound rejects a tools parameter.
function needsSearchTool(model) {
  return /gpt-oss/.test(model);
}

// Width of the longest alias name, so listings line up without a magic number.
export const ALIAS_WIDTH = Math.max(...Object.keys(ALIASES).map((n) => n.length));

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function apiKeyFor(provider, env, byoKey) {
  if (byoKey) return byoKey;
  const key = env[PROVIDERS[provider].env];
  if (!key && PROVIDERS[provider].keyOptional) return "";
  if (!key) {
    throw new HttpError(
      501,
      `this instance has no key for ${provider}.\n` +
        `the operator sets it with: npx wrangler secret put ${PROVIDERS[provider].env}\n` +
        `or send your own with: -H "X-Ask-Key: <key>"`,
    );
  }
  return key;
}

export async function ask({ provider, base, model, effort, messages, stream, maxTokens, key, signal, showThinking, prefix, search, promptMode }) {
  const body = {
    model,
    messages: [{ role: "system", content: systemPrompt(new Date(), promptMode) }, ...messages],
    max_tokens: maxTokens,
    stream,
  };
  // Only these families accept reasoning_effort; others 400 on it. The valid values
  // differ per family (gpt-oss: low/medium/high, qwen3: none/default), so the alias
  // carries the value and this just decides whether to send it at all.
  if (effort && /gpt-oss|qwen3/.test(model)) body.reasoning_effort = effort;
  if (search && needsSearchTool(model)) body.tools = [{ type: "browser_search" }];

  const headers = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  await throwIfUpstreamError(res, provider);
  const strip = showThinking ? (t) => t : contentFilter();

  if (!stream) {
    const json = await readJson(res, provider);
    const raw = json.choices?.[0]?.message?.content || "";
    const out = showThinking ? raw : stripArtifacts(raw);
    return { text: out.trim() ? out : "(empty response)\n" };
  }

  return {
    stream: sseToText(res.body, prefix, (event) => {
      const delta = event.choices?.[0]?.delta;
      if (!delta) return null;
      if (delta.content) return strip(delta.content);
      if (showThinking && delta.reasoning) return delta.reasoning;
      return null;
    }),
  };
}

// A provider that answers a non-streaming request with SSE (or an HTML error page
// from something in front of it) should read as one clear line, not a parser stack.
async function readJson(res, provider) {
  const raw = await res.text();
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(502, `${provider} returned a non-JSON response: ${raw.slice(0, 200).replace(/\s+/g, " ")}`);
  }
}

async function throwIfUpstreamError(res, provider) {
  if (res.ok) return;
  const raw = await res.text();
  let detail = raw.slice(0, 400);
  try {
    // Google wraps its errors in a single-element array; everyone else uses an object.
    const parsed = JSON.parse(raw);
    const json = Array.isArray(parsed) ? parsed[0] : parsed;
    detail = json?.error?.message || json?.message || detail;
  } catch {
    /* upstream sent something that is not JSON; the raw text is the best we have */
  }
  const status = res.status === 401 || res.status === 403 ? 502 : res.status;
  throw new HttpError(status, `${provider} said ${res.status}: ${detail}`);
}

// Two kinds of artefact have to be kept out of a terminal:
//
//   <think>...</think>  some reasoning models (qwen3, the r1 distills) put their
//                       chain of thought in the content stream rather than in a
//                       separate field, which buries the answer.
//   U+3010...U+3011     browser_search results come back cited as [1..L22-L26] in
//                       CJK brackets, which is noise you cannot click.
//
// Both are "suppress everything between these markers", and either marker can be
// split across SSE chunks, so hold back any tail that could still open one.
const SPANS = [
  { open: "<think>", close: "</think>", trimAfter: true },
  { open: "\u3010", close: "\u3011", trimAfter: false },
];

function partialTail(text, marker) {
  for (let n = Math.min(marker.length - 1, text.length); n > 0; n--) {
    if (marker.startsWith(text.slice(text.length - n))) return n;
  }
  return 0;
}

export function contentFilter() {
  let carry = "";
  let active = null;
  return (text) => {
    let rest = carry + text;
    carry = "";
    let out = "";
    for (;;) {
      if (active) {
        const at = rest.indexOf(active.close);
        if (at === -1) {
          carry = rest.slice(rest.length - partialTail(rest, active.close));
          break;
        }
        rest = rest.slice(at + active.close.length);
        if (active.trimAfter) rest = rest.replace(/^\s+/, "");
        active = null;
        continue;
      }
      let at = -1;
      let found = null;
      for (const span of SPANS) {
        const i = rest.indexOf(span.open);
        if (i !== -1 && (at === -1 || i < at)) {
          at = i;
          found = span;
        }
      }
      if (at === -1) {
        let keep = 0;
        for (const span of SPANS) keep = Math.max(keep, partialTail(rest, span.open));
        out += rest.slice(0, rest.length - keep);
        carry = rest.slice(rest.length - keep);
        break;
      }
      out += rest.slice(0, at);
      rest = rest.slice(at + found.open.length);
      active = found;
    }
    return out;
  };
}

export function stripArtifacts(text) {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").replace(/\u3010[^\u3011]*\u3011/g, "");
}

// Turn a provider's SSE body into a plain-text stream. `pick` pulls the printable
// piece out of each event and returns null for events we do not care about.
// A TransformStream (rather than a hand-rolled ReadableStream) guarantees every
// source chunk is delivered even when it produces no output - a pull-based source
// stalls on events like [DONE] that emit nothing.
function sseToText(body, prefix, pick) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  let emitted = false;
  const emit = (controller, line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      return; // a partial or non-JSON keepalive frame; nothing to print
    }
    const chunk = pick(event);
    if (chunk) {
      emitted = true;
      controller.enqueue(encoder.encode(chunk));
    }
  };

  return body.pipeThrough(
    new TransformStream({
      start(controller) {
        if (prefix) controller.enqueue(encoder.encode(prefix));
      },
      transform(value, controller) {
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) emit(controller, line.trim());
      },
      flush(controller) {
        const tail = buffer.trim();
        if (tail) emit(controller, tail);
        if (!emitted) {
          // Everything the model sent was reasoning, usually because it hit the
          // token cap mid-thought. Silence would look like a broken endpoint.
          controller.enqueue(
            encoder.encode("(no answer - the model used its whole budget reasoning; try t=2000 or m=smart)"),
          );
        }
        // Land the shell prompt on its own line.
        controller.enqueue(encoder.encode("\n"));
      },
    }),
  );
}
