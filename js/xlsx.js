// Real Excel workbook (.xlsx) writer — no library, works offline.
// Sheets: "Data" (numeric columns, real date/time, frozen header, filters),
//         "Charts" (PM mass + particle counts vs time, ready to use),
//         "Info" (session details).
// Opens correctly in any Excel language (no comma/semicolon problems).
import { parseCsv } from './parser.js';

const COLS = [
  // [csv column, header, width, kind]
  ['_time', 'Time (local)', 20, 'date'],
  ['_min', 'Elapsed (min)', 12, 'num'],
  ['box', 'Box', 15, 'str'],
  ['pm1_std', 'PM1 (µg/m³)', 11, 'num'], ['pm25_std', 'PM2.5 (µg/m³)', 12, 'num'], ['pm10_std', 'PM10 (µg/m³)', 12, 'num'],
  ['pm1_env', 'PM1 env (µg/m³)', 13, 'num'], ['pm25_env', 'PM2.5 env (µg/m³)', 14, 'num'], ['pm10_env', 'PM10 env (µg/m³)', 14, 'num'],
  ['p03', '>0.3 µm (/0.1 L)', 13, 'num'], ['p05', '>0.5 µm (/0.1 L)', 13, 'num'], ['p10', '>1.0 µm (/0.1 L)', 13, 'num'],
  ['p25', '>2.5 µm (/0.1 L)', 13, 'num'], ['p50', '>5.0 µm (/0.1 L)', 13, 'num'], ['p100', '>10 µm (/0.1 L)', 13, 'num'],
  ['aqi_pm25', 'AQI (PM2.5)', 10, 'num'],
  ['temp_c', 'Temperature (°C)', 13, 'num'], ['rh_pct', 'Humidity (%)', 11, 'num'],
  ['vbat_v', 'Battery (V)', 10, 'num'], ['rssi_dbm', 'Bluetooth (dBm)', 13, 'num'],
  ['lat', 'Latitude', 11, 'num'], ['lon', 'Longitude', 11, 'num'], ['gps_acc_m', 'GPS accuracy (m)', 13, 'num'],
  ['marker', 'Marker / event', 24, 'str'],
];

const xmlEsc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const colName = i => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = (i - m - 1) / 26; } return s; };
const excelTime = t => (t - new Date(t).getTimezoneOffset() * 60000) / 86400000 + 25569;   // local time serial

function sheetData(rows) {
  const out = [];
  out.push('<row r="1">' + COLS.map(c => `<c t="inlineStr" s="1"><is><t>${xmlEsc(c[1])}</t></is></c>`).join('') + '</row>');
  const t0 = rows.length ? rows[0].t : 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], cells = [];
    for (const [key, , , kind] of COLS) {
      if (kind === 'date') { cells.push(`<c s="2"><v>${excelTime(r.t)}</v></c>`); continue; }
      if (kind === 'num') {
        const v = key === '_min' ? (r.t - t0) / 60000 : r[key];
        cells.push(v == null || !Number.isFinite(v) ? '<c/>' : `<c${key === '_min' ? ' s="3"' : ''}><v>${+(+v).toFixed(6)}</v></c>`);
        continue;
      }
      const s = r[key];
      cells.push(s ? `<c t="inlineStr"><is><t>${xmlEsc(s)}</t></is></c>` : '<c/>');
    }
    out.push(`<row r="${i + 2}">${cells.join('')}</row>`);
  }
  const last = colName(COLS.length - 1);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0" tabSelected="1"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${COLS.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c[2]}" customWidth="1"/>`).join('')}</cols>
<sheetData>${out.join('')}</sheetData>
<autoFilter ref="A1:${last}${Math.max(rows.length + 1, 2)}"/>
</worksheet>`;
}

function sheetInfo(info) {
  const rows = info.map(([k, v], i) => `<row r="${i + 1}"><c t="inlineStr" s="1"><is><t>${xmlEsc(k)}</t></is></c>` +
    (typeof v === 'number' && Number.isFinite(v) ? `<c><v>${v}</v></c>` : `<c t="inlineStr"><is><t>${xmlEsc(v ?? '')}</t></is></c>`) + '</row>');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="26" customWidth="1"/><col min="2" max="2" width="48" customWidth="1"/></cols>
<sheetData>${rows.join('')}</sheetData></worksheet>`;
}

const sheetCharts = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetData/><drawing r:id="rId1"/></worksheet>`;

const COLORS = ['4C9DFF', 'F2B33D', 'FF6178', '36D28A', 'A76BFF', '8E9AB6'];
function chartXml(title, yTitle, series, n) {
  const last = n + 1;
  const ser = series.map(([colIdx, name], k) => {
    const c = colName(colIdx);
    return `<c:ser><c:idx val="${k}"/><c:order val="${k}"/><c:tx><c:v>${xmlEsc(name)}</c:v></c:tx>
<c:spPr><a:ln w="19050"><a:solidFill><a:srgbClr val="${COLORS[k % COLORS.length]}"/></a:solidFill></a:ln></c:spPr><c:marker><c:symbol val="none"/></c:marker>
<c:xVal><c:numRef><c:f>Data!$A$2:$A$${last}</c:f></c:numRef></c:xVal>
<c:yVal><c:numRef><c:f>Data!$${c}$2:$${c}$${last}</c:f></c:numRef></c:yVal><c:smooth val="0"/></c:ser>`;
  }).join('');
  const axTitle = t => `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${xmlEsc(t)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${xmlEsc(title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>
<c:plotArea><c:layout/><c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${ser}
<c:axId val="1001"/><c:axId val="1002"/></c:scatterChart>
<c:valAx><c:axId val="1001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>${axTitle('Time')}
<c:numFmt formatCode="hh:mm" sourceLinked="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="low"/><c:crossAx val="1002"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/></c:valAx>
<c:valAx><c:axId val="1002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/>${axTitle(yTitle)}
<c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="1001"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/></c:valAx>
</c:plotArea><c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}

const anchor = (id, r0, r1) => `<xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${r0}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
<xdr:to><xdr:col>14</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${r1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${id + 1}" name="Chart ${id}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>
<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId${id}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;

const FILES_STATIC = {
  '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>
<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>
<Override PartName="/xl/charts/chart2.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>
</Types>`,
  '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView/></bookViews><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Charts" sheetId="2" r:id="rId2"/><sheet name="Info" sheetId="3" r:id="rId3"/></sheets>
<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Data!$A$1:$X$1</definedName></definedNames></workbook>`,
  'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/><numFmt numFmtId="165" formatCode="0.00"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDCE6F2"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  'xl/worksheets/_rels/sheet2.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
  'xl/drawings/_rels/drawing1.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart2.xml"/></Relationships>`,
  'xl/drawings/drawing1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${anchor(1, 0, 22)}${anchor(2, 23, 45)}</xdr:wsDr>`,
};

// ---------- tiny ZIP (stored, no compression) ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nb = enc.encode(name), data = enc.encode(text), crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nb.length, true);
    parts.push(h, nb, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nb.length, true);
    c.setUint32(42, offset, true);
    central.push(c, nb);
    offset += 30 + nb.length + data.length;
  }
  const size = central.reduce((s, p) => s + p.byteLength, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, size, true); e.setUint32(16, offset, true);
  return [...parts, ...central, e];
}

// csvText: our own CSV (header + rows). meta: optional session details.
export function csvToXlsx(csvText, meta = {}) {
  const rows = parseCsv(csvText);
  const n = rows.length;
  const idx = k => COLS.findIndex(c => c[0] === k);
  const info = [
    ['Exported', new Date().toLocaleString()],
    ['Box', meta.deviceName || (rows[0] && rows[0].box) || ''],
    ['Worker / ID', meta.worker || ''], ['Task / activity', meta.task || ''], ['Site / location', meta.site || ''],
    ['Notes', meta.notes || ''], ['Firmware', meta.fw || ''],
    ['Start', n ? new Date(rows[0].t).toLocaleString() : ''], ['End', n ? new Date(rows[n - 1].t).toLocaleString() : ''],
    ['Readings', n],
    ['PM2.5 limit used (µg/m³)', meta.limits?.pm25 ?? ''], ['PM10 limit used (µg/m³)', meta.limits?.pm10 ?? ''],
    ['PM columns', 'PM1/PM2.5/PM10 = standard (CF=1); "env" = atmospheric environment values of the PMS5003'],
    ['Particle counts', 'number of particles larger than the size, per 0.1 L of air'],
  ];
  const files = Object.entries(FILES_STATIC);
  files.push(['xl/worksheets/sheet1.xml', sheetData(rows)]);
  files.push(['xl/worksheets/sheet2.xml', sheetCharts]);
  files.push(['xl/worksheets/sheet3.xml', sheetInfo(info)]);
  files.push(['xl/charts/chart1.xml', chartXml('PM mass concentration', 'µg/m³',
    [[idx('pm1_std'), 'PM1'], [idx('pm25_std'), 'PM2.5'], [idx('pm10_std'), 'PM10']], n)]);
  files.push(['xl/charts/chart2.xml', chartXml('Particle counts', 'particles / 0.1 L',
    [[idx('p03'), '>0.3 µm'], [idx('p05'), '>0.5 µm'], [idx('p10'), '>1.0 µm'], [idx('p25'), '>2.5 µm'], [idx('p50'), '>5.0 µm'], [idx('p100'), '>10 µm']], n)]);
  return new Blob(zip(files), { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
