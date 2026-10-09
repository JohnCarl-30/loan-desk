import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Cents } from "../domain/money";
import type { ErrorCode } from "../domain/errors";
import {
  EMPTY_MEETING,
  type CrmDelivery,
  type CrmStatus,
  type Lead,
  type LeadStatus,
  type Meeting,
  type Purpose,
} from "../domain/types";

type LeadRow = {
  id: string;
  external_id: string;
  idempotency_key: string;
  payload_hash: string;
  status: LeadStatus;
  error_code: ErrorCode | null;
  error_message: string | null;
  error_field: string | null;
  full_name: string | null;
  phone_e164: string | null;
  loan_amount_cents: number | null;
  purpose: Purpose | null;
  timeline: string | null;
  credit_band: string | null;
  meeting_json: string;
  source: string;
  prompt_version: string | null;
  transcript: string | null;
  extracted_json: string | null;
  dropped_fields: string;
  raw_payload: string;
  crm_status: CrmStatus | null;
  crm_request: string | null;
  crm_response: string | null;
  crm_attempts: number;
  created_at: string;
  updated_at: string;
};

type DeliveryRow = {
  lead_id: string;
  attempt: number;
  trigger: CrmDelivery["trigger"];
  started_at: string;
  duration_ms: number;
  status_code: number | null;
  outcome: CrmDelivery["outcome"];
  error: string | null;
  response_body: string | null;
};

@Injectable()
export class LeadStore implements OnModuleDestroy {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.db = new Database(databasePath);
    if (databasePath !== ":memory:") {
      this.db.pragma("journal_mode = WAL");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS leads (
        id TEXT PRIMARY KEY,
        external_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        error_field TEXT,
        full_name TEXT,
        phone_e164 TEXT,
        loan_amount_cents INTEGER,
        purpose TEXT,
        timeline TEXT,
        credit_band TEXT,
        meeting_json TEXT NOT NULL DEFAULT '{"booked":false,"startsAt":null}',
        source TEXT NOT NULL,
        prompt_version TEXT,
        transcript TEXT,
        extracted_json TEXT,
        dropped_fields TEXT NOT NULL DEFAULT '[]',
        raw_payload TEXT NOT NULL,
        crm_status TEXT,
        crm_request TEXT,
        crm_response TEXT,
        crm_attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
      CREATE INDEX IF NOT EXISTS idx_leads_external ON leads(external_id);
      CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);

      CREATE TABLE IF NOT EXISTS crm_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id TEXT NOT NULL REFERENCES leads(id),
        attempt INTEGER NOT NULL,
        trigger TEXT NOT NULL,
        started_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        status_code INTEGER,
        outcome TEXT NOT NULL,
        error TEXT,
        response_body TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_crm_deliveries_lead ON crm_deliveries(lead_id, id);
    `);
  }

  onModuleDestroy(): void {
    this.db.close();
  }

  insert(lead: Lead): Lead {
    this.db
      .prepare(
        `INSERT INTO leads (
          id, external_id, idempotency_key, payload_hash, status,
          error_code, error_message, error_field, full_name, phone_e164,
          loan_amount_cents, purpose, timeline, credit_band, meeting_json, source,
          prompt_version, transcript, extracted_json, dropped_fields, raw_payload,
          crm_status, crm_request, crm_response, crm_attempts, created_at, updated_at
        ) VALUES (
          @id, @external_id, @idempotency_key, @payload_hash, @status,
          @error_code, @error_message, @error_field, @full_name, @phone_e164,
          @loan_amount_cents, @purpose, @timeline, @credit_band, @meeting_json, @source,
          @prompt_version, @transcript, @extracted_json, @dropped_fields, @raw_payload,
          @crm_status, @crm_request, @crm_response, @crm_attempts, @created_at, @updated_at
        )`,
      )
      .run(this.toRow(lead));
    return lead;
  }

  update(lead: Lead): Lead {
    this.db
      .prepare(
        `UPDATE leads SET
          status=@status, error_code=@error_code, error_message=@error_message,
          error_field=@error_field, full_name=@full_name, phone_e164=@phone_e164,
          loan_amount_cents=@loan_amount_cents, purpose=@purpose, timeline=@timeline,
          credit_band=@credit_band, meeting_json=@meeting_json, prompt_version=@prompt_version,
          transcript=@transcript, extracted_json=@extracted_json, dropped_fields=@dropped_fields,
          crm_status=@crm_status, crm_request=@crm_request, crm_response=@crm_response,
          crm_attempts=@crm_attempts, updated_at=@updated_at
        WHERE id=@id`,
      )
      .run(this.toRow(lead));
    return lead;
  }

  findById(id: string): Lead | null {
    const row = this.db.prepare("SELECT * FROM leads WHERE id = ?").get(id) as LeadRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  findByIdempotencyKey(key: string): Lead | null {
    const row = this.db
      .prepare("SELECT * FROM leads WHERE idempotency_key = ?")
      .get(key) as LeadRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  listByCrmStatus(status: CrmStatus): Lead[] {
    const rows = this.db
      .prepare("SELECT * FROM leads WHERE crm_status = ? ORDER BY updated_at ASC")
      .all(status) as LeadRow[];
    return rows.map((row) => this.fromRow(row));
  }

  list(): Lead[] {
    const rows = this.db
      .prepare("SELECT * FROM leads ORDER BY created_at DESC")
      .all() as LeadRow[];
    return rows.map((row) => this.fromRow(row));
  }

  insertDelivery(delivery: CrmDelivery): void {
    this.db
      .prepare(
        `INSERT INTO crm_deliveries (
          lead_id, attempt, trigger, started_at, duration_ms, status_code, outcome, error, response_body
        ) VALUES (
          @lead_id, @attempt, @trigger, @started_at, @duration_ms, @status_code, @outcome, @error, @response_body
        )`,
      )
      .run({
        lead_id: delivery.leadId,
        attempt: delivery.attempt,
        trigger: delivery.trigger,
        started_at: delivery.startedAt,
        duration_ms: delivery.durationMs,
        status_code: delivery.statusCode,
        outcome: delivery.outcome,
        error: delivery.error,
        response_body: delivery.responseBody,
      } satisfies DeliveryRow);
  }

  /** Oldest first, so the log reads as a timeline. */
  listDeliveries(leadId: string): CrmDelivery[] {
    const rows = this.db
      .prepare("SELECT * FROM crm_deliveries WHERE lead_id = ? ORDER BY id ASC")
      .all(leadId) as DeliveryRow[];
    return rows.map((row) => ({
      leadId: row.lead_id,
      attempt: row.attempt,
      trigger: row.trigger,
      startedAt: row.started_at,
      durationMs: row.duration_ms,
      statusCode: row.status_code,
      outcome: row.outcome,
      error: row.error,
      responseBody: row.response_body,
    }));
  }

  private toRow(lead: Lead): LeadRow {
    return {
      id: lead.id,
      external_id: lead.externalId,
      idempotency_key: lead.idempotencyKey,
      payload_hash: lead.payloadHash,
      status: lead.status,
      error_code: lead.errorCode,
      error_message: lead.errorMessage,
      error_field: lead.errorField,
      full_name: lead.fullName,
      phone_e164: lead.phoneE164,
      loan_amount_cents: lead.loanAmountCents,
      purpose: lead.purpose,
      timeline: lead.timeline,
      credit_band: lead.creditBand,
      meeting_json: JSON.stringify(lead.meeting),
      source: lead.source,
      prompt_version: lead.promptVersion,
      transcript: lead.transcript,
      extracted_json: lead.extractedJson,
      dropped_fields: JSON.stringify(lead.droppedFields),
      raw_payload: lead.rawPayload,
      crm_status: lead.crmStatus,
      crm_request: lead.crmRequest,
      crm_response: lead.crmResponse,
      crm_attempts: lead.crmAttempts,
      created_at: lead.createdAt,
      updated_at: lead.updatedAt,
    };
  }

  private fromRow(row: LeadRow): Lead {
    let droppedFields: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.dropped_fields);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
        droppedFields = parsed;
      }
    } catch {
      droppedFields = [];
    }
    return {
      id: row.id,
      externalId: row.external_id,
      idempotencyKey: row.idempotency_key,
      payloadHash: row.payload_hash,
      status: row.status,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      errorField: row.error_field,
      fullName: row.full_name,
      phoneE164: row.phone_e164,
      loanAmountCents: row.loan_amount_cents === null ? null : (row.loan_amount_cents as Cents),
      purpose: row.purpose,
      timeline: row.timeline,
      creditBand: row.credit_band,
      meeting: parseMeetingJson(row.meeting_json),
      source: row.source,
      promptVersion: row.prompt_version,
      transcript: row.transcript,
      extractedJson: row.extracted_json,
      droppedFields,
      rawPayload: row.raw_payload,
      crmStatus: row.crm_status,
      crmRequest: row.crm_request,
      crmResponse: row.crm_response,
      crmAttempts: row.crm_attempts,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function parseMeetingJson(raw: string): Meeting {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const rec = parsed as { booked?: unknown; startsAt?: unknown };
      return {
        booked: rec.booked === true,
        startsAt: typeof rec.startsAt === "string" ? rec.startsAt : null,
      };
    }
  } catch {
    return { ...EMPTY_MEETING };
  }
  return { ...EMPTY_MEETING };
}
