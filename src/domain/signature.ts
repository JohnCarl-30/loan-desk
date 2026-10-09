import { createHmac, timingSafeEqual } from "node:crypto";

/** Lead sources sign `${timestamp}.${rawBody}` with the shared secret. */
export const SIGNATURE_HEADER = "x-loandesk-signature";
export const TIMESTAMP_HEADER = "x-loandesk-timestamp";

/** A signed request older (or newer) than this is a replay, not a retry. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export type SignatureFailure = "SIGNATURE_MISSING" | "SIGNATURE_INVALID" | "SIGNATURE_EXPIRED";

export function signPayload(secret: string, timestamp: string, rawBody: Buffer | string): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
  return `sha256=${mac}`;
}

/**
 * Checks the HMAC over the exact bytes received, not a re-serialized body: a
 * provider's key order or whitespace must not decide whether a lead is accepted.
 * Returns null when the request is authentic.
 */
export function verifySignature(input: {
  secret: string;
  rawBody: Buffer;
  timestamp: string | undefined;
  signature: string | undefined;
  nowSeconds: number;
}): SignatureFailure | null {
  const { secret, rawBody, timestamp, signature, nowSeconds } = input;
  if (!timestamp || !signature) return "SIGNATURE_MISSING";

  if (!/^\d+$/.test(timestamp)) return "SIGNATURE_INVALID";
  if (Math.abs(nowSeconds - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) {
    return "SIGNATURE_EXPIRED";
  }

  const expected = Buffer.from(signPayload(secret, timestamp, rawBody));
  const received = Buffer.from(signature.trim());
  if (expected.length !== received.length) return "SIGNATURE_INVALID";
  return timingSafeEqual(expected, received) ? null : "SIGNATURE_INVALID";
}
