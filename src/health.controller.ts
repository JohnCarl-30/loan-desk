import { Controller, Get } from "@nestjs/common";
import { PROMPT_VERSION_DEFAULT } from "./domain/prompt";

@Controller("api")
export class HealthController {
  @Get("health")
  health() {
    return {
      ok: true,
      promptVersion: process.env.PROMPT_VERSION ?? PROMPT_VERSION_DEFAULT,
    };
  }
}
