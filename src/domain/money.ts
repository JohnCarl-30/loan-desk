declare const centsBrand: unique symbol;

/** Integer USD cents. Never a float. $450,000 is 45_000_000. */
export type Cents = number & { readonly [centsBrand]: typeof centsBrand };

export type MoneyOk = { ok: true; cents: Cents };
export type MoneyErr = {
  ok: false;
  code: "MONEY_EMPTY" | "MONEY_INVALID" | "MONEY_AMBIGUOUS";
  message: string;
};
export type MoneyResult = MoneyOk | MoneyErr;

const MAX_DOLLARS = 50_000_000n;
const MIN_DOLLARS = 1_000n;

function asCents(value: bigint): Cents {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("cents exceed MAX_SAFE_INTEGER");
  }
  return Number(value) as Cents;
}

function fail(code: MoneyErr["code"], message: string): MoneyErr {
  return { ok: false, code, message };
}

function stripCurrencyJunk(raw: string): string {
  return raw
    .trim()
    .replace(/^(usd|cad)\s*/i, "")
    .replace(/^\$\s*/, "")
    .replace(/\s*(usd|cad|dollars?)\s*$/i, "")
    .replace(/\s+/g, "");
}

function suffixMultiplier(s: string): { body: string; multiplier: bigint } {
  const match = s.match(/^(.+?)([km])$/i);
  if (!match || match[1] === undefined || match[2] === undefined) {
    return { body: s, multiplier: 1n };
  }
  const multiplier = match[2].toLowerCase() === "k" ? 1_000n : 1_000_000n;
  return { body: match[1], multiplier };
}

function isUsThousands(grouped: string): boolean {
  return /^\d{1,3}(,\d{3})+$/.test(grouped) || /^\d{1,3}$/.test(grouped);
}

/**
 * US grouping only. Comma groups of three. Period is the decimal, at most two digits.
 * European 450.000 or 450,00 is rejected. That is the $450,000 bug.
 */
function parseGrouped(body: string): { intDigits: string; fracDigits: string } | MoneyErr {
  const commaCount = (body.match(/,/g) ?? []).length;
  const periodCount = (body.match(/\./g) ?? []).length;

  if (commaCount > 0 && periodCount > 0) {
    const lastComma = body.lastIndexOf(",");
    const lastPeriod = body.lastIndexOf(".");
    if (lastPeriod < lastComma) {
      return fail(
        "MONEY_AMBIGUOUS",
        "EU-style decimal comma is rejected. US/Canada amounts use 450,000.00",
      );
    }
    const decimals = body.slice(lastPeriod + 1);
    if (!/^\d{1,2}$/.test(decimals)) {
      return fail("MONEY_AMBIGUOUS", "more than two decimal digits");
    }
    const intPart = body.slice(0, lastPeriod);
    if (!isUsThousands(intPart)) {
      return fail("MONEY_AMBIGUOUS", "comma grouping is not US thousands");
    }
    return { intDigits: intPart.replaceAll(",", ""), fracDigits: decimals };
  }

  if (periodCount > 1) {
    return fail("MONEY_AMBIGUOUS", "multiple decimal points");
  }

  if (periodCount === 1 && commaCount === 0) {
    const [left, right] = body.split(".");
    if (left === undefined || right === undefined) {
      return fail("MONEY_INVALID", "broken decimal");
    }
    if (right.length === 3 && left.length <= 3 && /^\d+$/.test(left) && /^\d+$/.test(right)) {
      return fail(
        "MONEY_AMBIGUOUS",
        "450.000 is either 450 or 450 thousand depending on locale. Refusing to guess.",
      );
    }
    if (!/^\d{1,2}$/.test(right)) {
      return fail("MONEY_AMBIGUOUS", "decimal must be 1-2 digits, or this looks like EU thousands");
    }
    if (!/^\d+$/.test(left)) {
      return fail("MONEY_INVALID", "non-digit in dollar amount");
    }
    return { intDigits: left, fracDigits: right };
  }

  if (commaCount > 0 && periodCount === 0) {
    const last = body.slice(body.lastIndexOf(",") + 1);
    if (last.length === 2 && /^\d{2}$/.test(last)) {
      return fail(
        "MONEY_AMBIGUOUS",
        "450,00 looks like a European decimal. Send 450.00 or 450,000.",
      );
    }
    if (!isUsThousands(body)) {
      return fail("MONEY_AMBIGUOUS", "comma grouping is not US thousands");
    }
    return { intDigits: body.replaceAll(",", ""), fracDigits: "" };
  }

  if (!/^\d+$/.test(body)) {
    return fail("MONEY_INVALID", "amount contains non-digits");
  }
  return { intDigits: body, fracDigits: "" };
}

function fromParts(intDigits: string, fracDigits: string, multiplier: bigint): MoneyResult {
  if (intDigits.length === 0) {
    return fail("MONEY_INVALID", "missing dollar digits");
  }
  const fracLen = BigInt(fracDigits.length);
  const mantissa = BigInt(intDigits + fracDigits);
  const denom = 10n ** fracLen;
  const centsNumerator = mantissa * 100n * multiplier;
  if (centsNumerator % denom !== 0n) {
    return fail("MONEY_AMBIGUOUS", "amount is not a whole cent after suffix");
  }
  const cents = centsNumerator / denom;
  const dollars = cents / 100n;
  if (dollars < MIN_DOLLARS) {
    return fail("MONEY_INVALID", "loan amount is below $1,000");
  }
  if (dollars > MAX_DOLLARS) {
    return fail("MONEY_INVALID", "loan amount is above $50,000,000");
  }
  return { ok: true, cents: asCents(cents) };
}

/**
 * Parse an inbound loan amount into integer cents.
 * Accepts $450,000, 450000, 450,000.00, 450k.
 * Rejects locale-ambiguous values. Never uses float.
 */
export function parseMoneyToCents(input: unknown): MoneyResult {
  if (input === null || input === undefined) {
    return fail("MONEY_EMPTY", "loan amount is missing");
  }

  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      return fail("MONEY_INVALID", "loan amount is not finite");
    }
    if (!Number.isInteger(input)) {
      return fail(
        "MONEY_AMBIGUOUS",
        "JSON numbers with a fraction are floats. Send a string like 450000.00",
      );
    }
    if (input < 0) {
      return fail("MONEY_INVALID", "loan amount is negative");
    }
    return fromParts(String(input), "", 1n);
  }

  if (typeof input !== "string") {
    return fail("MONEY_INVALID", "loan amount must be a string or integer");
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return fail("MONEY_EMPTY", "loan amount is empty");
  }
  if (trimmed.startsWith("-")) {
    return fail("MONEY_INVALID", "loan amount is negative");
  }
  if (/\b(to|between)\b/i.test(trimmed) || /-|–/.test(trimmed)) {
    return fail("MONEY_AMBIGUOUS", "ranges are not a loan amount");
  }

  const stripped = stripCurrencyJunk(trimmed);
  if (stripped.length === 0) {
    return fail("MONEY_EMPTY", "loan amount is empty after stripping currency");
  }

  const { body, multiplier } = suffixMultiplier(stripped);
  if (body.length === 0) {
    return fail("MONEY_INVALID", "missing digits before suffix");
  }
  if (!/^[\d,.]+$/.test(body)) {
    return fail("MONEY_AMBIGUOUS", "amount contains words we will not interpret");
  }

  const grouped = parseGrouped(body);
  if ("ok" in grouped) return grouped;
  return fromParts(grouped.intDigits, grouped.fracDigits, multiplier);
}

export function formatUsdFromCents(cents: Cents): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.trunc(abs / 100);
  const rem = abs % 100;
  const grouped = dollars.toLocaleString("en-US");
  return `${negative ? "-" : ""}$${grouped}.${String(rem).padStart(2, "0")}`;
}

export function centsFromInteger(cents: number): Cents {
  if (!Number.isInteger(cents)) {
    throw new Error("cents must be an integer");
  }
  return cents as Cents;
}
