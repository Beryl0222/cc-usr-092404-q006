# 儿童联系人跨品牌互通

本项目用于整理儿童联系人跨品牌互通领域中的事件名称、交换字段与脱敏样例，方便业务、运营和研发人员在同一套术语下讨论后续服务。资料只包含领域约定，不包含真实个人信息、生产连接或外部账号。

在此之上，本合同定义了**跨机构授权联邦**：监护关系、儿童别名、可联系用途、有效期、机构信任、介绍证明和联系方式验证各自版本化；接收机构只取得本次照护所需的最小能力，不复制完整通讯录。所有 `*_ref` 与 `*_id` 均为脱敏标识，联系方式只以掩码形式出现。

## 目录

- `src/child_contact_federation.js`：事件种类、字段约定、单事件校验（`validateEvent`）、数据集审计（`auditDataset`）、合并（`dedupeByEventId` / `mergeOfflineConfirmations`）与追溯（`traceDecision`）。
- `data/sample.json`：单事件虚构样例。
- `data/scenario.json`：覆盖完整生命周期的虚构事件流（含一条重复投递的确认消息）。
- `tests/`：保证样例与领域约定保持一致。

## 七类版本化对象

每类对象有独立的标识字段与版本字段，变更即产生新版本，旧版本留痕供追溯。

| 对象 | 标识字段 | 版本字段 | 相关事件 |
| --- | --- | --- | --- |
| 监护关系 | `relation_id` | `relation_version` | `GUARDIAN_LINKED`、`RELATIONSHIP_REVOKED` |
| 儿童别名 | `alias_id` | `alias_version` | `CHILD_ALIAS_REGISTERED` |
| 可联系用途 | `purpose_code` | `purpose_version` | `CONTACT_PURPOSE_UPDATED` |
| 有效期 | `window_id` | `window_version` | `VALIDITY_WINDOW_SET` |
| 机构信任 | `org_ref` | `trust_version` | `ORG_TRUST_UPDATED`、`ORG_EXITED` |
| 介绍证明 | `proof_id` | `proof_version` | `INTRO_PROOF_ISSUED` |
| 联系方式验证 | `contact_id` | `contact_version` | `CONTACT_CONFIRMED`、`CONTACT_ROTATED` |

## 事件目录

公共字段：`event_id`、`kind`、`occurred_at`、`subject_id`、`payload`。`subject_id` 是事件主语的脱敏引用：儿童作用域事件为 `child_ref`；`CONTACT_CONFIRMED` / `CONTACT_ROTATED` 为 `guardian_ref`；`ORG_TRUST_UPDATED` / `ORG_EXITED` 为 `org_ref`；`CONTACT_PURPOSE_UPDATED` / `VALIDITY_WINDOW_SET` 为 `federation`；`CAPABILITY_EXPIRED` 为 `capability_id`。

| kind | 含义 | 关键 payload 字段 |
| --- | --- | --- |
| `GUARDIAN_LINKED` | 监护关系建立或新版本 | `relation_id`、`relation_version`、`guardian_ref`、`decision_weight` |
| `RELATIONSHIP_REVOKED` | 监护关系撤回 | `relation_id`、`revoked_relation_version`、`effective_at` |
| `CHILD_ALIAS_REGISTERED` | 儿童在某机构的别名版本 | `alias_id`、`alias_version`、`org_ref`、`alias_value_masked` |
| `CONTACT_PURPOSE_UPDATED` | 可联系用途版本 | `purpose_code`、`purpose_version`、`risk_level` |
| `VALIDITY_WINDOW_SET` | 有效期窗口版本 | `window_id`、`window_version`、`not_before`、`not_after` |
| `ORG_TRUST_UPDATED` | 机构信任版本 | `org_ref`、`trust_version`、`allowed_purpose_codes`、`max_capability_scope` |
| `ORG_EXITED` | 机构退出联邦 | `org_ref`、`exit_at` |
| `INTRO_PROOF_ISSUED` | 介绍证明签发（绑定单一儿童与接收机构） | `proof_id`、`proof_version`、`child_ref`、`issued_to_org`、`nonce`、`scope_purpose_codes` |
| `CONTACT_CONFIRMED` | 联系方式验证版本（支持离线来源） | `contact_id`、`contact_version`、`channel_value_masked`、`source_id`、`source_seq` |
| `CONTACT_ROTATED` | 联系方式轮换，旧版本退役 | `contact_id`、`retired_contact_version`、`rotated_at` |
| `CAPABILITY_GRANTED` | 最小能力授予 | `capability_id`、`allowed_purpose_codes`、`allowed_contacts`、`basis`、`expires_at` |
| `CAPABILITY_EXPIRED` | 到期收权（系统事件，幂等） | `capability_id`、`expired_at`、`sweep_id` |
| `GUARDIAN_CONFLICT_RECORDED` | 多监护人意见冲突 | `conflict_id`、`guardian_refs`、`conflicting_fields` |
| `HIGH_RISK_CHANGE_FROZEN` | 按生效规则冻结高风险变更 | `freeze_id`、`conflict_ref`、`frozen_change_ref`、`rule_ref` |
| `HIGH_RISK_CHANGE_RELEASED` | 冲突解决后解冻 | `freeze_id`、`released_by`、`resolution` |
| `BREAK_GLASS_ACCESS_RECORDED` | 紧急联系受限突破记录 | `access_id`、`justification`、`follow_up_required_by` |
| `CONTACT_DECISION_RECORDED` | 联系决定留痕（追溯锚点） | `decision_id`、`outcome`、`basis` |

## 保障规则

`auditDataset` 先做重复与离线合并，再执行以下检查；问题以 `规则: 详情` 形式返回。

### 最小能力

- `CAPABILITY_GRANTED.allowed_contacts` 必须逐个点名并钉住 `contact_version`，禁止通配与整本通讯录；
- 授予用途不得超出接收机构当前信任版本的 `allowed_purpose_codes`（`scope-exceeds-trust`），也不得超出介绍证明的 `scope_purpose_codes`（`scope-exceeds-proof`）；
- 放行决定不得使用能力范围之外的用途或联系方式（`decision-outside-capability`）。

### 冲突冻结

- `GUARDIAN_CONFLICT_RECORDED` 之后、对应 `HIGH_RISK_CHANGE_RELEASED` 之前，该儿童的 `GUARDIAN_LINKED` 与 `CAPABILITY_GRANTED` 属于高风险变更，必须被 `HIGH_RISK_CHANGE_FROZEN` 点名，否则报 `unfrozen-high-risk`。

### 受限突破

- 紧急联系以 `BREAK_GLASS_ACCESS_RECORDED` 留痕，必须携带理由与跟进时限；
- 突破记录不能成为 `CAPABILITY_GRANTED` 的依据（`break-glass-basis`），不会自动变成长期授权；
- `outcome = break_glass` 的决定必须挂到与机构、儿童一致的突破记录（`break-glass-mismatch`）。

### 撤回、轮换与退出

- 关系撤回、联系方式轮换、机构退出、能力到期之后，不得再发生依据它们的授权与查询（`post-revocation-use`、`post-rotation-use`、`post-exit-use`、`decision-after-expiry`）；
- 已经发生的处置事实继续留痕：审计只读历史，不改写旧事件。

### 合并与幂等

- `dedupeByEventId`：同一 `event_id` 的重复投递只保留第一条；
- `mergeOfflineConfirmations`：同一来源对同一联系方式同一版本的确认按 `source_seq` 取最大，迟到的旧消息被合并；合并只影响处理视图，原始事件全部保留；
- 同一证明不可跨儿童重放（`proof-replay`），同一机构内同一别名不可对应多个儿童（`alias-collision`）；
- 能力授予、到期收权、证明签发、冻结、解冻等同效果事件不得重复执行（`duplicate-effect`），保证服务重启后待确认与到期收权不会重复落地。

### 追溯

- `traceDecision(records, decisionId)` 从一次联系决定回到当时依据的监护关系版本、介绍证明版本、机构信任版本、联系方式版本，以及能力授予或突破记录；引用了但找不到的部分列入 `missing`。

## 测试与构建

```bash
npm test
npm run build
```
