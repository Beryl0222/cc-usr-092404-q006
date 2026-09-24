// child_contact_federation 领域资料的基础结构。
//
// 本文件在原有联系人事件合同上扩展“跨机构授权联邦”：
// 监护关系、儿童别名、可联系用途、有效期、机构信任、介绍证明与
// 联系方式验证七个维度各自独立版本化；接收方只能获得本次照护所需的
// 最小能力，任何联系决定都能回溯到当时有效的各维度版本。
// 文件内所有函数均为纯函数，不依赖外部服务，便于各品牌按同一合同实现。

// ---------- 事件种类 ----------

export const EVENT_KINDS = Object.freeze([
  // 监护关系（relationship_version 版本化）
  "GUARDIAN_LINKED",
  "RELATIONSHIP_REVOKED",
  // 儿童别名（alias_version 版本化）
  "CHILD_ALIAS_REGISTERED",
  // 可联系用途（purposes_version 版本化）
  "CONTACT_PURPOSES_SET",
  // 有效期（validity_version 版本化）
  "VALIDITY_UPDATED",
  // 机构信任（trust_version 版本化，机构退出即撤销）
  "INSTITUTION_TRUSTED",
  "INSTITUTION_TRUST_REVOKED",
  // 介绍证明（绑定单一儿童，不可跨儿童重放）
  "INTRO_PROOF_ISSUED",
  "INTRO_PROOF_REVOKED",
  // 联系方式验证（contact_version 版本化，轮换后旧版本停用）
  "CONTACT_METHOD_VERIFIED",
  "CONTACT_METHOD_ROTATED",
  "CONTACT_CONFIRMED",
  // 最小能力授予与到期收权
  "CAPABILITY_GRANTED",
  "CAPABILITY_EXPIRED",
  // 多监护人冲突下的高风险变更冻结
  "CHANGE_FROZEN",
  "CHANGE_RELEASED",
  // 紧急联系的受限突破（不自动转为长期授权）
  "EMERGENCY_CONTACT_USED",
  // 联系决定留痕（可回溯到各维度当时版本）
  "CONTACT_DECISION_RECORDED",
]);

// ---------- 信封与字段合同 ----------

// 信封必备字段。source_id + source_seq 是离线确认与重复消息合并、
// 以及服务重启后幂等重放的依据。subject_id 取事件主体：
// 儿童事件为 child_id，机构事件为 institution_id，联系方式事件为 guardian_id。
export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "source_id", "source_seq", "payload"]);

// 各事件种类的 payload 必备字段。
export const PAYLOAD_FIELDS = Object.freeze({
  GUARDIAN_LINKED: ["child_id", "guardian_id", "relation", "relationship_version", "proof_id"],
  RELATIONSHIP_REVOKED: ["child_id", "guardian_id", "relationship_version", "revoked_by"],
  CHILD_ALIAS_REGISTERED: ["child_id", "alias", "alias_version"],
  CONTACT_PURPOSES_SET: ["child_id", "guardian_id", "purposes", "purposes_version"],
  VALIDITY_UPDATED: ["child_id", "guardian_id", "valid_from", "valid_until", "validity_version"],
  INSTITUTION_TRUSTED: ["institution_id", "trust_version"],
  INSTITUTION_TRUST_REVOKED: ["institution_id", "trust_version", "revoked_by"],
  INTRO_PROOF_ISSUED: ["proof_id", "child_id", "issued_by", "expires_at"],
  INTRO_PROOF_REVOKED: ["proof_id", "revoked_by"],
  CONTACT_METHOD_VERIFIED: ["guardian_id", "channel", "masked_value", "contact_version"],
  CONTACT_METHOD_ROTATED: ["guardian_id", "channel", "contact_version", "replaces_version"],
  CONTACT_CONFIRMED: ["child_id", "guardian_id", "channel", "contact_version", "confirmed_via"],
  CAPABILITY_GRANTED: ["grant_id", "child_id", "institution_id", "purposes", "contact_version_ids", "valid_from", "valid_until"],
  CAPABILITY_EXPIRED: ["grant_id"],
  CHANGE_FROZEN: ["target_event_id", "freeze_rule"],
  CHANGE_RELEASED: ["target_event_id", "released_by"],
  EMERGENCY_CONTACT_USED: ["child_id", "institution_id", "staff_id", "contact_version_id", "reason_code"],
  CONTACT_DECISION_RECORDED: ["decision_id", "child_id", "guardian_id", "institution_id", "purpose", "relationship_version", "proof_id", "trust_version", "contact_version_id", "outcome"],
});

// 高风险变更：需先按生效规则评估全体在任监护人意见，意见冲突时冻结。
export const HIGH_RISK_KINDS = Object.freeze(["RELATIONSHIP_REVOKED", "CONTACT_METHOD_ROTATED", "CAPABILITY_GRANTED", "VALIDITY_UPDATED"]);

// 建议的可联系用途术语表（不强制取值，便于各品牌对齐）。
export const CONTACT_PURPOSES = Object.freeze(["pickup", "medical", "emergency", "general"]);

// 能力授予中禁止出现的字段：完整通讯录不得出域，紧急突破不能成为授权来源。
const GRANT_FORBIDDEN_FIELDS = Object.freeze(["contacts", "address_book", "contact_list", "emergency_event_id"]);

// 受限突破记录中禁止出现的字段：突破不得夹带任何长期授权。
const BREAK_GLASS_FORBIDDEN_FIELDS = Object.freeze(["grant_id", "valid_until", "purposes"]);

// ---------- 事件校验 ----------

// 返回问题列表，空数组表示符合合同。
export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) {
    problems.push("kind");
  } else if (record.payload && typeof record.payload === "object") {
    for (const field of PAYLOAD_FIELDS[record.kind]) {
      if (!(field in record.payload)) problems.push(`payload.${field}`);
    }
    problems.push(...checkKindInvariants(record));
  }
  if ("source_seq" in record && (!Number.isInteger(record.source_seq) || record.source_seq < 0)) {
    problems.push("source_seq");
  }
  return problems;
}

function checkKindInvariants(record) {
  const payload = record.payload ?? {};
  const problems = [];
  if (record.kind === "CAPABILITY_GRANTED") {
    // 最小能力：不得复制完整通讯录，不得使用通配用途，必须列明联系方式版本。
    if (GRANT_FORBIDDEN_FIELDS.some((field) => field in payload)) problems.push("payload.minimal_capability");
    if (!Array.isArray(payload.purposes) || payload.purposes.length === 0 || payload.purposes.includes("*")) {
      problems.push("payload.purposes");
    }
    if (!Array.isArray(payload.contact_version_ids) || payload.contact_version_ids.length === 0) {
      problems.push("payload.contact_version_ids");
    }
  }
  if (record.kind === "EMERGENCY_CONTACT_USED") {
    // 受限突破只是一次性记录，不得夹带长期授权字段。
    if (BREAK_GLASS_FORBIDDEN_FIELDS.some((field) => field in payload)) problems.push("payload.break_glass_scope");
  }
  if (record.kind === "CONTACT_DECISION_RECORDED") {
    // 每次联系决定必须说明授权来源：常规决定引用能力授予，紧急决定引用突破记录。
    if (payload.outcome === "allowed" && !("grant_id" in payload)) problems.push("payload.grant_id");
    if (payload.outcome === "emergency" && !("emergency_event_id" in payload)) problems.push("payload.emergency_event_id");
  }
  return problems;
}

// ---------- 来源序列合并 ----------

// 离线确认与重复消息按 (source_id, source_seq) 合并：同一来源同一序列只保留
// 首条；同一 event_id 全局只保留首条。跨来源按 occurred_at 排序，同一来源内
// 以 source_seq 为准（合同要求来源内 occurred_at 与 source_seq 同向）。
export function mergeBySourceSequence(events) {
  const seenEventIds = new Set();
  const bySourceSeq = new Map();
  for (const event of events) {
    if (seenEventIds.has(event.event_id)) continue;
    seenEventIds.add(event.event_id);
    const key = `${event.source_id} ${event.source_seq}`;
    if (!bySourceSeq.has(key)) bySourceSeq.set(key, event);
  }
  return [...bySourceSeq.values()].sort(compareEvents);
}

function compareEvents(a, b) {
  return (
    String(a.occurred_at).localeCompare(String(b.occurred_at)) ||
    String(a.source_id).localeCompare(String(b.source_id)) ||
    a.source_seq - b.source_seq
  );
}

// ---------- 版本化状态投影 ----------

const relKey = (a, b) => JSON.stringify([a, b]);

export function createState() {
  return {
    applied: new Set(), // 已应用 event_id：重启后重复投递不再执行
    lastSeq: new Map(), // source_id -> 已见的最大 source_seq（高水位，供对账）
    relationships: new Map(), // [child_id, guardian_id] -> 版本历史
    aliases: new Map(), // child_id -> 版本历史
    purposes: new Map(), // [child_id, guardian_id] -> 版本历史
    validity: new Map(), // [child_id, guardian_id] -> 版本历史
    trust: new Map(), // institution_id -> 版本历史
    proofs: new Map(), // proof_id -> 证明状态
    contacts: new Map(), // [guardian_id, channel] -> 版本历史
    grants: new Map(), // grant_id -> 授予状态
    frozen: new Map(), // target_event_id -> 是否冻结中
    deferred: new Map(), // target_event_id -> 冻结期间收到、待解除后生效的事件
    decisions: new Map(), // 处置事实留痕，不随撤回删除
    emergencies: [], // 受限突破留痕
  };
}

// 应用单条事件。幂等：重复 event_id 直接忽略（重启后重复投递不再执行）。
// 同一来源内允许乱序或晚到（离线确认）：未应用过的事件不因序列较旧而丢弃，
// 批量合并时的顺序与去重由 mergeBySourceSequence 保证。
export function applyEvent(state, event) {
  if (state.applied.has(event.event_id)) return state;
  state.applied.add(event.event_id);
  if (Number.isInteger(event.source_seq)) {
    state.lastSeq.set(event.source_id, Math.max(state.lastSeq.get(event.source_id) ?? -1, event.source_seq));
  }
  if (state.frozen.get(event.event_id) === true) {
    // 高风险变更被冻结：记录但不生效，待 CHANGE_RELEASED 后补放。
    state.deferred.set(event.event_id, event);
    return state;
  }
  applyEffect(state, event, event.occurred_at);
  return state;
}

// 由事件日志构建状态；对同一 state 重复投影同一日志是幂等的（服务重启安全）。
export function projectState(events, state = createState()) {
  for (const event of mergeBySourceSequence(events)) applyEvent(state, event);
  return state;
}

function applyEffect(state, event, effectiveAt) {
  const p = event.payload;
  switch (event.kind) {
    case "GUARDIAN_LINKED":
      append(state.relationships, relKey(p.child_id, p.guardian_id), {at: effectiveAt, status: "linked", relationship_version: p.relationship_version, proof_id: p.proof_id, relation: p.relation});
      break;
    case "RELATIONSHIP_REVOKED":
      append(state.relationships, relKey(p.child_id, p.guardian_id), {at: effectiveAt, status: "revoked", relationship_version: p.relationship_version});
      break;
    case "CHILD_ALIAS_REGISTERED":
      append(state.aliases, p.child_id, {at: effectiveAt, alias: p.alias, alias_version: p.alias_version});
      break;
    case "CONTACT_PURPOSES_SET":
      append(state.purposes, relKey(p.child_id, p.guardian_id), {at: effectiveAt, purposes: p.purposes, purposes_version: p.purposes_version});
      break;
    case "VALIDITY_UPDATED":
      append(state.validity, relKey(p.child_id, p.guardian_id), {at: effectiveAt, valid_from: p.valid_from, valid_until: p.valid_until, validity_version: p.validity_version});
      break;
    case "INSTITUTION_TRUSTED":
      append(state.trust, p.institution_id, {at: effectiveAt, status: "trusted", trust_version: p.trust_version});
      break;
    case "INSTITUTION_TRUST_REVOKED":
      append(state.trust, p.institution_id, {at: effectiveAt, status: "revoked", trust_version: p.trust_version});
      break;
    case "INTRO_PROOF_ISSUED":
      state.proofs.set(p.proof_id, {child_id: p.child_id, issued_by: p.issued_by, issued_at: effectiveAt, expires_at: p.expires_at, revoked_at: null});
      break;
    case "INTRO_PROOF_REVOKED": {
      const proof = state.proofs.get(p.proof_id);
      if (proof) proof.revoked_at = effectiveAt;
      break;
    }
    case "CONTACT_METHOD_VERIFIED":
    case "CONTACT_METHOD_ROTATED":
      append(state.contacts, relKey(p.guardian_id, p.channel), {at: effectiveAt, contact_version: p.contact_version, masked_value: p.masked_value ?? null});
      break;
    case "CAPABILITY_GRANTED":
      state.grants.set(p.grant_id, {grant_id: p.grant_id, child_id: p.child_id, institution_id: p.institution_id, purposes: p.purposes, contact_version_ids: p.contact_version_ids, valid_from: p.valid_from, valid_until: p.valid_until, expired_at: null});
      break;
    case "CAPABILITY_EXPIRED": {
      const grant = state.grants.get(p.grant_id);
      if (grant && grant.expired_at === null) grant.expired_at = effectiveAt;
      break;
    }
    case "CHANGE_FROZEN":
      state.frozen.set(p.target_event_id, true);
      break;
    case "CHANGE_RELEASED": {
      state.frozen.set(p.target_event_id, false);
      const deferred = state.deferred.get(p.target_event_id);
      if (deferred) {
        state.deferred.delete(p.target_event_id);
        // 解除时才生效，生效时点为解除时间，冻结期间的历史时刻不受影响。
        applyEffect(state, deferred, effectiveAt);
      }
      break;
    }
    case "EMERGENCY_CONTACT_USED":
      state.emergencies.push({event_id: event.event_id, occurred_at: event.occurred_at, ...p});
      break;
    case "CONTACT_DECISION_RECORDED":
      state.decisions.set(p.decision_id, event);
      break;
    default:
      break; // CONTACT_CONFIRMED 等仅留痕，不改变投影
  }
}

function append(map, key, entry) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(entry);
}

// 取 at 时刻生效的版本条目。
function effectiveEntry(history, at) {
  let found = null;
  for (const entry of history ?? []) {
    if (entry.at <= at && (found === null || entry.at >= found.at)) found = entry;
  }
  return found;
}

// ---------- 查询门禁（撤回 / 轮换 / 退出 / 到期停止后续查询） ----------

// 评估“机构是否可以在 at 时刻因 purpose 联系儿童的监护人”。
// 只返回授予中列明的联系方式版本（最小能力），不返回任何完整通讯录。
export function canQuery(state, query) {
  if (!query || !query.at) throw new Error("canQuery 需要 query.at（ISO 时间）");
  const reasons = [];

  const trust = effectiveEntry(state.trust.get(query.institution_id), query.at);
  if (!trust || trust.status !== "trusted") reasons.push("institution_not_trusted");

  const contacts = [];
  for (const [key, history] of state.relationships) {
    const [childId, guardianId] = JSON.parse(key);
    if (childId !== query.child_id) continue;
    const relationship = effectiveEntry(history, query.at);
    if (!relationship || relationship.status !== "linked") continue; // 关系撤回后停止查询

    const purposes = effectiveEntry(state.purposes.get(key), query.at);
    if (!purposes || !purposes.purposes.includes(query.purpose)) continue;

    const validity = effectiveEntry(state.validity.get(key), query.at);
    if (validity && !(validity.valid_from <= query.at && query.at <= validity.valid_until)) continue;

    const grant = [...state.grants.values()].find((g) => grantCovers(g, query));
    if (!grant) continue;

    for (const [contactKey, contactHistory] of state.contacts) {
      const [guardianKey, channel] = JSON.parse(contactKey);
      if (guardianKey !== guardianId) continue;
      const contact = effectiveEntry(contactHistory, query.at); // 轮换后旧版本不再返回
      if (!contact || !grant.contact_version_ids.includes(contact.contact_version)) continue;
      contacts.push({guardian_id: guardianId, channel, contact_version: contact.contact_version, masked_value: contact.masked_value, grant_id: grant.grant_id});
    }
  }
  if (contacts.length === 0) reasons.push("no_active_capability");
  return {allowed: reasons.length === 0, reasons, contacts};
}

function grantCovers(grant, query) {
  return (
    grant.child_id === query.child_id &&
    grant.institution_id === query.institution_id &&
    grant.purposes.includes(query.purpose) &&
    grant.valid_from <= query.at &&
    query.at <= grant.valid_until &&
    (grant.expired_at === null || query.at < grant.expired_at) // 到期收权后停止查询
  );
}

// ---------- 多监护人生效规则 ----------

// opinions 应包含全体在任监护人：[{guardian_id, stance: "consent" | "object"}]。
// 任一监护人反对即冻结；全体同意才生效；否则待定。
export function evaluateEffectRule(opinions) {
  if (opinions.some((o) => o.stance === "object")) return "frozen";
  if (opinions.length > 0 && opinions.every((o) => o.stance === "consent")) return "effective";
  return "pending";
}

export function shouldFreeze(kind, opinions) {
  return HIGH_RISK_KINDS.includes(kind) && evaluateEffectRule(opinions) === "frozen";
}

// ---------- 介绍证明防重放 ----------

// 介绍证明绑定单一儿童：同一证明不得跨儿童使用，也不得使用未知、已撤销或已过期的证明。
export function checkProofReplay(events) {
  const proofs = new Map(); // proof_id -> {issued, revoked_at}
  const links = [];
  for (const event of mergeBySourceSequence(events)) {
    if (event.kind === "INTRO_PROOF_ISSUED") proofs.set(event.payload.proof_id, {issued: event, revoked_at: null});
    if (event.kind === "INTRO_PROOF_REVOKED") {
      const proof = proofs.get(event.payload.proof_id);
      if (proof) proof.revoked_at = event.occurred_at;
    }
    if (event.kind === "GUARDIAN_LINKED" && event.payload.proof_id) links.push(event);
  }
  const problems = [];
  for (const link of links) {
    const proofId = link.payload.proof_id;
    const proof = proofs.get(proofId);
    if (!proof) {
      problems.push({problem: "proof_unknown", proof_id: proofId, event_id: link.event_id});
      continue;
    }
    if (proof.issued.payload.child_id !== link.payload.child_id) {
      problems.push({problem: "proof_replay_across_children", proof_id: proofId, event_id: link.event_id});
    }
    if (proof.revoked_at !== null && proof.revoked_at <= link.occurred_at) {
      problems.push({problem: "proof_revoked", proof_id: proofId, event_id: link.event_id});
    }
    if (proof.issued.payload.expires_at < link.occurred_at) {
      problems.push({problem: "proof_expired", proof_id: proofId, event_id: link.event_id});
    }
  }
  return problems;
}

// ---------- 到期收权 ----------

// 对 valid_until 已到期的授予执行收权，返回待写入平台日志的 CAPABILITY_EXPIRED
// 记录。重复调用不会重复收权（服务重启安全）；记录写回日志时 event_id 确定，
// 重复应用同样幂等。
export function expireAuthorizations(state, now) {
  const emitted = [];
  for (const grant of state.grants.values()) {
    if (grant.expired_at === null && grant.valid_until <= now) {
      grant.expired_at = now;
      emitted.push({
        event_id: `expiry:${grant.grant_id}`,
        kind: "CAPABILITY_EXPIRED",
        occurred_at: now,
        subject_id: grant.child_id,
        source_id: "platform",
        source_seq: 0, // 持久化时由平台分配真实序列
        payload: {grant_id: grant.grant_id},
      });
    }
  }
  return emitted;
}

// ---------- 联系决定追溯 ----------

// 从一次联系决定回溯到当时生效的关系版本、介绍证明、机构信任版本、
// 联系方式版本与授权来源（能力授予或受限突破记录）。
export function explainContactDecision(events, decisionId) {
  const log = mergeBySourceSequence(events);
  const decision = log.find((event) => event.kind === "CONTACT_DECISION_RECORDED" && event.payload.decision_id === decisionId);
  if (!decision) return null;
  const p = decision.payload;
  const find = (predicate) => log.find(predicate) ?? null;
  return {
    decision: p,
    relationship: find((e) => (e.kind === "GUARDIAN_LINKED" || e.kind === "RELATIONSHIP_REVOKED") && e.payload.child_id === p.child_id && e.payload.guardian_id === p.guardian_id && e.payload.relationship_version === p.relationship_version),
    proof: find((e) => e.kind === "INTRO_PROOF_ISSUED" && e.payload.proof_id === p.proof_id),
    trust: find((e) => (e.kind === "INSTITUTION_TRUSTED" || e.kind === "INSTITUTION_TRUST_REVOKED") && e.payload.institution_id === p.institution_id && e.payload.trust_version === p.trust_version),
    contact: find((e) => (e.kind === "CONTACT_METHOD_VERIFIED" || e.kind === "CONTACT_METHOD_ROTATED") && e.payload.guardian_id === p.guardian_id && e.payload.contact_version === p.contact_version_id),
    grant: "grant_id" in p ? find((e) => e.kind === "CAPABILITY_GRANTED" && e.payload.grant_id === p.grant_id) : null,
    emergency: "emergency_event_id" in p ? find((e) => e.kind === "EMERGENCY_CONTACT_USED" && e.event_id === p.emergency_event_id) : null,
  };
}
