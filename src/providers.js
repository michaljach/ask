import { systemPrompt } from "./prompt.js";

// Every provider here speaks the OpenAI /chat/completions shape, so one adapter
// covers all of them. Anthropic uses /v1/messages and gets its own adapter below.
export const PROVIDERS = {
  groq:       { base: "https://api.groq.com/openai/v1", env: "GROQ_API_KEY",       kind: "openai" },
  cerebras:   { base: "https://api.cerebras.ai/v1",     env: "CEREBRAS_API_KEY",   kind: "openai" },
  openrouter: { base: "https://openrouter.ai/api/v1",   env: "OPENROUTER_API_KEY", kind: "openai" },
  together:   { base: "https://api.together.xyz/v1",    env: "TOGETHER_API_KEY",   kind: "openai" },
  deepseek:   { base: "https://api.deepseek.com/v1",    env: "DEEPSEEK_API_KEY",   kind: "openai" },
  mistral:    { base: "https://api.mistral.ai/v1",      env: "MISTRAL_API_KEY",    kind: "openai" },
  openai:     { base: "https://api.openai.com/v1",      env: "OPENAI_API_KEY",     kind: "openai" },
  anthropic:  { base: "https://api.anthropic.com/v1",   env: "ANTHROPIC_API_KEY",  kind: "anthropic" },
  // Anything else that speaks the OpenAI shape: ollama, llama.cpp, vLLM, LM Studio,
  // a private gateway. Base URL comes from ASK_CUSTOM_BASE; the key is optional.
  custom:     { base: null,                             env: "CUSTOM_API_KEY",     kind: "openai", keyOptional: true },
};

// Short names people can actually remember at 2am with no browser open.
export const ALIASES = {
  fast:   { provider: "groq",      model: "openai/gpt-oss-20b",  effort: "low" },
  smart:  { provider: "groq",      model: "openai/gpt-oss-120b", effort: "medium" },
  think:  { provider: "groq",      model: "openai/gpt-oss-120b", effort: "high" },
  claude: { provider: "anthropic", model: "claude-opus-5",       effort: "low" },
};

// "fast" | "groq:openai/gpt-oss-120b" | "claude-opus-5" (bare model, default provider)
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
    const { provider, model } = resolveModel("", env);
    return `${provider} ${model}`;
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

export async function ask(opts) {
  const spec = PROVIDERS[opts.provider];
  return spec.kind === "anthropic" ? askAnthropic(opts) : askOpenAICompat(opts);
}

async function askOpenAICompat({ provider, base, model, effort, messages, stream, maxTokens, key, signal, showThinking, prefix }) {
  const body = {
    model,
    messages: [{ role: "system", content: systemPrompt(new Date()) }, ...messages],
    max_tokens: maxTokens,
    stream,
  };
  // gpt-oss on Groq understands reasoning_effort; other models 400 on it, so only
  // send it when the alias asked for it.
  if (effort && /gpt-oss/.test(model)) body.reasoning_effort = effort;

  const headers = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  await throwIfUpstreamError(res, provider);

  if (!stream) {
    const json = await readJson(res, provider);
    const choice = json.choices?.[0];
    return { text: choice?.message?.content || "(empty response)\n" };
  }

  return {
    stream: sseToText(res.body, prefix, (event) => {
      const delta = event.choices?.[0]?.delta;
      if (!delta) return null;
      if (delta.content) return delta.content;
      if (showThinking && delta.reasoning) return delta.reasoning;
      return null;
    }),
  };
}

async function askAnthropic({ base, model, effort, messages, stream, maxTokens, key, signal, showThinking, prefix }) {
  const body = {
    model,
    system: systemPrompt(new Date()),
    messages,
    max_tokens: maxTokens,
    stream,
    // Thinking is on by default on Opus 5 and the raw chain of thought is never
    // returned, so a short answer just needs a low effort setting. No temperature
    // and no thinking.budget_tokens - both are rejected on this model family.
    output_config: { effort: effort || "low" },
    // Route around safety refusals server-side instead of handing the user a
    // dead end at a terminal with no browser.
    fallbacks: "default",
  };
  if (showThinking) body.thinking = { type: "adaptive", display: "summarized" };

  const res = await fetch(`${base}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "server-side-fallback-2026-07-01",
    },
    body: JSON.stringify(body),
    signal,
  });

  await throwIfUpstreamError(res, "anthropic");

  if (!stream) {
    const json = await readJson(res, "anthropic");
    if (json.stop_reason === "refusal") {
      return { text: `declined to answer that (${json.stop_details?.category || "unspecified"})\n` };
    }
    const text = (json.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    return { text: text || "(empty response)\n" };
  }

  return {
    stream: sseToText(res.body, prefix, (event) => {
      if (event.type === "content_block_delta") {
        if (event.delta?.type === "text_delta") return event.delta.text;
        if (showThinking && event.delta?.type === "thinking_delta") return event.delta.thinking;
      }
      if (event.type === "message_delta" && event.delta?.stop_reason === "refusal") {
        return "\ndeclined to answer that\n";
      }
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
    const json = JSON.parse(raw);
    detail = json.error?.message || json.message || detail;
  } catch {
    /* upstream sent something that is not JSON; the raw text is the best we have */
  }
  const status = res.status === 401 || res.status === 403 ? 502 : res.status;
  throw new HttpError(status, `${provider} said ${res.status}: ${detail}`);
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
    if (chunk) controller.enqueue(encoder.encode(chunk));
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
        // Land the shell prompt on its own line.
        controller.enqueue(encoder.encode("\n"));
      },
    }),
  );
}
