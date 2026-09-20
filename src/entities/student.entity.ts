import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * 学生档案。导师端仅暴露最小必要字段（见 CoursesService.rosterForInstructor）：
 * 显示名、年级、安全备注；监护人电话、家庭信息等不出校务/安全角色。
 */
@Entity('students')
export class Student {
  @PrimaryColumn('text')
  id: string;

  @Column('text')
  fullName: string;

  @Column('text')
  gradeLevel: string;

  /** 安全相关备注（过敏、接送限制等），属于授课最小必要信息 */
  @Column('text', { nullable: true })
  safetyNotes: string | null;

  /** 监护人联系电话（敏感，导师不可见） */
  @Column('text')
  guardianPhone: string;

  @Column('text')
  createdAt: string;
}
