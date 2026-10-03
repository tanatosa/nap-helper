'use strict';
// The app used to be called "NAP Declarations". Its data folder (settings, saved login, portal session, log) is
// copied once to the folder of the new name; the old one is left in place. Only for the standard location
// (<appData>/<app name>), so a profile chosen on purpose - the smoke test's - never receives the real data.

const fs = require('fs');
const path = require('path');

const LEGACY_NAME = 'NAP Declarations';

/** @returns {boolean} true when something was copied */
function migrateLegacyProfile({ appData, appName, userData }) {
  try {
    const old = path.join(appData, LEGACY_NAME);
    if (userData !== path.join(appData, appName) || old === userData) return false;
    if (!fs.existsSync(path.join(old, 'settings.json')) || fs.existsSync(path.join(userData, 'settings.json'))) return false;
    fs.cpSync(old, userData, { recursive: true, force: false, filter: (src) => !/^(Singleton|lockfile)/i.test(path.basename(src)) });
    return true;
  } catch { return false; } // a fresh profile is the fallback
}

/** The archive of the old name keeps being used when it exists. */
function defaultDataDir(documents, appName) {
  const legacy = path.join(documents, LEGACY_NAME);
  return fs.existsSync(legacy) ? legacy : path.join(documents, appName);
}

module.exports = { migrateLegacyProfile, defaultDataDir, LEGACY_NAME };
