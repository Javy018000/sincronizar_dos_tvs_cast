// YouTube Dual Cast - Content Script (v3)
// Se inyecta en YouTube. Maneja la UI (botón, panel).
// Se comunica con page-script.js (MAIN world) via postMessage para Cast y Player API.
// Se comunica con background.js via chrome.runtime para la segunda pestaña.

(function () {
  'use strict';

  let dualCastPanel = null;
  let isSecondaryTab = false;

  // Detectar si esta pestaña fue abierta por la extensión como secundaria
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has('dualcast_secondary')) {
    isSecondaryTab = true;
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('dualcast_secondary');
    history.replaceState(null, '', cleanUrl.toString());
  }

  // === COMUNICACIÓN CON page-script.js (MAIN world) ===
  // page-script.js tiene acceso a chrome.cast y YouTube Player API
  function ytCmd(cmd, data) {
    window.postMessage({ from: 'dc-content', cmd: cmd, ...(data || {}) }, '*');
  }

  function ytGetTime() {
    return new Promise(function (resolve) {
      var done = false;
      function onMsg(e) {
        if (e.data && e.data.from === 'dc-page' && e.data.cmd === 'time') {
          window.removeEventListener('message', onMsg);
          done = true;
          resolve(e.data.t);
        }
      }
      window.addEventListener('message', onMsg);
      setTimeout(function () {
        if (!done) {
          window.removeEventListener('message', onMsg);
          var v = document.querySelector('video');
          resolve(v ? v.currentTime : 0);
        }
      }, 400);
      ytCmd('getTime');
    });
  }

  // Escuchar eventos de Cast desde page-script.js
  window.addEventListener('message', function (e) {
    if (e.data && e.data.from === 'dc-page' && e.data.cmd === 'castEvent') {
      switch (e.data.event) {
        case 'castSuccess':
          console.log('DualCast content: Cast conectado exitosamente');
          updateStepStatus('dc-cast-tv1', 'Cast conectado a TV 1');
          break;
        case 'castError':
          console.log('DualCast content: Cast error:', e.data.detail);
          showNotification('Error al conectar Cast: ' + (e.data.detail || 'desconocido'));
          break;
        case 'castUnavailable':
          console.log('DualCast content: Cast SDK no disponible');
          showNotification('Cast no disponible. Usa el menu de Chrome (3 puntos) > Enviar para castear manualmente.');
          break;
      }
    }
    // Diagnóstico
    if (e.data && e.data.from === 'dc-page' && e.data.cmd === 'diagnosis') {
      console.log('DualCast diagnosis:', e.data.info);
    }
  });

  // === OBSERVAR NAVEGACIÓN SPA DE YOUTUBE ===
  let lastUrl = location.href;
  const navObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (dualCastPanel) {
        dualCastPanel.remove();
        dualCastPanel = null;
      }
      setTimeout(addDualCastButton, 1500);
    }
  });
  navObserver.observe(document.body, { childList: true, subtree: true });

  // === BOTÓN DUAL CAST EN EL REPRODUCTOR ===
  function addDualCastButton() {
    if (!window.location.pathname.startsWith('/watch')) return;
    if (document.getElementById('dual-cast-btn')) return;

    const controls = document.querySelector('.ytp-right-controls');
    if (!controls) {
      setTimeout(addDualCastButton, 1000);
      return;
    }

    const btn = document.createElement('button');
    btn.id = 'dual-cast-btn';
    btn.className = 'ytp-button dual-cast-button';
    btn.title = 'Cast a dos TVs';
    btn.innerHTML = `
      <svg viewBox="0 0 36 36" width="100%" height="100%">
        <path fill="white" d="M3 18.5v2h2c0-1.1-.9-2-2-2zm0-3v1.5c2.2 0 4 1.8 4 4h1.5c0-3-2.5-5.5-5.5-5.5zm0-3v1.5c3.9 0 7 3.1 7 7h1.5c0-4.7-3.8-8.5-8.5-8.5zM15 14H5v6.5h13V14h-3z"/>
        <path fill="#FFD700" d="M22 18.5v2h2c0-1.1-.9-2-2-2zm0-3v1.5c2.2 0 4 1.8 4 4h1.5c0-3-2.5-5.5-5.5-5.5zm0-3v1.5c3.9 0 7 3.1 7 7h1.5c0-4.7-3.8-8.5-8.5-8.5zM34 14H24v6.5h13V14h-3z"/>
      </svg>
    `;

    btn.addEventListener('click', togglePanel);
    controls.insertBefore(btn, controls.firstChild);
  }

  // === PANEL DE CONTROL ===
  function togglePanel() {
    if (dualCastPanel) {
      dualCastPanel.remove();
      dualCastPanel = null;
      return;
    }
    createPanel();
  }

  function createPanel() {
    const player = document.querySelector('#movie_player');
    if (!player) return;

    // Pedir diagnóstico al cargar el panel
    ytCmd('diagnoseCast');

    dualCastPanel = document.createElement('div');
    dualCastPanel.id = 'dual-cast-panel';
    dualCastPanel.innerHTML = `
      <div class="dc-header">
        <span class="dc-title">YouTube Dual Cast</span>
        <button class="dc-close" id="dc-close-btn">&times;</button>
      </div>

      <div class="dc-body">
        <p class="dc-info">Envia este video a dos TVs al mismo tiempo</p>

        <!-- PASO 1 -->
        <div class="dc-step" id="dc-step1">
          <div class="dc-step-header">
            <span class="dc-step-num">1</span>
            <span>Transmitir a TV 1</span>
          </div>
          <p class="dc-step-desc">
            Haz clic para abrir el selector de Cast. Elige tu primer TV.
          </p>
          <button class="dc-btn" id="dc-cast-tv1">Abrir Cast para TV 1</button>
        </div>

        <!-- PASO 2 -->
        <div class="dc-step" id="dc-step2">
          <div class="dc-step-header">
            <span class="dc-step-num">2</span>
            <span>Transmitir a TV 2</span>
          </div>
          <p class="dc-step-desc">
            Se abrira una nueva ventana con el mismo video sincronizado.
            Desde ahi, envia Cast al segundo TV.
          </p>
          <button class="dc-btn" id="dc-cast-tv2">Abrir ventana para TV 2</button>
        </div>

        <!-- CONTROLES DE SINCRONIZACIÓN -->
        <div class="dc-sync" id="dc-sync-section" style="display:none;">
          <div class="dc-step-header">
            <span class="dc-step-num dc-step-sync">~</span>
            <span>Sincronizacion</span>
          </div>
          <div class="dc-sync-buttons">
            <button class="dc-btn dc-btn-sync" id="dc-sync-btn">Sincronizar tiempo</button>
            <button class="dc-btn dc-btn-sync" id="dc-pause-all-btn">Pausar ambos</button>
            <button class="dc-btn dc-btn-sync" id="dc-play-all-btn">Reproducir ambos</button>
          </div>
          <p class="dc-sync-status" id="dc-sync-status"></p>
        </div>
      </div>
    `;

    player.appendChild(dualCastPanel);

    // === EVENT LISTENERS DEL PANEL ===
    document.getElementById('dc-close-btn').addEventListener('click', () => {
      dualCastPanel.remove();
      dualCastPanel = null;
    });

    // NOTA: El clic en dc-cast-tv1 es manejado por page-script.js (MAIN world)
    // que tiene acceso a chrome.cast.requestSession(). El content script solo
    // actualiza la UI cuando recibe el resultado via postMessage.
    document.getElementById('dc-cast-tv1').addEventListener('click', () => {
      updateStepStatus('dc-cast-tv1', 'Abriendo Cast...');
    });

    document.getElementById('dc-cast-tv2').addEventListener('click', castToTV2);
    document.getElementById('dc-sync-btn').addEventListener('click', syncTime);
    document.getElementById('dc-pause-all-btn').addEventListener('click', pauseAll);
    document.getElementById('dc-play-all-btn').addEventListener('click', playAll);
  }

  // === ACCIONES ===

  async function castToTV2() {
    const currentTime = await ytGetTime();
    const videoId = new URLSearchParams(window.location.search).get('v');

    if (!videoId) {
      showNotification('No se pudo obtener el ID del video.');
      return;
    }

    chrome.runtime.sendMessage({
      action: 'openSecondTab',
      videoId: videoId,
      currentTime: Math.floor(currentTime)
    }, (response) => {
      if (chrome.runtime.lastError) {
        showNotification('Error: ' + chrome.runtime.lastError.message);
        return;
      }

      if (response && response.success) {
        updateStepStatus('dc-cast-tv2', 'Ventana abierta - envia Cast a TV 2');
        const syncSection = document.getElementById('dc-sync-section');
        if (syncSection) syncSection.style.display = 'block';
      } else {
        showNotification('Error al abrir la segunda ventana.');
      }
    });
  }

  // === SINCRONIZACIÓN (via YouTube Player API en page-script.js) ===

  async function syncTime() {
    const t = await ytGetTime();
    chrome.runtime.sendMessage({
      action: 'syncTime',
      currentTime: t
    }, () => {
      updateSyncStatus('Tiempo sincronizado: ' + formatTime(t));
    });
  }

  function pauseAll() {
    ytCmd('pause');
    chrome.runtime.sendMessage({ action: 'pauseSecondTab' }, () => {
      updateSyncStatus('Ambos pausados');
    });
  }

  function playAll() {
    ytCmd('play');
    chrome.runtime.sendMessage({ action: 'playSecondTab' }, () => {
      updateSyncStatus('Ambos reproduciendo');
    });
  }

  // === ESCUCHAR COMANDOS DEL BACKGROUND (para la pestaña secundaria) ===
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
      case 'syncTime':
        ytCmd('seek', { t: request.currentTime });
        sendResponse({ success: true });
        break;

      case 'pause':
        ytCmd('pause');
        sendResponse({ success: true });
        break;

      case 'play':
        ytCmd('play');
        sendResponse({ success: true });
        break;
    }
  });

  // === UTILIDADES ===

  function updateStepStatus(btnId, text) {
    const btn = document.getElementById(btnId);
    if (btn) {
      btn.textContent = text;
      btn.disabled = true;
      btn.classList.add('dc-btn-done');
    }
  }

  function updateSyncStatus(text) {
    const el = document.getElementById('dc-sync-status');
    if (el) el.textContent = text;
  }

  function showNotification(message) {
    const existing = document.querySelector('.dc-notification');
    if (existing) existing.remove();

    const notif = document.createElement('div');
    notif.className = 'dc-notification';
    notif.textContent = message;

    const panel = document.getElementById('dual-cast-panel');
    if (panel) {
      panel.querySelector('.dc-body').prepend(notif);
      setTimeout(() => notif.remove(), 5000);
    }
  }

  function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // === PESTAÑA SECUNDARIA: banner ===
  if (isSecondaryTab) {
    setTimeout(() => {
      const banner = document.createElement('div');
      banner.id = 'dc-secondary-banner';
      banner.innerHTML = `
        <span>Esta es la ventana para <strong>TV 2</strong> - Envia Cast a tu segundo TV</span>
        <button id="dc-banner-cast">Abrir Cast</button>
        <button id="dc-banner-close">&times;</button>
      `;
      document.body.prepend(banner);

      // NOTA: El clic en dc-banner-cast es manejado por page-script.js
      document.getElementById('dc-banner-cast').addEventListener('click', () => {
        // Solo feedback visual, page-script.js maneja el Cast
      });

      document.getElementById('dc-banner-close').addEventListener('click', () => {
        banner.remove();
      });
    }, 2000);
  }

  // === INICIALIZAR ===
  function init() {
    setTimeout(addDualCastButton, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
