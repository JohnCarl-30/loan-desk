import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { CRM_MAX_ATTEMPTS, CrmService, isRetryableStatus, retryDelayMs } from "../src/crm/crm.service";
import { MappingFailureFilter } from "../src/http/mapping.filter";
import { LeadStore } from "../src/store/lead-store";

const lead = {
  externalId: "crm_retry",
  firstName: "Alex",
  lastName: "Rivera",
  phone: "(415) 555-0100",
  customFields: { loanAmount: "$450,000", purpose: "purchase" },
};

const LATER = Date.now() + 24 * 60 * 60 * 1000;

describe("retry policy", () => {
  test("retries timeouts, rate limits, and 5xx; not other 4xx", () => {
    for (const status of [408, 429, 500, 502, 503]) expect(isRetryableStatus(status)).toBe(true);
    for (const status of [400, 401, 404, 409, 422]) expect(isRetryableStatus(status)).toBe(false);
  });

  test("doubles the wait after each failed attempt", () => {
    expect([1, 2, 3, 4].map((n) => retryDelayMs(n, 30_000))).toEqual([30_000, 60_000, 120_000, 240_000]);
  });
});

describe("CRM retry", () => {
  let app: INestApplication;
  let store: LeadStore;
  let crm: CrmService;
  let fetchMock: jest.SpyInstance;

  beforeEach(async () => {
    process.env.DATABASE_PATH = ":memory:";
    process.env.CRM_WEBHOOK_URL = "https://crm.test/hook";
    process.env.CRM_RETRY_INTERVAL_MS = "0";
    process.env.CRM_RETRY_BASE_MS = "30000";
    fetchMock = jest.spyOn(global, "fetch");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new MappingFailureFilter());
    await app.init();
    store = moduleRef.get(LeadStore);
    crm = moduleRef.get(CrmService);
  });

  afterEach(async () => {
    fetchMock.mockRestore();
    delete process.env.CRM_WEBHOOK_URL;
    if (app) await app.close();
  });

  async function ingest(): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/webhooks/lead")
      .set("Idempotency-Key", "crm_retry")
      .send(lead);
    expect(res.status).toBe(200);
    return res.body.id as string;
  }

  test("a 503 is retried after the backoff with the same Idempotency-Key", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const id = await ingest();
    expect(store.findById(id)?.crmStatus).toBe("failed");

    // Not due yet: the first wait is 30s.
    expect(await crm.retryDue(Date.now() + 1_000)).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await crm.retryDue(Date.now() + 31_000);
    const after = store.findById(id);
    expect(after?.crmStatus).toBe("posted");
    expect(after?.crmAttempts).toBe(2);

    const keys = fetchMock.mock.calls.map(
      ([, init]) => ((init as RequestInit).headers as Record<string, string>)["Idempotency-Key"],
    );
    expect(keys).toEqual([`loandesk-crm-${id}`, `loandesk-crm-${id}`]);
  });

  test("a network error is retried", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const id = await ingest();
    expect(store.findById(id)?.crmStatus).toBe("failed");
    await crm.retryDue(LATER);
    expect(store.findById(id)?.crmStatus).toBe("posted");
  });

  test("a 422 is rejected and never retried automatically", async () => {
    fetchMock.mockResolvedValue(new Response("bad field", { status: 422 }));

    const id = await ingest();
    expect(store.findById(id)?.crmStatus).toBe("rejected");
    await crm.retryDue(LATER);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("gives up after the attempt limit and leaves the lead failed", async () => {
    fetchMock.mockImplementation(async () => new Response("down", { status: 500 }));

    const id = await ingest();
    for (let i = 0; i < CRM_MAX_ATTEMPTS + 3; i += 1) await crm.retryDue(LATER);

    expect(fetchMock).toHaveBeenCalledTimes(CRM_MAX_ATTEMPTS);
    const after = store.findById(id);
    expect(after?.crmStatus).toBe("failed");
    expect(after?.crmAttempts).toBe(CRM_MAX_ATTEMPTS);
  });
});
