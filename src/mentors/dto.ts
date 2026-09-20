import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateMentorDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  fullName!: string;

  @IsString()
  @MinLength(4)
  @MaxLength(40)
  idDocumentNo!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsString()
  agencyId!: string;
}

export class CreateCredentialDto {
  @IsString()
  @MinLength(1)
  type!: string;

  @IsString()
  @MinLength(1)
  fileRef!: string;

  /** epoch 毫秒 */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  issuedAt!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  expiresAt!: number;
}

export class CreateTrainingDto {
  @IsIn(['minor_protection', 'campus_safety'])
  type!: 'minor_protection' | 'campus_safety';

  @Type(() => Number)
  @IsInt()
  @Min(0)
  completedAt!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  expiresAt!: number;

  @IsString()
  @MinLength(1)
  provider!: string;
}

export class ContactAuthDto {
  @IsString()
  @Matches(/^G\d+$/, { message: 'grade 需形如 G3' })
  grade!: string;

  @IsString()
  @MinLength(1)
  subject!: string;
}

export class VerificationDecisionDto {
  @IsIn(['verified', 'rejected'])
  decision!: 'verified' | 'rejected';

  @IsOptional()
  @IsString()
  note?: string;
}
