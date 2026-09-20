import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class RosterEntryDto {
  /** 学生代号（去标识化主键，如 S-G3-018） */
  @IsString()
  @MinLength(1)
  code!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  /** 仅校方可见的备注（健康/接送等），不对导师与门岗下发 */
  @IsOptional()
  @IsString()
  note?: string;
}

export class CreateSessionDto {
  @IsString()
  @MinLength(1)
  subject!: string;

  @Matches(/^G\d+$/)
  grade!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date!: string; // 开课当地日期

  @Matches(/^\d{2}:\d{2}$/)
  startTime!: string;

  /** endTime <= startTime 表示跨午夜 */
  @Matches(/^\d{2}:\d{2}$/)
  endTime!: string;

  @IsString()
  @MinLength(1)
  location!: string;

  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => RosterEntryDto)
  roster!: RosterEntryDto[];

  @IsOptional()
  @IsString()
  defaultMentorId?: string;
}
