'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('nap', {
  state: call('app:state'),
  openLog: call('app:open-log'),
  list: call('store:list'),
  get: call('store:get'),
  open: call('store:open'),
  importHtml: call('store:import'),
  chooseDataDir: call('settings:choose-dir'),
  setSetting: call('settings:set'),
  getRules: call('rules:get'),
  setRules: call('rules:set'),
  saveCredentials: call('creds:save'),
  clearCredentials: call('creds:clear'),
  acceptPendingLogin: call('creds:accept-pending'),
  sync: call('portal:sync'),
  portalNavigate: call('portal:navigate'),
  portalBounds: (b) => ipcRenderer.send('portal:bounds', b),
  drafts: call('drafts:list'),
  napViewDeclaration: call('napview:declaration'),
  napViewDraft: call('napview:draft'),
  loadPortalDraft: call('drafts:load-portal'),
  draftFrom: call('drafts:from'),
  saveDraft: call('drafts:save'),
  deleteDraft: call('drafts:delete'),
  fillDraft: call('drafts:fill'),
  addImports: call('imports:add'),
  removeImport: call('imports:remove'),
  recomputeImports: call('imports:recompute'),
  openImport: call('imports:open'),
  on: (ch, fn) => ipcRenderer.on(ch, (_e, data) => fn(data)),
});
