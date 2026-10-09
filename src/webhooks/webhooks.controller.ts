import { Body, Controller, Headers, HttpCode, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { WebhookSignatureGuard } from "./signature.guard";
import { WebhooksService } from "./webhooks.service";

@Controller("webhooks")
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post("lead")
  @UseGuards(WebhookSignatureGuard)
  async lead(
    @Body() body: unknown,
    @Headers() headers: Record<string, string | undefined>,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.webhooks.ingestLead(body, headers);
    res.status(result.statusCode).json(result.body);
  }

  @Post("voice")
  @HttpCode(200)
  @UseGuards(WebhookSignatureGuard)
  async voice(
    @Body() body: unknown,
    @Headers() headers: Record<string, string | undefined>,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.webhooks.ingestVoice(body, headers);
    res.status(result.statusCode).json(result.body);
  }
}
