// Composes one plain-text email. The recipient is decided here and ONLY from Config:
// test mode -> TEST_EMAIL, or the row's own address if it is on Config TEST_ALLOWLIST (owner-controlled inboxes);
// live mode -> the approved row's validated email. Row, website or AI text can never add an address to the allowlist.
const t = $input.first().json;
const { cfg, req, row, task } = t;
const flags = (req && req.flags) || [];
const EMAIL_RE = /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[A-Za-z]{2,}$/;
const live = req.recipient_mode === 'live';
const testEmail = String(cfg.TEST_EMAIL || '').trim();
const ownerEmail = String(cfg.OWNER_EMAIL || testEmail).trim();
const bad = (e) => !EMAIL_RE.test(e) || e.toUpperCase().includes('PLACEHOLDER');

if (bad(testEmail)) throw new Error('TEST_EMAIL is not configured - refusing to send any email');
const link = String(cfg.BOOKING_LINK || '').trim();
if (!link.startsWith('https://') || link.includes('<') || link.toUpperCase().includes('PLACEHOLDER')) {
  throw new Error('Invalid BOOKING_LINK: must be https and cannot contain < or PLACEHOLDER');
}
const sender = String(cfg.SENDER_NAME || 'Sid').trim();
const optOut = String(cfg.OPT_OUT_LINE || "Reply 'no' and I won't email again").trim();
const pitch = String(cfg.PITCH_LINE || '').replace(/[\r\n]+/g, ' ').trim();
const oneLine = (s, n) => String(s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const company = oneLine(String(row.company || '').replace(/[<>]/g, ''), 60) || 'your team';
const isTest = !live;
const testMode = cfg.TEST_MODE === true || cfg.TEST_MODE === 'true';
const baseAddr = (e) => { const [u, d] = String(e || '').trim().toLowerCase().split('@'); if (!d) return ''; return /^(gmail|googlemail)\.com$/.test(d) ? u.split('+')[0] + '@' + d : u + '@' + d; };
const allowList = new Set(String(cfg.TEST_ALLOWLIST || '').split(/[\s,;]+/).map(baseAddr).filter((a) => EMAIL_RE.test(a)));
const allowed = (e) => EMAIL_RE.test(String(e || '').trim()) && allowList.has(baseAddr(e));
const refTag = testMode && t.ref ? ' [' + t.ref + ']' : '';
const refBody = testMode && t.ref ? '\nRef: ' + t.ref : '';

let skip = '';
if (task === 'send' && row.status !== 'approved') skip = 'not_approved';
if (task === 'followup' && !(row.status === 'sent' && !row.followup_at)) skip = 'followup_not_due';
if ((task === 'send' || task === 'followup') && !EMAIL_RE.test(String(row.email || ''))) skip = 'invalid_email';

let to;
let subject;
let body;
if (task === 'owner_alert') {
  to = live ? ownerEmail : testEmail;
  if (bad(to)) throw new Error('OWNER_EMAIL is not a valid address');
  subject = '[STUDIO] Prospect replied: ' + company + refTag;
  body = 'A prospect replied, so follow-ups are stopped.\n\nCompany: ' + company + '\nWebsite: ' + oneLine(row.website, 120) + '\nEmail: ' + oneLine(row.email, 120) + '\nSheet row: ' + row._row + refBody;
} else {
  // TEST_MODE only: a row whose address is on TEST_ALLOWLIST (addresses the owner controls) gets the email itself,
  // so a real in-thread reply can be tested. Every other row in test mode still goes to TEST_EMAIL.
  const allowTo = testMode && !live && allowed(row.email) ? String(row.email).trim() : '';
  to = live ? String(row.email || '').trim() : (allowTo || testEmail);
  const firstLine = oneLine(row.first_line, 300) || String(cfg.NEUTRAL_FIRST_LINE || '').trim();
  const sig = '\n\nBest,\n' + sender + '\n\n' + optOut;
  const cta = "If a short call would help, here's my calendar: " + link;
  if (task === 'followup') {
    subject = 'Re: Quick idea for ' + company;
    body = 'Hi there,\n\nJust floating this back up in case it got buried. ' + pitch + '\n\n' + cta + sig;
  } else {
    subject = 'Quick idea for ' + company;
    body = 'Hi there,\n\n' + firstLine + '\n\n' + pitch + '\n\n' + cta + sig;
  }
  subject = oneLine(subject, 120) + refTag;
  if (isTest) body += '\n\n[TEST MODE] Intended recipient: ' + oneLine(row.email, 120) + refBody;
}
if (bad(to)) skip = skip || 'invalid_recipient';

const emailDown = flags.includes('email_down');
// DRY_RUN protects prospects. Owner alerts only ever go to the owner (TEST_EMAIL in test mode), and the row has
// already turned "replied" by the time the alert is built, so a dry-run alert would be lost for good. Send it.
const dry = Boolean(req.dry_run) && task !== 'owner_alert';
let shouldSend = !skip && !dry && !emailDown;
const dryNote = !skip && dry ? 'dry_run: would send ' + task + ' to ' + to + (isTest ? ' (test mode; intended ' + oneLine(row.email, 80) + ')' : '') : '';

return [{
  json: {
    ...t,
    email: {
      kind: task, to, subject, body, intended: oneLine(row.email, 120),
      should_send: shouldSend, skip_reason: skip, dry_note: dryNote, simulated_failure: !skip && !dry && emailDown,
    },
  },
}];

