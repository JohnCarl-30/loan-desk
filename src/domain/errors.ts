export const ERROR_CODES = {
  PAYLOAD_MALFORMED: "PAYLOAD_MALFORMED",
  MISSING_EXTERNAL_ID: "MISSING_EXTERNAL_ID",
  MISSING_NAME: "MISSING_NAME",
  FIELD_MAPPING_FAILED: "FIELD_MAPPING_FAILED",
  MONEY_EMPTY: "MONEY_EMPTY",
  MONEY_INVALID: "MONEY_INVALID",
  MONEY_AMBIGUOUS: "MONEY_AMBIGUOUS",
  PHONE_INVALID: "PHONE_INVALID",
  UNKNOWN_PURPOSE: "UNKNOWN_PURPOSE",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  PAN_REFUSED: "PAN_REFUSED",
  EXTRACTION_INVALID: "EXTRACTION_INVALID",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type MappingError = {
  code: ErrorCode;
  message: string;
  field?: string;
};

export class MappingFailure extends Error {
  readonly code: ErrorCode;
  readonly field?: string;
  readonly httpStatus: 400 | 409 | 422;

  constructor(error: MappingError, httpStatus: 400 | 409 | 422 = 400) {
    super(error.message);
    this.name = "MappingFailure";
    this.code = error.code;
    this.field = error.field;
    this.httpStatus = httpStatus;
  }

  toJSON(): { error: { code: ErrorCode; message: string; field: string | null } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        field: this.field ?? null,
      },
    };
  }
}
