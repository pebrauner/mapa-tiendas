/* js/io.js — MT.io: files in and out.
 *
 *  - CSV (RFC 4180, UTF-8 with BOM; reader auto-detects ',' ';' or tab — Excel in Spanish
 *    locales often writes ';').
 *  - stores ⇄ rows in the SPEC §3.1 column order, with tolerant header matching for imports
 *    (Spanish/English aliases, accents/case ignored) and decimal-comma coordinates.
 *  - XLSX read/write through SheetJS (lazy-loaded from vendor/xlsx).
 *  - Serializers for data/stores.js, data/chains.js, logos/logos.js in the same format the data
 *    build scripts produce, so "Guardar en carpeta" writes drop-in replacements.
 *  - download(), file readers, project-file naming.
 */
(function () {
  'use strict';
  var MT = window.MT, U = MT.util;
  var BOM = String.fromCharCode(0xFEFF); // byte-order mark

  var io = (MT.io = {});

  /* ---- CSV ------------------------------------------------------------------------------- */
  /**
   * Detect the delimiter from the first lines (outside quotes, up to 12 non-empty lines). The
   * winner is the candidate that splits the most lines into the same number of fields, so a
   * title row above a ';' header ("Tiendas Lima, octubre") does not fool it.
   */
  io.detectDelimiter = function (text) {
    var CANDS = [',', ';', '\t'];
    var lines = [], counts = null, inQ = false;
    var newLine = function () { return { ',': 0, ';': 0, '\t': 0, chars: 0 }; };
    counts = newLine();
    for (var i = 0; i < text.length && i < 60000 && lines.length < 12; i++) {
      var ch = text[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (inQ) continue;
      if (ch === '\n' || ch === '\r') {
        if (counts.chars) lines.push(counts);
        counts = newLine();
        continue;
      }
      counts.chars++;
      if (counts[ch] !== undefined) counts[ch]++;
    }
    if (counts.chars && lines.length < 12) lines.push(counts);
    var best = ',', bestScore = -1;
    CANDS.forEach(function (d) {
      // Most frequent non-zero field count for this delimiter, and how many lines share it.
      var freq = {};
      lines.forEach(function (l) { if (l[d]) freq[l[d]] = (freq[l[d]] || 0) + 1; });
      var mode = 0, agree = 0;
      Object.keys(freq).forEach(function (k) { if (freq[k] > agree || (freq[k] === agree && +k > mode)) { agree = freq[k]; mode = +k; } });
      var score = agree * 1000 + mode;
      if (score > bestScore) { bestScore = score; best = d; }
    });
    return bestScore > 0 ? best : ',';
  };

  /** Parse CSV text into an array of rows (arrays of strings). Handles BOM, quotes, CRLF, newlines in quotes. */
  io.parseCSV = function (text, opts) {
    text = String(text || '');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    var d = (opts && opts.delimiter) || io.detectDelimiter(text);
    var rows = [], row = [], field = '', i = 0, inQ = false, n = text.length;
    while (i < n) {
      var ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === '"' && field === '') { inQ = true; i++; continue; }
      if (ch === d) { row.push(field); field = ''; i++; continue; }
      if (ch === '\r' || ch === '\n') {
        row.push(field); rows.push(row); row = []; field = '';
        if (ch === '\r' && text[i + 1] === '\n') i++;
        i++; continue;
      }
      field += ch; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    // Drop fully empty trailing lines.
    while (rows.length && rows[rows.length - 1].every(function (c) { return c === ''; })) rows.pop();
    return rows;
  };

  function csvField(v, d) {
    var s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n;\t]/.test(s) || s.indexOf(d) >= 0 || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  /** Rows → CSV text (CRLF line endings). opts: {bom=true, delimiter=','}. */
  io.stringifyCSV = function (rows, opts) {
    opts = opts || {};
    var d = opts.delimiter || ',';
    var body = rows.map(function (r) { return r.map(function (v) { return csvField(v, d); }).join(d); }).join('\r\n') + '\r\n';
    return (opts.bom === false ? '' : BOM) + body;
  };

  /* ---- Stores ⇄ rows ----------------------------------------------------------------------- */
  // Header aliases (normalized with U.normalize) → canonical column. A generic "Código"/"code"
  // column is NOT an alias of `id`: client lists use their own store codes, and treating them as
  // app ids would make two unrelated lists overwrite each other's stores in merge mode.
  var ALIASES = {
    id: ['id', 'store id', 'id tienda', 'id mapa de tiendas'],
    chain: ['chain', 'cadena', 'marca', 'brand', 'chain id'],
    name: ['name', 'nombre', 'tienda', 'store', 'nombre tienda', 'nombre de la tienda', 'nombre del local', 'local'],
    address: ['address', 'direccion', 'dir', 'domicilio'],
    district: ['district', 'distrito'],
    province: ['province', 'provincia'],
    department: ['department', 'departamento', 'region', 'dpto'],
    ubigeo: ['ubigeo', 'cod ubigeo', 'codigo ubigeo'],
    lat: ['lat', 'latitude', 'latitud', 'y'],
    lng: ['lng', 'lon', 'long', 'longitude', 'longitud', 'x'],
    precision: ['precision', 'precisión'],
    source: ['source', 'fuente', 'origen'],
    source_ref: ['source ref', 'source_ref', 'referencia', 'ref', 'url'],
    status: ['status', 'estado'],
    notes: ['notes', 'notas', 'observaciones', 'comentarios'],
    updated: ['updated', 'actualizado', 'fecha', 'last updated', 'modificado', 'fecha de actualizacion', 'ultima actualizacion'],
  };
  var aliasIndex = {};
  Object.keys(ALIASES).forEach(function (col) { ALIASES[col].forEach(function (a) { aliasIndex[U.normalize(a)] = col; }); });
  var STATUS_ALIASES = { verified: 'verified', verificada: 'verified', verificado: 'verified', ok: 'verified',
    activa: 'verified', activo: 'verified', abierta: 'verified', abierto: 'verified', operativa: 'verified', operativo: 'verified',
    vigente: 'verified', open: 'verified', active: 'verified',
    'to verify': 'to_verify', to_verify: 'to_verify', 'por verificar': 'to_verify', pendiente: 'to_verify',
    'por confirmar': 'to_verify', 'sin verificar': 'to_verify', 'no verificada': 'to_verify', 'no verificado': 'to_verify',
    revisar: 'to_verify', 'por revisar': 'to_verify',
    closed: 'closed', cerrada: 'closed', cerrado: 'closed' };
  /**
   * Status words → enum. Anything that says closed/inactive ("Cerrado permanentemente", "Cerrada
   * temporalmente", "Inactivo", "Clausurado") is closed — closed stores are never drawn. Unknown
   * words become 'to_verify' rather than 'verified', so a doubtful store is flagged, not trusted.
   */
  io.parseStatus = function (v) {
    var n = U.normalize(v);
    if (!n) return '';
    if (STATUS_ALIASES[n] || STATUS_ALIASES[String(v).trim()]) return STATUS_ALIASES[n] || STATUS_ALIASES[String(v).trim()];
    if (/^(cerrad|clausur|inactiv|closed|permanently closed|temporarily closed|baja|dado de baja)/.test(n)) return 'closed';
    if (/^(verificad|activ|abiert|operativ)/.test(n)) return 'verified';
    return 'to_verify';
  };

  /**
   * Dates as typed by people or re-saved by Excel → ISO 'YYYY-MM-DD' (SPEC §3.1), or '' when the
   * value cannot be read (the caller then stamps today). Accepts ISO dates/datetimes, YYYY/MM/DD,
   * D/M/YYYY and D-M-YY (day first, as Excel writes them in Peru; month first only when the day
   * part cannot be a month), Excel serial numbers and Date objects.
   */
  io.parseDate = function (v) {
    if (v === null || v === undefined || v === '') return '';
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var iso = function (y, m, d) {
      if (y < 100) y += 2000;
      var dt = new Date(Date.UTC(y, m - 1, d));
      if (y < 1990 || y > 2100 || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return '';
      return y + '-' + pad(m) + '-' + pad(d);
    };
    if (v instanceof Date) return isNaN(v) ? '' : iso(v.getFullYear(), v.getMonth() + 1, v.getDate());
    var s = String(v).trim(), m;
    if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(s))) return iso(+m[1], +m[2], +m[3]);
    if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:\s.*)?$/.exec(s))) {
      var a = +m[1], b = +m[2];
      return a > 12 || b <= 12 ? iso(+m[3], b, a) : iso(+m[3], a, b);
    }
    // Excel serial day number (1900 date system): 25569 = 1970-01-01.
    if (/^\d{5}(\.\d+)?$/.test(s)) {
      var d = new Date(Math.round((+s - 25569) * 86400000));
      return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    return '';
  };

  /** Map a header row to canonical columns: [{index, column|null, header}]. */
  io.mapHeaders = function (header) {
    return header.map(function (h, i) { return { index: i, header: h, column: aliasIndex[U.normalize(h)] || null }; });
  };

  /** Stores → rows (header first) in SPEC column order. */
  io.storesToRows = function (stores) {
    var cols = MT.data.COLUMNS;
    return [cols.slice()].concat(stores.map(function (s) {
      return cols.map(function (c) {
        if (c === 'lat' || c === 'lng') return isFinite(s[c]) ? (+s[c]).toFixed(6) : '';
        return s[c] === undefined || s[c] === null ? '' : s[c];
      });
    }));
  };

  /**
   * Rows (header first) → {stores, errors:[{row, message}], unknownColumns:[], missingColumns:[]}.
   * Chains may be given as id, name or legend name. Coordinates accept decimal commas and
   * hemisphere letters ("12.08 S"); a Peru point typed as "lng, lat" is swapped back. Rows
   * without coordinates are kept (lat/lng NaN) so the caller can geocode them.
   * Each store carries a non-enumerable `_flags` {swapped, outside} (outside = has coordinates,
   * but not in Peru even after the swap) — copies made with Object.assign drop it.
   */
  io.rowsToStores = function (rows) {
    if (!rows || !rows.length) return { stores: [], errors: [], unknownColumns: [], missingColumns: MT.data.COLUMNS.slice() };
    var map = io.mapHeaders(rows[0]);
    var have = {};
    map.forEach(function (m) { if (m.column) have[m.column] = m.index; });
    var chainLookup = {};
    MT.data.chains().forEach(function (c) {
      [c.id, c.name, c.legendName].forEach(function (k) { if (k) chainLookup[U.normalize(k)] = c.id; });
    });
    var out = [], errors = [];
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r];
      if (!row || row.every(function (c) { return String(c || '').trim() === ''; })) continue;
      var s = {};
      Object.keys(have).forEach(function (col) { s[col] = row[have[col]] === undefined ? '' : String(row[have[col]]).trim(); });
      var chainKey = U.normalize(s.chain);
      s.chain = chainLookup[chainKey] || chainLookup[chainKey.replace(/ /g, '')] || U.slug(s.chain).replace(/-/g, '');
      s.lat = parseCoord(s.lat); s.lng = parseCoord(s.lng);
      var flags = { swapped: false, outside: false };
      if (isFinite(s.lat) && isFinite(s.lng) && !MT.geo.inPeru(s.lat, s.lng)) {
        if (MT.geo.inPeru(s.lng, s.lat)) { var tmp = s.lat; s.lat = s.lng; s.lng = tmp; flags.swapped = true; }
        else flags.outside = true;
      }
      Object.defineProperty(s, '_flags', { value: flags, enumerable: false });
      if (s.status) s.status = io.parseStatus(s.status);
      if ('updated' in s) s.updated = io.parseDate(s.updated);
      if (s.ubigeo) s.ubigeo = String(s.ubigeo).replace(/\D/g, '').padStart(6, '0');
      if (!s.chain) errors.push({ row: r + 1, message: 'chain-missing' });
      if (!s.name && !s.address && !isFinite(s.lat)) { errors.push({ row: r + 1, message: 'row-empty' }); continue; }
      out.push(s);
    }
    return {
      stores: out, errors: errors,
      unknownColumns: map.filter(function (m) { return !m.column && String(m.header || '').trim(); }).map(function (m) { return m.header; }),
      missingColumns: MT.data.COLUMNS.filter(function (c) { return !(c in have); }),
    };
  };
  /**
   * One coordinate cell → number (NaN when unreadable). Accepts "-12.0912", "-12,0912",
   * "12.08 S", "S 12.08", "77.05 O/W", "12°04'48\" S" (degrees-minutes-seconds). S/W/O make the
   * value negative; N/E positive. Anything else that is not a clean number is rejected rather
   * than half-read (parseFloat("12.08 S") used to give +12.08).
   */
  function parseCoord(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    var s = String(v === undefined || v === null ? '' : v).trim().toUpperCase().replace(/\s+/g, '').replace(/−/g, '-');
    if (!s) return NaN;
    var sign = 0, m;
    if ((m = /^([NSEWO])(.+)$/.exec(s))) { sign = /[SWO]/.test(m[1]) ? -1 : 1; s = m[2]; }
    else if ((m = /^(.+?)([NSEWO])$/.exec(s))) { sign = /[SWO]/.test(m[2]) ? -1 : 1; s = m[1]; }
    var n;
    if ((m = /^(-?\d{1,3})°(?:(\d{1,2}(?:[.,]\d+)?)['′])?(?:(\d{1,2}(?:[.,]\d+)?)(?:"|″|''))?$/.exec(s))) {
      var deg = Math.abs(+m[1]), min = m[2] ? +m[2].replace(',', '.') : 0, sec = m[3] ? +m[3].replace(',', '.') : 0;
      n = (deg + min / 60 + sec / 3600) * (m[1].charAt(0) === '-' ? -1 : 1);
    } else {
      s = s.replace(/°$/, '');
      if (/^[-+]?\d+,\d+$/.test(s)) s = s.replace(',', '.');
      if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
      n = +s;
    }
    if (!isFinite(n)) return NaN;
    return sign ? sign * Math.abs(n) : n;
  }
  io.parseCoord = parseCoord;

  io.storesToCSV = function (stores) { return io.stringifyCSV(io.storesToRows(stores)); };
  io.storesFromCSV = function (text) { return io.rowsToStores(io.parseCSV(text)); };

  /* ---- XLSX (SheetJS, lazy) ---------------------------------------------------------------- */
  /**
   * Read the first sheet (or opts.sheet) of an .xlsx/.xls ArrayBuffer → Promise<rows of strings>.
   * Cells are read as their stored VALUES, not as displayed: a coordinate in a "Número, 2
   * decimales" column must not come back rounded to 0.01° (≈ 1 km). Dates become YYYY-MM-DD.
   */
  io.readXLSX = function (buffer, opts) {
    return MT.vendor.xlsx().then(function (XLSX) {
      var wb = XLSX.read(buffer, { type: 'array', cellDates: true });
      var name = (opts && opts.sheet) || wb.SheetNames[0];
      var rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '', blankrows: false });
      return rows.map(function (r) {
        return r.map(function (v) {
          if (v === null || v === undefined) return '';
          if (v instanceof Date) return io.parseDate(v);
          if (typeof v === 'number') return isFinite(v) ? String(Number(v.toPrecision(15))) : '';
          return String(v);
        });
      });
    });
  };
  /**
   * Build an .xlsx Blob. sheets: [{name, rows, colWidths?: number[] (chars), numberColumns?: number[]}].
   * Numeric strings in numberColumns are written as numbers (lat/lng stay sortable in Excel).
   */
  io.writeXLSX = function (sheets) {
    return MT.vendor.xlsx().then(function (XLSX) {
      var wb = XLSX.utils.book_new();
      sheets.forEach(function (sh) {
        var rows = sh.rows.map(function (r, i) {
          if (!i || !sh.numberColumns) return r;
          return r.map(function (v, c) { return sh.numberColumns.indexOf(c) >= 0 && v !== '' && isFinite(+v) ? +v : v; });
        });
        var ws = XLSX.utils.aoa_to_sheet(rows);
        if (sh.colWidths) ws['!cols'] = sh.colWidths.map(function (w) { return { wch: w }; });
        if (rows.length > 1) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: rows[0].length - 1 } }) };
        XLSX.utils.book_append_sheet(wb, ws, String(sh.name || 'Hoja1').slice(0, 31));
      });
      var out = XLSX.write(wb, { bookType: 'xlsx', type: 'array', compression: true });
      out = io.polishXLSX(XLSX, out, sheets.map(function (sh) { return { heads: [0], freeze: sh.rows.length > 1 }; }));
      return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    });
  };

  /**
   * What SheetJS Community Edition does not write (it has no cell styles): header rows in bold on a
   * light grey fill and, on data tables, the header row frozen (it stays in view while scrolling).
   * Edits the package's XML in place through SheetJS' own zip reader/writer (XLSX.CFB): styles.xml
   * gets one font, one fill and one cell format; each sheet's header cells get that format, its
   * <sheetView> a frozen pane. data = XLSX.write(…, {type:'array'}); sheets[i] = {heads: [row
   * indexes, 0-based], freeze: bool} for the i-th sheet. Returns the new bytes, or the given ones
   * when anything looks unexpected (a plain, valid workbook beats a broken one).
   */
  io.polishXLSX = function (XLSX, data, sheets) {
    try {
      var CFB = XLSX.CFB;
      if (!CFB || !sheets || !sheets.length) return data;
      var zip = CFB.read(data instanceof Uint8Array ? data : new Uint8Array(data), { type: 'array' });
      var utf8 = function (e) { return new TextDecoder('utf-8').decode(e.content instanceof Uint8Array ? e.content : new Uint8Array(e.content)); };
      var put = function (e, text) { e.content = new TextEncoder().encode(text); e.size = e.content.length; };
      var styles = CFB.find(zip, '/xl/styles.xml');
      if (!styles) return data;
      var sx = utf8(styles);
      var count = function (tag) { var m = new RegExp('<' + tag + ' count="(\\d+)"').exec(sx); return m ? +m[1] : -1; };
      var fonts = count('fonts'), fills = count('fills'), xfs = count('cellXfs');
      if (fonts < 1 || fills < 1 || xfs < 1 || !/<\/fonts>/.test(sx) || !/<\/fills>/.test(sx) || !/<\/cellXfs>/.test(sx)) return data;
      sx = sx.replace(/<fonts count="\d+"/, '<fonts count="' + (fonts + 1) + '"')
        .replace('</fonts>', '<font><b/><sz val="12"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts>')
        .replace(/<fills count="\d+"/, '<fills count="' + (fills + 1) + '"')
        .replace('</fills>', '<fill><patternFill patternType="solid"><fgColor rgb="FFF3F4F6"/><bgColor indexed="64"/></patternFill></fill></fills>')
        .replace(/<cellXfs count="\d+"/, '<cellXfs count="' + (xfs + 1) + '"')
        .replace('</cellXfs>', '<xf numFmtId="0" fontId="' + fonts + '" fillId="' + fills + '" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>');
      var head = xfs;                                  // index of the new cell format
      var edits = [];
      for (var i = 0; i < sheets.length; i++) {
        var e = CFB.find(zip, '/xl/worksheets/sheet' + (i + 1) + '.xml');
        if (!e) return data;
        var x = utf8(e), o = sheets[i] || {};
        (o.heads || []).forEach(function (r) {
          x = x.replace(new RegExp('(<row r="' + (r + 1) + '"[^>]*>)([\\s\\S]*?)(</row>)'), function (m, a, cells, z) {
            return a + cells.replace(/<c r="([A-Z]+\d+)"(?![^>]*\ss=)/g, '<c r="$1" s="' + head + '"') + z;
          });
        });
        if (o.freeze) {
          var pane = '<sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/></sheetView>';
          if (x.indexOf('<sheetView workbookViewId="0"/>') < 0) return data;
          x = x.replace('<sheetView workbookViewId="0"/>', pane);
        }
        edits.push([e, x]);
      }
      put(styles, sx);
      edits.forEach(function (ed) { put(ed[0], ed[1]); });
      return CFB.write(zip, { type: 'array', fileType: 'zip', compression: true });
    } catch (err) {
      console.warn('[io] xlsx styling skipped', err);
      return data;
    }
  };
  io.storesToXLSX = function (stores, sheetName) {
    var cols = MT.data.COLUMNS;
    var widths = { id: 22, chain: 12, name: 32, address: 34, district: 18, province: 14, department: 14, ubigeo: 8, lat: 11, lng: 11, precision: 9, source: 8, source_ref: 24, status: 10, notes: 30, updated: 11 };
    return io.writeXLSX([{
      name: sheetName || MT.t('io.sheetStores'), rows: io.storesToRows(stores),
      colWidths: cols.map(function (c) { return widths[c] || 12; }),
      numberColumns: [cols.indexOf('lat'), cols.indexOf('lng')],
    }]);
  };

  /** Read a user file (.csv/.txt/.xlsx/.xls) → Promise<rows>. */
  io.readTable = function (file) {
    var name = (file.name || '').toLowerCase();
    if (/\.(xlsx|xlsm|xls|ods)$/.test(name)) return io.readAsArrayBuffer(file).then(io.readXLSX);
    return io.readAsArrayBuffer(file).then(function (buf) { return io.parseCSV(io.decodeText(buf)); });
  };

  /**
   * Bytes of a text file → string, whatever Excel saved. UTF-8 (with or without BOM) and UTF-16
   * ("Texto Unicode") are recognised; anything that is not valid UTF-8 is Windows-1252, which is
   * what Excel's "CSV (delimitado por comas)" writes on Spanish Windows — decoding it as UTF-8
   * would turn every á/é/ñ into "�" and then into the database.
   */
  io.decodeText = function (buf) {
    var b = new Uint8Array(buf);
    if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b);
    if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(b);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (e) { /* not UTF-8 */ }
    return new TextDecoder('windows-1252').decode(b);
  };

  /* ---- Serializers for the repository data files ------------------------------------------ */
  function jsonLines(arr) {
    return '[\n' + arr.map(function (o) { return '  ' + JSON.stringify(o); }).join(',\n') + '\n]';
  }

  /*
   * Canonical row order of data/stores.csv and data/stores.js — EXACTLY the order of
   * tools/build-data.mjs (and tools/merge.mjs): chain in data/chains.js order (unknown chain ids
   * after every known one, by id), then department, province, district, name, compared
   * accent- and case-insensitively by UTF-16 code units (NOT locale collation: "Ñ" folds to "n",
   * spaces and punctuation sort by code point), and finally the id. Saving the shipped data from the
   * app without edits therefore gives byte-identical files, and a folder save never reshuffles
   * the diff. Keep this in sync with build-data.mjs (tools/test/data-roundtrip.test.mjs checks it).
   */
  var MARKS = (function () { try { return new RegExp('\\p{M}', 'gu'); } catch (e) { return new RegExp('[\\u0300-\\u036f]', 'g'); } })();
  function fold(s) { return String(s === null || s === undefined ? '' : s).normalize('NFD').replace(MARKS, '').toLowerCase(); }
  function cmpCode(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  /** The chain ids data/chains.js lists, in its order (what MT.io.chainsJs writes). */
  function chainOrder() {
    return (MT.data && MT.data.chains ? MT.data.chains() : []).filter(function (c) { return !c.unknown; }).map(function (c) { return c.id; });
  }
  /**
   * Stores sorted like tools/build-data.mjs (new array). opts.chainOrder: chain ids in data/chains.js
   * order (default: the chains MT.io.chainsJs would write).
   */
  io.sortStores = function (stores, opts) {
    var order = (opts && opts.chainOrder) || chainOrder();
    var rank = Object.create(null);
    order.forEach(function (id, i) { if (!(id in rank)) rank[id] = i; });
    var unknown = order.length;
    var rows = stores.map(function (s) {
      return { s: s, r: s.chain in rank ? rank[s.chain] : unknown, chain: String(s.chain || ''), id: String(s.id || ''),
        k: [fold(s.department), fold(s.province), fold(s.district), fold(s.name)] };
    });
    rows.sort(function (a, b) {
      return a.r - b.r || cmpCode(a.chain, b.chain) || cmpCode(a.k[0], b.k[0]) || cmpCode(a.k[1], b.k[1]) ||
        cmpCode(a.k[2], b.k[2]) || cmpCode(a.k[3], b.k[3]) || cmpCode(a.id, b.id);
    });
    return rows.map(function (x) { return x.s; });
  };

  /**
   * data/stores.js content (window.MT_SEED) — byte for byte what `node tools/build-data.mjs`
   * generates from the data/stores.csv written next to it (same header comment, rows sorted with
   * io.sortStores, lat/lng rounded to 6 decimals, `generated` = the latest `updated` date), so
   * running build-data after a folder save changes nothing. opts: {generated?, chainOrder?}.
   */
  io.storesJs = function (stores, opts) {
    opts = opts || {};
    var cols = MT.data.COLUMNS;
    var list = io.sortStores(stores, opts).map(function (s) {
      var o = {};
      cols.forEach(function (c) { o[c] = c === 'lat' || c === 'lng' ? Math.round(+s[c] * 1e6) / 1e6 : (s[c] === undefined || s[c] === null ? '' : String(s[c])); });
      return o;
    });
    var generated = opts.generated || list.reduce(function (m, s) { return /^\d{4}-\d{2}-\d{2}$/.test(s.updated) && s.updated > m ? s.updated : m; }, '') || U.todayISO();
    return '/* mapa-tiendas — store database. Generated by tools/build-data.mjs from data/stores.csv on ' + generated + '.\n' +
      ' * Canonical source: data/stores.csv. Store data derived from OpenStreetMap is © OpenStreetMap contributors (ODbL). */\n' +
      'window.MT_SEED = {"generated":' + JSON.stringify(generated) + ',"count":' + list.length + ',"columns":' + JSON.stringify(cols) +
      ',"stores":' + jsonLines(list) + '};\n';
  };
  /** data/stores.csv content: header + rows in the canonical order (io.sortStores), UTF-8 BOM, CRLF. */
  io.storesCsvFile = function (stores, opts) { return io.storesToCSV(io.sortStores(stores, opts)); };
  /**
   * data/chains.js content: window.MT_CHAINS + window.MT_OSM_RULES, in exactly the format of
   * tools/merge.mjs (same header, key order, one chain per line, one rules key per line), so saving
   * unedited data writes the shipped file byte for byte (tools/test/data-roundtrip.test.mjs). The
   * header names tools/merge.mjs even when the app writes it — the only way to get identical bytes.
   * chains: MT.data.chains() (unknown/synthesized chains are skipped); osmRules: the cross-chain
   * rules (default MT.data.osmRules(); null = an old file without the block → none written).
   */
  io.chainsJs = function (chains, osmRules) {
    var list = chains.filter(function (c) { return !c.unknown; }).map(function (c) {
      var o = { id: c.id, name: c.name, legendName: c.legendName, group: c.group, color: c.color,
        ringColor: U.isHexColor(c.ringColor) ? c.ringColor : c.color };
      if (isFinite(+c.badgeZoom) && +c.badgeZoom > 0 && Math.abs(+c.badgeZoom - 1) > 1e-6) o.badgeZoom = +c.badgeZoom;
      var r = MT.data.normalizeOsm(c.osm, c.name), osm = {};
      MT.data.OSM_KEYS.forEach(function (k) { osm[k] = r[k]; });   // merge's key order
      return Object.assign(o, { owner: c.owner || '',
        defaultOn: c.defaultOn !== false, website: c.website || '', storeLocator: c.storeLocator || '',
        osm: osm, logo: c.logo === undefined ? c.id : c.logo });
    });
    var rules = osmRules === undefined ? (MT.data.osmRules ? MT.data.osmRules() : null) : osmRules;
    var out = '/* mapa-tiendas — tracked chains (SPEC §3.2). Generated by tools/merge.mjs from tools/seed/chains/*.json and tools/seed/osm-rules.json.\n' +
      ' * ringColor = badge ring colour (js/markers.js); osm = per-chain OpenStreetMap rules; MT_OSM_RULES = cross-chain OSM rules.\n' +
      ' * The seed merge (tools/merge.mjs) and the in-app OSM scan classify with these same rules: schema in tools/seed/OSM-RULES.md. */\n' +
      'window.MT_CHAINS = ' + jsonLines(list) + ';\n';
    if (rules && typeof rules === 'object') {
      out += 'window.MT_OSM_RULES = {\n' + Object.keys(rules).map(function (k) { return '  ' + JSON.stringify(k) + ':' + JSON.stringify(rules[k]); }).join(',\n') + '\n};\n';
    }
    return out;
  };
  /** logos/logos.js content (window.MT_LOGOS). logos: {chainId: {badge, wide?}}. */
  io.logosJs = function (logos) {
    var ids = Object.keys(logos).sort();
    var body = ids.map(function (id) {
      var l = logos[id], parts = [];
      if (l.badge) parts.push('"badge":' + JSON.stringify(l.badge));
      if (l.wide) parts.push('"wide":' + JSON.stringify(l.wide));
      return '  ' + JSON.stringify(id) + ':{' + parts.join(',') + '}';
    }).join(',\n');
    return '/* mapa-tiendas — chain logos as data URIs (SPEC §3.3). Generated by Mapa de Tiendas on ' + U.todayISO() + '. */\n' +
      'window.MT_LOGOS = {\n' + body + '\n};\n';
  };

  /**
   * Everything "Guardar en carpeta" writes: [{path, data}] for data/stores.csv, data/stores.js,
   * data/chains.js, logos/logos.js and logos/<id>.png for uploaded badges.
   */
  io.repoFiles = function () {
    var stores = MT.data.stores({ includeClosed: true });
    var logos = {};
    // A missing or half-written logos.js must not break the folder save (MT.data.missing.logos).
    var seed = window.MT_LOGOS && typeof window.MT_LOGOS === 'object' && !Array.isArray(window.MT_LOGOS) ? window.MT_LOGOS : {};
    Object.keys(seed).forEach(function (k) { if (seed[k] && seed[k].badge) logos[k] = { badge: seed[k].badge, wide: seed[k].wide }; });
    var ov = MT.logos.overlay();
    var files = [];
    Object.keys(ov).forEach(function (id) {
      var chain = MT.data.chain(id), key = chain.logo || id;
      logos[key] = { badge: ov[id].badge || (logos[key] && logos[key].badge), wide: ov[id].wide || (logos[key] && logos[key].wide) };
      if (ov[id].badge) files.push({ path: 'logos/' + key + '.png', data: io.dataUrlToBlob(ov[id].badge) });
      if (ov[id].wide) files.push({ path: 'logos/' + key + '-wide.png', data: io.dataUrlToBlob(ov[id].wide) });
    });
    // Never write a data file whose shipped version did not load (missing or half-written while the
    // data workflow regenerates it): the result would hold only the local changes and silently
    // replace the real database. Those paths are listed in `skipped` so the UI can say so.
    var miss = MT.data.missing || {};
    var out = [], skipped = [];
    var add = function (path, isMissing, make) { if (isMissing) skipped.push(path); else out.push({ path: path, data: make() }); };
    // Both store files in the canonical order of tools/build-data.mjs (see io.sortStores).
    add('data/stores.csv', miss.stores, function () { return io.storesCsvFile(stores); });
    add('data/stores.js', miss.stores, function () { return io.storesJs(stores); });
    add('data/chains.js', miss.chains, function () { return io.chainsJs(MT.data.chains()); });
    add('logos/logos.js', miss.logos, function () { return io.logosJs(logos); });
    out = out.concat(files);
    out.skipped = skipped;
    return out;
  };

  /* ---- Files, blobs, downloads ------------------------------------------------------------- */
  /** Trigger a browser download. data: Blob | string; mime defaults by extension. */
  io.download = function (data, filename, mime) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: mime || mimeFor(filename) });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener'; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 4000);
    return filename;
  };
  function mimeFor(name) {
    var ext = String(name || '').split('.').pop().toLowerCase();
    return ({ csv: 'text/csv;charset=utf-8', js: 'text/javascript;charset=utf-8', json: 'application/json',
      html: 'text/html;charset=utf-8', png: 'image/png', txt: 'text/plain;charset=utf-8' })[ext] || 'application/octet-stream';
  }
  io.readAsText = function (file) { return readWith(file, 'readAsText'); };
  io.readAsDataURL = function (file) { return readWith(file, 'readAsDataURL'); };
  io.readAsArrayBuffer = function (file) { return readWith(file, 'readAsArrayBuffer'); };
  function readWith(file, method) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error || new Error('file-read-failed')); };
      r[method](file);
    });
  }
  io.dataUrlToBlob = function (url) {
    var parts = String(url).split(','), meta = parts[0], b64 = /;base64/.test(meta);
    var mime = (meta.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
    var raw = b64 ? atob(parts[1]) : decodeURIComponent(parts[1]);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  };
  io.blobToDataURL = function (blob) { return io.readAsDataURL(blob); };
  io.canvasToBlob = function (canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) { if (b) resolve(b); else reject(new Error('canvas-export-failed')); }, type || 'image/png', quality);
    });
  };

  /** Safe file name: "Lima Sur: Q3/2026" → "Lima Sur - Q3-2026". */
  io.safeFilename = function (name, fallback) {
    var s = String(name || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').replace(/^[\s.-]+|[\s.-]+$/g, '');
    return s.slice(0, 120) || fallback || 'mapa';
  };
  /** "Mapa de Tiendas - 2026-10-01.xlsx" style names. */
  io.datedName = function (base, ext) { return io.safeFilename(base) + ' - ' + U.todayISO() + '.' + ext; };
})();
