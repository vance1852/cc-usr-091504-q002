import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateApplicationDto {
  @IsString()
  sessionId!: string;

  @IsString()
  mentorId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;

  /** 标记紧急换人（仍须双人确认，不缩短流程） */
  @IsOptional()
  @IsBoolean()
  emergency?: boolean;
}

export class ConfirmationDto {
  @IsIn(['approve', 'reject'])
  decision!: 'approve' | 'reject';

  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class GateScanDto {
  @IsString()
  @MinLength(1)
  gateId!: string;
}

export class IncidentDto {
  @IsIn([
    'credential_expired',
    'verification_revoked',
    'mentor_suspended',
    'out_of_scope',
    'other',
  ])
  type!:
    | 'credential_expired'
    | 'verification_revoked'
    | 'mentor_suspended'
    | 'out_of_scope'
    | 'other';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  detail?: string;

  @IsOptional()
  @IsString()
  passId?: string;
}
