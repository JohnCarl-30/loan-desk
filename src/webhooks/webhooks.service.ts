import { Injectable } from "@nestjs/common";
import { ERROR_CODES, MappingFailure } from "../domain/errors";
import { newId, nowIso, sha256, stableStringify } from "../domain/hash";
import { idempotencyKeyFrom, mapInboundLead } from "../domain/mapping";
import { qualifyLead } from "../domain/qualify";
import { PROMPT_VERSION_DEFAULT } from "../domain/prompt";
import type { Lead } from "../domain/types";
import { CrmService } from "../crm/crm.service";
import { LeadStore } from "../store/lead-store";

type HeaderMap = Record<string, string | undefined>;

@Injectable()
export class WebhooksService {
  constructor(
    private readonly store: LeadStore,
    private readonly crm: CrmService,
  ) {}

  async ingestLead(payload: unknown, headers: HeaderMap): Promise<{ statusCode: number; body: unknown }> {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new MappingFailure({
        code: ERROR_CODES.PAYLOAD_MALFORMED,
        message: "webhook body must be a JSON object",
      });
    }

    const key = idempotencyKeyFrom(headers, payload);
    const payloadHash = sha256(stableStringify(payload));
    const existing = this.store.findByIdempotencyKey(key);
    if (existing) {
      if (existing.payloadHash === payloadHash) {
        if (existing.status === "mapping_failed" && existing.errorCode) {
          throw new MappingFailure(
            {
              code: existing.errorCode,
              message: existing.errorMessage ?? "mapping failed",
              field: existing.errorField ?? undefined,
            },
            400,
          );
        }
        return { statusCode: 200, body: this.publicLead(existing) };
      }
      throw new MappingFailure(
        {
          code: ERROR_CODES.IDEMPOTENCY_CONFLICT,
          message: "Idempotency-Key was reused with a different payload",
          field: "idempotencyKey",
        },
        409,
      );
    }

    try {
      const mapped = mapInboundLead(payload);
      const stamp = nowIso();
      let lead: Lead = {
        id: newId(),
        externalId: mapped.externalId,
        idempotencyKey: key,
        payloadHash,
        status: mapped.purpose ? "qualified" : "needs_review",
        errorCode: null,
        errorMessage: null,
        errorField: null,
        fullName: mapped.fullName,
        phoneE164: mapped.phoneE164,
        loanAmountCents: mapped.loanAmountCents,
        purpose: mapped.purpose,
        timeline: mapped.timeline,
        creditBand: mapped.creditBand,
        meeting: mapped.meeting,
        source: "webhook:lead",
        promptVersion: process.env.PROMPT_VERSION ?? PROMPT_VERSION_DEFAULT,
        transcript: null,
        extractedJson: null,
        droppedFields: [],
        rawPayload: JSON.stringify(payload),
        crmStatus: "pending",
        crmRequest: null,
        crmResponse: null,
        crmAttempts: 0,
        createdAt: stamp,
        updatedAt: stamp,
      };
      lead = this.store.insert(lead);
      if (lead.status === "qualified") {
        lead = await this.crm.postLead(lead);
      }
      return { statusCode: 200, body: this.publicLead(lead) };
    } catch (err) {
      if (err instanceof MappingFailure) {
        const stamp = nowIso();
        const failed: Lead = {
          id: newId(),
          externalId: key,
          idempotencyKey: key,
          payloadHash,
          status: "mapping_failed",
          errorCode: err.code,
          errorMessage: err.message,
          errorField: err.field ?? null,
          fullName: null,
          phoneE164: null,
          loanAmountCents: null,
          purpose: null,
          timeline: null,
          creditBand: null,
          meeting: { booked: false, startsAt: null },
          source: "webhook:lead",
          promptVersion: process.env.PROMPT_VERSION ?? PROMPT_VERSION_DEFAULT,
          transcript: null,
          extractedJson: null,
          droppedFields: [],
          rawPayload: JSON.stringify(payload),
          crmStatus: "skipped",
          crmRequest: null,
          crmResponse: null,
          crmAttempts: 0,
          createdAt: stamp,
          updatedAt: stamp,
        };
        this.store.insert(failed);
        throw err;
      }
      throw err;
    }
  }

  async ingestVoice(payload: unknown, headers: HeaderMap): Promise<{ statusCode: number; body: unknown }> {
    const unwrapped = unwrapVoice(payload);
    if (unwrapped.ignored) {
      return { statusCode: 200, body: { ok: true, ignored: true } };
    }

    const key = headers["idempotency-key"] ?? headers["Idempotency-Key"] ?? unwrapped.externalId;
    const payloadHash = sha256(stableStringify(payload));
    const existing = this.store.findByIdempotencyKey(key);
    if (existing && existing.payloadHash === payloadHash) {
      return { statusCode: 200, body: this.publicLead(existing) };
    }
    if (existing && existing.payloadHash !== payloadHash) {
      throw new MappingFailure(
        {
          code: ERROR_CODES.IDEMPOTENCY_CONFLICT,
          message: "Idempotency-Key was reused with a different payload",
          field: "idempotencyKey",
        },
        409,
      );
    }

    const qualified = qualifyLead(unwrapped.extracted, {
      externalId: unwrapped.externalId,
      promptVersion: process.env.PROMPT_VERSION ?? PROMPT_VERSION_DEFAULT,
      fallbackPhone: unwrapped.fallbackPhone,
    });

    const stamp = nowIso();
    let lead: Lead = {
      id: newId(),
      externalId: unwrapped.externalId,
      idempotencyKey: key,
      payloadHash,
      status: "needs_review",
      errorCode: null,
      errorMessage: null,
      errorField: null,
      fullName: null,
      phoneE164: unwrapped.fallbackPhone ?? null,
      loanAmountCents: null,
      purpose: null,
      timeline: null,
      creditBand: null,
      meeting: { booked: false, startsAt: null },
      source: "webhook:voice",
      promptVersion: process.env.PROMPT_VERSION ?? PROMPT_VERSION_DEFAULT,
      transcript: unwrapped.transcript,
      extractedJson: JSON.stringify(unwrapped.extracted),
      droppedFields: qualified.droppedFields,
      rawPayload: JSON.stringify(payload),
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
      lead.meeting = qualified.lead.meeting;
    } else {
      lead.fullName = qualified.fullName;
      lead.phoneE164 = qualified.phoneE164 ?? lead.phoneE164;
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
        this.store.insert(lead);
        throw new MappingFailure({
          code: lead.errorCode ?? ERROR_CODES.FIELD_MAPPING_FAILED,
          message: lead.errorMessage ?? "voice extraction failed",
          field: lead.errorField ?? undefined,
        });
      }
    }

    lead = this.store.insert(lead);
    if (lead.status === "qualified") {
      lead = await this.crm.postLead(lead);
    }
    return { statusCode: 200, body: this.publicLead(lead) };
  }

  private publicLead(lead: Lead) {
    return {
      id: lead.id,
      externalId: lead.externalId,
      status: lead.status,
      errorCode: lead.errorCode,
      loanAmountCents: lead.loanAmountCents,
      crmStatus: lead.crmStatus,
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function unwrapVoice(payload: unknown): {
  ignored: boolean;
  externalId: string;
  transcript: string | null;
  extracted: unknown;
  fallbackPhone?: string;
} {
  const body = asRecord(payload);
  if (!body) {
    throw new MappingFailure({
      code: ERROR_CODES.PAYLOAD_MALFORMED,
      message: "voice webhook body must be a JSON object",
    });
  }

  const message = asRecord(body.message);
  const event = asString(body.event) ?? asString(message?.type);

  if (event && event !== "end-of-call-report" && event !== "call_ended" && event !== "transcript") {
    return { ignored: true, externalId: "", transcript: null, extracted: {} };
  }

  const call = asRecord(message?.call) ?? asRecord(body.call);
  const customer = asRecord(call?.customer);
  const artifact = asRecord(message?.artifact);
  const analysis = asRecord(message?.analysis);

  const externalId =
    asString(call?.id) ??
    asString(call?.call_id) ??
    asString(body.call_id) ??
    asString(body.externalId);
  if (!externalId) {
    throw new MappingFailure({
      code: ERROR_CODES.MISSING_EXTERNAL_ID,
      message: "voice payload missing call id",
      field: "externalId",
    });
  }

  const transcript =
    asString(artifact?.transcript) ??
    asString(call?.transcript) ??
    asString(body.transcript);

  const extracted =
    analysis?.structuredData ??
    body.extracted ??
    call?.collected_dynamic_variables ??
    {};

  const fallbackPhone =
    asString(customer?.number) ?? asString(call?.from_number) ?? undefined;

  return { ignored: false, externalId, transcript, extracted, fallbackPhone };
}
