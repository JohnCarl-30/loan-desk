import { Module } from "@nestjs/common";
import { QualifierController } from "./qualifier.controller";
import { QualifierService } from "./qualifier.service";

@Module({
  controllers: [QualifierController],
  providers: [QualifierService],
})
export class QualifierModule {}
