import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from "../domain/signature";

/**
 * Rejects an unsigned or forged lead before it touches the store. Runs ahead of
 * idempotency on purpose: an attacker must not be able to claim a key first.
 *
 * With WEBHOOK_SECRET unset the check is off, so local curl demos still work.
 * main.ts refuses to boot in production without it.
 */
@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  private readonly log = new Logger(WebhookSignatureGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const secret = process.env.WEBHOOK_SECRET?.trim();
    if (!secret) return true;

    const req = context.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();
    if (!req.rawBody) {
      // The app was created without { rawBody: true }. Fail closed.
      throw new Error("raw body unavailable for webhook signature check");
    }

    const failure = verifySignature({
      secret,
      rawBody: req.rawBody,
      timestamp: req.header(TIMESTAMP_HEADER),
      signature: req.header(SIGNATURE_HEADER),
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (failure) {
      this.log.warn(`${failure} ${req.path}`);
      throw new UnauthorizedException({
        error: { code: failure, message: "webhook signature check failed", field: SIGNATURE_HEADER },
      });
    }
    return true;
  }
}
