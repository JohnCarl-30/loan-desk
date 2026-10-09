import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { MappingFailureFilter } from "../src/http/mapping.filter";
import { LeadStore } from "../src/store/lead-store";
import { signPayload, verifySignature } from "../src/domain/signature";

const SECRET = "test-webhook-secret";

const body = JSON.stringify({
  externalId: "signed_lead",
  firstName: "Alex",
  lastName: "Rivera",
  phone: "(415) 555-0100",
  customFields: { loanAmount: "$450,000", purpose: "purchase" },
});

function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

describe("verifySignature", () => {
  const raw = Buffer.from(body);
  const ts = "1760000000";

  test("accepts the HMAC of timestamp.body", () => {
    const signature = signPayload(SECRET, ts, raw);
    expect(verifySignature({ secret: SECRET, rawBody: raw, timestamp: ts, signature, nowSeconds: 1760000010 })).toBeNull();
  });

  test("rejects a missing header, a wrong secret, and a stale timestamp", () => {
    const signature = signPayload(SECRET, ts, raw);
    expect(verifySignature({ secret: SECRET, rawBody: raw, timestamp: ts, signature: undefined, nowSeconds: 1760000000 })).toBe("SIGNATURE_MISSING");
    expect(
      verifySignature({ secret: SECRET, rawBody: raw, timestamp: ts, signature: signPayload("other", ts, raw), nowSeconds: 1760000000 }),
    ).toBe("SIGNATURE_INVALID");
    expect(verifySignature({ secret: SECRET, rawBody: raw, timestamp: ts, signature, nowSeconds: 1760000000 + 301 })).toBe("SIGNATURE_EXPIRED");
    expect(verifySignature({ secret: SECRET, rawBody: raw, timestamp: "soon", signature, nowSeconds: 1760000000 })).toBe("SIGNATURE_INVALID");
  });
});

describe("POST /webhooks/lead with WEBHOOK_SECRET set", () => {
  let app: INestApplication;
  let store: LeadStore;

  beforeEach(async () => {
    process.env.DATABASE_PATH = ":memory:";
    process.env.WEBHOOK_SECRET = SECRET;
    process.env.CRM_RETRY_INTERVAL_MS = "0";
    delete process.env.CRM_WEBHOOK_URL;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.useGlobalFilters(new MappingFailureFilter());
    await app.init();
    store = moduleRef.get(LeadStore);
  });

  afterEach(async () => {
    delete process.env.WEBHOOK_SECRET;
    if (app) await app.close();
  });

  function post() {
    return request(app.getHttpServer())
      .post("/webhooks/lead")
      .set("content-type", "application/json")
      .set("Idempotency-Key", "signed_lead");
  }

  test("accepts a correctly signed lead", async () => {
    const ts = nowSeconds();
    const res = await post()
      .set("X-LoanDesk-Timestamp", ts)
      .set("X-LoanDesk-Signature", signPayload(SECRET, ts, body))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.loanAmountCents).toBe(45_000_000);
  });

  test("rejects an unsigned lead with 401 and stores nothing", async () => {
    const res = await post().send(body);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("SIGNATURE_MISSING");
    expect(store.list()).toHaveLength(0);
  });

  test("rejects a body changed after signing", async () => {
    const ts = nowSeconds();
    const tampered = body.replace("$450,000", "$45,000");
    const res = await post()
      .set("X-LoanDesk-Timestamp", ts)
      .set("X-LoanDesk-Signature", signPayload(SECRET, ts, body))
      .send(tampered);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("SIGNATURE_INVALID");
    expect(store.list()).toHaveLength(0);
  });

  const voiceBody = JSON.stringify({
    message: {
      type: "end-of-call-report",
      call: { id: "signed_call", customer: { number: "+14155550100" } },
      analysis: {
        structuredData: { fullName: "Alex Rivera", phone: "+14155550100", loanAmount: "$450,000", purpose: "purchase" },
      },
    },
  });

  function postVoice() {
    return request(app.getHttpServer()).post("/webhooks/voice").set("content-type", "application/json");
  }

  test("rejects an unsigned voice call report with 401 and stores nothing", async () => {
    const res = await postVoice().send(voiceBody);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("SIGNATURE_MISSING");
    expect(store.list()).toHaveLength(0);
  });

  test("accepts a correctly signed voice call report", async () => {
    const ts = nowSeconds();
    const res = await postVoice()
      .set("X-LoanDesk-Timestamp", ts)
      .set("X-LoanDesk-Signature", signPayload(SECRET, ts, voiceBody))
      .send(voiceBody);
    expect(res.status).toBe(200);
    expect(res.body.loanAmountCents).toBe(45_000_000);
  });

  test("rejects a replayed signature outside the 5-minute window", async () => {
    const ts = String(Math.floor(Date.now() / 1000) - 600);
    const res = await post()
      .set("X-LoanDesk-Timestamp", ts)
      .set("X-LoanDesk-Signature", signPayload(SECRET, ts, body))
      .send(body);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("SIGNATURE_EXPIRED");
  });
});
