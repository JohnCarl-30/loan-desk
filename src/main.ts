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
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
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
