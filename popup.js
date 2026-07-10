// Estado del popup: pestañas de YouTube abiertas + sesión dual activa
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const dualStatus = document.getElementById('dual-status');

chrome.tabs.query({ url: '*://*.youtube.com/watch*' }, (tabs) => {
  if (tabs.length > 0) {
    statusDot.classList.add('active');
    statusText.textContent = 'YouTube activo (' + tabs.length + ' video' + (tabs.length > 1 ? 's' : '') + ')';
  } else {
    statusDot.classList.add('inactive');
    statusText.textContent = 'No hay videos de YouTube abiertos';
  }
});

chrome.runtime.sendMessage({ action: 'getStatus' }, (res) => {
  if (chrome.runtime.lastError) return;
  if (res && res.active) {
    dualStatus.style.display = 'flex';
  }
});
