import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  applyEvent,
  canQuery,
  checkProofReplay,
  createState,
  evaluateEffectRule,
  expireAuthorizations,
  explainContactDecision,
  mergeBySourceSequence,
  projectState,
  shouldFreeze,
  validateEvent,
} from "../src/child_contact_federation.js";

let seq = 0;
function evt(kind, payload, overrides = {}) {
  seq += 1;
  return {
    event_id: `t-${seq}`,
    kind,
    occurred_at: "2026-09-20T09:00:00+08:00",
    subject_id: payload.child_id ?? payload.institution_id ?? payload.guardian_id ?? "subject",
    source_id: "test-source",
    source_seq: seq,
    payload,
    ...overrides,
  };
}

// 一组能让 canQuery 放行的事件：信任、关系、用途、有效期、联系方式、最小能力授予。
function baseEvents() {
  return [
    evt("INSTITUTION_TRUSTED", {institution_id: "inst-a", trust_version: 1}, {subject_id: "inst-a"}),
    evt("GUARDIAN_LINKED", {child_id: "c1", guardian_id: "g1", relation: "mother", relationship_version: 1, proof_id: "p1"}),
    evt("CONTACT_PURPOSES_SET", {child_id: "c1", guardian_id: "g1", purposes: ["pickup"], purposes_version: 1}),
    evt("VALIDITY_UPDATED", {child_id: "c1", guardian_id: "g1", valid_from: "2026-09-01T00:00:00+08:00", valid_until: "2026-12-31T23:59:59+08:00", validity_version: 1}),
    evt("CONTACT_METHOD_VERIFIED", {guardian_id: "g1", channel: "phone", masked_value: "138****0000", contact_version: 1}, {subject_id: "g1"}),
    evt("CAPABILITY_GRANTED", {grant_id: "gr1", child_id: "c1", institution_id: "inst-a", purposes: ["pickup"], contact_version_ids: [1], valid_from: "2026-09-01T00:00:00+08:00", valid_until: "2026-10-31T23:59:59+08:00"}),
  ];
}

async function readStream() {
  return JSON.parse(await readFile(new URL("../data/sample_stream.json", import.meta.url), "utf8"));
}

test("样例符合领域约定", async () => {
  const record = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(record), []);
});

test("样例事件流全部符合合同，且介绍证明未被重放", async () => {
  const stream = await readStream();
  for (const record of stream) assert.deepEqual(validateEvent(record), [], record.event_id);
  assert.deepEqual(checkProofReplay(stream), []);
});

test("缺少信封字段、未知事件种类或非法来源序列会被检出", () => {
  const missing = validateEvent({kind: "GUARDIAN_LINKED", payload: {}});
  assert.ok(missing.includes("event_id"));
  assert.ok(missing.includes("source_id"));
  assert.ok(missing.includes("source_seq"));
  assert.ok(missing.includes("payload.child_id"));

  const unknown = validateEvent(evt("SOME_UNKNOWN_KIND", {}));
  assert.ok(unknown.includes("kind"));

  const badSeq = validateEvent(
    evt("GUARDIAN_LINKED", {child_id: "c1", guardian_id: "g1", relation: "mother", relationship_version: 1, proof_id: "p1"}, {source_seq: -1}),
  );
  assert.ok(badSeq.includes("source_seq"));
});

test("能力授予必须是最小能力：不得复制通讯录、不得通配用途、必须列明联系方式版本", () => {
  const problems = validateEvent(
    evt("CAPABILITY_GRANTED", {
      grant_id: "gr-bad",
      child_id: "c1",
      institution_id: "inst-a",
      purposes: ["*"],
      contact_version_ids: [],
      valid_from: "2026-09-01T00:00:00+08:00",
      valid_until: "2026-10-01T00:00:00+08:00",
      contacts: [{name: "某监护人", phone: "13800000000"}],
    }),
  );
  assert.ok(problems.includes("payload.minimal_capability"));
  assert.ok(problems.includes("payload.purposes"));
  assert.ok(problems.includes("payload.contact_version_ids"));

  const fromEmergency = validateEvent(
    evt("CAPABILITY_GRANTED", {
      grant_id: "gr-bad-2",
      child_id: "c1",
      institution_id: "inst-a",
      purposes: ["pickup"],
      contact_version_ids: [1],
      valid_from: "2026-09-01T00:00:00+08:00",
      valid_until: "2026-10-01T00:00:00+08:00",
      emergency_event_id: "evt-x",
    }),
  );
  assert.ok(fromEmergency.includes("payload.minimal_capability"));
});

test("紧急突破不得夹带长期授权字段", () => {
  const problems = validateEvent(
    evt("EMERGENCY_CONTACT_USED", {
      child_id: "c1",
      institution_id: "inst-a",
      staff_id: "s1",
      contact_version_id: 1,
      reason_code: "injury",
      grant_id: "gr-x",
      valid_until: "2027-01-01T00:00:00+08:00",
    }),
  );
  assert.ok(problems.includes("payload.break_glass_scope"));
});

test("联系决定必须引用授权来源", () => {
  const base = {decision_id: "d1", child_id: "c1", guardian_id: "g1", institution_id: "inst-a", purpose: "pickup", relationship_version: 1, proof_id: "p1", trust_version: 1, contact_version_id: 1};
  assert.ok(validateEvent(evt("CONTACT_DECISION_RECORDED", {...base, outcome: "allowed"})).includes("payload.grant_id"));
  assert.ok(validateEvent(evt("CONTACT_DECISION_RECORDED", {...base, outcome: "emergency"})).includes("payload.emergency_event_id"));
  assert.deepEqual(validateEvent(evt("CONTACT_DECISION_RECORDED", {...base, outcome: "allowed", grant_id: "gr1"})), []);
});

test("同一介绍证明不可跨儿童重放", () => {
  const issued = evt("INTRO_PROOF_ISSUED", {proof_id: "p1", child_id: "c1", issued_by: "inst-a", expires_at: "2026-12-31T23:59:59+08:00"});
  const okLink = evt("GUARDIAN_LINKED", {child_id: "c1", guardian_id: "g1", relation: "mother", relationship_version: 1, proof_id: "p1"});
  const replay = evt("GUARDIAN_LINKED", {child_id: "c2", guardian_id: "g9", relation: "father", relationship_version: 1, proof_id: "p1"});
  const problems = checkProofReplay([issued, okLink, replay]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].problem, "proof_replay_across_children");
  assert.equal(problems[0].event_id, replay.event_id);

  const orphan = checkProofReplay([evt("GUARDIAN_LINKED", {child_id: "c3", guardian_id: "g8", relation: "father", relationship_version: 1, proof_id: "ghost"})]);
  assert.deepEqual(orphan.map((p) => p.problem), ["proof_unknown"]);
});

test("监护人意见冲突时高风险变更被冻结，解除后才生效", () => {
  const state = projectState(baseEvents());
  const query = {child_id: "c1", institution_id: "inst-a", purpose: "pickup", at: "2026-09-21T10:00:00+08:00"};
  assert.equal(canQuery(state, query).allowed, true);

  const opinions = [
    {guardian_id: "g1", stance: "consent"},
    {guardian_id: "g2", stance: "object"},
  ];
  assert.equal(evaluateEffectRule(opinions), "frozen");
  assert.equal(evaluateEffectRule([{guardian_id: "g1", stance: "consent"}]), "effective");
  assert.equal(evaluateEffectRule([{guardian_id: "g1", stance: "consent"}, {guardian_id: "g2", stance: "undecided"}]), "pending");

  const revoke = evt("RELATIONSHIP_REVOKED", {child_id: "c1", guardian_id: "g1", relationship_version: 2, revoked_by: "g2"}, {occurred_at: "2026-09-22T09:00:00+08:00"});
  assert.equal(shouldFreeze(revoke.kind, opinions), true);
  applyEvent(state, evt("CHANGE_FROZEN", {target_event_id: revoke.event_id, freeze_rule: "guardian_conflict"}, {occurred_at: "2026-09-22T09:01:00+08:00"}));
  applyEvent(state, revoke);

  // 冻结期间变更不生效，查询不受影响。
  assert.equal(canQuery(state, {...query, at: "2026-09-23T10:00:00+08:00"}).allowed, true);

  applyEvent(state, evt("CHANGE_RELEASED", {target_event_id: revoke.event_id, released_by: "platform-mediation"}, {occurred_at: "2026-09-24T09:00:00+08:00"}));
  // 解除后变更生效（生效时点为解除时间），后续查询被停止。
  assert.equal(canQuery(state, {...query, at: "2026-09-25T10:00:00+08:00"}).allowed, false);
  // 解除前的历史时刻仍如实反映当时状态。
  assert.equal(canQuery(state, {...query, at: "2026-09-23T10:00:00+08:00"}).allowed, true);
});

test("查询只返回授予列明的最小联系方式", () => {
  const state = projectState(baseEvents());
  const result = canQuery(state, {child_id: "c1", institution_id: "inst-a", purpose: "pickup", at: "2026-09-21T10:00:00+08:00"});
  assert.equal(result.allowed, true);
  assert.deepEqual(result.contacts, [{guardian_id: "g1", channel: "phone", contact_version: 1, masked_value: "138****0000", grant_id: "gr1"}]);

  // 未授予的用途不在最小能力内。
  assert.equal(canQuery(state, {child_id: "c1", institution_id: "inst-a", purpose: "medical", at: "2026-09-21T10:00:00+08:00"}).allowed, false);
});

test("撤回、轮换与机构退出停止后续查询，处置事实继续留痕", async () => {
  const stream = await readStream();
  const state = projectState(stream);
  const query = {child_id: "child-demo-001", institution_id: "inst-gym-b", purpose: "pickup"};

  // 正常照护期间可以查询。
  assert.equal(canQuery(state, {...query, at: "2026-09-23T10:00:00+08:00"}).allowed, true);

  // 联系方式轮换后，授予列明的旧版本停用，查询停止。
  const afterRotation = canQuery(state, {...query, at: "2026-09-25T10:00:00+08:00"});
  assert.equal(afterRotation.allowed, false);
  assert.deepEqual(afterRotation.reasons, ["no_active_capability"]);

  // 关系撤回且机构退出后，查询停止并说明原因。
  const afterExit = canQuery(state, {...query, at: "2026-09-29T10:00:00+08:00"});
  assert.equal(afterExit.allowed, false);
  assert.ok(afterExit.reasons.includes("institution_not_trusted"));

  // 已经发生的联系决定与紧急突破继续留痕。
  assert.ok(state.decisions.has("decision-001"));
  assert.ok(state.decisions.has("decision-002"));
  assert.equal(state.emergencies.length, 1);
});

test("离线确认与重复消息按来源序列合并", () => {
  const first = evt("CONTACT_CONFIRMED", {child_id: "c1", guardian_id: "g1", channel: "phone", contact_version: 1, confirmed_via: "offline"}, {event_id: "m-1", source_id: "camp-offline", source_seq: 1});
  const duplicate = {...first, event_id: "m-1-copy"}; // 同一来源同一序列的重复消息
  const second = evt("CONTACT_CONFIRMED", {child_id: "c1", guardian_id: "g1", channel: "phone", contact_version: 1, confirmed_via: "offline"}, {event_id: "m-2", source_id: "camp-offline", source_seq: 2});
  const merged = mergeBySourceSequence([first, duplicate, second, {...second}]);
  assert.deepEqual(merged.map((e) => e.event_id), ["m-1", "m-2"]);
});

test("服务重启后待确认与到期收权不会重复执行", () => {
  const events = [...baseEvents(), evt("CONTACT_CONFIRMED", {child_id: "c1", guardian_id: "g1", channel: "phone", contact_version: 1, confirmed_via: "offline"})];
  const state = projectState(events);
  const appliedCount = state.applied.size;

  projectState(events, state); // 模拟重启后重放同一日志
  assert.equal(state.applied.size, appliedCount);

  const first = expireAuthorizations(state, "2026-11-01T00:00:00+08:00");
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, "CAPABILITY_EXPIRED");
  assert.deepEqual(validateEvent(first[0]), []);

  applyEvent(state, first[0]);
  applyEvent(state, first[0]); // 收权记录重复投递不重复执行
  assert.equal(state.applied.size, appliedCount + 1);

  const second = expireAuthorizations(state, "2026-11-01T00:00:00+08:00");
  assert.equal(second.length, 0);
});

test("联系决定可追溯到当时有效的关系、证明、机构权限与联系方式版本", async () => {
  const stream = await readStream();

  const trace = explainContactDecision(stream, "decision-001");
  assert.equal(trace.decision.outcome, "allowed");
  assert.equal(trace.relationship.payload.relationship_version, 1);
  assert.equal(trace.proof.payload.proof_id, "proof-demo-001");
  assert.equal(trace.trust.payload.trust_version, 1);
  assert.equal(trace.contact.payload.contact_version, 1);
  assert.equal(trace.grant.payload.grant_id, "grant-demo-001");
  assert.equal(trace.emergency, null);

  const emergencyTrace = explainContactDecision(stream, "decision-002");
  assert.equal(emergencyTrace.emergency.payload.reason_code, "injury_on_site");
  assert.equal(emergencyTrace.grant, null);

  assert.equal(explainContactDecision(stream, "decision-ghost"), null);
});
