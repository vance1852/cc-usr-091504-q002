import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DatabaseModule } from './database/database.module';
import { CommonModule } from './common/common.module';
import { EligibilityModule } from './eligibility/eligibility.module';
import { AgenciesModule } from './agencies/agencies.module';
import { MentorsModule } from './mentors/mentors.module';
import { SessionsModule } from './sessions/sessions.module';
import { ApplicationsModule } from './applications/applications.module';
import { SeedModule } from './seed/seed.module';
import { ActorGuard } from './common/actor.guard';

@Module({
  imports: [
    DatabaseModule,
    CommonModule,
    EligibilityModule,
    AgenciesModule,
    MentorsModule,
    SessionsModule,
    ApplicationsModule,
    SeedModule,
  ],
  providers: [
    // 全局守卫：所有接口必须携带身份；具体角色由 @Roles 限定
    { provide: APP_GUARD, useClass: ActorGuard },
  ],
})
export class AppModule {}
