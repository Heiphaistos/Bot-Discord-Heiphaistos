/** Générateur iCalendar (RFC 5545). */

export function icsEscape(text) {
  return String(text ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Fold lines longer than 75 octets (UTF-8 safe). */
export function foldLine(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out = [];
  let current = ''; let size = 0; let limit = 75;
  for (const ch of line) {
    const len = Buffer.byteLength(ch, 'utf8');
    if (size + len > limit) { out.push(current); current = ''; size = 0; limit = 74; }
    current += ch; size += len;
  }
  if (current) out.push(current);
  return out.join('\r\n ');
}

export function icsDate(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * @param {Array<{uid:string,start:number,end?:number,summary:string,description?:string,location?:string,url?:string,status?:string,created?:number}>} events
 * @param {{ name?: string, prodId?: string }} opts
 */
export function buildIcs(events, { name = 'Évènements', prodId = '-//HeiphaisBot//Events//FR' } = {}) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${prodId}`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsEscape(name)}`];
  const stamp = icsDate(Date.now());
  for (const ev of events) {
    const end = ev.end && ev.end > ev.start ? ev.end : ev.start + 3600000;
    lines.push('BEGIN:VEVENT', `UID:${ev.uid}`, `DTSTAMP:${stamp}`, `DTSTART:${icsDate(ev.start)}`, `DTEND:${icsDate(end)}`, `SUMMARY:${icsEscape(ev.summary)}`);
    if (ev.description) lines.push(`DESCRIPTION:${icsEscape(ev.description)}`);
    if (ev.location) lines.push(`LOCATION:${icsEscape(ev.location)}`);
    if (ev.url) lines.push(`URL:${ev.url}`);
    if (ev.created) lines.push(`CREATED:${icsDate(ev.created)}`);
    lines.push(`STATUS:${ev.status || 'CONFIRMED'}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
