'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrateLegacyProfile, defaultDataDir } = require('../src/legacy');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nap-legacy-'));

test('legacy profile: settings, login and nested data are copied once, the old folder stays', () => {
  const appData = tmp();
  try {
    const old = path.join(appData, 'NAP Declarations');
    fs.mkdirSync(path.join(old, 'Local Storage'), { recursive: true });
    fs.writeFileSync(path.join(old, 'settings.json'), '{"a":1}');
    fs.writeFileSync(path.join(old, 'credentials.bin'), 'x');
    fs.writeFileSync(path.join(old, 'Local Storage', 'f'), 'y');
    fs.writeFileSync(path.join(old, 'SingletonLock'), 'z');
    const userData = path.join(appData, 'NAP Helper');
    assert.equal(migrateLegacyProfile({ appData, appName: 'NAP Helper', userData }), true);
    assert.equal(fs.readFileSync(path.join(userData, 'credentials.bin'), 'utf8'), 'x');
    assert.equal(fs.readFileSync(path.join(userData, 'Local Storage', 'f'), 'utf8'), 'y');
    assert.equal(fs.existsSync(path.join(userData, 'SingletonLock')), false);
    assert.equal(fs.existsSync(path.join(old, 'settings.json')), true);
    // a second start must not overwrite what the new profile has meanwhile
    fs.writeFileSync(path.join(userData, 'settings.json'), '{"a":2}');
    assert.equal(migrateLegacyProfile({ appData, appName: 'NAP Helper', userData }), false);
    assert.equal(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'), '{"a":2}');
  } finally { fs.rmSync(appData, { recursive: true, force: true }); }
});

test('legacy profile: a profile chosen on purpose gets nothing', () => {
  const appData = tmp();
  try {
    fs.mkdirSync(path.join(appData, 'NAP Declarations'));
    fs.writeFileSync(path.join(appData, 'NAP Declarations', 'settings.json'), '{}');
    const userData = path.join(appData, 'elsewhere', 'profile');
    assert.equal(migrateLegacyProfile({ appData, appName: 'NAP Helper', userData }), false);
    assert.equal(fs.existsSync(userData), false);
  } finally { fs.rmSync(appData, { recursive: true, force: true }); }
});

test('data folder: the old archive is kept when it exists, new installs use the new name', () => {
  const docs = tmp();
  try {
    assert.equal(defaultDataDir(docs, 'NAP Helper'), path.join(docs, 'NAP Helper'));
    fs.mkdirSync(path.join(docs, 'NAP Declarations'));
    assert.equal(defaultDataDir(docs, 'NAP Helper'), path.join(docs, 'NAP Declarations'));
  } finally { fs.rmSync(docs, { recursive: true, force: true }); }
});
