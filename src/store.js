'use strict';
// Local archive layout:
//   <dataDir>/<tax year>/<incoming number>/
//       listing.json      row from the portal listing
//       declaration.html  the declaration exactly as served by the portal
//       declaration.pdf   official PDF
//       result.*          processing result
//       attachments.html  attachment list (when present)
//       parsed.json       parser output (regenerated when the parser changes)
//   <dataDir>/<tax year>/statements/   copies of imported broker statements
//   <dataDir>/drafts/*.json

const fs = require('fs');
const path = require('path');
const { parseDeclaration, PARSER_VERSION } = require('./parser');

const STATEMENTS = 'statements'; // <dataDir>/<year>/statements: copies of imported broker statements

const safeName = (s) => String(s || 'unknown').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'unknown';

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
  }

  dirFor(row) {
    return path.join(this.dataDir, safeName(row.TAXYEAR || 'unknown'), safeName(row.INNO || row.DOCID));
  }

  has(row, name) {
    const f = path.join(this.dirFor(row), name);
    return fs.existsSync(f) && fs.statSync(f).size > 0;
  }

  write(row, name, data) {
    const dir = this.dirFor(row);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), data);
  }

  /** (Re)parse declaration.html in a folder and write parsed.json. */
  parse(dir) {
    const html = path.join(dir, 'declaration.html');
    if (!fs.existsSync(html)) return null;
    const parsed = parseDeclaration(fs.readFileSync(html, 'utf8'));
    fs.writeFileSync(path.join(dir, 'parsed.json'), JSON.stringify(parsed, null, 2));
    return parsed;
  }

  loadParsed(dir) {
    const f = path.join(dir, 'parsed.json');
    try {
      const p = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (p.meta && p.meta.parserVersion === PARSER_VERSION) return p;
    } catch { /* fall through and re-parse */ }
    return this.parse(dir);
  }

  list() {
    const out = [];
    for (const year of fs.readdirSync(this.dataDir, { withFileTypes: true })) {
      if (!year.isDirectory() || year.name === 'drafts') continue;
      const ydir = path.join(this.dataDir, year.name);
      for (const d of fs.readdirSync(ydir, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name === STATEMENTS) continue;
        const dir = path.join(ydir, d.name);
        let listing = {};
        try { listing = JSON.parse(fs.readFileSync(path.join(dir, 'listing.json'), 'utf8')); } catch { /* imported file */ }
        const parsed = this.loadParsed(dir);
        const files = fs.readdirSync(dir);
        out.push({
          id: `${year.name}/${d.name}`,
          dir,
          taxYear: Number(listing.TAXYEAR) || (parsed && parsed.meta.taxYear) || year.name,
          inno: listing.INNO || (parsed && parsed.meta.incomingNumber) || d.name,
          date: listing.INNODATE || (parsed && parsed.meta.incomingDate) || '',
          form: listing.FORMNAME || (parsed && parsed.meta.title) || '',
          status: listing.STATUSTEXT || '',
          statusCode: listing.STATRES,
          signer: listing.SIGNER || '',
          summary: parsed ? parsed.summary : null,
          warnings: parsed ? parsed.warnings : ['Липсва declaration.html'],
          files,
        });
      }
    }
    const ts = (d) => { const m = String(d).match(/(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?/); return m ? `${m[3]}${m[2]}${m[1]}${m[4] || '00'}${m[5] || '00'}` : ''; };
    return out.sort((a, b) => (b.taxYear - a.taxYear) || ts(b.date).localeCompare(ts(a.date)));
  }

  resolve(id) {
    const dir = path.resolve(this.dataDir, id);
    if (!dir.startsWith(path.resolve(this.dataDir) + path.sep)) throw new Error('Невалиден път');
    return dir;
  }

  /** Import a declaration page saved by hand from the browser. */
  importHtml(file) {
    const html = fs.readFileSync(file, 'utf8');
    const p = parseDeclaration(html);
    if (!p.fields.length) throw new Error('Файлът не прилича на декларация от портала на НАП.');
    const row = { TAXYEAR: p.meta.taxYear, INNO: p.meta.incomingNumber || path.basename(file, path.extname(file)) };
    this.write(row, 'declaration.html', html);
    this.parse(this.dirFor(row));
    return `${safeName(row.TAXYEAR)}/${safeName(row.INNO)}`;
  }

  /**
   * Keep a copy of an imported statement next to that year's declarations.
   * Returns the path relative to the data folder.
   */
  saveStatement(file, st) {
    const year = safeName(st.year || 'unknown');
    const dir = path.join(this.dataDir, year, STATEMENTS);
    fs.mkdirSync(dir, { recursive: true });
    const data = fs.readFileSync(file);
    const ext = path.extname(file);
    const base = safeName(`${st.label} - ${path.basename(file, ext)}`);
    let name = base + ext;
    // same name, different content: keep both
    for (let n = 2; fs.existsSync(path.join(dir, name)) && !fs.readFileSync(path.join(dir, name)).equals(data); n++) name = `${base} (${n})${ext}`;
    fs.writeFileSync(path.join(dir, name), data);
    return path.join(year, STATEMENTS, name);
  }

  /** Keep the raw XML of the portal's own draft (always the latest copy) next to that year's declarations. */
  savePortalDraftXml(year, buf) {
    const dir = path.join(this.dataDir, safeName(year || 'unknown'), 'portal-draft');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'draft.xml'), buf);
    return dir;
  }

  /** The portal's form as drawn from its stylesheets: [{ key, title, caption, status, html }], for the "like NAP" view. */
  savePortalForm(year, parts, countries = []) {
    const dir = path.join(this.dataDir, safeName(year || 'unknown'), 'portal-draft');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'form.json'), JSON.stringify({ parts, countries }));
  }

  loadPortalForm(year) {
    try {
      const f = JSON.parse(fs.readFileSync(path.join(this.dataDir, safeName(year), 'portal-draft', 'form.json'), 'utf8'));
      return Array.isArray(f) ? { parts: f, countries: [] } : f; // the first version stored just the parts
    } catch { return null; }
  }

  // ---- drafts -------------------------------------------------------------
  draftsDir() {
    const d = path.join(this.dataDir, 'drafts');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  listDrafts() {
    return fs.readdirSync(this.draftsDir()).filter((f) => f.endsWith('.json')).map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(this.draftsDir(), f), 'utf8')); } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.taxYear - a.taxYear || String(b.updated).localeCompare(String(a.updated)));
  }

  saveDraft(draft) {
    draft.id = safeName(draft.id || `${draft.taxYear}-${Date.now()}`);
    draft.updated = new Date().toISOString();
    draft.status = 'draft'; // drafts are never marked as submitted by this app
    fs.writeFileSync(path.join(this.draftsDir(), draft.id + '.json'), JSON.stringify(draft, null, 2));
    return draft;
  }

  deleteDraft(id) {
    fs.rmSync(path.join(this.draftsDir(), safeName(id) + '.json'), { force: true });
  }

  /** New draft for `taxYear`, pre-filled from a previously filed declaration. */
  draftFrom(id, taxYear) {
    const parsed = this.loadParsed(this.resolve(id));
    if (!parsed) throw new Error('Декларацията не е намерена.');
    // Carry over identity/structure; amounts must be re-entered for the new year.
    const fields = parsed.fields.map((f) => ({
      key: f.key, section: f.section, part: f.part, group: f.group, rowId: f.rowId, rowNo: f.rowNo,
      code: f.code, name: f.name, label: f.label, column: f.column, columnNo: f.columnNo, type: f.type,
      options: f.options, previous: f.raw,
      value: f.type === 'number' ? '' : f.raw,
    }));
    return this.saveDraft({ taxYear, basedOn: id, basedOnSchema: parsed.meta.schema, created: new Date().toISOString(), fields });
  }
}

module.exports = { Store, safeName };
