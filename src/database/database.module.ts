import { Global, Module } from '@nestjs/common';
import { DbService } from './database.service';

@Global()
@Module({
  providers: [
    { provide: 'SQLITE_FILE', useValue: process.env.SQLITE_FILE || ':memory:' },
    DbService,
  ],
  exports: [DbService],
})
export class DatabaseModule {}
