import { Injectable } from "@nestjs/common";
import { CrmService } from "../crm/crm.service";
import { newId, nowIso, sha256, stableStringify } from "../domain/hash";
import { qualifyLead } from "../domain/qualify";
import { PROMPT_VERSION_DEFAULT } from "../domain/prompt";
import type { ChatTurn, Lead } from "../domain/types";
import { LeadStore } from "../store/lead-store";
import { fixtureExtract, streamAssistantReply } from "./llm";

@Injectable()
export class QualifierService {
  constructor(
    private readonly store: LeadStore,
    private readonly crm: CrmService,
  ) {}

  promptVersion(): string {
    return process.env.PROMPT_VERSION ?? PROMPT_VERSION_DEFAULT;
  }

  stream(messages: ChatTurn[]): AsyncGenerator<string> {
    return streamAssistantReply(messages, this.promptVersion());
  }

  async persistCall(messages: ChatTurn[]): Promise<Lead> {
    const extracted = fixtureExtract(messages);
    const transcript = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
    const externalId = `sim-${newId()}`;
    const qualified = qualifyLead(extracted, {
      externalId,
      promptVersion: this.promptVersion(),
    });

    const stamp = nowIso();
    let lead: Lead = {
      id: newId(),
      externalId,
      idempotencyKey: externalId,
      payloadHash: sha256(stableStringify({ messages })),
      status: "needs_review",
      errorCode: null,
      errorMessage: null,
      errorField: null,
      fullName: null,
      phoneE164: null,
      loanAmountCents: null,
      purpose: null,
      timeline: null,
      creditBand: null,
      meeting: { booked: false, startsAt: null },
      source: "simulate-call",
      promptVersion: this.promptVersion(),
      transcript,
      extractedJson: JSON.stringify(extracted),
      droppedFields: qualified.droppedFields,
      rawPayload: JSON.stringify({ messages, extracted }),
      crmStatus: "pending",
      crmRequest: null,
      crmResponse: null,
      crmAttempts: 0,
      createdAt: stamp,
      updatedAt: stamp,
    };

    if (qualified.ok) {
      lead.status = "qualified";
      lead.fullName = qualified.lead.fullName;
      lead.phoneE164 = qualified.lead.phoneE164;
      lead.loanAmountCents = qualified.lead.loanAmountCents;
      lead.purpose = qualified.lead.purpose;
      lead.timeline = qualified.lead.timeline;
      lead.creditBand = qualified.lead.creditBand;
      lead.meeting = { booked: true, startsAt: qualified.lead.meeting.startsAt };
    } else {
      lead.fullName = qualified.fullName;
      lead.phoneE164 = qualified.phoneE164;
      lead.loanAmountCents = qualified.loanAmountCents;
      lead.purpose = qualified.purpose;
      lead.timeline = qualified.timeline;
      lead.creditBand = qualified.creditBand;
      lead.meeting = qualified.meeting;
      if (qualified.error) {
        lead.status = "mapping_failed";
        lead.errorCode = qualified.error.code as Lead["errorCode"];
        lead.errorMessage = qualified.error.message;
        lead.errorField = qualified.error.field ?? null;
        lead.crmStatus = "skipped";
      }
    }

    lead = this.store.insert(lead);
    if (lead.status === "qualified") {
      lead = await this.crm.postLead(lead);
    }
    return lead;
  }
}
