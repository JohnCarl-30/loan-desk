import { createHmac } from "node:crypto";
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
    jest.restoreAllMocks();
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

  describe("delivery log", () => {
    async function deliveries(id: string) {
      return (await request(app.getHttpServer()).get(`/api/leads/${id}`)).body.crmDeliveries;
    }

    test("records every attempt in order, with what triggered it and what came back", async () => {
      fetchMock
        .mockResolvedValueOnce(new Response("down", { status: 503 }))
        .mockResolvedValueOnce(new Response("ok", { status: 200 }));

      const id = await ingest();
      await crm.retryDue(LATER);
      const log = await deliveries(id);

      expect(log).toHaveLength(2);
      expect(log[0]).toMatchObject({ attempt: 1, trigger: "initial", statusCode: 503, outcome: "failed", error: null, responseBody: "down" });
      expect(log[1]).toMatchObject({ attempt: 2, trigger: "auto_retry", statusCode: 200, outcome: "posted", error: null, responseBody: "ok" });
      for (const entry of log) {
        expect(Number.isNaN(Date.parse(entry.startedAt))).toBe(false);
        expect(entry.durationMs).toBeGreaterThanOrEqual(0);
      }
    });

    test("records a network error with no status code", async () => {
      fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));

      const log = await deliveries(await ingest());

      expect(log).toEqual([expect.objectContaining({ statusCode: null, outcome: "failed", error: "ECONNRESET", responseBody: null })]);
    });

    test("records a 4xx as rejected", async () => {
      fetchMock.mockResolvedValueOnce(new Response("bad field", { status: 422 }));

      const log = await deliveries(await ingest());

      expect(log).toEqual([expect.objectContaining({ statusCode: 422, outcome: "rejected", responseBody: "bad field" })]);
    });

    test("records the staff retry button as a manual attempt", async () => {
      fetchMock
        .mockResolvedValueOnce(new Response("bad field", { status: 422 }))
        .mockResolvedValueOnce(new Response("ok", { status: 200 }));

      const id = await ingest();
      await request(app.getHttpServer()).post(`/api/leads/${id}/crm-retry`).expect(201);
      const log = await deliveries(id);

      expect(log.map((e: { trigger: string; outcome: string }) => [e.trigger, e.outcome])).toEqual([
        ["initial", "rejected"],
        ["manual", "posted"],
      ]);
    });

    test("keeps at most 4000 characters of a response body", async () => {
      fetchMock.mockResolvedValueOnce(new Response("x".repeat(10_000), { status: 502 }));

      const [entry] = await deliveries(await ingest());

      expect(entry.responseBody).toHaveLength(4000);
    });

    test("keeps each lead's log separate", async () => {
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

      const first = await ingest();
      const second = (
        await request(app.getHttpServer())
          .post("/webhooks/lead")
          .set("Idempotency-Key", "crm_retry_2")
          .send({ ...lead, externalId: "crm_retry_2" })
      ).body.id as string;

      expect(await deliveries(first)).toHaveLength(1);
      expect(await deliveries(second)).toHaveLength(1);
    });
  });

  describe("retry state on the lead API", () => {
    async function detail(id: string) {
      return (await request(app.getHttpServer()).get(`/api/leads/${id}`)).body;
    }

    test("a failed lead shows when the next attempt is due", async () => {
      fetchMock.mockResolvedValueOnce(new Response("down", { status: 503 }));

      const lead = await detail(await ingest());

      expect(lead.crmNextRetryAt).toBe(new Date(Date.parse(lead.updatedAt) + 30_000).toISOString());
      expect(lead.crmGaveUp).toBe(false);
    });

    test("a lead out of attempts shows it gave up and has no next attempt", async () => {
      fetchMock.mockImplementation(async () => new Response("down", { status: 500 }));

      const id = await ingest();
      for (let i = 0; i < CRM_MAX_ATTEMPTS; i += 1) await crm.retryDue(LATER);
      const lead = await detail(id);

      expect(lead.crmNextRetryAt).toBeNull();
      expect(lead.crmGaveUp).toBe(true);
    });

    test("a rejected lead has no next attempt and is not counted as given up", async () => {
      fetchMock.mockResolvedValue(new Response("bad field", { status: 422 }));

      const lead = await detail(await ingest());

      expect(lead.crmNextRetryAt).toBeNull();
      expect(lead.crmGaveUp).toBe(false);
    });
  });

  describe("outbound signing", () => {
    const SECRET = "test-crm-signing-secret";

    afterEach(() => {
      delete process.env.CRM_SIGNING_SECRET;
    });

    function sent(call: number): { headers: Record<string, string>; body: string } {
      const init = fetchMock.mock.calls[call][1] as RequestInit;
      return { headers: init.headers as Record<string, string>, body: init.body as string };
    }

    function hmac(timestamp: string, body: string): string {
      return `sha256=${createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex")}`;
    }

    test("signs the CRM POST over timestamp.body so the receiver can verify it", async () => {
      process.env.CRM_SIGNING_SECRET = SECRET;
      fetchMock.mockResolvedValueOnce(new Response("ok", { status: 200 }));
      jest.spyOn(Date, "now").mockReturnValue(1_760_000_000_000);

      await ingest();

      const { headers, body } = sent(0);
      expect(headers["X-LoanDesk-Timestamp"]).toBe("1760000000");
      expect(headers["X-LoanDesk-Signature"]).toBe(hmac("1760000000", body));
    });

    test("a retry is signed with the time it is sent, not the first attempt's", async () => {
      process.env.CRM_SIGNING_SECRET = SECRET;
      fetchMock
        .mockResolvedValueOnce(new Response("down", { status: 503 }))
        .mockResolvedValueOnce(new Response("ok", { status: 200 }));
      const now = jest.spyOn(Date, "now").mockReturnValue(1_760_000_000_000);

      await ingest();
      // Ten minutes later: a receiver with a 5-minute window rejects a reused timestamp.
      now.mockReturnValue(1_760_000_600_000);
      await crm.retryDue(LATER);

      const { headers, body } = sent(1);
      expect(headers["X-LoanDesk-Timestamp"]).toBe("1760000600");
      expect(headers["X-LoanDesk-Signature"]).toBe(hmac("1760000600", body));
    });

    test("sends no signature headers when no secret is configured", async () => {
      fetchMock.mockResolvedValueOnce(new Response("ok", { status: 200 }));

      await ingest();

      expect(sent(0).headers).not.toHaveProperty("X-LoanDesk-Signature");
      expect(sent(0).headers).not.toHaveProperty("X-LoanDesk-Timestamp");
    });
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
