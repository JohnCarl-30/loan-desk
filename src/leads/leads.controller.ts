import { Controller, Get, NotFoundException, Param, Post } from "@nestjs/common";
import { formatUsdFromCents } from "../domain/money";
import { redactPhone } from "../domain/phone";
import type { Lead } from "../domain/types";
import { CrmService } from "../crm/crm.service";
import { LeadStore } from "../store/lead-store";

@Controller("api/leads")
export class LeadsController {
  constructor(
    private readonly store: LeadStore,
    private readonly crm: CrmService,
  ) {}

  @Get()
  list() {
    return this.store.list().map((lead) => serializeLead(lead, false));
  }

  @Get(":id")
  one(@Param("id") id: string) {
    const lead = this.store.findById(id);
    if (!lead) throw new NotFoundException({ error: { code: "NOT_FOUND", message: "lead not found" } });
    return serializeLead(lead, true);
  }

  @Post(":id/crm-retry")
  async retry(@Param("id") id: string) {
    const lead = this.store.findById(id);
    if (!lead) throw new NotFoundException({ error: { code: "NOT_FOUND", message: "lead not found" } });
    const updated = await this.crm.postLead(lead);
    return serializeLead(updated, true);
  }
}

function serializeLead(lead: Lead, detail: boolean) {
  const base = {
    id: lead.id,
    externalId: lead.externalId,
    status: lead.status,
    errorCode: lead.errorCode,
    errorMessage: lead.errorMessage,
    errorField: lead.errorField,
    fullName: lead.fullName,
    phoneRedacted: lead.phoneE164 ? redactPhone(lead.phoneE164) : null,
    phoneE164: detail ? lead.phoneE164 : undefined,
    loanAmountCents: lead.loanAmountCents,
    loanAmountUsd: lead.loanAmountCents === null ? null : formatUsdFromCents(lead.loanAmountCents),
    purpose: lead.purpose,
    timeline: lead.timeline,
    creditBand: lead.creditBand,
    meeting: lead.meeting,
    source: lead.source,
    promptVersion: lead.promptVersion,
    droppedFields: lead.droppedFields,
    crmStatus: lead.crmStatus,
    crmAttempts: lead.crmAttempts,
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt,
  };
  if (!detail) return base;
  return {
    ...base,
    transcript: lead.transcript,
    extractedJson: lead.extractedJson,
    rawPayload: lead.rawPayload,
    crmRequest: lead.crmRequest,
    crmResponse: lead.crmResponse,
  };
}
