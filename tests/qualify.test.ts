import { sanitizeExtraction, qualifyLead, toCrmContact } from "../src/domain/qualify";

describe("sanitizeExtraction", () => {
  test("drops invented fields and keeps $450,000 as a string until qualifyLead", () => {
    const result = sanitizeExtraction({
      fullName: "Alex Rivera",
      phone: "(415) 555-0100",
      loanAmount: "$450,000",
      purpose: "purchase",
      approved: true,
      creditScore: 812,
      ssn: "invented",
      pipelineStage: "the-model-chose-this",
    });
    expect(result.droppedFields.sort()).toEqual(
      ["approved", "creditScore", "pipelineStage", "ssn"].sort(),
    );
    expect(result.extraction.loanAmount).toBe("$450,000");
    expect(result.extraction.fullName).toBe("Alex Rivera");
  });

  test("qualifyLead then toCrmContact owns CRM field names", () => {
    const qualified = qualifyLead(
      {
        fullName: "Alex Rivera",
        phone: "4155550100",
        loanAmount: "$450,000",
        purpose: "refi",
        timeline: "30 days",
        creditBand: "good",
        meeting: { booked: true, startsAt: "2026-09-04T16:00:00Z" },
        approved: true,
      },
      { externalId: "lead_1", promptVersion: "loandesk-qualifier-v1" },
    );
    expect(qualified.ok).toBe(true);
    if (!qualified.ok) return;
    expect(qualified.droppedFields).toContain("approved");
    const crm = toCrmContact(qualified.lead);
    expect(crm.loanAmountCents).toBe(45_000_000);
    expect(crm.name).toBe("Alex Rivera");
    expect(crm.phone).toBe("+14155550100");
    expect(crm.purpose).toBe("refinance");
    expect(crm.creditBand).toBe("good");
    expect(crm.meeting).toEqual({ booked: true, startsAt: "2026-09-04T16:00:00Z" });
    expect(Object.keys(crm).sort()).toEqual(
      ["creditBand", "loanAmountCents", "meeting", "name", "phone", "purpose", "timeline"].sort(),
    );
  });

  test("does not qualify when the model invents a bad amount", () => {
    const qualified = qualifyLead(
      { fullName: "Alex Rivera", phone: "4155550100", loanAmount: "450.000", purpose: "purchase" },
      { externalId: "lead_2", promptVersion: "loandesk-qualifier-v1" },
    );
    expect(qualified.ok).toBe(false);
    if (qualified.ok) return;
    expect(qualified.error?.code).toBe("MONEY_AMBIGUOUS");
  });
});
