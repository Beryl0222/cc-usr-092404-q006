import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  VERSIONED_OBJECTS,
  auditDataset,
  dedupeByEventId,
  mergeOfflineConfirmations,
  traceDecision,
  validateEvent,
} from "../src/child_contact_federation.js";

const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
const scenario = JSON.parse(await readFile(new URL("../data/scenario.json", import.meta.url), "utf8"));

const clone = (records) => records.map((record) => structuredClone(record));
const problemsWith = (records, marker) => auditDataset(records).filter((problem) => problem.startsWith(marker));

test("样例符合领域约定", () => {
  assert.deepEqual(validateEvent(sample), []);
});

test("七类对象各自版本化", () => {
  assert.deepEqual(Object.keys(VERSIONED_OBJECTS).sort(), [
    "child_alias",
    "contact_method",
    "contact_purpose",
    "guardian_relation",
    "intro_proof",
    "org_trust",
    "validity_window",
  ]);
  for (const { id, version } of Object.values(VERSIONED_OBJECTS)) {
    assert.ok(id && version, "每类对象都要有标识字段与版本字段");
  }
});

test("情景事件逐条通过校验", () => {
  for (const record of scenario) {
    assert.deepEqual(validateEvent(record), [], `${record.kind} ${record.event_id}`);
  }
});

test("情景通过数据集审计", () => {
  assert.deepEqual(auditDataset(scenario), []);
});

test("重复消息与离线确认按来源序列合并", () => {
  const deduped = dedupeByEventId(scenario);
  assert.equal(deduped.duplicates.length, 1);
  assert.equal(deduped.records.length, scenario.length - 1);

  const merged = mergeOfflineConfirmations(deduped.records);
  assert.equal(merged.merged.length, 1);
  assert.equal(merged.merged[0].event_id, "evt-030-09");

  const confirmations = merged.records.filter(
    (record) => record.kind === "CONTACT_CONFIRMED" && record.payload.contact_id === "contact-mother-1" && record.payload.contact_version === 1,
  );
  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].payload.source_seq, 7);
});

test("同一证明不可跨儿童重放", () => {
  const records = clone(scenario);
  records.push({
    event_id: "evt-999-01",
    kind: "CAPABILITY_GRANTED",
    occurred_at: "2026-09-22T10:00:00+08:00",
    subject_id: "child-999",
    payload: {
      capability_id: "cap-999-gym-b",
      child_ref: "child-999",
      grantee_org_ref: "org-gym-b",
      allowed_purpose_codes: ["pickup"],
      allowed_contacts: [{ contact_id: "contact-mother-1", contact_version: 1 }],
      basis: { relation_id: "rel-030-mother", relation_version: 1, proof_id: "proof-030-a2b", proof_version: 1, org_trust_version: 1 },
      not_before: "2026-09-22T10:00:00+08:00",
      expires_at: "2026-09-23T10:00:00+08:00",
    },
  });
  assert.ok(problemsWith(records, "proof-replay").length > 0);
});

test("受限突破不会变成长期授权", () => {
  const records = clone(scenario);
  records.push({
    event_id: "evt-999-02",
    kind: "CAPABILITY_GRANTED",
    occurred_at: "2026-09-23T08:00:00+08:00",
    subject_id: "child-030",
    payload: {
      capability_id: "cap-030-camp-a",
      child_ref: "child-030",
      grantee_org_ref: "org-camp-a",
      allowed_purpose_codes: ["emergency_medical"],
      allowed_contacts: [{ contact_id: "contact-mother-1", contact_version: 1 }],
      basis: { relation_id: "rel-030-mother", relation_version: 1, org_trust_version: 1, break_glass_ref: "bga-030-01" },
      not_before: "2026-09-23T08:00:00+08:00",
      expires_at: "2026-09-24T08:00:00+08:00",
    },
  });
  assert.ok(problemsWith(records, "break-glass-basis").length > 0);
});

test("关系撤回后停止后续授权", () => {
  const records = clone(scenario);
  records.push({
    event_id: "evt-999-03",
    kind: "CAPABILITY_GRANTED",
    occurred_at: "2026-09-24T10:00:00+08:00",
    subject_id: "child-030",
    payload: {
      capability_id: "cap-030-late",
      child_ref: "child-030",
      grantee_org_ref: "org-camp-a",
      allowed_purpose_codes: ["pickup"],
      allowed_contacts: [{ contact_id: "contact-mother-1", contact_version: 2 }],
      basis: { relation_id: "rel-030-father", relation_version: 1, org_trust_version: 1 },
      not_before: "2026-09-24T10:00:00+08:00",
      expires_at: "2026-09-25T10:00:00+08:00",
    },
  });
  assert.ok(problemsWith(records, "post-revocation-use").length > 0);
});

test("联系方式轮换后停止查询旧版本", () => {
  const records = clone(scenario);
  records.push({
    event_id: "evt-999-04",
    kind: "BREAK_GLASS_ACCESS_RECORDED",
    occurred_at: "2026-09-23T19:00:00+08:00",
    subject_id: "child-030",
    payload: {
      access_id: "bga-030-02",
      org_ref: "org-camp-a",
      child_ref: "child-030",
      purpose_code: "emergency_medical",
      contact_id: "contact-mother-1",
      contact_version: 1,
      justification: "夜间突发过敏，值班人员按旧记录拨号",
      recorded_by: "staff-camp-a-12",
      follow_up_required_by: "2026-09-24T19:00:00+08:00",
    },
  });
  assert.ok(problemsWith(records, "post-rotation-use").length > 0);
});

test("机构退出后停止后续查询", () => {
  const records = clone(scenario);
  records.push({
    event_id: "evt-999-05",
    kind: "CONTACT_DECISION_RECORDED",
    occurred_at: "2026-09-24T19:00:00+08:00",
    subject_id: "child-030",
    payload: {
      decision_id: "dec-999-05",
      org_ref: "org-gym-b",
      child_ref: "child-030",
      purpose_code: "pickup",
      outcome: "denied",
      decided_by: "staff-gym-b-03",
      basis: { relation_id: "rel-030-mother", relation_version: 1, org_trust_version: 1, contact_id: "contact-mother-1", contact_version: 2 },
    },
  });
  assert.ok(problemsWith(records, "post-exit-use").length > 0);
});

test("冲突期间的高风险变更必须冻结", () => {
  const records = clone(scenario).filter((record) => record.kind !== "HIGH_RISK_CHANGE_FROZEN");
  assert.ok(problemsWith(records, "unfrozen-high-risk").length > 0);
});

test("到期收权重启后不重复执行", () => {
  const records = clone(scenario);
  records.push({
    event_id: "evt-999-06",
    kind: "CAPABILITY_EXPIRED",
    occurred_at: "2026-09-23T10:05:01+08:00",
    subject_id: "cap-030-gym-b",
    payload: { capability_id: "cap-030-gym-b", expired_at: "2026-09-23T10:05:00+08:00", sweep_id: "sweep-2026-09-23-01" },
  });
  assert.ok(problemsWith(records, "duplicate-effect").length > 0);
});

test("重复投递的消息合并后不产生问题", () => {
  const records = clone(scenario);
  records.push(structuredClone(records.find((record) => record.event_id === "evt-030-13")));
  assert.deepEqual(auditDataset(records), []);
});

test("值班人员能从决定追到关系、证明、机构权限与联系方式版本", () => {
  const trace = traceDecision(scenario, "dec-030-01");
  assert.deepEqual(trace.missing, []);
  assert.equal(trace.relation.payload.relation_id, "rel-030-mother");
  assert.equal(trace.relation.payload.relation_version, 1);
  assert.equal(trace.proof.payload.proof_id, "proof-030-a2b");
  assert.equal(trace.orgTrust.payload.org_ref, "org-gym-b");
  assert.equal(trace.orgTrust.payload.trust_version, 1);
  assert.equal(trace.contact.payload.contact_version, 1);
  assert.equal(trace.capability.payload.capability_id, "cap-030-gym-b");
});

test("受限突破决定追到突破记录而非长期授权", () => {
  const trace = traceDecision(scenario, "dec-030-02");
  assert.deepEqual(trace.missing, []);
  assert.equal(trace.breakGlass.payload.access_id, "bga-030-01");
  assert.equal(trace.capability, null);
});

test("找不到的决定如实报告缺失", () => {
  const trace = traceDecision(scenario, "dec-000-00");
  assert.equal(trace.decision, null);
  assert.deepEqual(trace.missing, ["decision"]);
});

test("最小能力与脱敏的单事件校验", () => {
  const grant = scenario.find((record) => record.event_id === "evt-030-12");

  const wildcard = structuredClone(grant);
  wildcard.payload.allowed_contacts = ["*"];
  assert.ok(validateEvent(wildcard).some((problem) => problem.startsWith("payload.allowed_contacts")));

  const emptyPurposes = structuredClone(grant);
  emptyPurposes.payload.allowed_purpose_codes = [];
  assert.ok(validateEvent(emptyPurposes).includes("payload.allowed_purpose_codes"));

  const rawPhone = structuredClone(scenario.find((record) => record.event_id === "evt-030-10"));
  rawPhone.payload.channel_value_masked = "13800000000";
  assert.ok(validateEvent(rawPhone).includes("payload.channel_value_masked"));
});
