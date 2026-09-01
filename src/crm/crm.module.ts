import { Global, Module } from "@nestjs/common";
import { CrmService } from "./crm.service";

@Global()
@Module({
  providers: [CrmService],
  exports: [CrmService],
})
export class CrmModule {}
