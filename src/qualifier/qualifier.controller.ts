import { Body, Controller, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { formatUsdFromCents } from "../domain/money";
import type { ChatTurn } from "../domain/types";
import { QualifierService } from "./qualifier.service";

type SimulateBody = {
  messages?: unknown;
  end?: unknown;
};

@Controller("api/calls")
export class QualifierController {
  constructor(private readonly qualifier: QualifierService) {}

  @Post("simulate")
  async simulate(@Body() body: SimulateBody, @Res() res: Response): Promise<void> {
    const messages = parseMessages(body.messages);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    let assembled = "";
    for await (const token of this.qualifier.stream(messages)) {
      assembled += token;
      res.write(`data: ${JSON.stringify({ type: "token", text: token })}\n\n`);
    }

    const withAssistant: ChatTurn[] = [...messages, { role: "assistant", content: assembled }];
    if (body.end === true) {
      const lead = await this.qualifier.persistCall(withAssistant);
      res.write(
        `data: ${JSON.stringify({
          type: "done",
          leadId: lead.id,
          status: lead.status,
          errorCode: lead.errorCode,
          loanAmountCents: lead.loanAmountCents,
          loanAmountUsd: lead.loanAmountCents === null ? null : formatUsdFromCents(lead.loanAmountCents),
          droppedFields: lead.droppedFields,
        })}\n\n`,
      );
    } else {
      res.write(`data: ${JSON.stringify({ type: "turn", text: assembled })}\n\n`);
    }
    res.end();
  }
}

function parseMessages(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatTurn[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const rec = item as { role?: unknown; content?: unknown };
    if ((rec.role === "assistant" || rec.role === "user") && typeof rec.content === "string") {
      out.push({ role: rec.role, content: rec.content });
    }
  }
  return out;
}
