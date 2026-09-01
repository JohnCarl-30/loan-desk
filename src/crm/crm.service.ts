import { Injectable, Logger } from "@nestjs/common";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { toCrmContact } from "../domain/qualify";
import { nowIso } from "../domain/hash";
import { redactPhone } from "../domain/phone";
import type { Lead } from "../domain/types";
import { LeadStore } from "../store/lead-store";

@Injectable()
export class CrmService {
  private readonly log = new Logger(CrmService.name);

  constructor(private readonly store: LeadStore) {}

  async postLead(lead: Lead): Promise<Lead> {
    if (!lead.fullName || !lead.phoneE164 || lead.loanAmountCents === null || !lead.purpose) {
      lead.crmStatus = "skipped";
      lead.updatedAt = nowIso();
      return this.store.update(lead);
    }

    const contact = toCrmContact({
      externalId: lead.externalId,
      fullName: lead.fullName,
      phoneE164: lead.phoneE164,
      loanAmountCents: lead.loanAmountCents,
      purpose: lead.purpose,
      timeline: lead.timeline,
      creditBand: lead.creditBand,
      meeting: lead.meeting,
      promptVersion: lead.promptVersion ?? "unknown",
    });
    const body = JSON.stringify(contact);
    lead.crmRequest = body;
    lead.crmAttempts += 1;
    lead.updatedAt = nowIso();

    const url = process.env.CRM_WEBHOOK_URL?.trim();
    if (!url) {
      this.writeOutbox(body);
      lead.crmStatus = "local_fallback";
      lead.crmResponse = JSON.stringify({ stored: "local_outbox" });
      lead.status = "crm_local";
      this.log.log(`CRM local fallback lead=${lead.id} phone=${redactPhone(lead.phoneE164)}`);
      return this.store.update(lead);
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": `loandesk-crm-${lead.id}`,
        },
        body,
      });
      const text = await res.text();
      lead.crmResponse = text.slice(0, 4000);
      if (!res.ok) {
        lead.crmStatus = "failed";
        lead.status = "crm_failed";
        this.log.warn(`CRM ${res.status} lead=${lead.id}`);
        return this.store.update(lead);
      }
      lead.crmStatus = "posted";
      lead.status = "crm_posted";
      this.log.log(`CRM posted lead=${lead.id}`);
      return this.store.update(lead);
    } catch (err) {
      const message = err instanceof Error ? err.message : "crm_fetch_failed";
      lead.crmStatus = "failed";
      lead.status = "crm_failed";
      lead.crmResponse = message;
      this.log.warn(`CRM network error lead=${lead.id}`);
      return this.store.update(lead);
    }
  }

  private writeOutbox(body: string): void {
    const path = process.env.CRM_OUTBOX_PATH ?? "./data/crm-outbox.jsonl";
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${body}\n`, "utf8");
  }
}
