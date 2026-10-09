import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { toCrmContact } from "../domain/qualify";
import { nowIso } from "../domain/hash";
import { redactPhone } from "../domain/phone";
import { signPayload } from "../domain/signature";
import type { Lead } from "../domain/types";
import { LeadStore } from "../store/lead-store";

/** Total POSTs per lead, first attempt included, before it is left for a person. */
export const CRM_MAX_ATTEMPTS = 5;

/**
 * 408 and 429 mean "later", 5xx means "not you". Any other 4xx is the CRM
 * refusing this body, and sending the same body again cannot change that.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Wait before attempt n+1, after n failed attempts: base, 2x, 4x, 8x. */
export function retryDelayMs(attempts: number, baseMs: number): number {
  return baseMs * 2 ** Math.max(0, attempts - 1);
}

/**
 * Same scheme as inbound, so n8n (or any receiver) can check the POST came from
 * LoanDesk. Signed per attempt: a retry minutes later carries a fresh timestamp
 * and still lands inside the receiver's replay window.
 */
function signingHeaders(body: string): Record<string, string> {
  const secret = process.env.CRM_SIGNING_SECRET?.trim();
  if (!secret) return {};
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    "X-LoanDesk-Timestamp": timestamp,
    "X-LoanDesk-Signature": signPayload(secret, timestamp, body),
  };
}

@Injectable()
export class CrmService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(CrmService.name);
  private readonly inFlight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly store: LeadStore) {}

  onModuleInit(): void {
    const every = Number(process.env.CRM_RETRY_INTERVAL_MS ?? 15_000);
    if (!(every > 0)) return;
    this.timer = setInterval(() => {
      void this.retryDue().catch((err: unknown) => {
        this.log.error(`CRM retry sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, every);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Re-posts every `failed` lead whose backoff has elapsed. Safe to repeat:
   * each POST carries the same Idempotency-Key, so a CRM that did receive an
   * earlier attempt (and only the response was lost) will not create a second
   * contact.
   */
  async retryDue(nowMs: number = Date.now()): Promise<Lead[]> {
    const retried: Lead[] = [];
    for (const lead of this.store.listByCrmStatus("failed")) {
      const dueAt = this.nextRetryAtMs(lead);
      if (dueAt === null || dueAt > nowMs) continue;
      retried.push(await this.postLead(lead));
    }
    return retried;
  }

  /** What the staff UI shows: when the sweep will post next, or that it stopped. */
  retrySchedule(lead: Lead): { nextRetryAt: string | null; gaveUp: boolean } {
    const dueAt = this.nextRetryAtMs(lead);
    return {
      nextRetryAt: dueAt === null ? null : new Date(dueAt).toISOString(),
      gaveUp: lead.crmStatus === "failed" && lead.crmAttempts >= CRM_MAX_ATTEMPTS,
    };
  }

  /** Null when the sweep will not touch this lead again. */
  private nextRetryAtMs(lead: Lead): number | null {
    if (lead.crmStatus !== "failed" || lead.crmAttempts >= CRM_MAX_ATTEMPTS) return null;
    const baseMs = Number(process.env.CRM_RETRY_BASE_MS ?? 30_000);
    return Date.parse(lead.updatedAt) + retryDelayMs(lead.crmAttempts, baseMs);
  }

  async postLead(lead: Lead): Promise<Lead> {
    // The sweep and the staff retry button can reach the same lead at once.
    if (this.inFlight.has(lead.id)) return this.store.findById(lead.id) ?? lead;
    this.inFlight.add(lead.id);
    try {
      return await this.send(lead);
    } finally {
      this.inFlight.delete(lead.id);
    }
  }

  private async send(lead: Lead): Promise<Lead> {
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
          ...signingHeaders(body),
        },
        body,
      });
      const text = await res.text();
      lead.crmResponse = text.slice(0, 4000);
      if (!res.ok) {
        const retryable = isRetryableStatus(res.status);
        lead.crmStatus = retryable ? "failed" : "rejected";
        lead.status = "crm_failed";
        const next = !retryable
          ? "not retrying"
          : lead.crmAttempts >= CRM_MAX_ATTEMPTS
            ? "giving up"
            : "will retry";
        this.log.warn(`CRM ${res.status} lead=${lead.id} attempt=${lead.crmAttempts} ${next}`);
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
      this.log.warn(`CRM network error lead=${lead.id} attempt=${lead.crmAttempts}`);
      return this.store.update(lead);
    }
  }

  private writeOutbox(body: string): void {
    const path = process.env.CRM_OUTBOX_PATH ?? "./data/crm-outbox.jsonl";
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${body}\n`, "utf8");
  }
}
