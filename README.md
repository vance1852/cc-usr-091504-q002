# 校外导师准入与当日通行凭证系统

面向学校课后课程负责人、校园安全人员与门岗，管理校外编程导师及**临时代课人员**的入校与授课资格。系统把「服务机构 → 导师身份 → 资质文件 → 培训记录 → 允许接触的年级/课程」关联起来，并为每次入校签发**只覆盖当日职责**的通行凭证，降低临时换人带来的未成年人保护风险。

技术栈：**NestJS 11 + TypeScript（严格模式）+ SQLite（Node 22 内置 `node:sqlite`，同步 API）+ Jest/supertest**。

---

## 一、核心安全规则

1. **代课必须双人、双角色、分别确认**
   - 课程负责人（`program_lead`）先确认教学必要性；
   - 校园安全人员（`campus_security`）后确认安全资格；
   - 角色互斥（不同接口 + 不同账户），顺序固定，任何一人可驳回；
   - **紧急换人不缩短流程、不豁免任何门槛**（`emergency` 仅做留痕标记）。
2. **资格 fail-closed**，在三个时点用同一套规则实时判定：
   - 审批确认时、发证时、门岗每次扫码时；
   - 任一项不满足即拒绝：导师/机构被暂停、身份未核验或被驳回、无有效资质或资质已过期、未完成未成年人保护培训或培训过期、接触年级/课程不在授权范围。
3. **当日通行凭证最小化**
   - 凭证编码为 32 字节随机 hex，不可枚举；
   - 有效期严格限定 `开课前 30 分钟 ~ 结课后 30 分钟`，只含当日、当堂、地点、年级范围；
   - 状态机 `ACTIVE → USED → EXITED`，可随时 `REVOKED`；入校一次性，重复出示即拒绝（**防重放**）。
4. **课程开始后发现资格问题**
   - 负责人或安全人员上报异常 → 凭证立即吊销，**停止后续通行**（不可再次入校）；
   - 同时冻结「已发生授课与接触范围」快照（入校/离校时间、实际接触学生的最小信息、年级/课程/地点），供事后复核，吊销不会抹掉快照；
   - 已在校内的人员仍可登记离校（避免滞留），但凭证不复活。
5. **数据最小化 / 租户隔离**
   - 导师只能读取**本人当前课程**花名册的 `code + name`，看不到校方备注，其他课程不可读；
   - 机构管理员只能访问**本机构**资料（机构、导师、申请、列表过滤）；
   - 门岗只能得到**放行结论 + 必要身份摘要**（姓名、掩码证件号、年级/课程/地点/有效期），得不到学生信息与资质细节。
6. **全量审计**：申请、双确认、发证、门岗进出、异常处置、自动/人工吊销均写入 append-only `audit_log`，负责人可按一次代课聚合追溯完整时间线。
7. **跨午夜课程**：`endTime <= startTime` 自动视为次日结束，凭证窗顺延至次日凌晨，但凭证始终归属开课当日，第二晚不可复用。

## 二、运行

需要 Node ≥ 22（使用内置 SQLite，需 `--experimental-sqlite`）。

```bash
npm install
npm run build

# 内存库（默认）
npm start

# 文件库 + 写入演示数据
npm run seed:serve          # SQLITE_FILE=data/admissions.sqlite SEED_ON_BOOT=1

# 测试（内置 29 个 e2e 用例）
npm test
```

演示账户（固定 ID，用请求头 `X-Actor-User-Id` 扮演）：
`u-lead`（负责人）/ `u-security`（安全人员）/ `u-guard`（门岗）/ `u-admin`（机构管理员）/ `u-mentor`（导师本人）。
演示数据包含：合格导师 `m-qualified` 的已发证凭证 `p-demo`，以及新助教 `m-newta`（未核验、未完成未保培训）的紧急换人申请 `a-demo-emergency`。

测试环境可通过 `ALLOW_CLOCK_OVERRIDE=1` + 请求头 `X-Now-Ms: <epoch毫秒>` 精确控制"当前时间"（生产环境该头被忽略）。

## 三、身份与鉴权

所有接口必须携带 `X-Actor-User-Id`；守卫从 `users` 表加载角色与机构归属，配合 `@Roles(...)` 做角色校验。生产可将该守卫替换为 JWT/会话，权限判定逻辑不变。

## 四、API 概览

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| POST | `/agencies` | lead | 建服务机构 |
| GET | `/agencies/:id` | 认证 | 机构管理员仅限本机构 |
| PATCH | `/agencies/:id/suspension` | lead, security | 暂停/恢复机构（即时影响资格） |
| POST | `/users` | lead | 开立账户 |
| POST | `/mentors` | lead, agency_admin | 导师建档（管理员仅限本机构） |
| GET | `/mentors/:id` | lead, security, agency_admin, mentor | 证件号对非校方角色掩码 |
| GET | `/mentors/:id/eligibility-check?grade=&subject=` | lead, security, agency_admin | 实时资格判定 |
| POST | `/mentors/:id/credentials` | lead, agency_admin | 资质文件 |
| PATCH | `/credentials/:id/revoke` | lead, security | 撤销资质 |
| POST | `/mentors/:id/trainings` | lead, agency_admin | 培训记录（`minor_protection` 强制） |
| POST | `/mentors/:id/contact-authorizations` | lead, security | 授权年级×课程 |
| PATCH | `/contact-authorizations/:id/revoke` | lead, security | 撤销接触授权 |
| PATCH | `/mentors/:id/verification` | security | 身份核验结论 |
| PATCH | `/mentors/:id/suspension` | lead, security | 暂停导师并**自动吊销在用凭证** |
| POST | `/sessions` | lead | 课程时段（支持跨午夜、含花名册） |
| GET | `/sessions/:id/roster` | lead, security, mentor | 导师仅限本人当前课程的最小信息 |
| POST | `/applications` | lead, agency_admin | 代课/入校申请（可 `emergency`） |
| GET | `/applications` | lead, security, agency_admin | 列表（管理员自动过滤本机构） |
| POST | `/applications/:id/lead-confirmation` | lead | 第一步：负责人 approve/reject |
| POST | `/applications/:id/security-confirmation` | security | 第二步：安全人员 approve/reject |
| POST | `/applications/:id/pass` | lead | 双人确认后签发当日凭证（一申请一凭证） |
| POST | `/gate/passes/:code/verify` | gate_guard | 只核验不落回执 |
| POST | `/gate/passes/:code/entry` | gate_guard | 入校（窗内 + 资格实时通过，一次性） |
| POST | `/gate/passes/:code/exit` | gate_guard | 离校（吊销后仍可离校） |
| POST | `/incidents` | lead, security | 异常处置：立即吊销 + 冻结接触快照 |
| POST | `/passes/:id/revoke` | lead, security | 人工吊销 |
| GET | `/passes/:id` | lead, security, gate_guard | 门岗只得到状态+身份摘要 |
| GET | `/applications/:id/timeline` | lead, security | 申请/审核/凭证/进出回执/异常/审计聚合追溯 |

## 五、目录结构

```
src/
  domain.ts                          角色/状态、跨午夜时间组合
  database/                          SQLite 连接与全量 schema（含审计表）
  common/                            身份守卫、@Roles、时钟、审计
  eligibility/eligibility.service.ts 资格判定引擎（审批/发证/门岗共用）
  agencies/ mentors/ sessions/       机构、导师档案、课程时段
  applications/                      申请、双人确认、凭证、门岗、异常、时间线
  seed/                              SEED_ON_BOOT 演示数据
test/
  permissions.e2e-spec.ts            角色越权、机构隔离、数据最小化
  pass-replay.e2e-spec.ts            凭证重放、时间窗、跨午夜
  eligibility.e2e-spec.ts            未核验/过期/培训缺失/越范围/暂停
  incidents.e2e-spec.ts              异常吊销、接触快照留存、追溯时间线
```

## 六、边界测试如何证明有效

- **权限**：无/伪造身份 401；角色越权 403；机构管理员跨机构读导师/机构/申请均 403 而本机构 200；门岗与机构管理员读花名册 403；双确认接口角色互斥。
- **凭证重放**：正常入校后二次出示 → `ALREADY_ENTERED`；离校后复用 → `ALREADY_EXITED`；伪造编码 → `PASS_NOT_FOUND`（不泄露存在性）；窗外 → `NOT_WITHIN_WINDOW`/`PASS_WINDOW_CLOSED`；次日/第二晚复用旧凭证被拒。
- **跨午夜**：`23:00–00:30` 的课，凭证窗为当日 `22:30` 至次日 `01:00`，次日凌晨 00:10 可入校、01:30 拒绝，`scopeDate` 始终是开课当日。
