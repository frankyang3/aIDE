'use strict';
const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const send = (channel) => (...args) => ipcRenderer.send(channel, ...args);
/** Subscribe to a main-process event; returns an unsubscribe function. */
const on = (channel) => (callback) => {
  const handler = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('aide', {
  init: invoke('app:init'),
  setPrefs: invoke('prefs:set'),
  setUi: invoke('ui:set'),

  sessions: {
    create: invoke('session:create'),
    start: invoke('session:start'),
    kill: invoke('session:kill'),
    remove: invoke('session:remove'),
    rename: invoke('session:rename'),
    float: invoke('session:float'),
    dock: invoke('session:dock'),
    menu: invoke('session:menu'),
    attach: invoke('session:attach'),
    detach: send('session:detach'),
    input: send('session:input'),
    /** Type a line and press Return. */
    submit: send('session:submit'),
    resize: send('session:resize'),
    setActive: send('session:active'),
    onUpdate: on('sessions:update'),
    onData: on('session:data'),
  },

  servers: {
    refresh: invoke('servers:refresh'),
    kill: invoke('servers:kill'),
    onUpdate: on('servers:update'),
  },

  files: {
    list: invoke('fs:list'),
    read: invoke('fs:read'),
    write: invoke('fs:write'),
    watch: send('fs:watch'),
    onChanged: on('fs:changed'),
    /** Where an HTML file shows rendered, served from its project folder: { url, dark }. */
    previewUrl: invoke('preview:url'),
    openInBrowser: invoke('preview:open-in-browser'),
    /** Absolute path of a File dropped onto the window. */
    pathOf: (file) => webUtils.getPathForFile(file),
  },

  openExternal: invoke('shell:open-external'),
  reveal: invoke('shell:reveal'),
  pickFolder: invoke('dialog:pick-folder'),

  float: {
    setPinned: send('float:pin'),
    setOpacity: send('float:opacity'),
    setMini: invoke('float:mini'),
    /** Shrink the bar to just its spinner, or grow it back. */
    setTiny: invoke('float:tiny'),
    chime: send('float:chime'),
    /** Move the spinner-only window: 'start', then 'move' with the distance from the start. */
    drag: send('float:drag'),
    /** Window height in screen points, whatever the zoom level. */
    height: () => window.innerHeight * webFrame.getZoomFactor(),
    width: () => window.innerWidth * webFrame.getZoomFactor(),
  },

  git: {
    /** { branch, detached } checked out in a folder, or null outside a repository. */
    head: invoke('git:head'),
    overview: invoke('git:overview'),
    fetch: invoke('git:fetch'),
  },
  closeWindow: send('window:close'),

  ui: {
    onSelect: on('ui:select'),
    onSelectIndex: on('ui:select-index'),
    onRename: on('ui:rename'),
    onNew: on('ui:new'),
    onSave: on('ui:save'),
    onToggleFloat: on('ui:toggle-float'),
    onMoveToGroup: on('ui:move-to-group'),
    // Agents asking, through their aIDE tools:
    onPlace: on('ui:place'),
    onOpenFile: on('ui:open-file'),
    onShowGit: on('ui:show-git'),
  },
});
