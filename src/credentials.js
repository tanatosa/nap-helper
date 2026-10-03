'use strict';
// Portal login storage. The secret is encrypted with Electron safeStorage,
// which on Windows is DPAPI bound to the current Windows user account: the
// file is useless on another machine or under another user.

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const file = () => path.join(app.getPath('userData'), 'credentials.bin');

function available() {
  return safeStorage.isEncryptionAvailable();
}

function load() {
  try {
    if (!available() || !fs.existsSync(file())) return null;
    const c = JSON.parse(safeStorage.decryptString(fs.readFileSync(file())));
    return c && c.username && c.password ? c : null;
  } catch {
    return null;
  }
}

function save(username, password, pinType) {
  if (!available()) throw new Error('Системното криптиране (DPAPI) не е достъпно – данните за вход не са записани.');
  if (!username || !password) throw new Error('Липсва потребител или парола.');
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), safeStorage.encryptString(JSON.stringify({ username, password, pinType: pinType || undefined })));
}

function clear() {
  fs.rmSync(file(), { force: true });
}

function status() {
  const c = load();
  return { available: available(), saved: !!c, username: c ? c.username.replace(/^(.{2}).*(.{2})$/, '$1••••••$2') : null };
}

module.exports = { load, save, clear, status };
