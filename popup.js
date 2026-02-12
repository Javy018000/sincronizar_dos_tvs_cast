// Verificar si hay pestañas de YouTube abiertas
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');

chrome.tabs.query({ url: '*://*.youtube.com/watch*' }, (tabs) => {
  if (tabs.length > 0) {
    statusDot.classList.add('active');
    statusText.textContent = 'YouTube activo (' + tabs.length + ' video' + (tabs.length > 1 ? 's' : '') + ')';
  } else {
    statusDot.classList.add('inactive');
    statusText.textContent = 'No hay videos de YouTube abiertos';
  }
});
