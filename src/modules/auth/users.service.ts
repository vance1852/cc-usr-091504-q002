import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../entities/user.entity';
import { Role } from '../../common/auth';
import { hashPassword, newId } from '../../common/crypto.util';
import { Clock } from '../../common/clock';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly repo: Repository<User>,
    private readonly clock: Clock,
  ) {}

  async create(input: {
    username: string;
    password: string;
    displayName: string;
    role: Role;
    orgId?: string | null;
    instructorId?: string | null;
  }): Promise<User> {
    const user = this.repo.create({
      id: newId(),
      username: input.username,
      passwordHash: hashPassword(input.password),
      displayName: input.displayName,
      role: input.role,
      orgId: input.orgId ?? null,
      instructorId: input.instructorId ?? null,
      createdAt: this.clock.now().toISOString(),
    });
    return this.repo.save(user);
  }

  findByUsername(username: string): Promise<User | null> {
    return this.repo.findOne({ where: { username } });
  }

  findById(id: string): Promise<User | null> {
    return this.repo.findOne({ where: { id } });
  }
}
