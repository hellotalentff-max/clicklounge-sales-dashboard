/*
 * In-memory mock of the Apps Script services used by the app, for local
 * testing in a browser. NOT deployed to Apps Script.
 *
 * Differences from real Sheets: cells keep the exact values written (date
 * strings stay strings), and number formats are ignored.
 */
(function (g) {
  'use strict';

  const OWNER_EMAIL = 'owner@clicklounge.test';
  const state = { activeEmail: OWNER_EMAIL, props: {}, cache: {}, ss: null, timeZone: 'Asia/Manila' };

  class Range {
    constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
    getValues() {
      const out = [];
      for (let i = 0; i < this.nr; i++) {
        const row = this.sheet.data[this.r - 1 + i] || [];
        const vals = [];
        for (let j = 0; j < this.nc; j++) {
          const v = row[this.c - 1 + j];
          vals.push(v === undefined || v === null ? '' : v);
        }
        out.push(vals);
      }
      return out;
    }
    setValues(values) {
      if (values.length !== this.nr || values.some((r) => r.length !== this.nc)) {
        throw new Error('The number of rows/columns in the data does not match the range.');
      }
      values.forEach((row, i) => {
        const target = this.sheet.data[this.r - 1 + i] = this.sheet.data[this.r - 1 + i] || [];
        row.forEach((v, j) => {
          if (v instanceof Date || (v && typeof v === 'object')) throw new Error('Mock: unexpected object value');
          target[this.c - 1 + j] = v;
        });
      });
      return this;
    }
    setNumberFormat() { return this; }
    setFontWeight() { return this; }
    setBackground() { return this; }
    setFontColor() { return this; }
  }

  class Sheet {
    constructor(name) { this.name = name; this.data = []; this.maxRows = 1000; }
    getName() { return this.name; }
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      if (r < 1 || c < 1) throw new Error('Invalid range');
      if (r + nr - 1 > this.maxRows) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
      return new Range(this, r, c, nr, nc);
    }
    isEmptyRow_(row) { return !row || row.every((v) => v === '' || v === null || v === undefined); }
    getLastRow() {
      for (let i = this.data.length - 1; i >= 0; i--) if (!this.isEmptyRow_(this.data[i])) return i + 1;
      return 0;
    }
    getLastColumn() {
      let max = 0;
      this.data.forEach((row) => {
        for (let j = (row || []).length - 1; j >= 0; j--) {
          if (row[j] !== '' && row[j] !== undefined && row[j] !== null) { max = Math.max(max, j + 1); break; }
        }
      });
      return max;
    }
    getDataRange() { return new Range(this, 1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
    getMaxRows() { return Math.max(this.maxRows, this.data.length); }
    insertRowsAfter(after, n) { this.maxRows += n; }
    deleteRow(r) { this.data.splice(r - 1, 1); }
    setFrozenRows() { return this; }
  }

  class Spreadsheet {
    constructor() { this.sheets = [new Sheet('Sheet1')]; }
    getId() { return 'mock-spreadsheet'; }
    getUrl() { return 'about:blank'; }
    getSheets() { return this.sheets.slice(); }
    getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
    insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
    deleteSheet(s) { this.sheets = this.sheets.filter((x) => x !== s); }
    getSpreadsheetTimeZone() { return state.timeZone; }
    setSpreadsheetTimeZone(tz) { state.timeZone = tz; }
  }

  /* ---- SHA-256 (synchronous, for Utilities.computeDigest) ---- */
  function sha256Bytes(message) {
    const bytes = new TextEncoder().encode(message);
    const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const l = bytes.length;
    const withPad = new Uint8Array(((l + 9 + 63) >> 6) << 6);
    withPad.set(bytes);
    withPad[l] = 0x80;
    const dv = new DataView(withPad.buffer);
    dv.setUint32(withPad.length - 4, l * 8);
    dv.setUint32(withPad.length - 8, Math.floor(l / 0x20000000));
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < withPad.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, gg, h] = H;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & gg);
        const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        h = gg; gg = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + gg) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    const out = [];
    H.forEach((x) => { for (let s = 24; s >= 0; s -= 8) { const b = (x >>> s) & 0xff; out.push(b > 127 ? b - 256 : b); } });
    return out; // signed bytes, like Apps Script
  }

  function formatDate(date, tz, fmt) {
    const parts = {};
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(date).forEach((p) => { parts[p.type] = p.value; });
    return fmt.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
      .replace('HH', parts.hour).replace('mm', parts.minute).replace('ss', parts.second);
  }

  g.SpreadsheetApp = {
    getActiveSpreadsheet: () => state.ss,
    openById: () => state.ss,
    flush: () => {},
    getUi: () => { throw new Error('No UI in mock'); }
  };
  g.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (k in state.props ? state.props[k] : null),
      setProperty: (k, v) => { state.props[k] = String(v); }
    })
  };
  g.CacheService = {
    getScriptCache: () => ({
      get: (k) => { const e = state.cache[k]; return e && e.exp > Date.now() ? e.v : null; },
      put: (k, v, ttl) => { state.cache[k] = { v: String(v), exp: Date.now() + (ttl || 600) * 1000 }; },
      remove: (k) => { delete state.cache[k]; }
    })
  };
  g.LockService = { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) };
  g.Session = {
    getActiveUser: () => ({ getEmail: () => state.activeEmail }),
    getEffectiveUser: () => ({ getEmail: () => OWNER_EMAIL }),
    getScriptTimeZone: () => 'Asia/Manila'
  };
  g.Utilities = {
    formatDate: formatDate,
    getUuid: () => crypto.randomUUID(),
    computeDigest: (alg, text) => sha256Bytes(String(text)),
    base64Decode: (b64) => Array.from(atob(b64), (c) => { const v = c.charCodeAt(0); return v > 127 ? v - 256 : v; }),
    newBlob: (bytes) => ({ getDataAsString: () => new TextDecoder('utf-8').decode(Uint8Array.from(bytes, (b) => (b + 256) % 256)) }),
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    sleep: () => {}
  };
  g.HtmlService = { XFrameOptionsMode: { DEFAULT: 'DEFAULT', ALLOWALL: 'ALLOWALL' } };
  g.ContentService = {
    MimeType: { JAVASCRIPT: 'JAVASCRIPT', JSON: 'JSON', TEXT: 'TEXT' },
    createTextOutput: (text) => {
      const out = { mime: 'TEXT', getContent: () => text, setMimeType: (m) => { out.mime = m; return out; }, getMimeType: () => out.mime };
      return out;
    }
  };
  g.ScriptApp = { getProjectTriggers: () => [], newTrigger: () => { throw new Error('No triggers in mock'); } };

  g.__mock = {
    OWNER_EMAIL: OWNER_EMAIL,
    reset() {
      state.ss = new Spreadsheet();
      state.props = {};
      state.cache = {};
      state.timeZone = 'Asia/Manila';
    },
    setActiveEmail(e) { state.activeEmail = e || ''; },
    get ss() { return state.ss; },
    state: state,
    sha256Hex: (s) => sha256Bytes(s).map((b) => ((b + 256) % 256).toString(16).padStart(2, '0')).join('')
  };
  g.__mock.reset();
})(window);

/** Loads the real Apps Script server files (src/*.gs) into this window. */
window.loadServerFiles = async function (base, extraUrls) {
  const urls = ['Api', 'Utils', 'Database', 'Config', 'Audit', 'Users', 'Commission', 'Schedules',
    'Sales', 'Packages', 'Reports', 'Code', 'Setup', 'Tests'].map((f) => base + f + '.gs').concat(extraUrls || []);
  const sources = await Promise.all(urls.map((u) =>
    fetch(u, { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error('Cannot load ' + u);
      return r.text();
    })));
  const code = sources.map((s, i) => '// ===== ' + urls[i] + ' =====\n' + s).join('\n\n');
  // Indirect eval → functions become globals, like the Apps Script runtime.
  // Top-level const/let stay shared inside this one evaluation (extra test files see them).
  (0, eval)(code);
};
