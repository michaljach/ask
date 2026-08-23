// A fake provider for testing the harness without a model or an API key.
//   node dev/stub.mjs           (listens on 127.0.0.1:9099)
// Point the worker at it with .dev.vars:
//   ASK_CUSTOM_BASE=http://127.0.0.1:9099/v1
//   ASK_PROVIDER=custom
//   ASK_MODEL=stub
// It answers by describing exactly what the worker asked for, so you can see
// whether history, piped context, trimming, and options arrived intact.
import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 9099);
const CONTEXT_MARK = "Here is the relevant output from my terminal:";
let n = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "stub: body was not JSON" } }));
    return;
  }

  // Anthropic puts the system prompt in its own field; everyone else in messages[0].
  const turns = (body.messages || []).filter((m) => m.role !== "system");
  const system = body.system || body.messages?.find((m) => m.role === "system")?.content || "";
  const last = turns[turns.length - 1]?.content || "";
  const [question, ...contextParts] = last.split(CONTEXT_MARK);
  const context = contextParts.join(CONTEXT_MARK);

  const lines = [
    `stub reply #${++n}`,
    `model        ${body.model}`,
    `streaming    ${!!body.stream}`,
    `max_tokens   ${body.max_tokens}`,
    body.reasoning_effort ? `effort       ${body.reasoning_effort}` : null,
    body.output_config ? `output_cfg   ${JSON.stringify(body.output_config)}` : null,
    `turns        ${turns.length} (${turns.map((t) => t.role[0]).join("")})`,
    `question     ${JSON.stringify(question.trim().slice(0, 120))}`,
    context ? `context      ${context.trim().length} chars, ends ${JSON.stringify(context.trim().slice(-40))}` : null,
    `clock in sys ${/current date and time is (\S+)/.exec(system)?.[1] || "MISSING"}`,
  ].filter(Boolean);

  console.log(`--- request ${n}: ${turns.length} turns, model=${body.model}, stream=${!!body.stream}`);

  if (!body.stream) {
    const text = lines.join("\n");
    const payload = body.system !== undefined
      ? { content: [{ type: "text", text }], stop_reason: "end_turn" }
      : { choices: [{ message: { content: text } }] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const frame = (text) =>
    body.system !== undefined
      ? { type: "content_block_delta", delta: { type: "text_delta", text } }
      : { choices: [{ delta: { content: text } }] };

  // Emit a chunk at a time so streaming is visibly incremental.
  for (const line of lines) {
    res.write(`data: ${JSON.stringify(frame(line + "\n"))}\n\n`);
    await sleep(90);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}).listen(PORT, "127.0.0.1", () => console.log(`stub provider on http://127.0.0.1:${PORT}`));
