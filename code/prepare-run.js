// Parses the prospects tab, validates rows, de-duplicates by website domain / suppresses opted-out emails,
// and prepares the reply check. Rows are only changed in memory here; the writes are planned in the next node.
const res = $input.first().json || {};
const ctx = $('Evaluate Auth and Request').first().json;
const req = ctx.req;
const cfg = ctx.cfg;

const COLS = ['website', 'company', 'email', 'services_summary', 'first_line', 'status', 'sent_at', 'followup_at', 'notes', 'thread_id'];
const KNOWN = new Set(['new', 'enriched', 'draft', 'approved', 'sent', 'followed_up', 'replied', 'opted_out', 'no_email', 'bounced', 'duplicate', 'invalid', 'blocked_url', 'fetch_failed', 'archived']);
const EMAIL_RE = /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[A-Za-z]{2,}$/;
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const values = Array.isArray(res.values) ? res.values : [];
const tabMissing = Boolean(res.error) && !values.length;
const header = (values[0] || []).slice(0, 10).map((s) => String(s || '').trim().toLowerCase());
const headerOk = COLS.every((c, i) => header[i] === c);
const lockCell = String((values[0] || [])[10] || '');
const lockUntil = Date.parse((/until=([^|]+)/.exec(lockCell) || [])[1] || '') || 0;

const out = {
  ...ctx,
  tab_missing: tabMissing,
  header_ok: headerOk,
  abort: false,
  abort_status: 'error',
  abort_note: '',
  rows: [],
  direct: {},
  counts: { invalid: 0, duplicates: 0, suppressed: 0 },
  contacted: [],
  need_reply_check: false,
  reply_query: '',
  enrich_candidates: [],
};

const action = req.action;
if (action === 'init') return [{ json: out }];

if (tabMissing || !headerOk) {
  out.abort = true;
  out.abort_note = tabMissing
    ? 'prospects tab not readable - run {"action":"init"} first'
    : 'prospects tab header does not match the expected columns - run {"action":"init"}';
  return [{ json: out }];
}
if (action === 'run' && !req.force_unlock && lockUntil > Date.now()) {
  out.abort = true;
  out.abort_status = 'ok';
  out.abort_note = 'busy: another run holds the lock until ' + new Date(lockUntil).toISOString();
  return [{ json: out }];
}

// ---- parse rows ----
let rows = values.slice(1).map((r, i) => ({
  _row: i + 2,
  website: String(r[0] || '').trim(),
  company: String(r[1] || '').trim(),
  email: String(r[2] || '').trim(),
  services_summary: String(r[3] || ''),
  first_line: String(r[4] || ''),
  status: String(r[5] || '').trim().toLowerCase(),
  sent_at: String(r[6] || '').trim(),
  followup_at: String(r[7] || '').trim(),
  notes: String(r[8] || ''),
  thread_id: String(r[9] || '').trim(),
})).filter((r) => r.website || r.email || r.company || r.status);

if (req.scope) {
  const re = new RegExp('(^|\\| )ref=' + esc(req.scope) + '( \\||$)');
  rows = rows.filter((r) => re.test(r.notes));
}
rows = rows.filter((r) => r.status !== 'archived');

const addNote = (existing, note) => {
  const refTok = (String(existing).match(/ref=[A-Za-z0-9_.:\-]+/) || [''])[0];
  const rest = String(existing).replace(/ref=[A-Za-z0-9_.:\-]+/, '').split('|').map((s) => s.trim()).filter(Boolean);
  return [refTok, ...rest.slice(-2), note].filter(Boolean).join(' | ').slice(0, 480);
};
const patch = (r, fields, note) => {
  Object.assign(r, fields);
  r.notes = addNote(r.notes, note);
  out.direct[r._row] = true;
};

const domainKey = (website) => {
  const raw = String(website || '').trim();
  if (!raw || /\s/.test(raw)) return null;
  const m = raw.match(/^(?:https?:\/\/)?(?:[^@\/\s]+@)?([a-zA-Z0-9.\-_]+)/);
  if (m && m[1]) return m[1].toLowerCase().replace(/^www\./, '');
  return null;
};

if (action === 'run') {
  // 1) validation
  for (const r of rows) {
    if (!KNOWN.has(r.status)) { patch(r, { status: 'invalid' }, 'invalid: unknown status "' + r.status.slice(0, 30) + '"'); out.counts.invalid++; continue; }
    if (r.status === 'new' && domainKey(r.website) === null) {
      patch(r, { status: 'invalid' }, 'invalid: website is empty or not a valid URL'); out.counts.invalid++; continue;
    }
    if ((r.status === 'approved' || r.status === 'sent') && !EMAIL_RE.test(r.email)) {
      patch(r, { status: 'invalid' }, 'invalid: no valid email on an ' + r.status + ' row'); out.counts.invalid++;
    }
  }
  // 2) duplicate check by website domain (first row wins)
  const seen = new Map();
  const dedupable = new Set(['new', 'enriched', 'draft', 'approved', 'no_email', 'fetch_failed', 'blocked_url']);
  for (const r of rows) {
    if (['duplicate', 'invalid'].includes(r.status)) continue;
    const key = domainKey(r.website);
    if (!key) continue;
    if (seen.has(key)) {
      if (dedupable.has(r.status)) {
        patch(r, { status: 'duplicate' }, 'duplicate domain ' + key + ' (row ' + seen.get(key) + ')');
        out.counts.duplicates++;
      }
    } else {
      seen.set(key, r._row);
    }
  }
  // 3) suppression: an opted-out email is never contacted again, whichever row it shows up on
  const optedOut = new Set(rows.filter((r) => r.status === 'opted_out' && r.email).map((r) => r.email.toLowerCase()));
  for (const r of rows) {
    if (['new', 'enriched', 'draft', 'approved'].includes(r.status) && r.email && optedOut.has(r.email.toLowerCase())) {
      patch(r, { status: 'opted_out' }, 'email is on the opt-out list');
      out.counts.suppressed++;
    }
  }
}

out.rows = rows;
if (action === 'run') {
  out.enrich_candidates = rows.filter((r) => r.status === 'new').slice(0, Number(cfg.MAX_ENRICH_PER_RUN || 10)).map((r) => r._row);
  const contacted = rows.filter((r) => ['sent', 'followed_up'].includes(r.status) && EMAIL_RE.test(r.email));
  out.contacted = contacted.map((r) => r._row);
  // Search by the base address: a Gmail reply to name+tag@gmail.com comes back From name@gmail.com.
  const baseAddr = (e) => { const [u, d] = String(e).toLowerCase().split('@'); return /^(gmail|googlemail)\.com$/.test(d) ? u.split('+')[0] + '@' + d : u + '@' + d; };
  const addrs = [...new Set(contacted.map((r) => baseAddr(r.email)))].slice(0, 20);
  if (addrs.length) {
    const times = contacted.map((r) => Date.parse(r.sent_at)).filter((t) => Number.isFinite(t));
    const earliest = times.length ? Math.min(...times) : Date.now() - 7 * 86400000;
    const after = Math.max(0, Math.floor((earliest - 86400000) / 1000));
    out.need_reply_check = true;
    out.reply_query = 'in:anywhere after:' + after + ' (' + addrs.map((a) => 'from:' + a).join(' OR ') + ' OR from:mailer-daemon)';
  }
}
return [{ json: out }];

