import { Column, Entity, PrimaryColumn } from 'typeorm';
import { Role } from '../common/auth';

@Entity('users')
export class User {
  @PrimaryColumn('text')
  id: string;

  @Column('text', { unique: true })
  username: string;

  @Column('text')
  passwordHash: string;

  @Column('text')
  displayName: string;

  @Column('text')
  role: Role;

  /** ORG_ADMIN 所属机构 */
  @Column('text', { nullable: true })
  orgId: string | null;

  /** INSTRUCTOR 账号关联的导师档案 */
  @Column('text', { nullable: true })
  instructorId: string | null;

  @Column('text')
  createdAt: string;
}
