// Unit tests for WF02 reply matching, thread tracking and test-recipient routing.
// They run the REAL code-node files with mocked n8n inputs ($ and $input). No network, no n8n needed.
// Usage: node tests/wf02-replies.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const dir = path.resolve(__dirname, '../code');
const load = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const runNode = (file, { nodes = {}, input = [] }) => {
  const $ = (name) => {
    if (!(name in nodes)) throw new Error('unexpected node reference: ' + name);
    return { first: () => ({ json: nodes[name] }) };
  };
  const $input = { first: () => ({ json: input[0] }), all: () => input.map((json) => ({ json })) };
  return new Function('$', '$input', load(file))($, $input);
};

const cfg = {
  CRM_SHEET_ID: 'sheet', PROSPECTS_TAB: 'prospects', TEST_EMAIL: 'owner@example.com', OWNER_EMAIL: 'owner@example.com',
  TEST_MODE: true, TEST_ALLOWLIST: 'prospect@gmail.com', BOOKING_LINK: 'https://cal.com/x/30min', SENDER_NAME: 'Sid',
  PITCH_LINE: 'pitch', DAILY_SEND_CAP: 30, SEND_WINDOW_START_HOUR: 0, SEND_WINDOW_END_HOUR: 24, TZ_OFFSET_HOURS: 8,
  FOLLOWUP_AFTER_DAYS: 3, MIN_DELAY_MINUTES: 0, MAX_DELAY_MINUTES: 0, MAX_ENRICH_PER_RUN: 10,
};
const NOW = '2026-11-07T06:00:00.000Z';
const T0 = Date.parse('2026-11-07T02:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const HEADER = ['website', 'company', 'email', 'services_summary', 'first_line', 'status', 'sent_at', 'followup_at', 'notes', 'thread_id'];

// Three companies, all on the same base inbox (plus-addressed), each with its own Gmail thread.
const sheet = (overrides = {}) => {
  const base = [
    ['https://acme.test', 'Acme', 'prospect+acme@gmail.com', '', 'l', 'sent', iso(T0), '', 'ref=t1', 'thrA'],
    ['https://beta.test', 'Beta', 'prospect+beta@gmail.com', '', 'l', 'sent', iso(T0 + 60000), '', 'ref=t1', 'thrB'],
    ['https://gamma.test', 'Gamma', 'prospect+gamma@gmail.com', '', 'l', 'sent', iso(T0 + 120000), '', 'ref=t1', 'thrG'],
  ];
  for (const [i, patch] of Object.entries(overrides)) Object.assign(base[i], patch);
  return { values: [HEADER, ...base] };
};
const req = (extra = {}) => ({ action: 'run', scope: 't1', flags: [], dry_run: true, recipient_mode: 'test', now_iso: NOW, cap_override: null, delay_override_minutes: null, simulated_replies: [], ...extra });
const evalCtx = (r = req()) => ({ cfg, req: r, ref: 't1', execution_id: '1', status: 'pending' });

const prepare = (values, r) => runNode('prepare-run.js', { nodes: { 'Evaluate Auth and Request': evalCtx(r) }, input: [values] })[0].json;
const classifyRun = (values, msgs, r) => {
  const prep = prepare(values, r);
  return { prep, out: runNode('classify-and-plan.js', { nodes: { 'Prepare Run': prep }, input: msgs.length ? msgs : [{ id: 'none' }] })[0].json };
};
const msg = (id, threadId, from, snippet, whenMs) => ({ id, threadId, internalDate: String(whenMs), snippet, payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: 'Re: Quick idea' }] } });
// Apply the sheet writes a run planned, so the next run sees the new state (like the real sheet would).
const applyOps = (values, out) => {
  const v = values.values.map((r) => [...r]);
  for (const op of out.ops) for (const d of (op.op_body.data || [])) {
    const m = /!A(\d+):J\d+$/.exec(d.range);
    if (m) v[Number(m[1]) - 1] = d.values[0];
  }
  return { values: v };
};
const statusOf = (values, company) => values.values.find((r) => r[1] === company)[5];
const alertsFor = (out) => out.tasks.filter((t) => t.task === 'owner_alert').map((t) => t.row.company);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('prepare-run reads the thread_id column and searches the base Gmail address', () => {
  const p = prepare(sheet());
  assert.strictEqual(p.header_ok, true);
  assert.strictEqual(p.rows[0].thread_id, 'thrA');
  assert.ok(p.reply_query.includes('from:prospect@gmail.com'), p.reply_query);
  assert.ok(!p.reply_query.includes('+acme'), 'plus tag must be stripped for Gmail search');
});

test('old 9-column header is rejected until init adds thread_id', () => {
  const v = sheet(); v.values[0] = HEADER.slice(0, 9);
  assert.strictEqual(prepare(v).header_ok, false);
});

test('in-thread reply marks ONLY its own row and sends ONE alert', () => {
  const { out } = classifyRun(sheet(), [msg('m1', 'thrA', 'Fwo <prospect@gmail.com>', 'Interested, tell me more On Sat wrote:', T0 + 600000)]);
  assert.deepStrictEqual(alertsFor(out), ['Acme']);
  assert.strictEqual(out.plan.replied, 1);
  const after = applyOps(sheet(), out);
  assert.strictEqual(statusOf(after, 'Acme'), 'replied');
  assert.strictEqual(statusOf(after, 'Beta'), 'sent');
  assert.strictEqual(statusOf(after, 'Gamma'), 'sent');
});

test('GAMMA REGRESSION: re-running after a reply never moves it to another row and never re-alerts', () => {
  let s = sheet();
  const m = [msg('m1', 'thrA', 'prospect@gmail.com', 'Interested, tell me more', T0 + 600000)];
  for (let run = 1; run <= 4; run++) {
    const { out } = classifyRun(s, m);
    assert.deepStrictEqual(alertsFor(out), run === 1 ? ['Acme'] : [], 'run ' + run + ' alerts');
    s = applyOps(s, out);
  }
  assert.strictEqual(statusOf(s, 'Beta'), 'sent');
  assert.strictEqual(statusOf(s, 'Gamma'), 'sent');
});

test('a message outside our threads never changes a thread-tracked row', () => {
  const { out } = classifyRun(sheet(), [msg('m9', 'thrNEW', 'prospect@gmail.com', 'no', T0 + 900000)]);
  assert.strictEqual(out.plan.opted_out + out.plan.replied, 0);
  assert.strictEqual(out.plan.replies_ignored, 1);
});

test('STEP-12 REGRESSION: old untracked "no" + backdated sent_at does not opt out Gamma; follow-up goes out', () => {
  const older = T0 - 4 * 86400000;
  const s = sheet({ 0: { 5: 'replied' }, 1: { 5: 'opted_out' }, 2: { 6: iso(older) } });
  const old = [msg('o1', 'thrOLD1', 'prospect@gmail.com', 'Interested, tell me more', T0 - 1800000), msg('o2', 'thrOLD2', 'prospect@gmail.com', 'no', T0 - 1700000)];
  const { out } = classifyRun(s, old);
  assert.strictEqual(out.plan.opted_out, 0);
  assert.strictEqual(out.plan.replied, 0);
  assert.deepStrictEqual(out.tasks.filter((t) => t.task === 'followup').map((t) => t.row.company), ['Gamma']);
});

test('legacy rows (no thread_id): fresh email maps to ONE row and stays there on reruns', () => {
  let s = sheet({ 0: { 9: '' }, 1: { 9: '' }, 2: { 9: '' } });
  const m = [msg('m9', 'thrNEW', 'prospect@gmail.com', 'Hey, saw your email, can we talk?', T0 + 900000)];
  const seen = [];
  for (let run = 1; run <= 3; run++) { const { out } = classifyRun(s, m); seen.push(alertsFor(out)); s = applyOps(s, out); }
  assert.deepStrictEqual(seen, [['Gamma'], [], []]);
  assert.strictEqual(statusOf(s, 'Acme'), 'sent');
  assert.strictEqual(statusOf(s, 'Beta'), 'sent');
});

test('"no" in thread opts out only that row; its follow-up is never planned', () => {
  const { out } = classifyRun(sheet(), [msg('m2', 'thrB', 'prospect@gmail.com', 'no On Sat, Nov 7 wrote: > Hi there', T0 + 600000)]);
  assert.strictEqual(out.plan.opted_out, 1);
  assert.deepStrictEqual(alertsFor(out), []);
  const after = applyOps(sheet(), out);
  assert.strictEqual(statusOf(after, 'Beta'), 'opted_out');
  assert.strictEqual(statusOf(after, 'Acme'), 'sent');
});

test('replied row that later says "no" is upgraded to opted_out, no second alert', () => {
  const s = sheet({ 0: { 5: 'replied' } });
  const { out } = classifyRun(s, [
    msg('m1', 'thrA', 'prospect@gmail.com', 'Interested', T0 + 600000),
    msg('m3', 'thrA', 'prospect@gmail.com', 'Please stop emailing me', T0 + 700000),
  ]);
  assert.deepStrictEqual(alertsFor(out), []);
  assert.strictEqual(statusOf(applyOps(s, out), 'Acme'), 'opted_out');
});

test('reply text starting with "not"/"November" is a reply, not an opt-out', () => {
  for (const text of ['Not sure yet, what does it cost?', 'November works for a call', 'Nothing urgent but interested', 'No problem, send details']) {
    const { out } = classifyRun(sheet(), [msg('m', 'thrA', 'prospect@gmail.com', text, T0 + 600000)]);
    assert.strictEqual(out.plan.replied, 1, text);
    assert.strictEqual(out.plan.opted_out, 0, text);
  }
  for (const text of ['no', 'No thanks', 'Stop', 'unsubscribe', 'not interested', "Please don't email me"]) {
    const { out } = classifyRun(sheet(), [msg('m', 'thrA', 'prospect@gmail.com', text, T0 + 600000)]);
    assert.strictEqual(out.plan.opted_out, 1, text);
  }
});

test('an old email from before we sent is ignored', () => {
  const { out } = classifyRun(sheet(), [msg('old', 'thrOLD', 'prospect@gmail.com', 'Interested (old test)', T0 - 3 * 86400000)]);
  assert.strictEqual(out.plan.replied, 0);
  assert.strictEqual(out.plan.replies_ignored, 1);
});

test('bounce in our thread marks that row bounced', () => {
  const { out } = classifyRun(sheet(), [msg('b1', 'thrG', 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', 'Address not found', T0 + 600000)]);
  assert.strictEqual(out.plan.bounced, 1);
  assert.strictEqual(statusOf(applyOps(sheet(), out), 'Gamma'), 'bounced');
});

test('follow-up planned only for the silent row after 3 days', () => {
  const s = sheet({ 0: { 5: 'replied' }, 1: { 5: 'opted_out' } });
  const later = req({ now_iso: iso(T0 + 3 * 86400000 + 3600000) });
  const { out } = classifyRun(s, [], later);
  const fu = out.tasks.filter((t) => t.task === 'followup').map((t) => t.row.company);
  assert.deepStrictEqual(fu, ['Gamma']);
});

test('follow-up is never sent to an address that opted out on another row', () => {
  const s = sheet({ 1: { 2: 'prospect+gamma@gmail.com', 5: 'opted_out' } });
  const { out } = classifyRun(s, [], req({ now_iso: iso(T0 + 4 * 86400000) }));
  assert.deepStrictEqual(out.tasks.filter((t) => t.task === 'followup').map((t) => t.row.company), ['Acme']);
});

test('init writes the 10-column header', () => {
  const { out } = classifyRun(sheet(), [], req({ action: 'init' }));
  const d = out.ops.find((o) => o.op_body.data && o.op_body.data[0].range === 'prospects!A1:J1');
  assert.ok(d, 'header op');
  assert.deepStrictEqual(d.op_body.data[0].values[0], HEADER);
});

test('patch_row cannot write unknown fields like _row', () => {
  const r = req({ action: 'patch_row', row_number: 2, patch_fields: { _row: 99, sent_at: '2026-11-01T00:00:00Z' } });
  const { out } = classifyRun(sheet(), [], r);
  const d = out.ops[0].op_body.data[0];
  assert.strictEqual(d.range, 'prospects!A2:J2');
  assert.strictEqual(d.values[0][6], '2026-11-01T00:00:00Z');
});

// ---- worker nodes ----
const compose = (row, task = 'send', over = {}) => runNode('worker/compose-email.js', {
  input: [{ cfg: { ...cfg, ...(over.cfg || {}) }, req: { flags: [], dry_run: false, recipient_mode: over.mode || 'test', now_iso: NOW }, row, task, ref: 't1' }],
})[0].json.email;

test('TEST_ALLOWLIST: allowlisted row gets the real email; anything else goes to TEST_EMAIL', () => {
  const r = { _row: 2, company: 'Acme', email: 'prospect+acme@gmail.com', status: 'approved', first_line: 'hi' };
  assert.strictEqual(compose(r).to, 'prospect+acme@gmail.com');
  assert.strictEqual(compose({ ...r, email: 'ceo@realcompany.com' }).to, 'owner@example.com');
  assert.strictEqual(compose({ ...r, email: 'evil@x.com, prospect@gmail.com' }).to, 'owner@example.com');
  assert.strictEqual(compose(r, 'send', { cfg: { TEST_ALLOWLIST: '' } }).to, 'owner@example.com');
  assert.strictEqual(compose(r, 'send', { cfg: { TEST_MODE: false } }).to, 'owner@example.com');
  assert.strictEqual(compose(r, 'owner_alert').to, 'owner@example.com');
});

test('dry run still sends the owner alert (to the owner only) but never a prospect email', () => {
  const r = { _row: 2, company: 'Acme', email: 'prospect+acme@gmail.com', status: 'approved', first_line: 'hi' };
  const dry = (row, task) => runNode('worker/compose-email.js', { input: [{ cfg, req: { flags: [], dry_run: true, recipient_mode: 'test', now_iso: NOW }, row, task, ref: 't1' }] })[0].json.email;
  const a = dry({ ...r, status: 'replied' }, 'owner_alert');
  assert.strictEqual(a.should_send, true);
  assert.strictEqual(a.to, 'owner@example.com');
  assert.strictEqual(dry(r, 'send').should_send, false);
  assert.strictEqual(dry({ ...r, status: 'sent' }, 'followup').should_send, false);
});

const outcome = (row, task, inp) => runNode('worker/email-outcome.js', {
  nodes: { 'Compose Email': { cfg, req: { recipient_mode: 'test', now_iso: NOW }, task, row, email: { should_send: true, to: 'x@y.com', intended: row.email, subject: 's' } } },
  input: [inp],
})[0].json;

test('email-outcome stores the Gmail thread on send and appends it on follow-up', () => {
  const r1 = outcome({ _row: 2, email: 'a@b.com', status: 'approved', notes: 'ref=t1' }, 'send', { id: 'g1', threadId: 'thrX' });
  assert.strictEqual(r1.row_range, 'prospects!A2:J2');
  assert.strictEqual(r1.row_values[9], 'thrX');
  assert.strictEqual(r1.row_values[5], 'sent');
  const r2 = outcome({ _row: 2, email: 'a@b.com', status: 'sent', notes: 'ref=t1', thread_id: 'thrX' }, 'followup', { id: 'g2', threadId: 'thrY' });
  assert.strictEqual(r2.row_values[9], 'thrX thrY');
  assert.strictEqual(r2.row_values[5], 'followed_up');
});

let failed = 0;
for (const t of tests) {
  try { t.fn(); console.log('PASS  ' + t.name); } catch (e) { failed++; console.log('FAIL  ' + t.name + '\n      ' + e.message.split('\n')[0]); }
}
console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
