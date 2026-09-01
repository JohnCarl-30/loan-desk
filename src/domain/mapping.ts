import { ERROR_CODES, MappingFailure } from "./errors";
import { parseMoneyToCents, type Cents } from "./money";
import { looksLikePan, parsePhoneToE164 } from "./phone";
import { EMPTY_MEETING, type Meeting, type Purpose } from "./types";

export type MappedInbound = {
  externalId: string;
  fullName: string;
  phoneE164: string;
  loanAmountCents: Cents;
  purpose: Purpose | null;
  timeline: string | null;
  creditBand: string | null;
  meeting: Meeting;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const s = asString(value);
    if (s) return s;
  }
  return null;
}

function customFieldEntries(body: Record<string, unknown>): Array<{ key: string; value: unknown }> {
  const out: Array<{ key: string; value: unknown }> = [];
  const nested = asRecord(body.data);
  const bags = [body.customFields, nested?.customFields];
  for (const bag of bags) {
    if (Array.isArray(bag)) {
      for (const item of bag) {
        const rec = asRecord(item);
        if (!rec) continue;
        const key = firstString(rec.key, rec.name);
        if (!key) continue;
        out.push({ key: normalizeKey(key), value: rec.value });
      }
    }
    const rec = asRecord(bag);
    if (rec) {
      for (const [key, value] of Object.entries(rec)) {
        out.push({ key: normalizeKey(key), value });
      }
    }
  }
  return out;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/\s+/g, "_");
}

function customValue(body: Record<string, unknown>, names: string[]): unknown {
  const want = new Set(names.map(normalizeKey));
  for (const entry of customFieldEntries(body)) {
    if (want.has(entry.key)) return entry.value;
  }
  return undefined;
}

function parsePurpose(value: unknown): Purpose | null | typeof FAIL_PURPOSE {
  const s = asString(value);
  if (!s) return null;
  const n = s.toLowerCase();
  if (n === "purchase" || n === "buy" || n === "buying") return "purchase";
  if (n === "refinance" || n === "refi" || n === "refinancing") return "refinance";
  return FAIL_PURPOSE;
}

const FAIL_PURPOSE = Symbol("unknown_purpose");

export function parseMeeting(value: unknown): Meeting {
  if (value === null || value === undefined) return { ...EMPTY_MEETING };
  if (typeof value === "boolean") return { booked: value, startsAt: null };
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return { ...EMPTY_MEETING };
    return { booked: true, startsAt: trimmed };
  }
  const rec = asRecord(value);
  if (!rec) return { ...EMPTY_MEETING };
  const startsAt = firstString(rec.startsAt, rec.starts_at, rec.at);
  const booked = rec.booked === true || Boolean(startsAt);
  return { booked, startsAt };
}

function refusePan(payload: unknown, path: string): void {
  if (typeof payload === "string" && looksLikePan(payload)) {
    throw new MappingFailure({
      code: ERROR_CODES.PAN_REFUSED,
      message: "value looks like a card number. LoanDesk will not store it.",
      field: path,
    });
  }
  if (Array.isArray(payload)) {
    payload.forEach((item, i) => refusePan(item, `${path}[${i}]`));
    return;
  }
  const rec = asRecord(payload);
  if (!rec) return;
  for (const [key, value] of Object.entries(rec)) {
    refusePan(value, path ? `${path}.${key}` : key);
  }
}

function requireName(body: Record<string, unknown>, contact: Record<string, unknown> | null): string {
  const first = firstString(body.firstName, contact?.firstName);
  const last = firstString(body.lastName, contact?.lastName);
  const combined = first && last ? `${first} ${last}` : null;
  const name = firstString(body.name, body.fullName, contact?.name, combined);
  if (!name) {
    throw new MappingFailure({
      code: ERROR_CODES.MISSING_NAME,
      message: "inbound lead is missing a name",
      field: "name",
    });
  }
  return name;
}

/**
 * Messy inbound: nested customFields, money as a string, extra keys ignored.
 * Throws MappingFailure on bad money, phone, or missing identity. Never invents fields.
 */
export function mapInboundLead(payload: unknown): MappedInbound {
  const body = asRecord(payload);
  if (!body) {
    throw new MappingFailure({
      code: ERROR_CODES.PAYLOAD_MALFORMED,
      message: "webhook body must be a JSON object",
    });
  }
  refusePan(body, "");

  const contact = asRecord(body.contact);
  const externalId = firstString(body.externalId, body.id, contact?.id, contact?.externalId);
  if (!externalId) {
    throw new MappingFailure({
      code: ERROR_CODES.MISSING_EXTERNAL_ID,
      message: "missing externalId or id",
      field: "externalId",
    });
  }

  const fullName = requireName(body, contact);
  const phoneRaw = firstString(body.phone, contact?.phone);
  const phone = parsePhoneToE164(phoneRaw);
  if (!phone.ok) {
    throw new MappingFailure(phone.error);
  }

  const moneyRaw =
    customValue(body, ["loanAmount"]) ?? body.loanAmount ?? contact?.loanAmount;
  const money = parseMoneyToCents(moneyRaw);
  if (!money.ok) {
    throw new MappingFailure({
      code: money.code,
      message: money.message,
      field: "loanAmount",
    });
  }

  const purposeRaw = customValue(body, ["purpose"]) ?? body.purpose ?? contact?.purpose;
  const purpose = parsePurpose(purposeRaw);
  if (purpose === FAIL_PURPOSE) {
    throw new MappingFailure({
      code: ERROR_CODES.UNKNOWN_PURPOSE,
      message: "purpose must be purchase or refinance",
      field: "purpose",
    });
  }

  return {
    externalId,
    fullName,
    phoneE164: phone.e164,
    loanAmountCents: money.cents,
    purpose,
    timeline: firstString(customValue(body, ["timeline"]), body.timeline),
    creditBand: firstString(customValue(body, ["creditBand", "credit"]), body.creditBand),
    meeting: parseMeeting(customValue(body, ["meeting"]) ?? body.meeting),
  };
}

export function idempotencyKeyFrom(headers: Record<string, string | undefined>, payload: unknown): string {
  const header = headers["idempotency-key"] ?? headers["Idempotency-Key"];
  if (header && header.trim().length > 0) return header.trim();
  const body = asRecord(payload);
  const fromBody = firstString(body?.externalId, body?.id);
  if (fromBody) return fromBody;
  throw new MappingFailure({
    code: ERROR_CODES.MISSING_EXTERNAL_ID,
    message: "Idempotency-Key header or externalId is required",
    field: "idempotencyKey",
  });
}
