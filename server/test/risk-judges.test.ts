// The judges of the safety risks: one per rule, the risks each has not judged, what the model reads
// for a risk, and the latest judgment the pages read.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RULES } from '../src/semantics/sequences/rules.ts';
import { judgmentCase, latestJudgmentsSql, RISK_JUDGES, riskJudgeOf, riskReadsSql, riskSubject, unjudgedRisksSql } from '../src/semantics/judges/risk-judges.ts';

test('one judge per rule, whose criterion is answered violates for a breach', () => {
  assert.deepEqual(RISK_JUDGES.map((j) => [j.rule, j.judge, j.version, j.model]), RULES.map((r) => [r.id, `risk-${r.id}`, 1, 'claude-haiku-5-5']));
  assert.ok(RISK_JUDGES.every((j) => /Answer violates when/.test(j.criterion)));
  assert.deepEqual(RISK_JUDGES.map((j) => [j.name, j.createdAt]), RULES.map((r) => [`Risk: ${r.name}`, '2026-11-19 00:00:00.000000']));
  assert.equal(riskJudgeOf('exfil')?.judge, 'risk-exfil');
  assert.equal(riskJudgeOf('else'), undefined);
  assert.equal(riskSubject('s-1', 'confirm', 12), 's-1:confirm:12');
});

test('the risks a judge has not judged with its version, in trees whose rules have run', () => {
  assert.equal(unjudgedRisksSql('otel', RISK_JUDGES[0]!).sql, [
    'SELECT r.session_id, r.rule, r.first_seq, r.ts',
    'FROM otel.agent_risks r',
    'JOIN otel.agent_sessions m ON m.session_id = r.root_id',
    "LEFT JOIN (SELECT DISTINCT subject FROM otel.agent_judgments WHERE judge = 'risk-confirm' AND judge_version = 1) d",
    "  ON d.subject = concat(r.session_id, ':', r.rule, ':', CAST(r.first_seq AS STRING))",
    "WHERE r.rule = 'confirm' AND m.safety_risks IS NOT NULL AND d.subject IS NULL",
    'ORDER BY r.ts, r.session_id, r.first_seq',
  ].join('\n'));
});

test('what the model reads for a risk: its events in order, the step before the first, the request of its turn', () => {
  const s = riskReadsSql('otel', [{ session_id: 's-1', rule: 'confirm', first_seq: 12 }, { session_id: 's-2', rule: 'deny', first_seq: 4 }]).sql;
  assert.match(s, /WHERE \(r\.session_id = 's-1' AND r\.rule = 'confirm' AND r\.first_seq = 12\) OR \(r\.session_id = 's-2' AND r\.rule = 'deny' AND r\.first_seq = 4\)/);
  assert.match(s, /FROM picked p LATERAL VIEW explode\(p\.events\) t AS ev/);
  assert.match(s, /min\(step\) AS lo, max\(step\) AS hi, min\(turn\) AS turn/);
  // A long risk reads only the steps of its events, the step before the first, and the request.
  assert.match(s, /AND \(\(e\.step BETWEEN sp\.lo - 1 AND sp\.hi AND \(sp\.hi - sp\.lo <= 30 OR ms\.step IS NOT NULL OR e\.step = sp\.lo - 1\)\)\n {9}OR \(e\.kind = 'user_input' AND e\.turn = sp\.turn\)\)/);
  assert.match(s, /if\(mk\.seq IS NULL, 0, 1\) AS marked/, 'the events the rule matched are marked, not their whole steps');
  assert.match(s, /LEFT JOIN marked mk ON mk\.session_id = sp\.session_id AND mk\.rule = sp\.rule AND mk\.first_seq = sp\.first_seq AND mk\.seq = e\.seq/);
  assert.match(s, /AND \(m\.event_seq = v\.seq OR m\.msg_seq = v\.msg_seq OR m\.msg_seq = v\.result_msg\)/);
  assert.match(s, /ORDER BY v\.session_id, v\.rule, v\.first_seq, v\.seq, m\.msg_seq$/);
  assert.throws(() => riskReadsSql('otel', []), /no risk to read/);
  assert.throws(() => riskReadsSql('otel', [{ session_id: 's', rule: "x' OR '1", first_seq: 1 }]), /no such rule/);
});

test('the latest judgment of every risk, and its words on the pages', () => {
  const s = latestJudgmentsSql('otel');
  assert.match(s, /^\(SELECT subject, max\(judge_version\) AS judge_version, max_by\(verdict, judge_version\) AS verdict, max_by\(reason, judge_version\) AS reason,/);
  assert.match(s, /FROM otel\.agent_judgments WHERE judge IN \('risk-confirm', 'risk-exfil', 'risk-subvert', 'risk-deny'\) GROUP BY subject\)$/);
  assert.equal(judgmentCase('j'), "CASE j.verdict WHEN 'violates' THEN 'breach' WHEN 'ok' THEN 'ok' WHEN 'unsure' THEN 'review' ELSE 'none' END");
});
