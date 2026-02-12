// YouTube Dual Cast - Content Script (CORREGIDO v2)
// Se inyecta en YouTube y agrega controles para cast dual

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

  // === INYECTAR SCRIPT EN EL CONTEXTO DE LA PÁGINA ===
  // El content script NO puede acceder a las funciones JavaScript de YouTube.
  // Pero YouTube expone pauseVideo(), playVideo(), seekTo(), getCurrentTime()
  // en el elemento #movie_player. Esas funciones SÍ funcionan durante Cast activo.
  // Este script inyectado corre en el contexto de la página y se comunica
  // con el content script via window.postMessage.
  function injectPageScript() {
    if (document.getElementById('dualcast-injected')) return;
    const script = document.createElement('script');
    script.id = 'dualcast-injected';
    script.textContent = `
      (function() {
        window.addEventListener('message', function(e) {
          if (e.source !== window || !e.data || e.data.from !== 'dualcast') return;
          var p = document.getElementById('movie_player');
          if (!p) return;
          try {
            switch (e.data.cmd) {
              case 'pause':  if (p.pauseVideo)    p.pauseVideo(); break;
              case 'play':   if (p.playVideo)     p.playVideo();  break;
              case 'seek':   if (p.seekTo)        p.seekTo(e.data.t, true); break;
              case 'getTime':
                window.postMessage({
                  from: 'dualcast-page',
                  cmd: 'time',
                  t: p.getCurrentTime ? p.getCurrentTime() : 0
                }, '*');
                break;
            }
          } catch(err) {
            console.error('DualCast injected script error:', err);
          }
        });
      })();
    `;
    (document.head || document.documentElement).appendChild(script);
  }

  // Enviar comando a YouTube via el script inyectado
  function ytCmd(cmd, data) {
    window.postMessage({ from: 'dualcast', cmd: cmd, ...(data || {}) }, '*');
  }

  // Obtener tiempo actual del reproductor (funciona durante Cast)
  function ytGetTime() {
    return new Promise(function (resolve) {
      var done = false;
      function onMsg(e) {
        if (e.data && e.data.from === 'dualcast-page' && e.data.cmd === 'time') {
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

  // === ABRIR EL PICKER DE CAST ===
  // Método 1: Remote Playback API (estándar de Chrome, no depende de la UI de YouTube)
  // Método 2: Buscar botón de Cast de YouTube con múltiples selectores
  // Método 3: Instrucciones manuales
  function findCastButton() {
    const selectors = [
      'button.ytp-cast-button',
      '.ytp-cast-button',
      'button[data-tooltip-target-id="ytp-cast-button"]',
      'google-cast-launcher',
      'button[aria-label*="Cast"]',
      'button[aria-label*="Transmitir"]',
      'button[aria-label*="Enviar"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  async function openCastPicker() {
    // Método 1: Remote Playback API
    try {
      const video = document.querySelector('video');
      if (video && video.remote) {
        await video.remote.prompt();
        console.log('DualCast: Cast abierto via Remote Playback API');
        return true;
      }
    } catch (e) {
      console.log('DualCast: Remote Playback falló:', e.name, '-', e.message);
    }

    // Método 2: Click en botón de YouTube
    const btn = findCastButton();
    if (btn) {
      btn.click();
      console.log('DualCast: Cast abierto via botón de YouTube');
      return true;
    }

    console.log('DualCast: No se pudo abrir Cast automáticamente');
    return false;
  }

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
      setTimeout(injectPageScript, 1500);
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

  async function castToTV1() {
    const ok = await openCastPicker();
    if (ok) {
      updateStepStatus('dc-cast-tv1', 'Cast abierto - selecciona TV 1');
    } else {
      showNotification('No se pudo abrir Cast. Haz clic manualmente en el icono de Cast del reproductor, o ve al menu de Chrome > Enviar.');
    }
  }

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

  // === SINCRONIZACIÓN (usa YouTube Player API via script inyectado, funciona durante Cast) ===

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

  // === PESTAÑA SECUNDARIA: mostrar banner ===
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

      document.getElementById('dc-banner-cast').addEventListener('click', async () => {
        const ok = await openCastPicker();
        if (!ok) {
          alert('No se pudo abrir Cast.\n\nHaz clic en el icono de Cast del reproductor de YouTube, o ve al menu de Chrome (3 puntos) > Enviar.');
        }
      });

      document.getElementById('dc-banner-close').addEventListener('click', () => {
        banner.remove();
      });
    }, 2000);
  }

  // === INICIALIZAR ===
  function init() {
    injectPageScript();
    setTimeout(addDualCastButton, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
