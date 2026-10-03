'use strict';
// Dev smoke test: runs the real app against a throw-away profile, imports the
// synthetic fixture declaration and saves screenshots. Usage:
//   npx electron test/smoke-main.js <scratch dir>
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const scratch = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'nap-smoke'));
const userData = path.join(scratch, 'profile');
const dataDir = path.join(scratch, 'data');
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ dataDir }));
app.setPath('userData', userData);

const { Store } = require('../src/store');
new Store(dataDir).importHtml(path.join(__dirname, 'fixtures', 'declaration.html'));

require('../src/main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on('unhandledRejection', (e) => { console.log('SMOKE FAILED:', e); app.exit(1); });
app.whenReady().then(async () => {
  await sleep(4000);
  const win = BrowserWindow.getAllWindows()[0];
  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) errors.push(e.message); });
  const shot = async (name) => fs.writeFileSync(path.join(scratch, name + '.png'), (await win.webContents.capturePage()).toPNG());
  const js = (code) => win.webContents.executeJavaScript(code, true);
  await shot('1-archive');
  // credentials round trip through DPAPI
  const creds = require('../src/credentials');
  creds.save('0000000000', 'smoke-secret');
  const raw = fs.readFileSync(path.join(userData, 'credentials.bin'));
  console.log('creds roundtrip:', creds.load().password === 'smoke-secret', '| plaintext on disk:', raw.includes('smoke-secret'));
  await js(`document.querySelector('[data-tab=settings]').click()`); await sleep(700); await shot('2-settings');
  creds.clear();
  await js(`document.querySelector('[data-tab=archive]').click(); [...document.querySelectorAll('#detail button')].find(b => b.textContent.startsWith('Нова чернова')).click()`);
  await sleep(1200); await shot('3-draft');
  console.log('draft tables:', JSON.stringify(await js(`(() => { const t = [...document.querySelectorAll('#draft-detail table.records')]; const before = t.map(x => x.tBodies[0].rows.length);
    const box = document.querySelector('#draft-detail'); t[t.length - 1].scrollIntoView(); const y = box.scrollTop;
    t[t.length - 1].parentElement.nextElementSibling.querySelector('button').click();
    const after = [...document.querySelectorAll('#draft-detail table.records')].map(x => x.tBodies[0].rows.length);
    const kept = Math.abs(box.scrollTop - y) < 2 && y > 0; document.querySelector('#draft-detail table.records').scrollIntoView(); return { before, after, scrollKept: kept }; })()`)));
  await sleep(500); await shot('3b-draft-tables');
  // Statement import through the real UI and IPC, with the file dialog stubbed (downloads the ECB rates).
  // The synthetic IBKR fixture is always imported; real statements from samples/ are added when present (local only).
  const { dialog } = require('electron');
  const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (/_files$/.test(e.name) ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)])) : []);
  const real = walk(path.join(__dirname, '..', 'samples')).filter((f) => /\.(csv|pdf)$/i.test(f));
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(__dirname, 'fixtures', 'ibkr.csv'), ...real] });
  await js(`window.confirm = () => true; [...document.querySelectorAll('#draft-detail button')].find(b => b.textContent.startsWith('Добави файлове')).click()`);
  for (let i = 0; i < 60 && !(await js(`!!document.querySelector('#draft-detail table.imports')`)); i++) await sleep(500);
  console.log('import:', JSON.stringify(await js(`({ status: document.querySelector('#status').textContent, banner: (document.querySelector('#banner-import span') || {}).textContent,
    files: [...document.querySelectorAll('#draft-detail table.imports tbody tr')].map(tr => tr.cells[0].textContent + ': ' + tr.cells[3].textContent),
    badges: [...new Set([...document.querySelectorAll('#draft-detail table.records .src')].map(b => b.textContent))],
    help: document.querySelector('#draft-detail .help').hidden })`)));
  await js(`document.querySelector('#draft-detail button.round').click(); document.querySelector('#draft-detail details.panel').scrollIntoView()`); await sleep(400); await shot('3c-import-panel');
  await js(`document.querySelector('#draft-detail details.report').open = false; [...document.querySelectorAll('#draft-detail table.records')].pop().scrollIntoView()`); await sleep(400); await shot('3d-draft-sources');
  // removing a source takes its rows with it
  const before = await js(`document.querySelectorAll('#draft-detail table.imports tbody tr').length`);
  await js(`document.querySelector('#draft-detail table.imports button.danger').click()`); await sleep(2500);
  console.log('remove:', before, '->', await js(`document.querySelectorAll('#draft-detail table.imports tbody tr').length`), 'files;', 'archive:',
    JSON.stringify(fs.readdirSync(dataDir).filter((y) => fs.existsSync(path.join(dataDir, y, 'statements'))).map((y) => `${y}/statements: ${fs.readdirSync(path.join(dataDir, y, 'statements')).length}`)));
  // the "Борси" page: law text, every venue listed, a choice is saved to settings.json
  await js(`document.querySelector('[data-tab=exchanges]').click()`); await sleep(800); await shot('3e-exchanges');
  console.log('exchanges:', JSON.stringify(await js(`({ rows: document.querySelectorAll('#exchanges table.exchanges tbody tr').length, flagged: document.querySelectorAll('#exchanges tr.attention').length,
    law: !!document.querySelector('#exchanges details.law blockquote'), unclear: [...document.querySelectorAll('#exchanges tr.attention td.code')].map(td => td.textContent).join(' ') })`)));
  await js(`(() => { const s = document.querySelector('#exchanges tr.attention select'); s.value = 'exempt'; s.dispatchEvent(new Event('change')); })()`); await sleep(800);
  console.log('saved rule:', JSON.stringify(JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')).exchangeRules));
  await js(`document.querySelector('[data-tab=portal]').click()`); await sleep(5000); await shot('4-portal');
  const view = win.contentView.children[0];
  fs.writeFileSync(path.join(scratch, '5-portal-view.png'), (await view.webContents.capturePage()).toPNG());
  console.log('view bounds:', JSON.stringify(view.getBounds()), 'window:', JSON.stringify(win.getContentBounds()));
  console.log('ui:', JSON.stringify(await js(`({items: document.querySelectorAll('#list .item').length, tiles: document.querySelectorAll('.tile').length, drafts: document.querySelectorAll('#draft-list .item').length, url: document.querySelector('#portal-url').textContent, badge: document.querySelector('#ro-badge').textContent})`)));
  console.log('renderer errors:', JSON.stringify(errors));
  app.exit(0);
});
