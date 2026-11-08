"""Build the v9 Apps Script locally from a verified backup. Never stores credentials in Git."""
import re, sys
from pathlib import Path
source = Path(sys.argv[1]).read_text()
overrides = Path('operations/daily-booking.gs').read_text()
# Preserve existing notification code, recipients, script properties and sheet columns.
for name in re.findall(r'^function (\w+)\(', overrides, re.M):
    source = re.sub(r'^function '+re.escape(name)+r'\([^\n]*\)\s*\{.*?^\}', '', source, flags=re.M|re.S)
source = source[source.index('const SHEET_NAME'):]
source = '/* Tokyo Weekday Club v9: single days and weekly bookings; each dated session requires 3 children.\n * Prices: JPY 14,000/day or 48,000/four-day week. No 14-day automatic charge.\n * Existing credentials, organiser destinations and notification triggers preserved. */\n'+source
source = source.replace("function appendBooking_(b) {\n  const sh = sheet_();", "function appendBooking_(b) {\n  const existing = bookingRow_(b.ref);\n  if (existing) return json_({ ok: true, ref: b.ref, row: existing });\n  const sh = sheet_();")
source = source.replace("    const oldNotes = String(sh.getRange(row, COL.notes).getValue() || '');", """    const oldNotes = String(sh.getRange(row, COL.notes).getValue() || '');
    if (!['card saved', 'paid', 'cancelled'].includes(String(b.status))) return json_({ok:false,error:'Invalid status'});
    if (prev === 'cancelled' && b.status !== 'cancelled') return json_({ok:true,ignored:true});
    if (prev === 'paid' && b.status === 'card saved') return json_({ok:true,ignored:true});
    if (b.status === 'card saved' && !['card active','card saved','paid'].includes(prev)) {
      const current = rowData_(sh,row);
      const result = JSON.parse(activateBooking_({ref:b.ref,weekCodes:current.codes,kidsCount:current.kidsCount}).getContent());
      if (!result.activated) return json_({ok:false,error:'Booking needs review'});
    }
    if (b.status === 'cancelled') clearHold_(b.ref);""")
# De-duplicate note tokens; Stripe retries must not duplicate confirmation emails.
source = source.replace("    if (b.note) sh.getRange(row, COL.notes).setValue", "    if (b.note && oldNotes.indexOf(String(b.note)) === -1) sh.getRange(row, COL.notes).setValue")
# Human-facing organiser alerts use the existing destination/template and selected dates.
source = source.replace("['Weeks / sessions', f.weeks]", "['Dates / sessions', f.weeks]")
Path(sys.argv[2]).write_text(source+'\n'+overrides)
