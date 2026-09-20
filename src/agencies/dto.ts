import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateAgencyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;
}

export class CreateUserDto {
  @IsString()
  @MinLength(2)
  displayName!: string;

  @IsIn(['agency_admin', 'program_lead', 'campus_security', 'gate_guard', 'mentor'])
  role!:
    | 'agency_admin'
    | 'program_lead'
    | 'campus_security'
    | 'gate_guard'
    | 'mentor';

  /** role=agency_admin 时必填，且必须是已存在的机构 */
  @IsOptional()
  @IsString()
  agencyId?: string;

  /** role=mentor 时绑定导师档案 */
@IsOptional()
  @IsString()
  mentorId?: string;
}
