'use strict';
/**
 * The window's only bridge, and the window's chrome.
 *
 * It runs before any page script, so it can do two things the page cannot do for itself:
 *  - take the anti-forgery token this process minted for the load about to happen, and put it
 *    in this tab's session storage (where the team view looks for a desktop session);
 *  - draw the title bar and the connection footer around the page.
 *
 * What it exposes to the page is a single read-only status object. No Node API, no
 * filesystem, and no channel that could reach a credential.
 */
const { contextBridge, ipcRenderer } = require('electron');

// Hand-off first, before the page's own scripts mount anything.
try {
  const token = ipcRenderer.sendSync('desktop:csrf-token');
  if (typeof token === 'string' && token.length > 0) {
    window.sessionStorage.setItem('multi-agent.desktop.csrf', token);
  }
} catch {
  // No token, or storage unavailable: the page falls back to its own pairing form.
}

const CHROME_CSS = `
  html { --ma-top: 40px; --ma-bottom: 28px; }
  body { padding-top: var(--ma-top) !important; padding-bottom: var(--ma-bottom) !important; box-sizing: border-box; }
  #ma-titlebar, #ma-statusbar {
    position: fixed; left: 0; right: 0; z-index: 2147483000; box-sizing: border-box;
    display: flex; align-items: center; gap: 8px;
    font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
    font-size: 12px; color: #999ba6; background: #151619; user-select: none;
  }
  #ma-titlebar { top: 0; height: var(--ma-top); padding: 0 148px 0 12px;
    border-bottom: 1px solid #2c2d34; -webkit-app-region: drag; }
  #ma-titlebar .name { color: #ededf0; font-weight: 600; font-size: 12.5px; }
  #ma-titlebar .sep { color: #2c2d34; }
  #ma-titlebar .project { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #ma-statusbar { bottom: 0; height: var(--ma-bottom); padding: 0 12px; border-top: 1px solid #2c2d34; }
  #ma-statusbar .dot { width: 7px; height: 7px; border-radius: 50%; background: #999ba6; flex: none; }
  #ma-statusbar[data-state="connected"] .dot { background: #34d399; }
  #ma-statusbar[data-state="error"] .dot { background: #f87171; }
  #ma-statusbar .state { color: #ededf0; }
  #ma-statusbar .detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

function mount(status) {
  if (!document.body) return;
  if (!document.getElementById('ma-chrome-style')) {
    const style = document.createElement('style');
    style.id = 'ma-chrome-style';
    style.textContent = CHROME_CSS;
    document.head.appendChild(style);

    const title = document.createElement('div');
    title.id = 'ma-titlebar';
    title.innerHTML = '<span class="name">Multi-Agent</span><span class="sep">·</span><span class="project" id="ma-project"></span>';
    document.body.appendChild(title);

    const bar = document.createElement('div');
    bar.id = 'ma-statusbar';
    bar.innerHTML = '<span class="dot"></span><span class="state" id="ma-state"></span><span class="detail" id="ma-detail"></span>';
    document.body.appendChild(bar);
  }
  render(status);
}

function render(status) {
  if (!status) return;
  const project = document.getElementById('ma-project');
  const bar = document.getElementById('ma-statusbar');
  const text = document.getElementById('ma-state');
  const detail = document.getElementById('ma-detail');
  if (project) project.textContent = status.project || '';
  if (!bar || !text) return;
  bar.dataset.state = status.connected ? 'connected' : ['unknown', 'start-failed'].includes(status.phase) ? 'error' : 'busy';
  text.textContent = status.connected ? 'Local runtime connected' : (status.message || 'Starting…');
  if (detail) detail.textContent = status.connected ? (status.project || '') : '';
}

let current = null;
ipcRenderer.on('desktop:state', (_event, status) => {
  current = status;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => mount(status), { once: true });
  } else {
    mount(status);
  }
  document.dispatchEvent(new CustomEvent('desktop-status', { detail: status }));
});

contextBridge.exposeInMainWorld('multiAgentDesktop', {
  /** The last status the window sent, or null before the first one. */
  status: async () => current ?? ipcRenderer.invoke('desktop:get-state'),
  /** Subscribe to status changes; returns an unsubscribe function. */
  onStatus: callback => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('desktop:state', listener);
    return () => ipcRenderer.removeListener('desktop:state', listener);
  },
  /** Run a first-run action: "retry", "install-wsl" or "clone-repo". */
  run: action => ipcRenderer.invoke(`desktop:${action}`),
});
