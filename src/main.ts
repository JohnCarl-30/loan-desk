import "reflect-metadata";
import { config } from "dotenv";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { MappingFailureFilter } from "./http/mapping.filter";

config();

async function bootstrap(): Promise<void> {
  if (process.env.NODE_ENV === "production" && !process.env.WEBHOOK_SECRET?.trim()) {
    throw new Error("WEBHOOK_SECRET must be set in production; unsigned leads would be accepted");
  }
  // rawBody: the webhook signature is checked over the exact bytes received.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  app.useGlobalFilters(new MappingFailureFilter());
  const origin = process.env.CORS_ORIGIN?.trim();
  app.enableCors({ origin: origin && origin.length > 0 ? origin : true });

  if (process.env.NODE_ENV === "production") {
    const webDir = join(__dirname, "web");
    if (existsSync(webDir)) {
      app.useStaticAssets(webDir);
    }
  }

  const port = Number(process.env.PORT ?? 8787);
  await app.listen(port);
}

void bootstrap();
