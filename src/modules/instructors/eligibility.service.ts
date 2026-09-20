import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Instructor, InstructorStatus } from '../../entities/instructor.entity';
import {
  QualificationDocument,
  QualificationStatus,
} from '../../entities/qualification.entity';
import { TrainingRecord, TrainingType } from '../../entities/training.entity';
import { Clearance } from '../../entities/clearance.entity';
import { CourseSession } from '../../entities/course-session.entity';
import { Course } from '../../entities/course.entity';
import { contains, dayInterval, weekdayOf } from '../../common/time.util';

export interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
}

/**
 * 授课资格评估：代课申请、凭证签发、门岗放行三个环节共用同一套判定，
 * 保证「资质过期 / 核验未完成 / 已暂停 / 超出允许接触范围」在任何入口都被拦截。
 */
@Injectable()
export class EligibilityService {
  constructor(
    @InjectRepository(Instructor)
    private readonly instructors: Repository<Instructor>,
    @InjectRepository(QualificationDocument)
    private readonly qualifications: Repository<QualificationDocument>,
    @InjectRepository(TrainingRecord)
    private readonly trainings: Repository<TrainingRecord>,
    @InjectRepository(Clearance)
    private readonly clearances: Repository<Clearance>,
  ) {}

  async evaluate(instructorId: string, session: CourseSession, course: Course): Promise<EligibilityResult> {
    const reasons: string[] = [];
    const instructor = await this.instructors.findOne({ where: { id: instructorId } });
    if (!instructor) {
      return { eligible: false, reasons: ['导师档案不存在'] };
    }

    // 1. 身份核验状态
    if (instructor.status === InstructorStatus.PENDING) {
      reasons.push('身份核验未完成');
    } else if (instructor.status === InstructorStatus.SUSPENDED) {
      reasons.push(`该导师已被暂停：${instructor.suspensionReason ?? '未注明原因'}`);
    }

    const sessionInterval = dayInterval(session.date, session.startTime, session.endTime);
    const sessionEndIso = sessionInterval.end.toISOString();

    // 2. 资质文件：至少一份已核准且覆盖到课次结束
    const quals = await this.qualifications.find({ where: { instructorId } });
    const validQual = quals.some(
      (q) =>
        q.status === QualificationStatus.APPROVED &&
        (q.expiresAt === null || q.expiresAt > sessionEndIso),
    );
    if (!validQual) {
      reasons.push('缺少覆盖本次授课的有效资质文件（未提交、未核准或已过期）');
    }

    // 3. 未成年人保护培训：必须完成且在有效期内
    const trainings = await this.trainings.find({ where: { instructorId } });
    const validTraining = trainings.some(
      (t) =>
        t.type === TrainingType.MINOR_PROTECTION &&
        (t.expiresAt === null || t.expiresAt > sessionEndIso),
    );
    if (!validTraining) {
      reasons.push('未成年人保护培训缺失或已过期');
    }

    // 4. 允许接触范围：年级 + 星期 + 时间窗（跨午夜感知）
    const clearances = await this.clearances.find({ where: { instructorId } });
    const weekday = weekdayOf(session.date);
    const covered = clearances.some((c) => {
      if (c.gradeLevel !== course.gradeLevel || c.weekday !== weekday) return false;
      const window = dayInterval(session.date, c.windowStart, c.windowEnd);
      return contains(window, sessionInterval);
    });
    if (!covered) {
      reasons.push(
        `不在允许的接触范围内（需覆盖 ${course.gradeLevel} 年级、周${'日一二三四五六'[weekday]} ${session.startTime}-${session.endTime}）`,
      );
    }

    return { eligible: reasons.length === 0, reasons };
  }
}
