import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { IsNotEmpty, IsString } from 'class-validator';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Organization } from '../../entities/organization.entity';
import { Role, Roles } from '../../common/auth';
import { newId } from '../../common/crypto.util';
import { Clock } from '../../common/clock';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

@Injectable()
export class OrgsService {
  constructor(
    @InjectRepository(Organization) private readonly repo: Repository<Organization>,
    private readonly clock: Clock,
  ) {}

  create(input: { name: string; contactName: string; contactPhone: string }) {
    return this.repo.save(
      this.repo.create({
        id: newId(),
        name: input.name,
        contactName: input.contactName,
        contactPhone: input.contactPhone,
        createdAt: this.clock.now().toISOString(),
      }),
    );
  }

  findAll() {
    return this.repo.find();
  }

  findOne(id: string) {
    return this.repo.findOne({ where: { id } });
  }
}

class CreateOrgDto {
  @IsString() @IsNotEmpty()
  name: string;

  @IsString() @IsNotEmpty()
  contactName: string;

  @IsString() @IsNotEmpty()
  contactPhone: string;
}

@Controller('orgs')
export class OrgsController {
  constructor(private readonly svc: OrgsService) {}

  @Post()
  @Roles(Role.ADMIN)
  create(@Body() dto: CreateOrgDto) {
    return this.svc.create(dto);
  }

  @Get()
  @Roles(Role.ADMIN, Role.SAFETY_OFFICER, Role.COURSE_LEAD)
  list() {
    return this.svc.findAll();
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.SAFETY_OFFICER, Role.COURSE_LEAD)
  get(@Param('id') id: string) {
    return this.svc.findOne(id);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([Organization])],
  controllers: [OrgsController],
  providers: [OrgsService],
  exports: [OrgsService],
})
export class OrgsModule {}
