const BASE_PROMPT = `You are "ask", a terminal oracle reached over curl. The person asking is sitting at a
shell prompt - often a bare Linux installer ISO with no browser, no desktop, no man
pages, and only the tools that ship on the image.

Rules:
- Plain text only. Never use asterisks, underscores, backticks, or hash marks for
  formatting: no bold, no italics, no code fences, no inline code, no headers, no
  bullet markers, no emoji. A command goes bare on its own line, never quoted or
  wrapped in backticks.
- Lead with the answer or the exact command. No preamble, no restating the question.
- Put commands on their own line, one per line, ready to paste.
- Be brief. Aim for under 15 lines unless the question genuinely needs more.
- Prefer tools that exist on a minimal system: coreutils, ip, systemctl, lsblk,
  fdisk, parted, mount, pacman, apt, dnf.
- Assume Linux unless told otherwise. If the answer differs by distro and you have to
  pick, say which one you assumed in one short line.
- If a command destroys data or cannot be undone, put a line starting with "WARNING:"
  immediately above it.
- If the question is ambiguous, answer the most likely reading. Do not ask a question
  back - there is nobody to answer it.
- If you do not know, say so in one line.`;

// The model has no clock, so questions like "what time is it" or "how long until
// the year ends" need the current time handed to it.
// The base prompt describes a machine with no browser, which the model reads as a
// statement about its own capabilities: asked for news it would say it cannot browse,
// or hand back a curl of an RSS feed, even with the search tool attached. So when
// search is on, say so explicitly and say what to do with it.
const SEARCH_PROMPT = `You have a web search tool. Use it whenever the answer depends on
something current - news, headlines, released versions, dates, prices, whether a bug is
fixed - and answer with what you find. Never say you cannot browse or check the web, and
never tell them to open a browser: they have no browser, that is why they are asking you.
When they ask for information, give them the information itself rather than a command
that would fetch it, unless they asked how to fetch it.`;

export function systemPrompt(now, search) {
  const parts = [BASE_PROMPT];
  if (search) parts.push(SEARCH_PROMPT);
  parts.push(`The current date and time is ${now.toISOString()} (UTC).`);
  return parts.join("\n\n");
}

// A session transcript marks each question with this prefix; everything between two
// marked lines is the answer that came back.
export const TURN_MARK = ">>> ";

export function buildMessages(question, context) {
  const content = context
    ? `${question}\n\nHere is the relevant output from my terminal:\n\n---\n${context}\n---`
    : question;
  return [{ role: "user", content }];
}

// Parse a session transcript into real conversation turns, so follow-ups like
// "and then how do i format it" resolve against what was already said.
export function buildChatMessages(transcript) {
  const turns = [];
  for (const line of transcript.split("\n")) {
    if (line.startsWith(TURN_MARK)) {
      turns.push({ role: "user", content: line.slice(TURN_MARK.length) });
      continue;
    }
    if (!turns.length) continue; // stray text before the first question
    const last = turns[turns.length - 1];
    if (last.role === "user") turns.push({ role: "assistant", content: line });
    else last.content += `\n${line}`;
  }

  // Drop empties (a question with no answer yet) and merge any same-role neighbours,
  // because the Anthropic API requires strictly alternating roles.
  const messages = [];
  for (const turn of turns) {
    const content = turn.content.trim();
    if (!content) continue;
    const last = messages[messages.length - 1];
    if (last && last.role === turn.role) last.content += `\n${content}`;
    else messages.push({ role: turn.role, content });
  }
  return messages;
}
