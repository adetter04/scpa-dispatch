// Parser tests. Fixtures mirror the real markup captured 2026-11-17 (house numbers altered).
import assert from 'node:assert/strict';
import * as S from '../src/sources.js';

const src = (id) => S.SOURCES.find((s) => s.id === id);
let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('ok  -', name); };

// Lancaster RSS (verbatim structure)
const LCWC = `<rss version="2.0"><channel><title>Lancaster County Live Incidents</title>
<item><title>TRAINING-FIRE</title><link>x</link><description>EARL TOWNSHIP;  GRISTMILL RD &amp; MARTINDALE RD; RESCUE 30; </description><pubDate>Mon, 16 Nov 2026 23:34:42 GMT</pubDate><guid isPermaLink="false">acd9ddb2-5fef-4241-9f8c-9e7647523103</guid></item>
<item><title>MEDICAL EMERGENCY</title><link>x</link><description>EAST COCALICO TOWNSHIP;  GROUSE DR &amp; HERON DR; MEDIC 04-1&lt;br&gt; INT 17-1; </description><pubDate>Tue, 17 Nov 2026 02:03:22 GMT</pubDate><guid isPermaLink="false">6ecf94c2</guid></item>
<item><title>VEHICLE ACCIDENT-NO INJURIES</title><link>x</link><description>MANHEIM TOWNSHIP;  ROYER DR &amp; BROOKSHIRE DR; </description><pubDate>Tue, 17 Nov 2026 02:32:24 GMT</pubDate><guid isPermaLink="false">351b4bf0</guid></item>
</channel></rss>`;
t('Lancaster RSS', () => {
  const r = S.parseLCWC(LCWC, src('lancaster'));
  assert.equal(r.length, 3);
  assert.deepEqual([r[0].municipality, r[0].location, r[0].time], ['Earl Township', 'GRISTMILL RD & MARTINDALE RD', '2026-11-16T23:34:42.000Z']);
  assert.equal(r[0].id, 'lancaster:acd9ddb2-5fef-4241-9f8c-9e7647523103');
  assert.deepEqual(r[1].units, ['MEDIC 04-1', 'INT 17-1']);
  assert.deepEqual(r.map((i) => i.category), ['fire', 'medical', 'traffic']);
  assert.equal(r[0].major, false, 'training is never major');
});

// Chester WebCAD
const CHESCO = `<h4>Incident Status</h4>
<font face="verdana" size="2"><b>Fire Incidents</b><br></font><div><table border='1' class='main'>
<tr><td align='center'><b>Incident No.</b></td><td><b>Incident Type</b></td><td><b>Incident Location</b></td><td><b>Municipality</b></td><td><b>Dispatch Time</b></td><td><b>Station</b></td></tr>
<tr><td width='12%'><a onclick="showPopup(this.href);return(false);" href='livecadcomments-fire.asp?eid=1'>F26063287</a></td>
<td width='15%'>MEDICAL - BLS ALARM</td><td width='43%'>LINCOLN HWY & S THIRD AVE</td><td width='10%' align='center'>Coatesville City</td><td width='15%' align='center'>11-17-2026 00:31:14</td><td width='5%' align='center'>41</td></tr>
</table></div>
<font face="verdana" size="2"><b>EMS Incidents</b><br></font><div><table border='1' class='main'>
<tr><td><b>Incident No.</b></td><td><b>Incident Type</b></td><td><b>Incident Location</b></td><td><b>Municipality</b></td><td><b>Dispatch Time</b></td><td><b>Station</b></td></tr>
<tr><td><a href='x'>F26063290</a></td><td>FALL / LIFT ASSIST </td><td >MALONEY TER & TURNBRIDGE CT</td><td>London Grove Township</td><td>11-17-2026 00:58:44</td><td>22</td></tr>
</table></div>
<font face="verdana" size="2"><b>Traffic Incidents</b><br></font><div><table border='1' class='main'>
<tr><td><b>Incident No.</b></td><td><b>Incident Type</b></td><td><b>Incident Location</b></td><td><b>Municipality</b></td><td><b>Dispatch Time</b></td><td><b>Agency</b></td></tr>
<tr><td><a href='x'>P26433859</a></td><td>BLS ACCIDENT</td><td>LANCASTER AVE & OLD LINCOLN HWY</td><td>East Whiteland Township</td><td>11-17-2026 00:30:30</td><td>42PD</td></tr>
</table></div>`;
t('Chester sections, ids, Eastern time', () => {
  const r = S.parseChesco(CHESCO, src('chester'));
  assert.equal(r.length, 3);
  assert.deepEqual(r.map((i) => i.category), ['fire', 'medical', 'traffic']);
  assert.equal(r[0].id, 'chester:F26063287');
  assert.equal(r[0].time, '2026-11-17T05:31:14.000Z'); // 00:31 EST
  assert.deepEqual(r[1].units, ['STA 22']);
  assert.deepEqual(r[2].units, ['42PD']);
  assert.equal(r[1].type, 'FALL / LIFT ASSIST');
});

// Cumberland ArcGIS
const CUMB = { fields: [], features: [
  { attributes: { CaseNumber: 'E26055801', StationName: 'SHIPPENSBURG EMS', unid: 'A573, MU573', Incident: 'ROUTINE/STAND BY', StreetName: 'E ORANGE ST ', BoxNumber: '4-01:52', Municipality: 'SHIPPENSBURG BORO', CrossStreets: 'CRAIG ST & WALNUT BOTTOM RD', EventType: 'EMS', TextDateTime: '11-16-2026 18:59', EventDateTime: 1794855540000 }, geometry: { x: -77.5052, y: 40.0575 } },
  { attributes: { CaseNumber: 'F26014600', StationName: 'CARLISLE FIRE', unid: 'E201', Incident: 'VEHICLE ACCIDENT W/ENTRAPMENT', StreetName: 'I-81 NB', Municipality: 'MIDDLESEX TWP', CrossStreets: '', EventType: 'Fire', TextDateTime: '11-16-2026 20:05' }, geometry: { x: -77.2, y: 40.2 } },
  { attributes: { CaseNumber: 'F26014600', StationName: 'CARLISLE EMS', unid: 'MU12', Incident: 'VEHICLE ACCIDENT W/ENTRAPMENT', StreetName: 'I-81 NB', Municipality: 'MIDDLESEX TWP', EventType: 'Fire', TextDateTime: '11-16-2026 20:05' }, geometry: { x: -77.2, y: 40.2 } },
] };
t('Cumberland groups unit rows per case; uses text time not fake-UTC epoch', () => {
  const r = S.parseCumberland(JSON.stringify(CUMB), src('cumberland'));
  assert.equal(r.length, 2);
  assert.equal(r[0].time, '2026-11-16T23:59:00.000Z');
  assert.deepEqual(r[0].units, ['A573', 'MU573']);
  assert.equal(r[0].municipality, 'Shippensburg Borough');
  assert.equal(r[0].location, 'E ORANGE ST (CRAIG ST & WALNUT BOTTOM RD)');
  assert.equal(r[0].category, 'medical');
  assert.deepEqual([r[0].lat, r[0].lon], [40.0575, -77.5052]);
  assert.deepEqual(r[1].units, ['E201', 'MU12']);
  assert.equal(r[1].category, 'traffic');
  assert.equal(r[1].major, true);
  assert.throws(() => S.parseCumberland('{"error":{"code":400,"message":"bad"}}', src('cumberland')), /ArcGIS/);
});

// York PDW pager log
const yrow = (time, date, body, agency) => `<TR><TD CLASS="COL1">0890001</TD><TD CLASS="COL2">${time}</TD><TD CLASS="COL3">${date}</TD><TD CLASS="COL7">${body} <SPAN CLASS="C0" ID="F">${agency}</SPAN></TD></TR>\n<TR><TD COLSPAN="4"><HR></TD></TR>`;
const YORK = `<PDW VERSION='v2.16'><TABLE>
${yrow('15:41:47', '11-16-26', 'box: 89-303 FALLS CL 1 , 999 ARTHUR ST, SPRINGETTSBURY TWP, cross streets: N HARRISON ST / EAST ST 72f/aloc units: EMSSTA2-6,INT2-60,MICU97-31 lat/long: 39.9831 / -76.7036 [1524]', 'YAUFR - 3')}
${yrow('15:30:02', '11-16-26', 'box: 89-104 MOTORCYCLE ACCIDENT NORTH 3 FIESTA MEXICO, 9999 E MARKET ST, SPRINGETTSBURY TWP, ita cross streets: HAINES RD / S NORTHERN WAY 65m/consc units: FIRESTA891,E89-1 lat/long: 39.9745 / -76.6778 [1524]', 'YAUFR - 1')}
${yrow('15:27:17', '11-16-26', 'box: 89-104 MOTORCYCLE ACCIDENT NORTH 3 FIESTA MEXICO, 9999 E MARKET ST, SPRINGETTSBURY TWP, ita cross streets: HAINES RD / S NORTHERN WAY units: EMSSTA2-6,MICU2-62 lat/long: 39.9745 / -76.6778 [1524]', 'YAUFR - 1')}
${yrow('15:28:36', '11-16-26', 'box: 13-241 FALLS CL 3 WELLSPAN NEUROSCIENCE CENTER, 999 ST CHARLES WAY, YORK TWP, Suite 300 cross streets: S QUEEN ST / DEW DROP RD units: EMSSTA5-3,INT5-21 lat/long: 39.9301 / -76.6890 [1511]', 'First Capital EMS')}
${yrow('09:00:00', '11-16-26', 'box: 13-215 LIFT ASSIST , 999 WILSON AVE, YORK TWP, units: MICU5-51', 'First Capital EMS')}
</TABLE>`;
t('York pager: fields, place split, alarm level, grouping, window', () => {
  const now = Date.parse('2026-11-16T21:00:00Z'); // 16:00 ET
  const r = S.parseYork(YORK, src('york'), now);
  assert.equal(r.latest, '2026-11-16T20:41:47.000Z');
  assert.equal(r.length, 3, '09:00 page is outside the 2 h window; two moto pages merge');
  const moto = r.find((i) => i.box === '89-104');
  assert.equal(moto.type, 'MOTORCYCLE ACCIDENT (NORTH 3)');
  assert.equal(moto.place, 'FIESTA MEXICO');
  assert.equal(moto.location, '9999 E MARKET ST');
  assert.equal(moto.municipality, 'Springettsbury Township');
  assert.deepEqual(moto.units, ['FIRESTA891', 'E89-1', 'EMSSTA2-6', 'MICU2-62']);
  assert.equal(moto.time, '2026-11-16T20:27:17.000Z');
  assert.equal(moto.lastPaged, '2026-11-16T20:30:02.000Z');
  assert.equal(moto.category, 'traffic');
  const fall = r.find((i) => i.box === '13-241');
  assert.deepEqual([fall.type, fall.place], ['FALLS CL 3', 'WELLSPAN NEUROSCIENCE CENTER']);
  assert.deepEqual([fall.lat, fall.lon], [39.9301, -76.689]);
  const f1 = r.find((i) => i.box === '89-303');
  assert.equal(f1.type, 'FALLS CL 1');
  assert.ok(!JSON.stringify(f1).includes('72f'), 'free-text patient notes are dropped');
});

// Lebanon PDW pager log (no COL1, DD-MM-YY)
const lrow = (time, date, body, agency) => `</TD><TD CLASS="COL2">${time}</TD><TD CLASS="COL3">${date}</TD><TD CLASS="COL4">POCSAG-1</TD><TD CLASS="COL7">${body}  <SPAN CLASS="M">${agency}</SPAN></TD></TR>\n<TR><TD COLSPAN="4"><HR></TD></TR>`;
const LEB = `<PDW VERSION='v2.14'><TABLE>
${lrow('00:52:14', '17-11-26', '999 STRACK DRIVE, North Lebanon Township Med Class3 abdominal pain INT11-43 Fire-Box 28-05 EMS-Box 11-02', 'Amb 11 Myerstown')}
${lrow('00:40:00', '17-11-26', '999 EAST WALNUT STREET, City of Lebanon apt 1 Med Class1 chest pain M12-18,MU12-20,FASP-CITYSTA Fire-Box 15-03 EMS-Box 12-11', 'FASP')}
${lrow('00:39:58', '17-11-26', '999 EAST WALNUT STREET, City of Lebanon apt 1 Med Class1 chest pain INT82-40 Fire-Box 15-03 EMS-Box 12-11', 'Life Lion EMS')}
${lrow('00:30:00', '17-11-26', '999 MAIN ST, North Cornwall Township Celebration Villa of Lebanon AFA-High Risk FG 04 E14,E16,L36,STA14 Fire-Box 36-01 EMS-Box 12-02', 'Station 14')}
${lrow('00:20:00', '17-11-26', 'CYS Non-Emergency CYS On Call Fire-Box EMS-Box', 'Children &amp; Youth')}
${lrow('00:10:00', '17-11-26', 'Tone', 'x')}
</TABLE>`;
t('Lebanon pager: day-first dates, municipality anchor, place/type/unit split', () => {
  const now = Date.parse('2026-11-17T06:00:00Z'); // 01:00 ET
  const r = S.parseLebanon(LEB, src('lebanon'), now);
  assert.equal(r.latest, '2026-11-17T05:52:14.000Z');
  assert.equal(r.length, 3, 'chest pain pages merge; CYS/tone pages are dropped');
  const cp = r.find((i) => i.box === '15-03');
  assert.equal(cp.municipality, 'City of Lebanon');
  assert.equal(cp.place, 'apt 1');
  assert.equal(cp.type, 'MED CLASS1 CHEST PAIN');
  assert.deepEqual(cp.units, ['M12-18', 'MU12-20', 'FASP-CITYSTA', 'INT82-40']);
  assert.equal(cp.category, 'medical');
  const afa = r.find((i) => i.box === '36-01');
  assert.deepEqual([afa.place, afa.type, afa.category, afa.major], ['Celebration Villa of Lebanon', 'AFA-HIGH RISK', 'fire', true]);
  assert.deepEqual(afa.units, ['E14', 'E16', 'L36', 'STA14']);
});

// shared
t('Eastern time incl. DST and day-first', () => {
  assert.equal(S.parseEasternTime('07/04/2026 12:00:00'), '2026-07-04T16:00:00.000Z');
  assert.equal(S.parseEasternTime('01/15/2026 12:00 PM'), '2026-01-15T17:00:00.000Z');
  assert.equal(S.parseEasternTime('03-11-26 12:00:00', 'dmy'), '2026-11-03T17:00:00.000Z');
});
t('Classifier / major flag', () => {
  assert.equal(S.classify('VEHICLE FIRE'), 'fire');
  assert.equal(S.classify('MVA W/ENTRAPMENT'), 'traffic');
  assert.equal(S.classify('ROUTINE TRANSFER-CLASS 3'), 'medical');
  assert.equal(S.classify('WATER RESCUE'), 'rescue');
  assert.equal(S.classify('CARBON MONOXIDE (CO) DETECTOR'), 'fire');
  assert.equal(S.classify('SICK PERSON CL 3'), 'medical');
  assert.equal(S.isMajor('STRUCTURE FIRE HIGH RISK (NORTH 3)'), true);
  assert.equal(S.isMajor('TRAIN DERAILMENT'), true);
  assert.equal(S.isMajor('MEDICAL EMERGENCY'), false);
});

console.log(`\n${pass} passed`);
