// Applies replies (real Gmail replies + TEST_MODE simulated ones), then plans every sheet write and every worker task:
// enrich (new rows), owner alerts (replies), first sends (approved rows) and one follow-up (sent >= N days, no reply).
const ctx = $('Prepare Run').first().json;
const cfg = ctx.cfg;
const req = ctx.req;
const rows = ctx.rows || [];
const action = req.action;

const COLS = ['website', 'company', 'email', 'services_summary', 'first_line', 'status', 'sent_at', 'followup_at', 'notes', 'thread_id'];
const EMAIL_RE = /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[A-Za-z]{2,}$/;
const sheetBase = 'https://sheets.googleapis.com/v4/spreadsheets/' + cfg.CRM_SHEET_ID;
const tab = cfg.PROSPECTS_TAB || 'prospects';
const direct = { ...(ctx.direct || {}) };
const byRow = new Map(rows.map((r) => [r._row, r]));

const addNote = (existing, note) => {
  const refTok = (String(existing).match(/ref=[A-Za-z0-9_.:\-]+/) || [''])[0];
  const rest = String(existing).replace(/ref=[A-Za-z0-9_.:\-]+/, '').split('|').map((s) => s.trim()).filter(Boolean);
  return [refTok, ...rest.slice(-2), note].filter(Boolean).join(' | ').slice(0, 480);
};
const patch = (r, fields, note) => { Object.assign(r, fields); r.notes = addNote(r.notes, note); direct[r._row] = true; };
const rowValues = (r) => COLS.map((c) => (r[c] === undefined || r[c] === null ? '' : String(r[c])));

// ---------------- replies ----------------
const decode = (s) => String(s || '').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
// The \b matters: "not sure yet" or "November works" must not count as a "no".
const OPT_OUT = /^(no|nope|no thanks|no thank you|please (do not|don't|stop)|stop|unsubscribe|remove me|not interested|do not (contact|email)|don't (contact|email))\b/;
const NOT_OPT_OUT = /^no (problem|worries)/;
const classify = (text) => {
  const t = decode(text).toLowerCase().replace(/^[\s>"']+/, '').trim();
  if (NOT_OPT_OUT.test(t)) return 'replied';
  if (/^no\b[\s.!,]*$/.test(t) || OPT_OUT.test(t)) return 'opted_out';
  return 'replied';
};
const contacted = (ctx.contacted || []).map((n) => byRow.get(n)).filter(Boolean);
const isContacted = new Set(contacted.map((r) => r._row));
// name+tag@gmail.com and name@gmail.com are the same inbox; a Gmail reply always comes From the base address.
const baseAddr = (e) => { const [u, d] = String(e || '').trim().toLowerCase().split('@'); if (!d) return u || ''; return /^(gmail|googlemail)\.com$/.test(d) ? u.split('+')[0] + '@' + d : u + '@' + d; };
// Every Gmail thread we started for a row (first email + follow-up). Built from ALL rows, so a thread that
// belongs to a row that already replied can never be re-used to mark a different row.
const threadOwner = new Map();
for (const r of rows) for (const t of String(r.thread_id || '').split(/\s+/).filter(Boolean)) threadOwner.set(t, r);
const sentMs = (r) => Date.parse(r.sent_at);
const events = []; // {row, kind, text, via}
let ignoredReplies = 0;
const msgs = $input.all().map((i) => i.json).filter((j) => j && j.id && j.payload);
for (const m of msgs) {
  const hd = (m.payload && m.payload.headers) || [];
  const h = (n) => (hd.find((x) => String(x.name).toLowerCase() === n) || {}).value || '';
  const fromRaw = h('from');
  const addr = baseAddr((/<([^>]+)>/.exec(fromRaw) || [])[1] || fromRaw);
  const when = Number(m.internalDate) || 0;
  const snippet = String(m.snippet || '');
  const bounce = /mailer-daemon|postmaster/.test(addr);
  const owner = m.threadId ? threadOwner.get(String(m.threadId)) : null;

  // 1) In one of our threads: it belongs to that row and to no other row.
  if (owner) {
    const kind = bounce ? 'bounced' : classify(snippet);
    if (isContacted.has(owner._row)) events.push({ row: owner, kind, text: snippet, via: 'thread' });
    else if (owner.status === 'replied' && kind === 'opted_out') events.push({ row: owner, kind, text: snippet, via: 'thread' });
    else ignoredReplies++;
    continue;
  }
  // 2) Bounce outside our threads: only the contacted row whose address the notice names.
  if (bounce) {
    const hit = contacted.filter((r) => snippet.toLowerCase().includes(r.email.toLowerCase()));
    if (hit.length === 1) events.push({ row: hit[0], kind: 'bounced', text: snippet, via: 'address' });
    else ignoredReplies++;
    continue;
  }
  // 3) Not in any of our threads. A row that has a thread_id is matched ONLY by its thread, never by address:
  //    otherwise old mail from the same person (an earlier campaign, an archived row) could flip a new row.
  //    The address fallback is kept only for rows sent before thread tracking existed (no thread_id). Among
  //    those, the row most recently sent before the message wins, chosen over ALL rows so reruns stay stable.
  const cands = rows.filter((r) => !r.thread_id && baseAddr(r.email) === addr && Number.isFinite(sentMs(r)) && sentMs(r) - 60000 <= when);
  cands.sort((a, b) => sentMs(b) - sentMs(a) || b._row - a._row);
  const pick = cands[0];
  if (pick && isContacted.has(pick._row)) events.push({ row: pick, kind: classify(snippet), text: snippet, via: 'address' });
  else ignoredReplies++;
}
for (const s of req.simulated_replies || []) {
  for (const r of contacted) if (r.email.toLowerCase() === s.email) events.push({ row: r, kind: classify(s.body), text: s.body, simulated: true, via: 'simulated' });
}
const rank = { opted_out: 3, bounced: 2, replied: 1 };
const best = new Map();
for (const e of events) {
  const cur = best.get(e.row._row);
  if (!cur || rank[e.kind] > rank[cur.kind]) best.set(e.row._row, e);
}
const alertTasks = [];
let replied = 0; let optedOut = 0; let bounced = 0;
for (const [, e] of best) {
  const r = e.row;
  const src = e.simulated ? ' (simulated reply)' : '';
  const via = e.via ? ' [matched by ' + e.via + ']' : '';
  if (e.kind === 'opted_out') { patch(r, { status: 'opted_out' }, 'opted out: "no" reply received' + src + via); optedOut++; }
  else if (e.kind === 'bounced') { patch(r, { status: 'bounced' }, 'bounced: delivery failure notice received' + via); bounced++; }
  else if (r.status !== 'replied') {
    // Exactly one owner alert, at the moment the row turns "replied".
    patch(r, { status: 'replied' }, 'replied: follow-ups stopped' + src + via); replied++; alertTasks.push({ task: 'owner_alert', row: { ...r } });
  }
}

// ---------------- planning ----------------
const nowMs = Date.parse(req.now_iso);
const tzMs = Number(cfg.TZ_OFFSET_HOURS || 0) * 3600000;
const localDay = (ms) => new Date(ms + tzMs).toISOString().slice(0, 10);
const today = localDay(nowMs);
const localHour = new Date(nowMs + tzMs).getUTCHours();
const inWindow = localHour >= Number(cfg.SEND_WINDOW_START_HOUR) && localHour < Number(cfg.SEND_WINDOW_END_HOUR);
const dayOf = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? localDay(t) : null; };
const sentToday = rows.reduce((n, r) => n + (dayOf(r.sent_at) === today ? 1 : 0) + (dayOf(r.followup_at) === today ? 1 : 0), 0);
const cap = req.cap_override !== null && req.cap_override !== undefined ? req.cap_override : Number(cfg.DAILY_SEND_CAP);
const remaining = Math.max(0, cap - sentToday);

const followMs = Number(cfg.FOLLOWUP_AFTER_DAYS) * 86400000;
const optedOutAddrs = new Set(rows.filter((r) => r.status === 'opted_out' && r.email).map((r) => r.email.toLowerCase()));
const followups = rows.filter((r) => r.status === 'sent' && !optedOutAddrs.has(r.email.toLowerCase()) && !r.followup_at && EMAIL_RE.test(r.email) && Number.isFinite(Date.parse(r.sent_at)) && nowMs - Date.parse(r.sent_at) >= followMs);
const approved = rows.filter((r) => r.status === 'approved' && EMAIL_RE.test(r.email));
const candidates = [...followups.map((r) => ({ r, task: 'followup' })), ...approved.map((r) => ({ r, task: 'send' }))];

let planned = [];
let windowNote = '';
if (action === 'run') {
  if (!inWindow) { windowNote = 'outside_send_window (local hour ' + localHour + ')'; }
  else planned = candidates.slice(0, remaining);
}
const waiting = action === 'run' ? candidates.length - planned.length : 0;
const minD = Number(cfg.MIN_DELAY_MINUTES); const maxD = Number(cfg.MAX_DELAY_MINUTES);
const sendTasks = planned.map((c, i) => {
  let delay = 0;
  if (!req.dry_run && i < planned.length - 1) {
    const minutes = req.delay_override_minutes !== null && req.delay_override_minutes !== undefined ? req.delay_override_minutes : minD + Math.random() * Math.max(0, maxD - minD);
    delay = Math.round(minutes * 60);
  }
  return { task: c.task, row: { ...c.r }, delay_seconds: delay };
});

let enrichTasks = [];
if (action === 'run' && !ctx.abort) {
  enrichTasks = (ctx.enrich_candidates || []).map((n) => byRow.get(n)).filter((r) => r && r.status === 'new').map((r) => ({ task: 'enrich', row: { ...r } }));
}
const tasks = ctx.abort || action !== 'run' ? [] : [...alertTasks, ...enrichTasks, ...sendTasks];

// ---------------- sheet operations ----------------
const ops = [];
if (action === 'init') {
  if (ctx.tab_missing) {
    ops.push({ op_method: 'POST', op_url: sheetBase + ':batchUpdate', op_body: { requests: [{ addSheet: { properties: { title: tab } } }] } });
  }
  ops.push({
    op_method: 'POST',
    op_url: sheetBase + '/values:batchUpdate',
    op_body: { valueInputOption: 'RAW', data: [{ range: tab + '!A1:J1', values: [COLS] }] },
  });
}
if (action === 'seed' && !ctx.abort) {
  const STATUSES = new Set(['new', 'enriched', 'draft', 'approved', 'sent', 'followed_up', 'replied', 'opted_out', 'no_email', 'bounced', 'duplicate', 'invalid']);
  const clean = (v) => String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').slice(0, 500);
  const vals = (req.seed_rows || []).map((s) => {
    const o = s && typeof s === 'object' ? s : {};
    const status = STATUSES.has(String(o.status || 'new').toLowerCase()) ? String(o.status || 'new').toLowerCase() : 'new';
    const notes = ['ref=' + req.scope, clean(o.notes)].filter(Boolean).join(' | ');
    return [clean(o.website), clean(o.company), clean(o.email), clean(o.services_summary), clean(o.first_line), status, clean(o.sent_at), clean(o.followup_at), notes, clean(o.thread_id)];
  });
  if (vals.length) ops.push({ op_method: 'POST', op_url: sheetBase + '/values/' + encodeURIComponent(tab + '!A:J') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', op_body: { values: vals } });
}
if (action === 'archive' && !ctx.abort) {
  for (const r of rows) patch(r, { status: 'archived' }, 'archived after test');
}
if (action === 'patch_row' && !ctx.abort) {
  let target = byRow.get(req.row_number);
  if (!target && req.company_match) {
    target = rows.find((r) => r.company.toLowerCase() === req.company_match.toLowerCase());
  }
  if (target) {
    const pf = {};
    for (const [k, v] of Object.entries(req.patch_fields || {})) if (COLS.includes(k) && k !== 'notes') pf[k] = String(v === null || v === undefined ? '' : v).slice(0, 500);
    patch(target, pf, 'test patch ' + Object.keys(pf).join(','));
  }
}
if (!ctx.abort) {
  const changed = Object.keys(direct).map(Number).map((n) => byRow.get(n)).filter(Boolean);
  for (let i = 0; i < changed.length; i += 100) {
    const chunk = changed.slice(i, i + 100);
    ops.push({
      op_method: 'POST', op_url: sheetBase + '/values:batchUpdate',
      op_body: { valueInputOption: 'RAW', data: chunk.map((r) => ({ range: tab + '!A' + r._row + ':J' + r._row, values: [rowValues(r)] })) },
    });
  }
}
let lockSet = false;
if (action === 'run' && !ctx.abort && tasks.length) {
  const est = sendTasks.reduce((n, t) => n + t.delay_seconds, 0) + tasks.length * 90 + 300;
  const until = new Date(Date.now() + est * 1000).toISOString();
  ops.push({
    op_method: 'POST',
    op_url: sheetBase + '/values:batchUpdate',
    op_body: { valueInputOption: 'RAW', data: [{ range: tab + '!K1', values: [['until=' + until + '|exec=' + ctx.execution_id]] }] },
  });
  lockSet = true;
}

const { rows: _rows, direct: _direct, ...rest } = ctx;
return [{
  json: {
    ...rest,
    ops,
    tasks,
    lock_set: lockSet,
    plan: {
      rows_seen: rows.length, direct_updates: Object.keys(direct).length,
      invalid: ctx.counts.invalid, duplicates: ctx.counts.duplicates, suppressed: ctx.counts.suppressed,
      replied, opted_out: optedOut, bounced, replies_seen: msgs.length, replies_ignored: ignoredReplies,
      enrich_tasks: enrichTasks.length, send_candidates: candidates.length, send_planned: planned.length,
      waiting, sent_today: sentToday, cap, in_window: inWindow, window_note: windowNote,
    },
  },
}];

