import { ERROR_CODES, MappingFailure } from "./errors";
import { parseMoneyToCents, type Cents } from "./money";
import { looksLikePan, parsePhoneToE164 } from "./phone";
import { parseMeeting } from "./mapping";
import { EXTRACTION_KEYS } from "./prompt";
import type { CrmContact, Meeting, Purpose, QualifiedLead } from "./types";

export type Extraction = {
  fullName: string | null;
  phone: string | null;
  loanAmount: unknown;
  purpose: string | null;
  timeline: string | null;
  creditBand: string | null;
  meeting: unknown;
};

export type SanitizeResult = {
  extraction: Extraction;
  droppedFields: string[];
};

const ALIASES: Record<string, keyof Extraction> = {
  fullname: "fullName",
  name: "fullName",
  phone: "phone",
  loanamount: "loanAmount",
  purpose: "purpose",
  timeline: "timeline",
  credit: "creditBand",
  creditband: "creditBand",
  meeting: "meeting",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function targetKey(key: string): keyof Extraction | null {
  const alias = ALIASES[key.toLowerCase()];
  if (alias) return alias;
  if ((EXTRACTION_KEYS as readonly string[]).includes(key)) return key as keyof Extraction;
  return null;
}

/**
 * The model output is unknown. Keep the extraction keys we own. Drop the rest.
 * The model cannot name CRM columns. toCrmContact is the only writer of those names.
 */
export function sanitizeExtraction(raw: unknown): SanitizeResult {
  const rec = asRecord(raw);
  if (!rec) {
    throw new MappingFailure({
      code: ERROR_CODES.EXTRACTION_INVALID,
      message: "model output is not a JSON object",
    });
  }

  const droppedFields: string[] = [];
  const extraction: Extraction = {
    fullName: null,
    phone: null,
    loanAmount: null,
    purpose: null,
    timeline: null,
    creditBand: null,
    meeting: null,
  };

  for (const [key, value] of Object.entries(rec)) {
    if (typeof value === "string" && looksLikePan(value)) {
      throw new MappingFailure({
        code: ERROR_CODES.PAN_REFUSED,
        message: "extraction contained a value that looks like a card number",
        field: key,
      });
    }
    const target = targetKey(key);
    if (!target) {
      droppedFields.push(key);
      continue;
    }
    if (target === "loanAmount" || target === "meeting") {
      extraction[target] = value;
    } else {
      extraction[target] = asString(value);
    }
  }

  return { extraction, droppedFields };
}

function parsePurpose(value: string | null): Purpose | null {
  if (!value) return null;
  const n = value.toLowerCase();
  if (n === "purchase" || n === "buy" || n === "buying") return "purchase";
  if (n === "refinance" || n === "refi" || n === "refinancing") return "refinance";
  return null;
}

export type QualifyOk = {
  ok: true;
  lead: QualifiedLead;
  droppedFields: string[];
};
export type QualifyPartial = {
  ok: false;
  droppedFields: string[];
  fullName: string | null;
  phoneE164: string | null;
  loanAmountCents: Cents | null;
  purpose: Purpose | null;
  timeline: string | null;
  creditBand: string | null;
  meeting: Meeting;
  error?: { code: string; message: string; field?: string };
};
export type QualifyResult = QualifyOk | QualifyPartial;

function partial(
  droppedFields: string[],
  extraction: Extraction,
  phoneE164: string | null,
  loanAmountCents: Cents | null,
  purpose: Purpose | null,
  error?: QualifyPartial["error"],
): QualifyPartial {
  return {
    ok: false,
    droppedFields,
    fullName: extraction.fullName,
    phoneE164,
    loanAmountCents,
    purpose,
    timeline: extraction.timeline,
    creditBand: extraction.creditBand,
    meeting: parseMeeting(extraction.meeting),
    error,
  };
}

export function qualifyLead(
  raw: unknown,
  ctx: { externalId: string; promptVersion: string; fallbackPhone?: string },
): QualifyResult {
  const { extraction, droppedFields } = sanitizeExtraction(raw);
  const phoneRaw = extraction.phone ?? ctx.fallbackPhone ?? null;
  const phone = phoneRaw ? parsePhoneToE164(phoneRaw) : null;
  const money =
    extraction.loanAmount === null || extraction.loanAmount === undefined
      ? null
      : parseMoneyToCents(extraction.loanAmount);
  const purpose = parsePurpose(extraction.purpose);
  const meeting = parseMeeting(extraction.meeting);

  if (money && !money.ok) {
    return partial(droppedFields, extraction, phone && phone.ok ? phone.e164 : null, null, purpose, {
      code: money.code,
      message: money.message,
      field: "loanAmount",
    });
  }
  if (phone && !phone.ok) {
    return partial(
      droppedFields,
      extraction,
      null,
      money && money.ok ? money.cents : null,
      purpose,
      { code: phone.error.code, message: phone.error.message, field: "phone" },
    );
  }

  if (!extraction.fullName || !phone?.ok || !money?.ok || !purpose) {
    return partial(
      droppedFields,
      extraction,
      phone && phone.ok ? phone.e164 : null,
      money && money.ok ? money.cents : null,
      purpose,
    );
  }

  return {
    ok: true,
    droppedFields,
    lead: {
      externalId: ctx.externalId,
      fullName: extraction.fullName,
      phoneE164: phone.e164,
      loanAmountCents: money.cents,
      purpose,
      timeline: extraction.timeline,
      creditBand: extraction.creditBand,
      meeting,
      promptVersion: ctx.promptVersion,
    },
  };
}

export function toCrmContact(lead: QualifiedLead): CrmContact {
  return {
    name: lead.fullName,
    phone: lead.phoneE164,
    loanAmountCents: lead.loanAmountCents,
    purpose: lead.purpose,
    timeline: lead.timeline,
    creditBand: lead.creditBand,
    meeting: lead.meeting,
  };
}
