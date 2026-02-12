// YouTube Dual Cast - Content Script
// Se inyecta en YouTube y agrega controles para cast dual

(function () {
  'use strict';

  let dualCastPanel = null;
  let isSecondaryTab = false;

  // Detectar si esta pestaña fue abierta por la extensión como secundaria
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has('dualcast_secondary')) {
    isSecondaryTab = true;
    // Limpiar el parámetro de la URL para que no se vea
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('dualcast_secondary');
    history.replaceState(null, '', cleanUrl.toString());
  }

  // === OBSERVAR NAVEGACIÓN SPA DE YOUTUBE ===
  // YouTube no recarga la página al cambiar de video, usa navegación interna
  let lastUrl = location.href;
  const navObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // Limpiar panel si existe
      if (dualCastPanel) {
        dualCastPanel.remove();
        dualCastPanel = null;
      }
      // Re-agregar botón después de un momento (YouTube tarda en renderizar)
      setTimeout(addDualCastButton, 1500);
    }
  });
  navObserver.observe(document.body, { childList: true, subtree: true });

  // === BOTÓN DUAL CAST EN EL REPRODUCTOR ===
  function addDualCastButton() {
    // Solo en páginas de video
    if (!window.location.pathname.startsWith('/watch')) return;

    // No duplicar el botón
    if (document.getElementById('dual-cast-btn')) return;

    const controls = document.querySelector('.ytp-right-controls');
    if (!controls) {
      // Si no encontró los controles, reintentar
      setTimeout(addDualCastButton, 1000);
      return;
    }

    const btn = document.createElement('button');
    btn.id = 'dual-cast-btn';
    btn.className = 'ytp-button dual-cast-button';
    btn.title = 'Cast a dos TVs';
    btn.innerHTML = `
      <svg viewBox="0 0 36 36" width="100%" height="100%">
        <!-- Primer TV (izquierda) -->
        <path fill="white" d="M3 18.5v2h2c0-1.1-.9-2-2-2zm0-3v1.5c2.2 0 4 1.8 4 4h1.5c0-3-2.5-5.5-5.5-5.5zm0-3v1.5c3.9 0 7 3.1 7 7h1.5c0-4.7-3.8-8.5-8.5-8.5zM15 14H5v6.5h13V14h-3z"/>
        <!-- Segundo TV (derecha, dorado) -->
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

    document.getElementById('dc-cast-tv1').addEventListener('click', castToTV1);
    document.getElementById('dc-cast-tv2').addEventListener('click', castToTV2);
    document.getElementById('dc-sync-btn').addEventListener('click', syncTime);
    document.getElementById('dc-pause-all-btn').addEventListener('click', pauseAll);
    document.getElementById('dc-play-all-btn').addEventListener('click', playAll);
  }

  // === ACCIONES DE CAST ===

  function castToTV1() {
    // Intenta hacer clic en el botón de Cast nativo de YouTube
    const castBtn = document.querySelector('.ytp-cast-button');
    if (castBtn) {
      castBtn.click();
      updateStepStatus('dc-cast-tv1', 'Cast abierto - selecciona TV 1');
    } else {
      showNotification('No se encontro el boton de Cast. Asegurate de tener un Chromecast en tu red.');
    }
  }

  function castToTV2() {
    const video = document.querySelector('video');
    const videoId = new URLSearchParams(window.location.search).get('v');
    const currentTime = video ? Math.floor(video.currentTime) : 0;

    if (!videoId) {
      showNotification('No se pudo obtener el ID del video.');
      return;
    }

    // Pedir al background que abra la segunda pestaña
    chrome.runtime.sendMessage({
      action: 'openSecondTab',
      videoId: videoId,
      currentTime: currentTime
    }, (response) => {
      if (chrome.runtime.lastError) {
        showNotification('Error: ' + chrome.runtime.lastError.message);
        return;
      }

      if (response && response.success) {
        updateStepStatus('dc-cast-tv2', 'Ventana abierta - envia Cast a TV 2');
        // Mostrar controles de sincronización
        const syncSection = document.getElementById('dc-sync-section');
        if (syncSection) syncSection.style.display = 'block';
      } else {
        showNotification('Error al abrir la segunda ventana.');
      }
    });
  }

  // === SINCRONIZACIÓN ===

  function syncTime() {
    const video = document.querySelector('video');
    if (!video) return;

    chrome.runtime.sendMessage({
      action: 'syncTime',
      currentTime: video.currentTime
    }, () => {
      updateSyncStatus('Tiempo sincronizado: ' + formatTime(video.currentTime));
    });
  }

  function pauseAll() {
    const video = document.querySelector('video');
    if (video) video.pause();
    chrome.runtime.sendMessage({ action: 'pauseSecondTab' }, () => {
      updateSyncStatus('Ambos pausados');
    });
  }

  function playAll() {
    const video = document.querySelector('video');
    if (video) video.play();
    chrome.runtime.sendMessage({ action: 'playSecondTab' }, () => {
      updateSyncStatus('Ambos reproduciendo');
    });
  }

  // === ESCUCHAR COMANDOS DEL BACKGROUND (para la pestaña secundaria) ===
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const video = document.querySelector('video');

    switch (request.action) {
      case 'syncTime':
        if (video) {
          video.currentTime = request.currentTime;
          sendResponse({ success: true });
        }
        break;

      case 'pause':
        if (video) {
          video.pause();
          sendResponse({ success: true });
        }
        break;

      case 'play':
        if (video) {
          video.play();
          sendResponse({ success: true });
        }
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
    // Mostrar notificación temporal en el panel
    const existing = document.querySelector('.dc-notification');
    if (existing) existing.remove();

    const notif = document.createElement('div');
    notif.className = 'dc-notification';
    notif.textContent = message;

    const panel = document.getElementById('dual-cast-panel');
    if (panel) {
      panel.querySelector('.dc-body').prepend(notif);
      setTimeout(() => notif.remove(), 4000);
    }
  }

  function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // === PESTAÑA SECUNDARIA: mostrar banner ===
  if (isSecondaryTab) {
    setTimeout(() => {
      const banner = document.createElement('div');
      banner.id = 'dc-secondary-banner';
      banner.innerHTML = `
        <span>Esta es la ventana para <strong>TV 2</strong> - Haz clic en el boton de Cast para enviar a tu segundo TV</span>
        <button id="dc-banner-cast">Abrir Cast</button>
        <button id="dc-banner-close">&times;</button>
      `;
      document.body.prepend(banner);

      document.getElementById('dc-banner-cast').addEventListener('click', () => {
        const castBtn = document.querySelector('.ytp-cast-button');
        if (castBtn) castBtn.click();
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
