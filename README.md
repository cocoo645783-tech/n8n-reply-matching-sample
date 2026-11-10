# n8n outbound engine: reply matching (code sample)

Code-node JavaScript from a self-hosted n8n outbound lead engine, plus its unit tests.
The full workflow researches a prospect list, drafts personal first lines, sends only approved emails within a daily cap, detects replies in Gmail, stops follow-ups and alerts the owner.

**Demo (1 min):** https://www.loom.com/share/1d552251df804f9d855d049af2aaf66a

## What this sample shows

The hard part of an outbound engine is deciding *which prospect* an incoming email belongs to.
A first version matched replies by email address, and a live test exposed the bug: when several prospects share an inbox, a reply to one company was later attributed to another on the next scheduled run, and the owner got a false "prospect replied" alert.

The fix in this code:

- **Thread-based matching.** Every email sent to a prospect stores its Gmail `threadId` (first email and follow-up). A reply inside one of our threads can only change that one row, and once that row has replied, the message is ignored instead of sliding onto another row.
- **Deterministic fallback** for fresh (non-thread) emails, used only for rows sent before thread tracking existed.
- **Exactly one owner alert** when a row first turns `replied`; a later "no" upgrades it to `opted_out`.
- **Opt-out detection with word boundaries**, so "Not sure yet" or "November works" are replies, not opt-outs.
- **Follow-ups never go to an address that opted out.**
- **Test-mode safety:** outside live mode, email only reaches the owner's test inbox or an explicit allowlist.

## Files

| File | n8n node | Role |
|---|---|---|
| `code/prepare-run.js` | Prepare Run | Reads the prospect sheet, validates the header, builds the Gmail reply query |
| `code/classify-and-plan.js` | Classify and Plan | Matches replies to rows, classifies them, plans sends and follow-ups |
| `code/worker/compose-email.js` | Compose Email | Decides the recipient (test vs live) and builds the email |
| `code/worker/email-outcome.js` | Email Outcome | Turns the Gmail send result into a row update and stores the thread id |
| `tests/wf02-replies.test.js` | — | 19 unit tests that run the real node code with mocked n8n inputs |

## Run the tests

```bash
node tests/wf02-replies.test.js
```

No dependencies, no network. The harness wraps each Code-node file in `new Function('$', '$input', code)` and feeds it mocked n8n data, including the exact regression found in the live test.

All company names and addresses in the tests are fictional.
