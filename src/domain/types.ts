import type { Cents } from "./money";
import type { ErrorCode } from "./errors";

export type Purpose = "purchase" | "refinance";

export type LeadStatus =
  | "mapping_failed"
  | "needs_review"
  | "qualified"
  | "crm_posted"
  | "crm_failed"
  | "crm_local";

/**
 * `failed` is retried on a backoff; `rejected` is a 4xx the CRM will keep
 * returning, so only a person (the staff UI's retry button) sends it again.
 */
export type CrmStatus = "pending" | "posted" | "failed" | "rejected" | "local_fallback" | "skipped";

export type Meeting = {
  booked: boolean;
  startsAt: string | null;
};

export type Lead = {
  id: string;
  externalId: string;
  idempotencyKey: string;
  payloadHash: string;
  status: LeadStatus;
  errorCode: ErrorCode | null;
  errorMessage: string | null;
  errorField: string | null;
  fullName: string | null;
  phoneE164: string | null;
  loanAmountCents: Cents | null;
  purpose: Purpose | null;
  timeline: string | null;
  creditBand: string | null;
  meeting: Meeting;
  source: string;
  promptVersion: string | null;
  transcript: string | null;
  extractedJson: string | null;
  droppedFields: string[];
  rawPayload: string;
  crmStatus: CrmStatus | null;
  crmRequest: string | null;
  crmResponse: string | null;
  crmAttempts: number;
  createdAt: string;
  updatedAt: string;
};

export type QualifiedLead = {
  externalId: string;
  fullName: string;
  phoneE164: string;
  loanAmountCents: Cents;
  purpose: Purpose;
  timeline: string | null;
  creditBand: string | null;
  meeting: Meeting;
  promptVersion: string;
};

/** Outbound CRM body. n8n (or anything) maps these names. The model does not. */
export type CrmContact = {
  name: string;
  phone: string;
  loanAmountCents: number;
  purpose: Purpose;
  timeline: string | null;
  creditBand: string | null;
  meeting: Meeting;
};

export type ChatTurn = {
  role: "assistant" | "user";
  content: string;
};

export const EMPTY_MEETING: Meeting = { booked: false, startsAt: null };
