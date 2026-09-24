// child_contact_federation 领域资料的基础结构。
//
// 跨机构授权联邦约定：
// - 监护关系、儿童别名、可联系用途、有效期、机构信任、介绍证明、联系方式验证各自版本化；
// - 接收机构只取得本次照护所需的最小能力，事件只携带脱敏引用，不交换完整通讯录；
// - 多监护人冲突期间按生效规则冻结高风险变更；
// - 紧急联系只留受限突破记录，不自动变成长期授权；
// - 关系撤回、联系方式轮换、机构退出停止后续查询，已发生的处置事实继续留痕；
// - 离线确认与重复消息按来源序列合并，同一证明不可跨儿童重放，
//   服务重启后待确认与到期收权不重复执行；
// - 每次联系决定都能追到关系、证明、机构权限与当时有效的联系方式版本。

export const EVENT_KINDS = Object.freeze([
  // 既有事件
  "GUARDIAN_LINKED",
  "INTRO_PROOF_ISSUED",
  "CONTACT_CONFIRMED",
  "CAPABILITY_GRANTED",
  "RELATIONSHIP_REVOKED",
  // 版本化对象登记
  "CHILD_ALIAS_REGISTERED",
  "CONTACT_PURPOSE_UPDATED",
  "VALIDITY_WINDOW_SET",
  "ORG_TRUST_UPDATED",
  // 轮换、退出与到期收权
  "CONTACT_ROTATED",
  "ORG_EXITED",
  "CAPABILITY_EXPIRED",
  // 冲突冻结与受限突破
  "GUARDIAN_CONFLICT_RECORDED",
  "HIGH_RISK_CHANGE_FROZEN",
  "HIGH_RISK_CHANGE_RELEASED",
  "BREAK_GLASS_ACCESS_RECORDED",
  // 追溯锚点
  "CONTACT_DECISION_RECORDED",
]);

export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

// 七类各自版本化的对象：标识字段与版本字段。
export const VERSIONED_OBJECTS = Object.freeze({
  guardian_relation: Object.freeze({ id: "relation_id", version: "relation_version" }),
  child_alias: Object.freeze({ id: "alias_id", version: "alias_version" }),
  contact_purpose: Object.freeze({ id: "purpose_code", version: "purpose_version" }),
  validity_window: Object.freeze({ id: "window_id", version: "window_version" }),
  org_trust: Object.freeze({ id: "org_ref", version: "trust_version" }),
  intro_proof: Object.freeze({ id: "proof_id", version: "proof_version" }),
  contact_method: Object.freeze({ id: "contact_id", version: "contact_version" }),
});

// 各事件种类在 payload 中的必备字段。
export const KIND_PAYLOAD_FIELDS = Object.freeze({
  GUARDIAN_LINKED: Object.freeze(["relation_id", "relation_version", "guardian_ref", "relation_type", "decision_weight", "valid_from"]),
  RELATIONSHIP_REVOKED: Object.freeze(["relation_id", "revoked_relation_version", "revoked_by", "effective_at"]),
  CHILD_ALIAS_REGISTERED: Object.freeze(["alias_id", "alias_version", "org_ref", "alias_value_masked"]),
  CONTACT_PURPOSE_UPDATED: Object.freeze(["purpose_code", "purpose_version", "risk_level", "allowed_channel_types"]),
  VALIDITY_WINDOW_SET: Object.freeze(["window_id", "window_version", "applies_to_kind", "applies_to_ref", "not_before", "not_after"]),
  ORG_TRUST_UPDATED: Object.freeze(["org_ref", "trust_version", "trust_level", "allowed_purpose_codes", "max_capability_scope"]),
  ORG_EXITED: Object.freeze(["org_ref", "exit_at", "final_trust_version"]),
  INTRO_PROOF_ISSUED: Object.freeze(["proof_id", "proof_version", "child_ref", "issued_by_org", "issued_to_org", "nonce", "expires_at", "scope_purpose_codes"]),
  CONTACT_CONFIRMED: Object.freeze(["contact_id", "contact_version", "guardian_ref", "channel_type", "channel_value_masked", "verification_method", "source_id", "source_seq"]),
  CONTACT_ROTATED: Object.freeze(["contact_id", "retired_contact_version", "rotated_at", "reason"]),
  CAPABILITY_GRANTED: Object.freeze(["capability_id", "child_ref", "grantee_org_ref", "allowed_purpose_codes", "allowed_contacts", "basis", "not_before", "expires_at"]),
  CAPABILITY_EXPIRED: Object.freeze(["capability_id", "expired_at", "sweep_id"]),
  GUARDIAN_CONFLICT_RECORDED: Object.freeze(["conflict_id", "child_ref", "guardian_refs", "conflicting_fields", "detected_rule_ref"]),
  HIGH_RISK_CHANGE_FROZEN: Object.freeze(["freeze_id", "conflict_ref", "frozen_change_ref", "rule_ref", "child_ref"]),
  HIGH_RISK_CHANGE_RELEASED: Object.freeze(["freeze_id", "child_ref", "released_by", "resolution"]),
  BREAK_GLASS_ACCESS_RECORDED: Object.freeze(["access_id", "org_ref", "child_ref", "purpose_code", "contact_id", "contact_version", "justification", "recorded_by", "follow_up_required_by"]),
  CONTACT_DECISION_RECORDED: Object.freeze(["decision_id", "org_ref", "child_ref", "purpose_code", "outcome", "basis", "decided_by"]),
});

// 冲突期间需要冻结的高风险变更种类。
export const HIGH_RISK_CHANGE_KINDS = Object.freeze(["GUARDIAN_LINKED", "CAPABILITY_GRANTED"]);

export const DECISION_OUTCOMES = Object.freeze(["allowed", "denied", "break_glass"]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

function isNonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0;
}

function isTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isNonEmptyStringList(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0);
}

function timeOf(record) {
  return Date.parse(record.occurred_at);
}

// 单事件校验：返回问题列表，空数组表示符合约定。
export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) problems.push("kind");
  if ("occurred_at" in record && !isTimestamp(record.occurred_at)) problems.push("occurred_at");
  if (!isPlainObject(record.payload)) {
    if (!problems.includes("payload")) problems.push("payload");
    return problems;
  }
  for (const name of KIND_PAYLOAD_FIELDS[record.kind] || []) {
    if (!(name in record.payload)) problems.push(`payload.${name}`);
  }
  return problems.concat(validatePayloadShape(record));
}

function validatePayloadShape(record) {
  const problems = [];
  const payload = record.payload;
  // 版本字段统一为正整数。
  for (const [key, value] of Object.entries(payload)) {
    if (key.endsWith("_version") && !isPositiveInt(value)) problems.push(`payload.${key}`);
  }
  switch (record.kind) {
    case "CONTACT_CONFIRMED": {
      if ("source_seq" in payload && !isNonNegativeInt(payload.source_seq)) problems.push("payload.source_seq");
      const masked = payload.channel_value_masked;
      if (typeof masked === "string") {
        // 脱敏约定：掩码必须含 *，且不得出现 7 位以上连续数字。
        if (!masked.includes("*") || /\d{7,}/.test(masked)) problems.push("payload.channel_value_masked");
      }
      break;
    }
    case "CAPABILITY_GRANTED": {
      if ("allowed_purpose_codes" in payload && !isNonEmptyStringList(payload.allowed_purpose_codes)) {
        problems.push("payload.allowed_purpose_codes");
      }
      // 最小能力：联系方式必须逐个点名并钉住版本，禁止通配与整本通讯录。
      const contacts = payload.allowed_contacts;
      if (!Array.isArray(contacts) || contacts.length === 0) {
        problems.push("payload.allowed_contacts");
      } else {
        contacts.forEach((entry, index) => {
          const ok = isPlainObject(entry) && typeof entry.contact_id === "string" && isPositiveInt(entry.contact_version);
          if (!ok) problems.push(`payload.allowed_contacts[${index}]`);
        });
      }
      if (isPlainObject(payload.basis)) {
        for (const name of ["relation_id", "relation_version", "org_trust_version"]) {
          if (!(name in payload.basis)) problems.push(`payload.basis.${name}`);
        }
      }
      if (isTimestamp(payload.not_before) && isTimestamp(payload.expires_at) && Date.parse(payload.not_before) >= Date.parse(payload.expires_at)) {
        problems.push("payload.expires_at");
      }
      break;
    }
    case "VALIDITY_WINDOW_SET": {
      if (isTimestamp(payload.not_before) && isTimestamp(payload.not_after) && Date.parse(payload.not_before) >= Date.parse(payload.not_after)) {
        problems.push("payload.not_after");
      }
      break;
    }
    case "INTRO_PROOF_ISSUED":
    case "ORG_TRUST_UPDATED": {
      const key = record.kind === "INTRO_PROOF_ISSUED" ? "scope_purpose_codes" : "allowed_purpose_codes";
      if (key in payload && !isNonEmptyStringList(payload[key])) problems.push(`payload.${key}`);
      break;
    }
    case "GUARDIAN_CONFLICT_RECORDED": {
      // 冲突至少涉及两位监护人。
      if ("guardian_refs" in payload && (!Array.isArray(payload.guardian_refs) || payload.guardian_refs.length < 2)) {
        problems.push("payload.guardian_refs");
      }
      break;
    }
    case "BREAK_GLASS_ACCESS_RECORDED": {
      if ("justification" in payload && (typeof payload.justification !== "string" || payload.justification.length === 0)) {
        problems.push("payload.justification");
      }
      break;
    }
    case "CONTACT_DECISION_RECORDED": {
      if ("outcome" in payload && !DECISION_OUTCOMES.includes(payload.outcome)) problems.push("payload.outcome");
      if (isPlainObject(payload.basis)) {
        // 任何决定都要说明依据的关系与机构信任版本。
        for (const name of ["relation_id", "relation_version", "org_trust_version"]) {
          if (!(name in payload.basis)) problems.push(`payload.basis.${name}`);
        }
        // 放行与突破必须钉住当时使用的联系方式版本。
        if (payload.outcome === "allowed" || payload.outcome === "break_glass") {
          for (const name of ["contact_id", "contact_version"]) {
            if (!(name in payload.basis)) problems.push(`payload.basis.${name}`);
          }
        }
        // 受限突破必须挂到突破记录；正常放行必须挂到能力授予。
        if (payload.outcome === "break_glass" && !("break_glass_ref" in payload.basis)) problems.push("payload.basis.break_glass_ref");
        if (payload.outcome === "allowed" && !("capability_id" in payload.basis)) problems.push("payload.basis.capability_id");
      }
      break;
    }
    default:
      break;
  }
  return problems;
}

// 重复消息合并：同一 event_id 只保留第一条，重复投递不改变处理结果。
export function dedupeByEventId(records) {
  const seen = new Set();
  const unique = [];
  const duplicates = [];
  for (const record of records) {
    if (record && typeof record.event_id === "string") {
      if (seen.has(record.event_id)) {
        duplicates.push(record);
        continue;
      }
      seen.add(record.event_id);
    }
    unique.push(record);
  }
  return { records: unique, duplicates };
}

// 离线确认合并：同一来源对同一联系方式同一版本的确认按 source_seq 取最大，
// 其余视为迟到的旧消息。合并只影响处理视图，原始事件全部保留。
export function mergeOfflineConfirmations(records) {
  const positionByKey = new Map();
  const result = [];
  const merged = [];
  for (const record of records) {
    if (!isPlainObject(record) || record.kind !== "CONTACT_CONFIRMED" || !isPlainObject(record.payload)) {
      result.push(record);
      continue;
    }
    const { source_id, contact_id, contact_version, source_seq } = record.payload;
    if (typeof source_id !== "string" || !isNonNegativeInt(source_seq)) {
      result.push(record);
      continue;
    }
    const key = `${source_id}|${contact_id}|${contact_version}`;
    if (!positionByKey.has(key)) {
      positionByKey.set(key, result.length);
      result.push(record);
      continue;
    }
    const position = positionByKey.get(key);
    const current = result[position];
    if (source_seq > current.payload.source_seq) {
      merged.push(current);
      result[position] = record;
    } else {
      merged.push(record);
    }
  }
  return { records: result, merged };
}

function normalizeView(records) {
  return mergeOfflineConfirmations(dedupeByEventId(records).records).records;
}

function buildIndex(records) {
  const ofKind = (kind) => records.filter((record) => record.kind === kind);
  return {
    ofKind,
    findRelation: (id, version) => ofKind("GUARDIAN_LINKED").find((r) => r.payload.relation_id === id && r.payload.relation_version === version) || null,
    findProof: (id, version) => ofKind("INTRO_PROOF_ISSUED").find((r) => r.payload.proof_id === id && r.payload.proof_version === version) || null,
    findTrust: (org, version) => ofKind("ORG_TRUST_UPDATED").find((r) => r.payload.org_ref === org && r.payload.trust_version === version) || null,
    findContact: (id, version) => ofKind("CONTACT_CONFIRMED").find((r) => r.payload.contact_id === id && r.payload.contact_version === version) || null,
    findCapability: (id) => ofKind("CAPABILITY_GRANTED").find((r) => r.payload.capability_id === id) || null,
    findBreakGlass: (id) => ofKind("BREAK_GLASS_ACCESS_RECORDED").find((r) => r.payload.access_id === id) || null,
  };
}

// 数据集审计：先做重复与离线合并，再检查跨事件保障规则。
// 返回问题列表（"规则: 详情"），空数组表示通过。
export function auditDataset(records) {
  const problems = [];
  const view = normalizeView(records);
  for (const record of view) {
    for (const problem of validateEvent(record)) {
      problems.push(`event ${record.event_id}: ${problem}`);
    }
  }
  const wellFormed = view.filter((record) => isPlainObject(record.payload));
  const index = buildIndex(wellFormed);
  const grants = index.ofKind("CAPABILITY_GRANTED");
  const decisions = index.ofKind("CONTACT_DECISION_RECORDED");

  auditAliases(index, problems);
  auditProofReplay(index, problems);
  auditGrants(index, grants, problems);
  auditStopRules(index, grants, decisions, problems);
  auditDuplicateEffects(index, problems);
  auditConflictFreezes(index, wellFormed, problems);
  auditDecisions(index, decisions, problems);
  return problems;
}

// 同一机构内同一别名不得对应多个儿童，避免工作人员联系错人。
function auditAliases(index, problems) {
  const childrenByAlias = new Map();
  for (const record of index.ofKind("CHILD_ALIAS_REGISTERED")) {
    const key = `${record.payload.org_ref}|${record.payload.alias_value_masked}`;
    if (!childrenByAlias.has(key)) childrenByAlias.set(key, new Set());
    childrenByAlias.get(key).add(record.subject_id);
  }
  for (const [alias, children] of childrenByAlias) {
    if (children.size > 1) problems.push(`alias-collision: 别名 ${alias} 对应多个儿童（${[...children].join("、")}）`);
  }
}

// 同一证明不可跨儿童重放。
function auditProofReplay(index, problems) {
  const childrenByProof = new Map();
  const note = (proofId, childRef) => {
    if (typeof proofId !== "string" || typeof childRef !== "string") return;
    if (!childrenByProof.has(proofId)) childrenByProof.set(proofId, new Set());
    childrenByProof.get(proofId).add(childRef);
  };
  for (const proof of index.ofKind("INTRO_PROOF_ISSUED")) note(proof.payload.proof_id, proof.payload.child_ref);
  for (const grant of index.ofKind("CAPABILITY_GRANTED")) note(grant.payload.basis?.proof_id, grant.payload.child_ref);
  for (const [proofId, children] of childrenByProof) {
    if (children.size > 1) problems.push(`proof-replay: 证明 ${proofId} 被用于多个儿童（${[...children].join("、")}）`);
  }
}

// 能力授予：依据可解析、用途不超出机构信任与证明范围、不依据突破记录。
function auditGrants(index, grants, problems) {
  for (const grant of grants) {
    const payload = grant.payload;
    const basis = isPlainObject(payload.basis) ? payload.basis : {};
    const label = `能力 ${payload.capability_id}`;
    // 受限突破记录不能成为长期授权的依据。
    if (basis.break_glass_ref || index.findBreakGlass(basis.proof_id)) {
      problems.push(`break-glass-basis: ${label} 依据了突破记录`);
    }
    if (!index.findRelation(basis.relation_id, basis.relation_version)) problems.push(`unknown-ref: ${label} 的监护关系版本不存在`);
    const trust = index.findTrust(payload.grantee_org_ref, basis.org_trust_version);
    if (!trust) {
      problems.push(`unknown-ref: ${label} 的机构信任版本不存在`);
    } else {
      for (const purpose of payload.allowed_purpose_codes || []) {
        if (!(trust.payload.allowed_purpose_codes || []).includes(purpose)) {
          problems.push(`scope-exceeds-trust: ${label} 的用途 ${purpose} 超出机构信任范围`);
        }
      }
    }
    if (basis.proof_id) {
      const proof = index.findProof(basis.proof_id, basis.proof_version);
      if (!proof) {
        problems.push(`unknown-ref: ${label} 的介绍证明不存在`);
      } else {
        if (proof.payload.issued_to_org !== payload.grantee_org_ref) {
          problems.push(`proof-org-mismatch: ${label} 的证明实际签发给 ${proof.payload.issued_to_org}`);
        }
        for (const purpose of payload.allowed_purpose_codes || []) {
          if (!(proof.payload.scope_purpose_codes || []).includes(purpose)) {
            problems.push(`scope-exceeds-proof: ${label} 的用途 ${purpose} 超出证明范围`);
          }
        }
      }
    }
    for (const entry of payload.allowed_contacts || []) {
      if (isPlainObject(entry) && !index.findContact(entry.contact_id, entry.contact_version)) {
        problems.push(`unknown-ref: ${label} 的联系方式版本不存在`);
      }
    }
  }
}

// 撤回、轮换、退出、到期之后的停止使用检查；已发生的处置事实继续留痕，不作改写。
function auditStopRules(index, grants, decisions, problems) {
  // 关系撤回：之后的授权与放行决定不得再依据该关系。
  for (const revoked of index.ofKind("RELATIONSHIP_REVOKED")) {
    const effective = Date.parse(revoked.payload.effective_at);
    const relationId = revoked.payload.relation_id;
    for (const grant of grants) {
      if (grant.payload.basis?.relation_id === relationId && timeOf(grant) > effective) {
        problems.push(`post-revocation-use: 能力 ${grant.payload.capability_id} 在关系 ${relationId} 撤回后仍依据它`);
      }
    }
    for (const decision of decisions) {
      if (decision.payload.outcome === "allowed" && decision.payload.basis?.relation_id === relationId && timeOf(decision) > effective) {
        problems.push(`post-revocation-use: 决定 ${decision.payload.decision_id} 在关系 ${relationId} 撤回后仍依据它放行`);
      }
    }
  }
  // 联系方式轮换：之后的查询不得再使用已退役版本。
  for (const rotation of index.ofKind("CONTACT_ROTATED")) {
    const rotatedAt = Date.parse(rotation.payload.rotated_at);
    const { contact_id, retired_contact_version } = rotation.payload;
    const label = `${contact_id} v${retired_contact_version}`;
    for (const grant of grants) {
      const stale = (grant.payload.allowed_contacts || []).some(
        (entry) => isPlainObject(entry) && entry.contact_id === contact_id && entry.contact_version === retired_contact_version,
      );
      if (stale && timeOf(grant) > rotatedAt) problems.push(`post-rotation-use: 能力 ${grant.payload.capability_id} 在轮换后仍使用 ${label}`);
    }
    for (const decision of decisions) {
      const basis = decision.payload.basis || {};
      if (basis.contact_id === contact_id && basis.contact_version === retired_contact_version && timeOf(decision) > rotatedAt) {
        problems.push(`post-rotation-use: 决定 ${decision.payload.decision_id} 在轮换后仍使用 ${label}`);
      }
    }
    for (const access of index.ofKind("BREAK_GLASS_ACCESS_RECORDED")) {
      if (access.payload.contact_id === contact_id && access.payload.contact_version === retired_contact_version && timeOf(access) > rotatedAt) {
        problems.push(`post-rotation-use: 突破记录 ${access.payload.access_id} 在轮换后仍使用 ${label}`);
      }
    }
  }
  // 机构退出：之后不得再与该机构互签证明、授予能力或以其名义决定。
  for (const exit of index.ofKind("ORG_EXITED")) {
    const exitAt = Date.parse(exit.payload.exit_at);
    const org = exit.payload.org_ref;
    for (const proof of index.ofKind("INTRO_PROOF_ISSUED")) {
      if ((proof.payload.issued_to_org === org || proof.payload.issued_by_org === org) && timeOf(proof) > exitAt) {
        problems.push(`post-exit-use: 证明 ${proof.payload.proof_id} 在机构 ${org} 退出后仍与其相关`);
      }
    }
    for (const grant of grants) {
      if (grant.payload.grantee_org_ref === org && timeOf(grant) > exitAt) {
        problems.push(`post-exit-use: 能力 ${grant.payload.capability_id} 在机构 ${org} 退出后仍授予它`);
      }
    }
    for (const decision of decisions) {
      if (decision.payload.org_ref === org && timeOf(decision) > exitAt) {
        problems.push(`post-exit-use: 决定 ${decision.payload.decision_id} 在机构 ${org} 退出后仍以其名义作出`);
      }
    }
  }
  // 到期收权：之后的放行决定不得再依据该能力。
  for (const expiry of index.ofKind("CAPABILITY_EXPIRED")) {
    const expiredAt = Date.parse(expiry.payload.expired_at);
    for (const decision of decisions) {
      if (decision.payload.outcome === "allowed" && decision.payload.basis?.capability_id === expiry.payload.capability_id && timeOf(decision) > expiredAt) {
        problems.push(`decision-after-expiry: 决定 ${decision.payload.decision_id} 在能力 ${expiry.payload.capability_id} 到期后仍依据它放行`);
      }
    }
  }
}

// 重启幂等：同一效果的执行类事件不得重复（重复消息已在合并阶段去掉）。
function auditDuplicateEffects(index, problems) {
  const groups = [
    ["能力授予", index.ofKind("CAPABILITY_GRANTED"), (r) => r.payload.capability_id],
    ["到期收权", index.ofKind("CAPABILITY_EXPIRED"), (r) => r.payload.capability_id],
    ["介绍证明", index.ofKind("INTRO_PROOF_ISSUED"), (r) => `${r.payload.proof_id}|${r.payload.proof_version}`],
    ["冻结", index.ofKind("HIGH_RISK_CHANGE_FROZEN"), (r) => r.payload.frozen_change_ref],
    ["解冻", index.ofKind("HIGH_RISK_CHANGE_RELEASED"), (r) => r.payload.freeze_id],
  ];
  for (const [label, records, keyOf] of groups) {
    const counts = new Map();
    for (const record of records) {
      const key = keyOf(record);
      if (typeof key !== "string" || !key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const [key, count] of counts) {
      if (count > 1) problems.push(`duplicate-effect: ${label}对 ${key} 重复执行 ${count} 次`);
    }
  }
}

// 冲突未解决期间，高风险变更必须被冻结事件点名。
function auditConflictFreezes(index, view, problems) {
  const freezes = index.ofKind("HIGH_RISK_CHANGE_FROZEN");
  const releases = index.ofKind("HIGH_RISK_CHANGE_RELEASED");
  const conflicts = index.ofKind("GUARDIAN_CONFLICT_RECORDED");
  const frozenChangeIds = new Set(freezes.map((freeze) => freeze.payload.frozen_change_ref));
  const releaseByFreezeId = new Map(releases.map((release) => [release.payload.freeze_id, release]));
  for (const freeze of freezes) {
    if (!view.some((record) => record.event_id === freeze.payload.frozen_change_ref)) {
      problems.push(`unknown-ref: 冻结 ${freeze.payload.freeze_id} 指向的变更不存在`);
    }
    if (!conflicts.some((conflict) => conflict.payload.conflict_id === freeze.payload.conflict_ref)) {
      problems.push(`unknown-ref: 冻结 ${freeze.payload.freeze_id} 指向的冲突不存在`);
    }
  }
  for (const release of releases) {
    if (!freezes.some((freeze) => freeze.payload.freeze_id === release.payload.freeze_id)) {
      problems.push(`unknown-ref: 解冻 ${release.payload.freeze_id} 没有对应的冻结`);
    }
  }
  for (const conflict of conflicts) {
    const child = conflict.payload.child_ref;
    const start = timeOf(conflict);
    const ends = freezes
      .filter((freeze) => freeze.payload.conflict_ref === conflict.payload.conflict_id)
      .map((freeze) => releaseByFreezeId.get(freeze.payload.freeze_id))
      .filter(Boolean)
      .map(timeOf);
    const end = ends.length > 0 ? Math.min(...ends) : Number.POSITIVE_INFINITY;
    for (const change of view) {
      if (!HIGH_RISK_CHANGE_KINDS.includes(change.kind)) continue;
      if (change.subject_id !== child) continue;
      const at = timeOf(change);
      if (at > start && at < end && !frozenChangeIds.has(change.event_id)) {
        problems.push(`unfrozen-high-risk: 冲突 ${conflict.payload.conflict_id} 期间的变更 ${change.event_id} 未按规则冻结`);
      }
    }
  }
}

// 联系决定：依据可解析，放行不超出能力范围，突破与记录一致。
function auditDecisions(index, decisions, problems) {
  for (const decision of decisions) {
    const payload = decision.payload;
    const basis = isPlainObject(payload.basis) ? payload.basis : {};
    const label = `决定 ${payload.decision_id}`;
    if (!index.findRelation(basis.relation_id, basis.relation_version)) problems.push(`unknown-ref: ${label} 的监护关系版本不存在`);
    if (!index.findTrust(payload.org_ref, basis.org_trust_version)) problems.push(`unknown-ref: ${label} 的机构信任版本不存在`);
    if (basis.contact_id !== undefined && !index.findContact(basis.contact_id, basis.contact_version)) {
      problems.push(`unknown-ref: ${label} 的联系方式版本不存在`);
    }
    if (basis.proof_id && !index.findProof(basis.proof_id, basis.proof_version)) problems.push(`unknown-ref: ${label} 的介绍证明不存在`);
    if (payload.outcome === "allowed") {
      const capability = index.findCapability(basis.capability_id);
      if (!capability) {
        problems.push(`unknown-ref: ${label} 的能力不存在`);
      } else {
        if (capability.payload.grantee_org_ref !== payload.org_ref) problems.push(`decision-outside-capability: ${label} 的机构与能力授予对象不符`);
        if (capability.payload.child_ref !== payload.child_ref) problems.push(`decision-outside-capability: ${label} 的儿童与能力授予对象不符`);
        if (!(capability.payload.allowed_purpose_codes || []).includes(payload.purpose_code)) {
          problems.push(`decision-outside-capability: ${label} 的用途超出能力范围`);
        }
        const contactOk = (capability.payload.allowed_contacts || []).some(
          (entry) => isPlainObject(entry) && entry.contact_id === basis.contact_id && entry.contact_version === basis.contact_version,
        );
        if (!contactOk) problems.push(`decision-outside-capability: ${label} 使用了能力之外的联系方式`);
      }
    }
    if (payload.outcome === "break_glass") {
      const access = index.findBreakGlass(basis.break_glass_ref);
      if (!access) {
        problems.push(`unknown-ref: ${label} 的突破记录不存在`);
      } else if (access.payload.org_ref !== payload.org_ref || access.payload.child_ref !== payload.child_ref) {
        problems.push(`break-glass-mismatch: ${label} 与突破记录 ${basis.break_glass_ref} 的机构或儿童不符`);
      }
    }
  }
}

// 追溯：从一次联系决定回到关系、证明、机构权限与当时有效的联系方式版本。
// 返回各部分对应的事件记录；引用了但找不到的部分列入 missing。
export function traceDecision(records, decisionId) {
  const view = normalizeView(records).filter((record) => isPlainObject(record.payload));
  const index = buildIndex(view);
  const decision = view.find((record) => record.kind === "CONTACT_DECISION_RECORDED" && record.payload.decision_id === decisionId) || null;
  const trace = { decision, relation: null, proof: null, orgTrust: null, contact: null, capability: null, breakGlass: null, missing: [] };
  if (!decision) {
    trace.missing.push("decision");
    return trace;
  }
  const basis = isPlainObject(decision.payload.basis) ? decision.payload.basis : {};
  trace.relation = index.findRelation(basis.relation_id, basis.relation_version);
  if (!trace.relation) trace.missing.push("relation");
  trace.orgTrust = index.findTrust(decision.payload.org_ref, basis.org_trust_version);
  if (!trace.orgTrust) trace.missing.push("org_trust");
  if (basis.proof_id) {
    trace.proof = index.findProof(basis.proof_id, basis.proof_version);
    if (!trace.proof) trace.missing.push("proof");
  }
  if (basis.contact_id !== undefined) {
    trace.contact = index.findContact(basis.contact_id, basis.contact_version);
    if (!trace.contact) trace.missing.push("contact");
  }
  if (basis.capability_id) {
    trace.capability = index.findCapability(basis.capability_id);
    if (!trace.capability) trace.missing.push("capability");
  }
  if (basis.break_glass_ref) {
    trace.breakGlass = index.findBreakGlass(basis.break_glass_ref);
    if (!trace.breakGlass) trace.missing.push("break_glass");
  }
  return trace;
}
