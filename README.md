# 儿童联系人跨品牌互通

本项目用于整理儿童联系人跨品牌互通领域中的事件名称、交换字段与脱敏样例，方便业务、运营和研发人员在同一套术语下讨论后续服务。资料只包含领域约定，不包含真实个人信息、生产连接或外部账号。

## 跨机构授权联邦

在原有联系人事件合同之上，本合同扩展了跨机构授权联邦：儿童在营地、运动馆、托育点之间流动时，监护人不必逐家重录联系人，机构也只能取得本次照护所需的最小能力。以下七个维度各自独立版本化，任何联系决定都能回溯到当时有效的版本：

| 维度 | 版本字段 | 相关事件 |
| --- | --- | --- |
| 监护关系 | `relationship_version` | `GUARDIAN_LINKED` / `RELATIONSHIP_REVOKED` |
| 儿童别名 | `alias_version` | `CHILD_ALIAS_REGISTERED` |
| 可联系用途 | `purposes_version` | `CONTACT_PURPOSES_SET` |
| 有效期 | `validity_version` | `VALIDITY_UPDATED` |
| 机构信任 | `trust_version` | `INSTITUTION_TRUSTED` / `INSTITUTION_TRUST_REVOKED` |
| 介绍证明 | `proof_id`（绑定单一儿童） | `INTRO_PROOF_ISSUED` / `INTRO_PROOF_REVOKED` |
| 联系方式验证 | `contact_version` | `CONTACT_METHOD_VERIFIED` / `CONTACT_METHOD_ROTATED` / `CONTACT_CONFIRMED` |

信封必备字段：`event_id`、`kind`、`occurred_at`、`subject_id`、`source_id`、`source_seq`、`payload`。`subject_id` 取事件主体（儿童事件为儿童，机构事件为机构，联系方式事件为监护人）。各事件的 payload 必备字段见 `src/child_contact_federation.js` 的 `PAYLOAD_FIELDS`。

## 领域规则

1. **最小能力**：`CAPABILITY_GRANTED` 必须列明用途、联系方式版本与有效期，不得携带完整通讯录，紧急突破不能作为授权来源；`canQuery` 只返回授予列明的联系方式版本。
2. **高风险变更冻结**：关系撤回、联系方式轮换、能力授予、有效期调整属于高风险变更，需先按 `evaluateEffectRule` 评估全体在任监护人意见；任一监护人反对即冻结（`CHANGE_FROZEN`），解除（`CHANGE_RELEASED`）后才生效，生效时点为解除时间。
3. **紧急受限突破**：`EMERGENCY_CONTACT_USED` 只记录一次性突破，不得夹带长期授权字段；引用它的联系决定以 `outcome: "emergency"` 留痕，不会自动变成长期授权。
4. **撤回、轮换与退出停止后续查询**：关系撤回、联系方式轮换、机构退出与到期收权（`expireAuthorizations`）之后，`canQuery` 不再返回相应联系方式；已经发生的联系决定与突破记录继续留痕。
5. **来源序列合并与幂等**：离线确认与重复消息按 `(source_id, source_seq)` 合并，同一 `event_id` 全局去重；对同一状态重复投影同一日志、重复执行到期收权都不会产生重复效果（服务重启安全）。
6. **证明不可跨儿童重放**：`checkProofReplay` 检出跨儿童使用、未知、已撤销或已过期的介绍证明。
7. **联系决定可追溯**：`explainContactDecision` 从一次联系决定回溯到当时生效的关系版本、介绍证明、机构信任版本、联系方式版本与授权来源。

## 目录

- `src/`：事件种类、字段合同与领域规则（纯函数）。
- `data/sample.json`：用于核对资料格式的虚构事件。
- `data/sample_stream.json`：覆盖完整生命周期的虚构事件流（信任、证明、关系、授予、决定、突破、轮换、撤回、退出）。
- `tests/`：保证样例与领域约定保持一致，并覆盖上述规则。

## 测试与构建

```bash
npm test
npm run build
```
