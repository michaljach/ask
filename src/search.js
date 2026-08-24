// Search done here rather than by the model. Groq's browser_search is bundled with
// the model, so every search spends the same token budget the answers come from -
// about 4700 of 200000 per day, roughly 42 searches. A search API keeps the two
// budgets separate: Exa's free tier is 20000 requests a month, and the model only
// pays for the snippets it reads. It also means the default model does the
// searching, instead of web=1 having to switch to one that can.
import { HttpError } from "./providers.js";

const RESULTS = 5;
const SNIPPET_CHARS = 700;

const ENGINES = {
  exa: {
    env: "EXA_API_KEY",
    url: "https://api.exa.ai/search",
    headers: (key) => ({ "content-type": "application/json", "x-api-key": key }),
    body: (query) => ({
      query,
      numResults: RESULTS,
      contents: { text: { maxCharacters: SNIPPET_CHARS } },
    }),
    parse: (json) =>
      (json.results || []).map((r) => ({
        title: r.title,
        url: r.url,
        published: r.publishedDate,
        text: r.text,
      })),
  },
  tavily: {
    env: "TAVILY_API_KEY",
    url: "https://api.tavily.com/search",
    headers: (key) => ({ "content-type": "application/json", authorization: `Bearer ${key}` }),
    body: (query) => ({ query, max_results: RESULTS, search_depth: "basic" }),
    parse: (json) =>
      (json.results || []).map((r) => ({
        title: r.title,
        url: r.url,
        published: r.published_date,
        text: (r.content || "").slice(0, SNIPPET_CHARS),
      })),
  },
};

// Which engine this instance can use, if any. Order is the preference order.
export function searchEngine(env) {
  return Object.keys(ENGINES).find((name) => env[ENGINES[name].env]) || null;
}

export async function webSearch(name, query, env, signal) {
  const engine = ENGINES[name];
  const res = await fetch(engine.url, {
    method: "POST",
    headers: engine.headers(env[engine.env]),
    body: JSON.stringify(engine.body(query)),
    signal,
  });

  if (!res.ok) {
    const raw = await res.text();
    let detail = raw.slice(0, 200).replace(/\s+/g, " ");
    try {
      const json = JSON.parse(raw);
      detail = json.error?.message || json.error || json.detail || detail;
    } catch {
      /* not JSON; the raw text is the best we have */
    }
    throw new HttpError(502, `${name} search said ${res.status}: ${detail}`);
  }

  return engine.parse(await res.json());
}

// A block the model can read. Hosts rather than full URLs: nobody can click a link
// in a terminal, but knowing it came from kernel.org rather than a forum matters.
export function formatResults(query, results, now) {
  if (!results.length) return "";
  const lines = results.map((r, i) => {
    let host = r.url || "";
    try {
      host = new URL(r.url).host;
    } catch {
      /* leave it as-is if it will not parse */
    }
    const when = r.published ? ` (${r.published.slice(0, 10)})` : "";
    const text = (r.text || "").trim().replace(/\s+/g, " ");
    return `[${i + 1}] ${r.title || "untitled"} - ${host}${when}\n${text}`;
  });
  return [
    `Web results for "${query}", searched ${now.toISOString().slice(0, 16)}Z:`,
    "",
    lines.join("\n\n"),
  ].join("\n");
}
