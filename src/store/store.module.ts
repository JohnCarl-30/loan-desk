import { Global, Module } from "@nestjs/common";
import { LeadStore } from "./lead-store";

@Global()
@Module({
  providers: [
    {
      provide: LeadStore,
      useFactory: () => new LeadStore(process.env.DATABASE_PATH ?? "./data/loandesk.sqlite"),
    },
  ],
  exports: [LeadStore],
})
export class StoreModule {}
