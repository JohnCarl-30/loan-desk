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
    return this.store.list().map((lead) => serializeLead(lead, this.crm, this.store, false));
  }

  @Get(":id")
  one(@Param("id") id: string) {
    const lead = this.store.findById(id);
    if (!lead) throw new NotFoundException({ error: { code: "NOT_FOUND", message: "lead not found" } });
    return serializeLead(lead, this.crm, this.store, true);
  }

  @Post(":id/crm-retry")
  async retry(@Param("id") id: string) {
    const lead = this.store.findById(id);
    if (!lead) throw new NotFoundException({ error: { code: "NOT_FOUND", message: "lead not found" } });
    const updated = await this.crm.postLead(lead, "manual");
    return serializeLead(updated, this.crm, this.store, true);
  }
}

function serializeLead(lead: Lead, crm: CrmService, store: LeadStore, detail: boolean) {
  const schedule = crm.retrySchedule(lead);
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
    crmNextRetryAt: schedule.nextRetryAt,
    crmGaveUp: schedule.gaveUp,
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
    crmDeliveries: store.listDeliveries(lead.id),
  };
}
