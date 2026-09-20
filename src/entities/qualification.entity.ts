import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum QualificationType {
  TEACHING_CERT = 'TEACHING_CERT',
  BACKGROUND_CHECK = 'BACKGROUND_CHECK',
  DEGREE = 'DEGREE',
  OTHER = 'OTHER',
}

export enum QualificationStatus {
  SUBMITTED = 'SUBMITTED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

/** 资质文件（教师资格证、无犯罪记录证明等） */
@Entity('qualification_documents')
export class QualificationDocument {
  @PrimaryColumn('text')
  id: string;

  @Column('text')
  instructorId: string;

  @Column('text')
  type: QualificationType;

  @Column('text')
  docNumber: string;

  @Column('text')
  issuedAt: string;

  /** 到期日（ISO）；null 表示长期有效 */
  @Column('text', { nullable: true })
  expiresAt: string | null;

  @Column('text')
  status: QualificationStatus;

  @Column('text', { nullable: true })
  reviewedBy: string | null;

  @Column('text', { nullable: true })
  reviewedAt: string | null;

  @Column('text')
  createdAt: string;
}
