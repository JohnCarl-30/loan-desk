import { Module } from "@nestjs/common";
import { CrmModule } from "./crm/crm.module";
import { HealthController } from "./health.controller";
import { LeadsModule } from "./leads/leads.module";
import { QualifierModule } from "./qualifier/qualifier.module";
import { StoreModule } from "./store/store.module";
import { WebhooksModule } from "./webhooks/webhooks.module";

@Module({
  imports: [StoreModule, CrmModule, WebhooksModule, LeadsModule, QualifierModule],
  controllers: [HealthController],
})
export class AppModule {}
