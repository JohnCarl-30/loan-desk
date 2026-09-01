import { centsFromInteger, formatUsdFromCents, parseMoneyToCents } from "../src/domain/money";

describe("parseMoneyToCents", () => {
  test("parses $450,000 as integer cents, not 450", () => {
    const result = parseMoneyToCents("$450,000");
    expect(result).toEqual({ ok: true, cents: 45_000_000 });
    if (result.ok) {
      expect(Number.isInteger(result.cents)).toBe(true);
      expect(formatUsdFromCents(result.cents)).toBe("$450,000.00");
    }
  });

  test("accepts 450000, 450,000.00, and 450k", () => {
    expect(parseMoneyToCents("450000")).toEqual({ ok: true, cents: 45_000_000 });
    expect(parseMoneyToCents("450,000.00")).toEqual({ ok: true, cents: 45_000_000 });
    expect(parseMoneyToCents("450k")).toEqual({ ok: true, cents: 45_000_000 });
    expect(parseMoneyToCents("450K")).toEqual({ ok: true, cents: 45_000_000 });
    expect(parseMoneyToCents(450000)).toEqual({ ok: true, cents: 45_000_000 });
  });

  test("rejects locale-ambiguous values", () => {
    const euThousands = parseMoneyToCents("450.000");
    expect(euThousands.ok).toBe(false);
    if (!euThousands.ok) {
      expect(euThousands.code).toBe("MONEY_AMBIGUOUS");
    }
    expect(parseMoneyToCents("450,00").ok).toBe(false);
    expect(parseMoneyToCents("450-500k").ok).toBe(false);
    expect(parseMoneyToCents("about 450k").ok).toBe(false);
    expect(parseMoneyToCents(450000.5).ok).toBe(false);
    expect(parseMoneyToCents("$450,000.123").ok).toBe(false);
  });

  test("rejects empty and junk", () => {
    expect(parseMoneyToCents("").ok).toBe(false);
    expect(parseMoneyToCents("n/a").ok).toBe(false);
    expect(parseMoneyToCents(null).ok).toBe(false);
    expect(parseMoneyToCents(-5).ok).toBe(false);
  });

  test("never stores a float", () => {
    const result = parseMoneyToCents("$450,000");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(String(result.cents).includes(".")).toBe(false);
    }
    expect(() => centsFromInteger(450000.1)).toThrow(/integer/);
  });
});
