import { Column, Entity, PrimaryColumn } from 'typeorm';

/** 校外服务机构 */
@Entity('organizations')
export class Organization {
  @PrimaryColumn('text')
  id: string;

  @Column('text')
  name: string;

  @Column('text')
  contactName: string;

  @Column('text')
  contactPhone: string;

  @Column('text')
  createdAt: string;
}
