// Turns the send outcome (Gmail success, Gmail error, or a skip) into a row patch + result record.
const comp = $('Compose Email').first().json;
const inp = $input.first().json || {};
const { cfg, req, task } = comp;
const e = comp.email;
const row = { ...comp.row };
const tab = cfg.PROSPECTS_TAB || 'prospects';
const COLS = ['website', 'company', 'email', 'services_summary', 'first_line', 'status', 'sent_at', 'followup_at', 'notes', 'thread_id'];
const clean = (v) => String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').slice(0, 500);
const addNote = (existing, note) => {
  const refTok = (String(existing).match(/ref=[A-Za-z0-9_.:\-]+/) || [''])[0];
  const rest = String(existing).replace(/ref=[A-Za-z0-9_.:\-]+/, '').split('|').map((s) => s.trim()).filter(Boolean);
  return [refTok, ...rest.slice(-2), note].filter(Boolean).join(' | ').slice(0, 480);
};

const before = String(row.status || '');
const sent = e.should_send && Boolean(inp.id) && !inp.error;
const failed = (e.should_send && !sent) || e.simulated_failure;
const isAlert = task === 'owner_alert';
let note = '';
let errorMessage = '';
let writeNeeded = false;

if (sent) {
  if (!isAlert) {
    // Keep the Gmail thread of every email sent to this row, so a reply is matched to exactly this row.
    const tid = String(inp.threadId || '').replace(/[^A-Za-z0-9]/g, '');
    const known = String(row.thread_id || '').split(/\s+/).filter(Boolean);
    if (tid && !known.includes(tid)) known.push(tid);
    row.thread_id = known.join(' ');
    if (task === 'followup') { row.status = 'followed_up'; row.followup_at = req.now_iso; }
    else { row.status = 'sent'; row.sent_at = req.now_iso; }
    writeNeeded = true;
  }
  note = (isAlert ? 'owner alert sent to ' : task + ' sent to ') + e.to + (req.recipient_mode === 'live' ? '' : ' (test mode; intended ' + e.intended + ')');
} else if (failed) {
  const msg = String(typeof inp.error === 'string' ? inp.error : (inp.error && (inp.error.message || inp.error.description)) || (e.simulated_failure ? 'simulated email failure (test hook)' : 'Gmail send failed')).slice(0, 160);
  note = 'send_failed: ' + msg;
  errorMessage = 'Email ' + task + ' failed for sheet row ' + row._row + ': ' + msg;
  writeNeeded = !isAlert;
} else if (e.skip_reason) {
  note = 'skipped: ' + e.skip_reason;
} else {
  note = e.dry_note;
}
if (writeNeeded) row.notes = addNote(row.notes || '', note);

return [{
  json: {
    outcome_ready: true, task, route: 'email', cfg,
    row_range: tab + '!A' + row._row + ':J' + row._row,
    row_values: COLS.map((c) => clean(row[c])),
    write_needed: writeNeeded,
    result: {
      task, row_number: row._row, status_before: before, status_after: String(row.status || ''), note,
      emails_sent: sent ? 1 : 0, would_send: !e.skip_reason && Boolean(e.dry_note), failures: failed ? 1 : 0,
      error_message: errorMessage, ai_calls: 0, used_ai_fallback: false, sent_to: sent ? e.to : '', subject: sent ? e.subject : '',
    },
  },
}];

