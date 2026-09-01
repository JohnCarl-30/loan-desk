import type { ChatTurn } from "../domain/types";
import { qualifierSystemPrompt } from "../domain/prompt";

export async function* streamAssistantReply(
  messages: ChatTurn[],
  promptVersion: string,
): AsyncGenerator<string> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    const text = fixtureReply(messages);
    yield* chunk(text);
    return;
  }

  const model = process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [
        { role: "system", content: qualifierSystemPrompt(promptVersion) },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    }),
  });
  if (!res.ok || !res.body) {
    const text = fixtureReply(messages);
    yield* chunk(text);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const json: unknown = JSON.parse(data);
        const token = tokenFromChunk(json);
        if (token) yield token;
      } catch {
        continue;
      }
    }
  }
}

function tokenFromChunk(json: unknown): string | null {
  if (json === null || typeof json !== "object") return null;
  const choices = (json as { choices?: Array<{ delta?: { content?: unknown } }> }).choices;
  const content = choices?.[0]?.delta?.content;
  return typeof content === "string" ? content : null;
}

function chunk(text: string): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += 12) {
    parts.push(text.slice(i, i + 12));
  }
  return parts;
}

export function fixtureReply(messages: ChatTurn[]): string {
  const extracted = heuristicFromUser(messages);
  if (!extracted.fullName) {
    return "This is Jordan at the lending desk. Who am I speaking with?";
  }
  if (!extracted.phone) {
    return `Got it, ${extracted.fullName}. What's the best callback number?`;
  }
  if (!extracted.loanAmount) {
    return "What loan amount are you looking at? Give me the number you have in mind, not a range.";
  }
  if (!extracted.purpose) {
    return "Is this a purchase or a refinance?";
  }
  if (!extracted.timeline) {
    return "When do you need this to close?";
  }
  if (!extracted.credit) {
    return "How would you describe your credit. Excellent, good, fair, or poor is enough.";
  }
  return `I'm repeating this back before I put you on the calendar. ${extracted.fullName}, ${extracted.phone}, ${extracted.loanAmount}, ${extracted.purpose}. I'll have a specialist grab a meeting. Anything else before I do that?`;
}

export function fixtureExtract(messages: ChatTurn[]): Record<string, unknown> {
  const h = heuristicFromUser(messages);
  return {
    fullName: h.fullName,
    phone: h.phone,
    loanAmount: h.loanAmount,
    purpose: h.purpose,
    timeline: h.timeline,
    creditBand: h.credit,
    meeting: h.credit ? { booked: true, startsAt: null } : null,
    approved: true,
    creditScore: 812,
    ssn: "invented",
  };
}

function heuristicFromUser(messages: ChatTurn[]): {
  fullName: string | null;
  phone: string | null;
  loanAmount: string | null;
  purpose: string | null;
  timeline: string | null;
  credit: string | null;
} {
  const blob = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");

  const phoneMatch = blob.match(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  const amountMatch = blob.match(/\$?\d[\d,]*(?:\.\d{1,2})?\s*[kK]?|\d+\s*[kK]\b/);
  const purpose = /\brefi|\brefinance/i.test(blob)
    ? "refinance"
    : /\bpurchase|\bbuy/i.test(blob)
      ? "purchase"
      : null;
  const creditMatch = blob.match(/\b(excellent|good|fair|poor)\b/i);
  const timelineMatch = blob.match(/\b(\d+\s+(days?|weeks?|months?)|asap|immediately)\b/i);
  const nameMatch = blob.match(/\b(?:I am|I'm|this is|name is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i)
    ?? blob.match(/^([A-Z][a-z]+\s+[A-Z][a-z]+)\b/m);

  return {
    fullName: nameMatch?.[1] ?? null,
    phone: phoneMatch?.[0] ?? null,
    loanAmount: amountMatch?.[0] ?? null,
    purpose,
    timeline: timelineMatch?.[0] ?? null,
    credit: creditMatch?.[1]?.toLowerCase() ?? null,
  };
}
