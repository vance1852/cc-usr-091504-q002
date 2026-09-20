# 校外导师准入系统

面向学校课后课程负责人、校园安全人员和门岗的校外导师（含临时代课）准入服务。
系统将**服务机构、导师身份、资质文件、培训记录、允许接触范围（年级/时段）**关联起来，
为每次入校签发**只覆盖当日当次课职责的通行凭证**，并对代课全流程留痕可追溯。

技术栈：NestJS 10 + TypeORM + SQLite（better-sqlite3）+ JWT，全部时间按 UTC 处理。

## 快速开始

```bash
npm install          # 如 better-sqlite3 编译缺头文件：npm install --nodedir=/usr/local
npm run build
npm start            # 默认端口 3000，首次启动写入演示数据（SEED=false 可关闭）
npm test             # 43 个 e2e 用例：权限 / 凭证重放 / 跨午夜 / 资格 / 双人确认 / 异常处置
```

演示账号（口令均为 `Passw0rd!`，仅本地演示）：
`admin` 系统管理员、`lead1` 课程负责人、`safety1` 安全员、`guard1` 门岗、
`orgA_admin`/`orgB_admin` 机构管理员、`mentorA` 导师（王工，已核验）。
种子数据里另有**未完成核验与培训的新助教「小李」**——对他发起代课会被系统直接拒绝。

## 核心规则

| 规则 | 实现 |
| --- | --- |
| 资质过期、核验未完成、被暂停、培训缺失、超出允许接触范围者**不得代课** | `EligibilityService` 在代课申请、批准、凭证签发、门岗扫码**四个环节**统一评估 |
| 紧急换人须课程负责人与安全人员**分别确认**（两个不同账号） | `SubstitutionsService.confirm`，普通代课仅需负责人确认；批准前重新评估资格 |
| 每次入校一张凭证，仅覆盖当日当次课职责 | 窗口 = 课次区间 ±30 分钟；库中只存令牌 SHA-256 摘要，明文签发时返回一次 |
| 凭证重放拦截 | 入校后状态置 USED，再次入校扫码判 `重放` 拒绝；每次扫码（含拒绝）写回执 |
| 跨午夜课程 | `endTime <= startTime` 视为次日结束；接触范围时间窗同样支持跨零点（`src/common/time.util.ts`） |
| 课中发现资格问题立即停止后续通行 | `POST /incidents`：导师暂停 + 吊销其全部未消耗凭证 + 未结束课次标记 FLAGGED；门岗扫码时还会按当前时刻重新评估资格，双重拦截 |
| 已发生授课与接触范围保留供复核 | 历史课次、门岗回执、接触名单只读保留：`GET /instructors/:id/exposure` |
| 导师最小学生信息 | 导师仅见本人被指派课次的 `{显示名, 年级, 安全备注}`；负责人/安全员见完整名单 |
| 机构数据隔离 | 机构管理员一切操作限定本机构（`assertOrgScope`），跨机构访问 403 |
| 门岗最小结论 | 门岗只得到 `ALLOW/DENY + 姓名/机构/脱敏证件号/当日职责/有效窗口` |
| 全程追溯 | `GET /substitutions/:id/trace`：申请 → 双方确认 → 凭证 → 进出回执 → 异常处置 + 审计链 |

## 角色

`ADMIN` 系统管理员 · `COURSE_LEAD` 课程负责人 · `SAFETY_OFFICER` 校园安全人员 ·
`ORG_ADMIN` 机构管理员（限本机构） · `GATE_GUARD` 门岗 · `INSTRUCTOR` 导师

## API 一览

所有接口除 `POST /auth/login` 外均需 `Authorization: Bearer <JWT>`。

| 方法/路径 | 角色 | 说明 |
| --- | --- | --- |
| `POST /auth/login` | 公开 | 登录换取 JWT |
| `POST /orgs` · `GET /orgs` | ADMIN / 校务 | 机构管理 |
| `GET/POST /orgs/:orgId/instructors` | ORG_ADMIN(本机构)/ADMIN | 导师登记，证件号返回即脱敏 |
| `POST /instructors/:id/qualifications` | ORG_ADMIN/ADMIN | 提交资质文件 |
| `POST /qualifications/:qid/review` | SAFETY_OFFICER/ADMIN | 核准/驳回资质 |
| `POST /instructors/:id/verify` | SAFETY_OFFICER/ADMIN | 完成身份核验 |
| `POST /instructors/:id/suspend` · `/reinstate` | SAFETY_OFFICER/ADMIN | 暂停/恢复 |
| `POST /instructors/:id/trainings` | ORG_ADMIN/ADMIN | 登记培训记录（含未成年人保护培训） |
| `POST /instructors/:id/clearances` | SAFETY_OFFICER/ADMIN | 授予允许接触范围（年级+星期+时间窗，支持跨午夜） |
| `GET /instructors/:id/exposure` | SAFETY/LEAD/ADMIN | 已发生授课与接触学生名单（复核用） |
| `POST /courses` · `POST /courses/:id/sessions` · `POST /courses/:id/enrollments` | COURSE_LEAD/ADMIN | 课程、课次（支持跨午夜）、选课 |
| `GET /sessions/:id/roster` | INSTRUCTOR(本人课次,最小信息)/LEAD/SAFETY/ADMIN | 学生名单 |
| `POST /substitutions` | COURSE_LEAD/ADMIN | 代课申请（创建即资格预审，不合格判 `ELIGIBILITY_FAILED`） |
| `POST /substitutions/:id/confirm` | COURSE_LEAD + SAFETY_OFFICER | 确认；紧急代课需两方分别确认，批准响应一次性返回凭证明文 |
| `POST /substitutions/:id/reject` | LEAD/SAFETY/ADMIN | 驳回 |
| `GET /substitutions/:id/trace` | LEAD/SAFETY/ADMIN | 代课全程追溯 |
| `POST /sessions/:id/pass` | COURSE_LEAD/ADMIN | 为课次当前导师签发当日凭证（明文仅本次返回） |
| `POST /gate/verify` | GATE_GUARD | 门岗核验 `{token, direction: IN/OUT}` → 放行结论 + 必要身份摘要 |
| `POST /incidents` | SAFETY_OFFICER/ADMIN | 资格异常上报：暂停导师、吊销凭证、标记待复核课次 |

## 测试边界证明（`npm test`，43 例）

- `test/eligibility.e2e-spec.ts` — 核验未完成 / 资质过期（含课中到期）/ 未保培训缺失 / 已暂停 / 超出接触范围，均不得代课
- `test/substitution-approval.e2e-spec.ts` — 紧急换人双人分别确认、重复确认拦截、越权角色 403、批准前资格重评
- `test/permissions.e2e-spec.ts` — 跨机构隔离、导师最小名单、门岗/未认证访问拦截
- `test/pass-replay.e2e-spec.ts` — 凭证重放拒绝并留痕、时间窗、未知令牌、吊销、出入校状态机、门岗响应最小化
- `test/cross-midnight.e2e-spec.ts` — 22:30–次日01:30 课次的凭证窗口与接触范围跨零点判定、次夜失效
- `test/incident-trace.e2e-spec.ts` — 课中异常：立即停止后续通行 + 历史保留 + trace 全链路还原

## 环境变量

`PORT`（默认 3000）· `DB_PATH`（默认 ./data.sqlite）· `JWT_SECRET`（生产必须设置）· `SEED=false` 关闭演示数据
