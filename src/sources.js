// Shared fetch + parse layer. Runs unchanged on Cloudflare Workers and Node 18+.
// Every source returns { id, county, status, fetchedAt, latest, incidents[], error? }.
//
// Two kinds of feed:
//   cad   – the county publishes its list of currently-active incidents (Lancaster, Chester, Cumberland)
//   pager – the page is a log of dispatch pages decoded off the air (York, Lebanon). There is no
//           "cleared" signal, so pages are grouped into incidents and shown while the last page
//           is younger than PAGER_WINDOW_MIN.

export const PAGER_WINDOW_MIN = 120;

export const SOURCES = [
  {
    id: 'lancaster', county: 'Lancaster', agency: 'LCWC', kind: 'lcwc-rss', feed: 'cad',
    url: 'https://webcad.lcwc911.us/Pages/Public/LiveIncidentsFeed.aspx',
    web: 'https://webcad.lcwc911.us/Pages/Public/LiveIncidents.aspx',
  },
  {
    id: 'york', county: 'York', agency: 'York Fire Page', kind: 'pdw-york', feed: 'pager',
    url: 'http://www.yorkfirepage.org/filter.html',
    web: 'http://www.yorkfirepage.org/filter.html',
  },
  {
    id: 'chester', county: 'Chester', agency: 'ChesCo DES', kind: 'chesco', feed: 'cad',
    url: 'https://webcad.chesco.org/WebCad/webcad.asp',
    web: 'https://webcad.chesco.org/WebCad/webcad.asp',
  },
  {
    id: 'lebanon', county: 'Lebanon', agency: 'Lebanon DES', kind: 'pdw-lebanon', feed: 'pager',
    url: 'https://www.lcdes.org/monitor.html',
    web: 'https://www.lcdes.org/monitor.html',
  },
  {
    id: 'cumberland', county: 'Cumberland', agency: 'Cumberland DPS', kind: 'arcgis-cumberland', feed: 'cad',
    url: 'https://services1.arcgis.com/1Cfo0re3un0w6a30/arcgis/rest/services/Active_Incidents_Public/FeatureServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=json',
    web: 'https://gis.ccpa.net/incidents/',
  },
];

const UA = 'SouthCentralPA-CAD-Monitor/2.0 (personal dashboard; polls <=1/min)';
const MAX_AGE_MS = 48 * 3600 * 1000;
const FETCH_TIMEOUT_MS = 12000;

// text helpers
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decode(s = '') {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}
const stripTags = (s) => s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' ');
const clean = (s) => decode(stripTags(s)).replace(/[ \t\r\f\v ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
const squash = (s = '') => s.replace(/\s+/g, ' ').trim();
const titleCase = (s) => s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\bTwp\b/g, 'Township').replace(/\bBoro\b/g, 'Borough').replace(/\b(Of|And|The)\b/g, (w) => w.toLowerCase());

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

// time: county pages print Eastern wall-clock time
function easternOffsetMinutes(utcMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const g = (t) => +parts.find((p) => p.type === t).value;
  return (Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - utcMs) / 60000;
}
export function easternToISO(y, mo, d, h = 0, mi = 0, s = 0) {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  let ms = naive - easternOffsetMinutes(naive) * 60000;
  ms = naive - easternOffsetMinutes(ms) * 60000; // second pass settles DST edges
  return new Date(ms).toISOString();
}
// order: 'mdy' (US, default) or 'dmy' (Lebanon's pager log)
export function parseEasternTime(text, order = 'mdy') {
  if (!text) return null;
  const t = text.trim();
  let m = t.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (m) {
    let [, a, b, y, h, mi, s, ap] = m;
    const [mo, d] = order === 'dmy' ? [b, a] : [a, b];
    y = +y < 100 ? 2000 + +y : +y; h = +h;
    if (ap) { ap = ap.toUpperCase(); if (ap === 'PM' && h < 12) h += 12; if (ap === 'AM' && h === 12) h = 0; }
    return easternToISO(y, +mo, +d, h, +mi, +(s || 0));
  }
  const p = Date.parse(t);
  return Number.isFinite(p) ? new Date(p).toISOString() : null;
}

// classification
const RULES = [
  ['traffic', /\bMVA\b|\bMVC\b|ACCIDENT|CRASH|TRAFFIC|ROAD ?CLOS|DISABLED VEH|PEDESTRIAN/],
  ['fire', /\bFIRE\b|SMOKE|ALARM|\bAFA\b|\bGAS\b|\bCO\b|CARBON MONOXIDE|HAZ ?MAT|\bBRUSH\b|STRUCTURE|\bSF-|WIRES|ELECTRICAL|ODOR|EXPLOSION|FUEL SPILL|BURN|TRANSFORMER/],
  ['rescue', /RESCUE|WATER|ELEVATOR|SEARCH|COLLAPSE|TECHNICAL|ENTRAP/],
  ['medical', /MEDICAL|\bMED\b|\bEMS\b|TRANSFER|CARDIAC|ARREST|FALL|BREATH|UNCONSC|OVERDOSE|SICK|STROKE|CVA|SEIZURE|DIABETIC|HEMORR|CHEST PAIN|TRAUMA|INJUR|\bALS\b|\bBLS\b|AMBULANCE|PSYCH|LIFT ASSIST|\bCL ?\d|CLASS ?\d|ALOC|SYNCOPE|FAINT|STEMI|PAIN|MATERNITY|ALLERG|HEART/],
  ['police', /POLICE|THEFT|BURGLAR|ASSAULT|SHOTS|DOMESTIC|SUSPIC|DISTURB|TRESPASS|WARRANT|WELL-?BEING|WELFARE/],
];
export function classify(type = '') {
  const t = type.toUpperCase();
  // a crash with entrapment is still a traffic call; a vehicle fire is a fire
  if (/VEHICLE FIRE|VEH FIRE|CAR FIRE/.test(t)) return 'fire';
  for (const [cat, re] of RULES) if (re.test(t)) return cat;
  return 'other';
}
const MAJOR = /WORKING|STRUCTURE FIRE|\bSF-|DWELLING|BUILDING FIRE|COMMERCIAL FIRE|HIGH RISK|CARDIAC ARREST|MASS CASUALTY|\bMCI\b|ENTRAP|PINNED|HAZ ?MAT|EXPLOSION|COLLAPSE|WATER RESCUE|SPECIAL RESCUE|AIRCRAFT|PLANE CRASH|\bTRAIN\b|DERAIL|HELICOPTER|LANDING ZONE|\bLZ\b|SHOOTING|STABBING|PEDESTRIAN|2ND ALARM|3RD ALARM|ALARM-2|ALARM-3|FATAL|ROLLOVER|STEMI|\*\*48|RIT\b/;
export const isMajor = (type = '') => !/TRAINING|DRILL|TEST/.test(type.toUpperCase()) && MAJOR.test(type.toUpperCase());

function finalize(src, raw) {
  const type = squash(raw.type).toUpperCase();
  const municipality = raw.municipality ? titleCase(squash(raw.municipality)) : '';
  const location = squash(raw.location).toUpperCase();
  const id = raw.id ? `${src.id}:${raw.id}` : `${src.id}:${hash([type, raw.time || '', location, municipality].join('|'))}`;
  const lat = Number.isFinite(raw.lat) && raw.lat !== 0 ? +raw.lat.toFixed(6) : null;
  const lon = Number.isFinite(raw.lon) && raw.lon !== 0 ? +raw.lon.toFixed(6) : null;
  return {
    id, source: src.id, county: src.county, feed: src.feed,
    number: raw.number || null,
    type, category: raw.category || classify(type), major: isMajor(type),
    location, place: raw.place ? squash(raw.place) : '', municipality,
    box: raw.box || null,
    units: [...new Set((raw.units || []).map((u) => squash(u)).filter(Boolean))],
    agencies: [...new Set((raw.agencies || []).filter(Boolean))],
    time: raw.time || null,
    lastPaged: raw.lastPaged || null,
    lat, lon,
  };
}

// Lancaster: LCWC RSS
export function parseLCWC(xml, src) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const tag = (n) => { const r = block.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)<\\/${n}>`)); return r ? r[1].replace(/^<!\[CDATA\[|\]\]>$/g, '') : ''; };
    const parts = decode(tag('description')).split(';').map((p) => p.trim());
    const pub = tag('pubDate');
    out.push(finalize(src, {
      id: tag('guid').trim() || null,
      type: decode(tag('title')),
      municipality: parts[0] || '',
      location: parts[1] || '',
      units: parts.slice(2).join('\n').split(/<br\s*\/?>|\n/i).map((u) => u.trim()).filter(Boolean),
      time: pub && Number.isFinite(Date.parse(pub)) ? new Date(pub).toISOString() : null,
    }));
  }
  return out;
}

// Chester: WebCAD, one table per section (Fire / EMS / Traffic)
export function parseChesco(html, src) {
  const out = [];
  const sectionCat = { fire: 'fire', ems: 'medical', traffic: 'traffic' };
  const re = /<b>\s*(Fire|EMS|Traffic)\s+Incidents\s*<\/b>[\s\S]*?<table[^>]*>([\s\S]*?)<\/table>/gi;
  for (const sec of html.matchAll(re)) {
    const secCat = sectionCat[sec[1].toLowerCase()];
    for (const r of sec[2].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => clean(c[1]));
      if (cells.length < 6 || /^incident no/i.test(cells[0])) continue;
      const [number, type, location, municipality, time, station] = cells;
      if (!type) continue;
      // let the classifier override the section only when it's clearly different (e.g. an EMS-section crash)
      const cat = classify(type);
      out.push(finalize(src, {
        id: number, number, type, location, municipality,
        time: parseEasternTime(time),
        category: secCat === 'medical' && cat !== 'medical' && cat !== 'other' ? cat : secCat,
        units: station ? [secCat === 'traffic' ? station : `STA ${station}`] : [],
      }));
    }
  }
  return out;
}

// Cumberland: ArcGIS FeatureServer, one row per unit
export function parseCumberland(json, src) {
  const d = typeof json === 'string' ? JSON.parse(json) : json;
  if (d.error) throw new Error(`ArcGIS: ${d.error.message || d.error.code}`);
  const byCase = new Map();
  for (const f of d.features || []) {
    const a = f.attributes || {};
    const key = a.CaseNumber || `${a.Incident}|${a.StreetName}|${a.TextDateTime}`;
    const inc = byCase.get(key) || {
      id: a.CaseNumber || null, number: a.CaseNumber || null,
      type: a.Incident || '',
      location: [squash(a.StreetName || ''), a.CrossStreets ? `(${squash(a.CrossStreets)})` : ''].filter(Boolean).join(' '),
      municipality: a.Municipality || '',
      box: a.BoxNumber || null,
      // EventDateTime is local time stored as if UTC; the text field is unambiguous
      time: parseEasternTime(a.TextDateTime || ''),
      lat: f.geometry?.y ?? a.latitude, lon: f.geometry?.x ?? a.longitude,
      units: [], agencies: [],
      category: /^ems$/i.test(a.EventType || '') && classify(a.Incident || '') !== 'traffic' ? 'medical' : undefined,
    };
    String(a.unid || '').split(',').forEach((u) => inc.units.push(u.trim()));
    if (a.StationName) inc.agencies.push(titleCase(a.StationName));
    byCase.set(key, inc);
  }
  return [...byCase.values()].map((i) => finalize(src, i));
}

// PDW pager logs (York, Lebanon)
function pdwRows(html) {
  // Lebanon's log drops the opening <TR><TD COL1>, so key on COL2/COL3/COL7 only
  return [...html.matchAll(/CLASS="COL2">([^<]*)<\/TD>\s*<TD CLASS="COL3">([^<]*)<\/TD>(?:\s*<TD CLASS="COL4">[^<]*<\/TD>)?\s*<TD CLASS="COL7">([\s\S]*?)<\/TD>\s*<\/TR>/gi)]
    .map((m) => {
      const agencyM = m[3].match(/<SPAN[^>]*ID="F"[^>]*>([\s\S]*?)<\/SPAN>|<SPAN CLASS="[MF]"[^>]*>([\s\S]*?)<\/SPAN>\s*$/i);
      const agency = agencyM ? clean(agencyM[1] || agencyM[2] || '') : '';
      const body = clean(m[3].replace(/<SPAN[^>]*>[\s\S]*?<\/SPAN>\s*$/i, ''));
      return { clock: m[1].trim(), date: m[2].trim(), body, agency };
    });
}

// group pages that belong to one call; keep calls whose last page is inside the window
function groupPages(pages, src, now = Date.now()) {
  const groups = new Map();
  for (const p of pages) {
    if (!p.time) continue;
    const t = Date.parse(p.time);
    if (now - t > PAGER_WINDOW_MIN * 60000 || t - now > 10 * 60000) continue;
    const key = `${p.box || ''}|${p.location}|${p.municipality}`.toUpperCase();
    const g = groups.get(key);
    if (!g) { groups.set(key, { ...p, first: t, last: t, units: [...p.units], agencies: [p.agency] }); continue; }
    g.units.push(...p.units); g.agencies.push(p.agency);
    if (t < g.first) g.first = t;
    if (t > g.last) { g.last = t; if (p.type) g.type = p.type; } // later pages carry upgrades ("…SOUTH 4")
    if (!g.lat && p.lat) { g.lat = p.lat; g.lon = p.lon; }
  }
  return [...groups.values()].map((g) => finalize(src, {
    ...g,
    id: hash(`${g.box}|${g.location}|${g.municipality}|${new Date(g.first).toISOString().slice(0, 13)}`),
    time: new Date(g.first).toISOString(),
    lastPaged: new Date(g.last).toISOString(),
  }));
}

// York: "box: 89-104 MVA W/INJURIES CL 1 SOUTH 4 PLACE NAME, 2500 E MARKET ST, SPRINGETTSBURY TWP, … units: A,B lat/long: 39.9 / -76.7 [1524]"
const YORK_ALARM = /\s+((?:NORTH|SOUTH|EAST|WEST)\s+\d)\b/;
const YORK_CLASS = /^(.*?\bCL\s*\d(?:-[A-Z]+)?)\b\s*(.*)$/;
export function parseYorkLine(body) {
  const m = body.match(/^box:\s*(\S+)\s+([^,]+),\s*([^,]+),\s*([^,]+?)(?:,|\s+cross streets:|\s+units:|\s+lat\/long:|$)/i);
  if (!m) return null;
  let [, box, head, location, municipality] = m;
  let type = head.trim(), place = '', alarm = '';
  const a = type.match(YORK_ALARM);
  if (a) { place = type.slice(a.index + a[0].length).trim(); alarm = a[1]; type = type.slice(0, a.index).trim(); }
  else { const c = type.match(YORK_CLASS); if (c) { type = c[1]; place = c[2]; } }
  if (alarm) type = `${type} (${alarm})`;
  const units = (body.match(/units:\s*([^\s]+(?:,\s*[^\s,]+)*)/i)?.[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ll = body.match(/lat\/long:\s*(-?\d+\.\d+)\s*\/\s*(-?\d+\.\d+)/i);
  return { box, type, place, location, municipality, units, lat: ll ? +ll[1] : null, lon: ll ? +ll[2] : null };
}
export function parseYork(html, src, now) {
  const pages = [];
  let latest = null;
  for (const r of pdwRows(html)) {
    const p = parseYorkLine(r.body);
    const time = parseEasternTime(`${r.date} ${r.clock}`, 'mdy');
    if (time && (!latest || time > latest)) latest = time;
    if (!p || !p.type || /\d{3}-?\d{3}|TEST PAGE/i.test(p.type)) continue;
    pages.push({ ...p, time, agency: r.agency });
  }
  const incidents = groupPages(pages, src, now);
  incidents.latest = latest;
  return incidents;
}

// Lebanon: "211 EAST WALNUT STREET, City of Lebanon apt 1 Med Class1 chest pain M12-18,MU12-20 Fire-Box 15-03 EMS-Box 12-11"
const LEB_MUNIS = ['City of Lebanon', 'Cleona Borough', 'Cornwall Borough', 'Jonestown Borough', 'Mount Gretna Borough', 'Myerstown Borough', 'Palmyra Borough', 'Richland Borough',
  'Annville Township', 'Bethel Township', 'East Hanover Township', 'Heidelberg Township', 'Jackson Township', 'Millcreek Township', 'North Annville Township', 'North Cornwall Township',
  'North Lebanon Township', 'North Londonderry Township', 'South Annville Township', 'South Lebanon Township', 'South Londonderry Township', 'Swatara Township', 'Union Township',
  'West Cornwall Township', 'West Lebanon Township', 'Cold Spring Township'];
const LEB_MUNI_RE = new RegExp(`^(${LEB_MUNIS.map((m) => m.replace(/ /g, '\\s+')).join('|')})\\b\\s*(.*)$`, 'i');
const LEB_TYPE_START = /\b(Med(?:ical)?\s+Class\s*\d|Medical Assist|MVA|AFA|SF-|Structure|[A-Z][\w-]*\s+Fire\b|Fire\b|Brush|Vehicle|Traffic Control|Public Service|Well-?Being|Land Search|Water|Gas\b|CO\s|Carbon|Odor|Wires|Haz|Lift|Rescue|Search|Investigation|Tree|Elevator|Electrical|Hydrant|Lockout|Transfer|Standby|Assist|Alarm|Smoke|Explosion|Aircraft|Landing Zone|LZ\b)/i;
export function parseLebanonLine(body) {
  const fb = body.search(/\bFire-Box\b/);
  if (fb < 0) return null;
  const box = body.match(/Fire-Box\s+(\S+)/)?.[1] || null;
  const head = body.slice(0, fb).trim();
  const comma = head.indexOf(',');
  if (comma < 0) return null;
  const location = head.slice(0, comma).trim();
  const mm = head.slice(comma + 1).trim().match(LEB_MUNI_RE);
  if (!mm) return null;
  let rest = mm[2].trim();
  // trailing unit list: a token of unit codes (has a digit or STA, comma-joined)
  let units = [];
  const um = rest.match(/\s((?:[A-Za-z]*\d[\w-]*|[A-Z]+-?[A-Z]*STA\w*)(?:,[\w-]+)*)$/);
  if (um && /\d|STA/.test(um[1])) { units = um[1].split(','); rest = rest.slice(0, um.index).trim(); }
  rest = rest.replace(/\s+FG\s+\d+\s*$/i, '').trim();
  const ts = rest.search(LEB_TYPE_START);
  const place = ts > 0 ? rest.slice(0, ts).trim() : '';
  const type = (ts >= 0 ? rest.slice(ts) : rest).replace(/\*\*/g, '').trim();
  return { box, type, place, location, municipality: mm[1], units };
}
export function parseLebanon(html, src, now) {
  const pages = [];
  let latest = null;
  for (const r of pdwRows(html)) {
    const time = parseEasternTime(`${r.date} ${r.clock}`, 'dmy');
    if (time && (!latest || time > latest)) latest = time;
    const p = parseLebanonLine(r.body);
    if (!p || !p.type) continue;
    pages.push({ ...p, time, agency: r.agency });
  }
  const incidents = groupPages(pages, src, now);
  incidents.latest = latest;
  return incidents;
}

// fetch orchestration
async function fetchText(url, attempt = 1) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/json,application/xml;q=0.9,*/*;q=0.8' }, signal: ctrl.signal, redirect: 'follow' });
    if (r.status >= 500 && attempt === 1) { // these county boxes hiccup; one polite retry
      clearTimeout(timer);
      await new Promise((res) => setTimeout(res, 1500));
      return fetchText(url, 2);
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } catch (e) {
    const cause = e.cause?.code || e.cause?.message;
    throw new Error(cause === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
      ? 'TLS: server omits its intermediate certificate (start with npm start, which loads certs/)'
      : (e.name === 'AbortError' ? 'timed out' : (cause ? `${e.message} (${cause})` : e.message)));
  } finally { clearTimeout(timer); }
}

const PARSERS = {
  'lcwc-rss': parseLCWC, chesco: parseChesco, 'arcgis-cumberland': parseCumberland,
  'pdw-york': parseYork, 'pdw-lebanon': parseLebanon,
};

export async function fetchSource(src) {
  const base = { id: src.id, county: src.county, agency: src.agency, feed: src.feed, web: src.web, fetchedAt: new Date().toISOString() };
  try {
    const body = await fetchText(src.url);
    let incidents = PARSERS[src.kind](body, src);
    let latest = incidents.latest || incidents.reduce((m, i) => (i.time && (!m || i.time > m) ? i.time : m), null);
    const now = Date.now();
    incidents = incidents.filter((i) => !i.time || now - Date.parse(i.time) < MAX_AGE_MS);
    let status = 'ok';
    if (src.feed === 'pager' && !latest) status = 'unparsed';
    else if (src.feed === 'cad' && src.kind === 'chesco' && !/Incident Status/i.test(body)) status = 'unparsed';
    return { ...base, ok: status === 'ok', status, latest, incidents };
  } catch (e) {
    return { ...base, ok: false, status: 'error', error: String(e.message || e), latest: null, incidents: [] };
  }
}

export async function fetchAll() {
  const results = await Promise.all(SOURCES.map(fetchSource));
  const incidents = results.flatMap((r) => r.incidents)
    .sort((a, b) => (Date.parse(b.time || 0) || 0) - (Date.parse(a.time || 0) || 0));
  return {
    generatedAt: new Date().toISOString(),
    pagerWindowMin: PAGER_WINDOW_MIN,
    sources: results.map(({ incidents: list, ...r }) => ({ ...r, count: list.length })),
    incidents,
  };
}
