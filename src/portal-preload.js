'use strict';
// Runs inside the embedded portal page (isolated world). Two jobs:
//   1. fill the login form from the securely stored credentials
//   2. notice a manual login so the app can offer to remember it
// The password only ever travels between this script and the main process.

const { ipcRenderer } = require('electron');

const visible = (el) => !!(el && el.offsetParent !== null && !el.disabled);

function findLoginForm() {
  const pw = [...document.querySelectorAll('input[type=password]')].find(visible);
  if (!pw) return null;
  const scope = pw.closest('form') || document;
  const texts = [...scope.querySelectorAll('input')].filter((i) => visible(i) && /^(text|tel|email|number|)$/.test(i.getAttribute('type') || ''));
  // the user field is the last text input that precedes the password field
  const user = texts.filter((i) => i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING).pop() || null;
  return { pw, user, scope };
}

function setValue(input, value) {
  // go through the native setter so that React-controlled inputs notice the change
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

let filledFor = null;
let tabOpened = false;
async function tryAutofill() {
  let f = findLoginForm();
  // login-portal.nra.bg opens on the КЕП tab; the ПИК form sits behind a[href="#picTab"]
  const pikTab = !f && !tabOpened && document.querySelector('a[href="#picTab"]');
  if (pikTab) {
    tabOpened = true;
    if (!(await ipcRenderer.invoke('portal:has-credentials'))) return;
    pikTab.click();
    f = findLoginForm();
  }
  if (!f || f.pw === filledFor || f.pw.value) return;
  filledFor = f.pw;
  const creds = await ipcRenderer.invoke('portal:credentials');
  if (!creds) return;
  const kind = f.scope.querySelector('select[name=pinType]');
  if (kind && creds.pinType && [...kind.options].some((o) => o.value === creds.pinType)) {
    kind.value = creds.pinType;
    kind.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (f.user && !f.user.value) setValue(f.user, creds.username);
  setValue(f.pw, creds.password);
  if (creds.autoSubmit) {
    const btn = f.scope.querySelector('button[type=submit], input[type=submit]')
      || [...f.scope.querySelectorAll('button')].filter(visible).find((b) => f.pw.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (btn) setTimeout(() => btn.click(), 300);
  }
}

function reportAttempt() {
  const f = findLoginForm();
  if (!f || !f.pw.value) return;
  const kind = f.scope.querySelector('select[name=pinType]');
  ipcRenderer.send('portal:login-attempt', { username: f.user ? f.user.value : '', password: f.pw.value, pinType: kind ? kind.value : undefined });
}

window.addEventListener('DOMContentLoaded', () => {
  if (window.top !== window) return;
  new MutationObserver(() => tryAutofill()).observe(document.documentElement, { childList: true, subtree: true });
  tryAutofill();
  document.addEventListener('submit', reportAttempt, true);
  document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('button, input[type=submit], input[type=button]')) reportAttempt(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches && e.target.matches('input')) reportAttempt(); }, true);
});
