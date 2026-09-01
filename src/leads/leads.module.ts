import { Module } from "@nestjs/common";
import { LeadsController } from "./leads.controller";

@Module({
  controllers: [LeadsController],
})
export class LeadsModule {}
