import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { MappingFailureFilter } from "../src/http/mapping.filter";
import { LeadStore } from "../src/store/lead-store";

const inboundPayload = {
  externalId: "lead_450k",
  firstName: "Alex",
  lastName: "Rivera",
  phone: "(415) 555-0100",
  extraNoise: { utm: "facebook" },
  customFields: {
    loanAmount: "$450,000",
    purpose: "purchase",
    timeline: "45 days",
    creditBand: "good",
    meeting: { booked: true, startsAt: "2026-09-04T16:00:00Z" },
  },
};

describe("POST /webhooks/lead", () => {
  let app: INestApplication;
  let store: LeadStore;

  beforeEach(async () => {
    process.env.DATABASE_PATH = ":memory:";
    delete process.env.CRM_WEBHOOK_URL;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new MappingFailureFilter());
    await app.init();
    store = moduleRef.get(LeadStore);
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  test("maps a messy inbound payload and stores $450,000 as cents", async () => {
    const res = await request(app.getHttpServer())
      .post("/webhooks/lead")
      .set("Idempotency-Key", "lead_450k")
      .send(inboundPayload);
    expect(res.status).toBe(200);
    expect(res.body.loanAmountCents).toBe(45_000_000);
    expect(res.body.status === "qualified" || res.body.status === "crm_local").toBe(true);
    const lead = store.findById(res.body.id as string);
    expect(lead?.loanAmountCents).toBe(45_000_000);
    expect(Number.isInteger(lead?.loanAmountCents)).toBe(true);
    expect(lead?.crmRequest).toContain('"loanAmountCents":45000000');
    expect(lead?.crmRequest).not.toContain("450.000");
  });

  test("returns 4xx with a typed code on bad money, never 200", async () => {
    const res = await request(app.getHttpServer())
      .post("/webhooks/lead")
      .set("Idempotency-Key", "bad_money")
      .send({
        externalId: "bad_money",
        firstName: "Alex",
        lastName: "Rivera",
        phone: "4155550100",
        customFields: { loanAmount: "450.000" },
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MONEY_AMBIGUOUS");
    expect(store.list().some((l) => l.status === "mapping_failed")).toBe(true);
  });

  test("is idempotent on the same key and payload", async () => {
    const first = await request(app.getHttpServer())
      .post("/webhooks/lead")
      .set("Idempotency-Key", "repeat")
      .send(inboundPayload);
    const second = await request(app.getHttpServer())
      .post("/webhooks/lead")
      .set("Idempotency-Key", "repeat")
      .send(inboundPayload);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(store.list()).toHaveLength(1);
  });

  test("conflicts when the same key is reused with a different body", async () => {
    await request(app.getHttpServer())
      .post("/webhooks/lead")
      .set("Idempotency-Key", "clash")
      .send(inboundPayload);
    const res = await request(app.getHttpServer())
      .post("/webhooks/lead")
      .set("Idempotency-Key", "clash")
      .send({ ...inboundPayload, firstName: "Jordan" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  test("replays a mapping failure as 4xx, not 200", async () => {
    const payload = {
      externalId: "fail_replay",
      firstName: "Alex",
      lastName: "Rivera",
      phone: "4155550100",
      loanAmount: "450.000",
    };
    const first = await request(app.getHttpServer())
      .post("/webhooks/lead")
      .set("Idempotency-Key", "fail_replay")
      .send(payload);
    const second = await request(app.getHttpServer())
      .post("/webhooks/lead")
      .set("Idempotency-Key", "fail_replay")
      .send(payload);
    expect(first.status).toBe(400);
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe("MONEY_AMBIGUOUS");
  });
});

describe("POST /webhooks/voice", () => {
  let app: INestApplication;

  beforeEach(async () => {
    process.env.DATABASE_PATH = ":memory:";
    delete process.env.CRM_WEBHOOK_URL;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new MappingFailureFilter());
    await app.init();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  test("sanitizes voice structuredData before CRM mapping", async () => {
    const res = await request(app.getHttpServer())
      .post("/webhooks/voice")
      .send({
        message: {
          type: "end-of-call-report",
          call: { id: "call_1", customer: { number: "+14155550100" } },
          artifact: { transcript: "User: I need 450k to buy a house." },
          analysis: {
            structuredData: {
              fullName: "Alex Rivera",
              phone: "+14155550100",
              loanAmount: "$450,000",
              purpose: "purchase",
              approved: true,
              pipelineStage: "the-model-named-this",
            },
          },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.loanAmountCents).toBe(45_000_000);
    const detail = await request(app.getHttpServer()).get(`/api/leads/${res.body.id}`);
    expect(detail.body.droppedFields).toEqual(
      expect.arrayContaining(["approved", "pipelineStage"]),
    );
  });
});
