import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from "@nestjs/common";
import type { Response } from "express";
import { MappingFailure } from "../domain/errors";

@Catch()
export class MappingFailureFilter implements ExceptionFilter {
  private readonly log = new Logger(MappingFailureFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof MappingFailure) {
      this.log.warn(`${exception.code} ${exception.field ?? ""}`);
      res.status(exception.httpStatus).json(exception.toJSON());
      return;
    }
    if (exception instanceof HttpException) {
      res.status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    this.log.error(exception instanceof Error ? exception.message : "unhandled");
    res.status(500).json({
      error: { code: "INTERNAL", message: "internal error", field: null },
    });
  }
}
