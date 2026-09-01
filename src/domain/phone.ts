import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { ERROR_CODES, type MappingError } from "./errors";

const DEFAULT_REGIONS: CountryCode[] = ["US", "CA"];

export type PhoneOk = { ok: true; e164: string };
export type PhoneErr = { ok: false; error: MappingError };
export type PhoneResult = PhoneOk | PhoneErr;

export function parsePhoneToE164(input: unknown): PhoneResult {
  if (input === null || input === undefined) {
    return {
      ok: false,
      error: { code: ERROR_CODES.PHONE_INVALID, message: "phone is missing", field: "phone" },
    };
  }
  if (typeof input !== "string" && typeof input !== "number") {
    return {
      ok: false,
      error: { code: ERROR_CODES.PHONE_INVALID, message: "phone must be a string", field: "phone" },
    };
  }
  const raw = String(input).trim();
  if (raw.length === 0) {
    return {
      ok: false,
      error: { code: ERROR_CODES.PHONE_INVALID, message: "phone is empty", field: "phone" },
    };
  }

  if (raw.startsWith("+")) {
    const parsed = parsePhoneNumberFromString(raw);
    if (!parsed || !parsed.isValid()) {
      return {
        ok: false,
        error: {
          code: ERROR_CODES.PHONE_INVALID,
          message: "phone is not valid E.164",
          field: "phone",
        },
      };
    }
    const iso = parsed.country;
    if (iso !== "US" && iso !== "CA") {
      return {
        ok: false,
        error: {
          code: ERROR_CODES.PHONE_INVALID,
          message: "phone must be US or Canada",
          field: "phone",
        },
      };
    }
    return { ok: true, e164: parsed.number };
  }

  for (const region of DEFAULT_REGIONS) {
    const parsed = parsePhoneNumberFromString(raw, region);
    if (parsed?.isValid() && (parsed.country === "US" || parsed.country === "CA")) {
      return { ok: true, e164: parsed.number };
    }
  }

  return {
    ok: false,
    error: {
      code: ERROR_CODES.PHONE_INVALID,
      message: "phone could not be parsed as US/Canada E.164",
      field: "phone",
    },
  };
}

/** Logs and UI get this. Full E.164 stays in the database. */
export function redactPhone(e164: string): string {
  if (e164.length < 6) return "***";
  return `${e164.slice(0, 3)}***${e164.slice(-4)}`;
}

export function looksLikePan(value: string): boolean {
  if (/^\d{4}-\d{2}-\d{2}/.test(value.trim())) return false;
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  return luhnOk(digits);
}

function luhnOk(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const ch = digits[i];
    if (ch === undefined) return false;
    let n = Number(ch);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}
