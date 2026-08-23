// The server cannot see whether the client is a terminal: `curl host` and
// `curl host | sh` send byte-identical requests. So colour is decided by user
// agent - a terminal fetcher gets escapes, a browser (which would render them as
// literal junk) gets plain text - with query overrides in both directions.
const E = "\x1b[";
const CODES = {
  reset: `${E}0m`,
  bold: `${E}1m`,
  dim: `${E}2m`,
  red: `${E}31m`,
  yellow: `${E}33m`,
};

const TERMINAL_AGENTS = /\b(curl|wget|httpie|fetch|powershell)\b/i;

export function wantsColor(request, params) {
  if (params.get("nc") === "1" || params.get("color") === "0") return false;
  if (params.get("color") === "1") return true;
  return TERMINAL_AGENTS.test(request.headers.get("user-agent") || "");
}

// Returns tag functions so call sites read the same whether colour is on or off.
export function palette(on) {
  const wrap = (...names) => (text) =>
    on ? `${names.map((n) => CODES[n]).join("")}${text}${CODES.reset}` : text;
  return {
    banner: wrap("bold", "red"),
    cmd: wrap("bold"),
    note: wrap("dim"),
    head: wrap("bold", "yellow"),
    warn: wrap("red"),
    on,
  };
}
