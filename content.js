// YouTube Dual Cast - Content Script
// Se inyecta en YouTube. Maneja la UI (botón, panel, banner) y la sincronización.
// Se comunica con page-script.js (MAIN world) via postMessage para Cast y Player API.
// Se comunica con background.js via chrome.runtime para hablar con la otra pestaña.
//
// Modelo de sincronización:
//   - La pestaña PRIMARIA manda: cada 3 s envía su tiempo + estado de
//     reproducción. La SECUNDARIA compara con su propio reproductor y solo
//     corrige (seek) si el desfase supera un umbral, con un cooldown para no
//     encadenar seeks mientras el TV aún está buscando.
//   - Como los dos TVs tienen latencias distintas (WiFi, redes diferentes),
//     el desfase de AUDIO no se puede medir desde el navegador: se corrige
//     con el offset manual, que ahora se aplica EN VIVO al mover el slider
//     (ajuste a oído), se guarda en chrome.storage.local y se incluye en
//     cada corrección automática para que se mantenga en el tiempo.

(function () {
  'use strict';

  var SYNC_INTERVAL_MS = 3000;    // cadencia del auto-sync (primaria)
  var DRIFT_THRESHOLD_S = 0.4;    // desfase mínimo para corregir con seek
  var SEEK_COOLDOWN_MS = 5000;    // espera tras un seek (el TV tarda en buscar)
  var OFFSET_MIN = -3000;
  var OFFSET_MAX = 3000;
  var OFFSET_STEP = 25;

  var dualCastPanel = null;
  var autoSyncTimer = null;
  var sessionActive = false;
  var autoSyncOn = true;
  var offsetMs = 0;
  var offsetDebounce = null;
  var lastSeekAt = 0;             // (secundaria) último seek aplicado
  var currentVideoId = getVideoId();

  // === ROL DE LA PESTAÑA ===
  // El parámetro de URL marca la pestaña secundaria; lo persistimos en
  // sessionStorage para que el rol sobreviva recargas y navegación SPA.
  var isSecondaryTab = false;
  try {
    if (sessionStorage.getItem('dcSecondary') === '1') isSecondaryTab = true;
  } catch (e) {}
  if (new URLSearchParams(window.location.search).has('dualcast_secondary')) {
    isSecondaryTab = true;
    try { sessionStorage.setItem('dcSecondary', '1'); } catch (e) {}
    var cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('dualcast_secondary');
    history.replaceState(null, '', cleanUrl.toString());
  }

  // === PREFERENCIAS PERSISTIDAS ===
  try {
    chrome.storage.local.get(['dcOffsetMs', 'dcAutoSync'], function (r) {
      if (chrome.runtime.lastError || !r) return;
      if (typeof r.dcOffsetMs === 'number') offsetMs = r.dcOffsetMs;
      if (typeof r.dcAutoSync === 'boolean') autoSyncOn = r.dcAutoSync;
      refreshOffsetUI();
    });
  } catch (e) {}

  function savePrefs() {
    try {
      chrome.storage.local.set({ dcOffsetMs: offsetMs, dcAutoSync: autoSyncOn });
    } catch (e) {}
  }

  // === MENSAJERÍA SEGURA CON EL BACKGROUND ===
  // No lanza si el contexto de la extensión se invalidó (p. ej. al recargarla).
  function safeSend(message) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (response) {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(response || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function getVideoId() {
    return new URLSearchParams(window.location.search).get('v');
  }

  // === COMUNICACIÓN CON page-script.js (MAIN world) ===
  function ytCmd(cmd, data) {
    window.postMessage(Object.assign({ from: 'dc-content', cmd: cmd }, data || {}), '*');
  }

  // Estado del reproductor con reqId para no cruzar respuestas concurrentes.
  var stateReqSeq = 0;
  function ytGetState() {
    return new Promise(function (resolve) {
      var reqId = ++stateReqSeq;
      var done = false;
      function finish(state) {
        if (done) return;
        done = true;
        window.removeEventListener('message', onMsg);
        clearTimeout(timer);
        resolve(state);
      }
      function onMsg(e) {
        if (e.source === window && e.data && e.data.from === 'dc-page' &&
            e.data.cmd === 'state' && e.data.reqId === reqId) {
          finish(e.data.state);
        }
      }
      window.addEventListener('message', onMsg);
      var timer = setTimeout(function () {
        // Fallback: leer el <video> local si page-script no responde
        var v = document.querySelector('video');
        finish({
          t: v ? v.currentTime : 0,
          playerState: v ? (v.paused ? 2 : 1) : -1,
          videoId: getVideoId(),
          duration: v && !isNaN(v.duration) ? v.duration : 0
        });
      }, 500);
      ytCmd('getState', { reqId: reqId });
    });
  }

  function isPlayingState(playerState) {
    return playerState === 1 || playerState === 3; // playing o buffering
  }

  // === EVENTOS DE CAST DESDE page-script.js ===
  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data || e.data.from !== 'dc-page') return;

    if (e.data.cmd === 'castEvent') {
      switch (e.data.event) {
        case 'pickerOpened':
          setCastStatus('Selector de Cast abierto — elige tu TV', 'pending');
          break;
        case 'castSuccess':
          setCastStatus(
            e.data.device ? 'Conectado a ' + e.data.device : 'Cast conectado',
            'ok'
          );
          break;
        case 'castState':
          if (e.data.connected) {
            setCastStatus(
              e.data.device ? 'Transmitiendo a ' + e.data.device : 'Cast conectado',
              'ok'
            );
          } else {
            setCastStatus('Cast desconectado', 'off');
          }
          break;
        case 'castError':
          var detail = String(e.data.detail || '');
          if (/cancel/i.test(detail)) {
            setCastStatus('Selección cancelada', 'off');
          } else {
            setCastStatus('Error de Cast', 'off');
            showNotification('Error al conectar Cast: ' + (detail || 'desconocido'));
          }
          break;
        case 'castUnavailable':
          setCastStatus('Cast no disponible', 'off');
          showNotification('Cast no disponible. Usa el menú de Chrome (⋮) → "Enviar..." para castear esta pestaña.');
          break;
      }
    }

    if (e.data.cmd === 'diagnosis') {
      console.log('DualCast diagnosis:', e.data.info);
    }
  });

  // === NAVEGACIÓN SPA DE YOUTUBE ===
  // yt-navigate-finish es el evento oficial del SPA de YouTube; mucho más
  // barato que un MutationObserver sobre todo el body. Dejamos un chequeo
  // ligero de respaldo por si YouTube cambia el evento.
  window.addEventListener('yt-navigate-finish', onNavigate, true);
  var lastUrl = location.href;
  setInterval(function () {
    if (location.href !== lastUrl) onNavigate();
  }, 2000);

  function onNavigate() {
    if (location.href === lastUrl) {
      ensureButton();
      return;
    }
    lastUrl = location.href;
    if (dualCastPanel) {
      dualCastPanel.remove();
      dualCastPanel = null;
    }
    ensureButton();

    var vid = getVideoId();
    if (vid && vid !== currentVideoId) {
      currentVideoId = vid;
      // Si la primaria cambia de video con la sesión activa, la secundaria
      // carga el mismo video automáticamente.
      if (!isSecondaryTab && sessionActive) {
        safeSend({ action: 'videoChanged', videoId: vid, currentTime: 0 });
        updateSyncStatus('Video cambiado — sincronizando TV 2…');
      }
    }
  }

  function ensureButton() {
    setTimeout(addDualCastButton, 800);
  }

  // === BOTÓN DUAL CAST EN EL REPRODUCTOR ===
  var buttonRetries = 0;
  function addDualCastButton() {
    if (!window.location.pathname.startsWith('/watch')) return;
    if (document.getElementById('dual-cast-btn')) return;

    var controls = document.querySelector('.ytp-right-controls');
    if (!controls) {
      if (++buttonRetries < 20) setTimeout(addDualCastButton, 1000);
      return;
    }
    buttonRetries = 0;

    var btn = document.createElement('button');
    btn.id = 'dual-cast-btn';
    btn.className = 'ytp-button dual-cast-button';
    btn.title = 'Cast a dos TVs';
    btn.innerHTML =
      '<svg viewBox="0 0 36 36" width="100%" height="100%">' +
      '<path fill="white" d="M3 18.5v2h2c0-1.1-.9-2-2-2zm0-3v1.5c2.2 0 4 1.8 4 4h1.5c0-3-2.5-5.5-5.5-5.5zm0-3v1.5c3.9 0 7 3.1 7 7h1.5c0-4.7-3.8-8.5-8.5-8.5zM15 14H5v6.5h13V14h-3z"/>' +
      '<path fill="#FFD700" d="M22 18.5v2h2c0-1.1-.9-2-2-2zm0-3v1.5c2.2 0 4 1.8 4 4h1.5c0-3-2.5-5.5-5.5-5.5zm0-3v1.5c3.9 0 7 3.1 7 7h1.5c0-4.7-3.8-8.5-8.5-8.5zM34 14H24v6.5h13V14h-3z"/>' +
      '</svg>';

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
    var player = document.querySelector('#movie_player');
    if (!player) return;

    ytCmd('diagnoseCast');

    dualCastPanel = document.createElement('div');
    dualCastPanel.id = 'dual-cast-panel';

    if (isSecondaryTab) {
      dualCastPanel.innerHTML = buildSecondaryPanelHTML();
    } else {
      dualCastPanel.innerHTML = buildPrimaryPanelHTML();
    }

    player.appendChild(dualCastPanel);

    // Que el teclado y los clics dentro del panel no activen los atajos
    // del reproductor de YouTube (espacio = pausa, flechas = seek, etc.)
    ['keydown', 'keyup', 'keypress'].forEach(function (ev) {
      dualCastPanel.addEventListener(ev, function (e) { e.stopPropagation(); });
    });
    dualCastPanel.addEventListener('click', function (e) { e.stopPropagation(); });

    dualCastPanel.querySelector('.dc-close').addEventListener('click', function () {
      dualCastPanel.remove();
      dualCastPanel = null;
    });

    if (isSecondaryTab) return; // el panel secundario solo tiene el botón de cast

    // --- listeners del panel primario ---
    // El clic en .dc-cast-trigger lo maneja page-script.js (MAIN world);
    // aquí solo damos feedback inmediato.
    document.getElementById('dc-cast-tv1').addEventListener('click', function () {
      setCastStatus('Abriendo Cast…', 'pending');
    });
    document.getElementById('dc-cast-tv2').addEventListener('click', castToTV2);
    document.getElementById('dc-sync-btn').addEventListener('click', function () {
      syncNow(true);
    });
    document.getElementById('dc-pause-all-btn').addEventListener('click', pauseAll);
    document.getElementById('dc-play-all-btn').addEventListener('click', playAll);

    // Toggle de auto-sync
    var autoToggle = document.getElementById('dc-autosync');
    autoToggle.checked = autoSyncOn;
    autoToggle.addEventListener('change', function () {
      autoSyncOn = autoToggle.checked;
      savePrefs();
      startAutoSync();
      updateSyncStatus(autoSyncOn ? 'Auto-sync activado' : 'Auto-sync desactivado');
    });

    // Slider de offset: se aplica EN VIVO (con debounce corto) para poder
    // ajustar a oído hasta que el sonido de los dos TVs coincida.
    var slider = document.getElementById('dc-offset-slider');
    slider.addEventListener('input', function () {
      setOffset(parseInt(slider.value, 10));
    });

    // Botones de ajuste fino
    dualCastPanel.querySelectorAll('.dc-nudge').forEach(function (b) {
      b.addEventListener('click', function () {
        setOffset(offsetMs + parseInt(b.dataset.ms, 10));
      });
    });
    document.getElementById('dc-offset-reset').addEventListener('click', function () {
      setOffset(0);
    });

    refreshOffsetUI();

    // Restaurar estado de la sesión (p. ej. si se recargó la pestaña
    // o se cerró y reabrió el panel con la sesión ya activa).
    // Solo si ESTA pestaña es la primaria de la sesión; así una tercera
    // pestaña de YouTube no puede robar el rol de primaria sin querer.
    safeSend({ action: 'getStatus' }).then(function (status) {
      if (status && status.active && status.isPrimary) {
        activateSession('Sesión dual activa');
      }
    });
  }

  function buildPrimaryPanelHTML() {
    return '' +
      '<div class="dc-header">' +
      '  <span class="dc-title">YouTube Dual Cast</span>' +
      '  <button class="dc-close">&times;</button>' +
      '</div>' +
      '<div class="dc-body">' +
      '  <p class="dc-info">Envía este video a dos TVs al mismo tiempo</p>' +

      '  <div class="dc-step" id="dc-step1">' +
      '    <div class="dc-step-header">' +
      '      <span class="dc-step-num">1</span>' +
      '      <span>Transmitir a TV 1</span>' +
      '      <span class="dc-chip" id="dc-cast-chip">sin conectar</span>' +
      '    </div>' +
      '    <p class="dc-step-desc">Abre el selector de Cast y elige tu primer TV.</p>' +
      '    <button class="dc-btn dc-cast-trigger" id="dc-cast-tv1">Elegir TV 1</button>' +
      '  </div>' +

      '  <div class="dc-step" id="dc-step2">' +
      '    <div class="dc-step-header">' +
      '      <span class="dc-step-num">2</span>' +
      '      <span>Transmitir a TV 2</span>' +
      '    </div>' +
      '    <p class="dc-step-desc">Se abrirá otra pestaña con el mismo video. Desde ahí, envía Cast al segundo TV.</p>' +
      '    <button class="dc-btn" id="dc-cast-tv2">Abrir ventana para TV 2</button>' +
      '  </div>' +

      '  <div class="dc-sync" id="dc-sync-section" style="display:none;">' +
      '    <div class="dc-step-header">' +
      '      <span class="dc-step-num dc-step-sync">~</span>' +
      '      <span>Sincronización</span>' +
      '      <label class="dc-toggle" title="Corrige el desfase automáticamente cada 3 segundos">' +
      '        <input type="checkbox" id="dc-autosync" checked>' +
      '        <span class="dc-toggle-track"></span>' +
      '        <span class="dc-toggle-text">auto</span>' +
      '      </label>' +
      '    </div>' +

      '    <div class="dc-sync-buttons">' +
      '      <button class="dc-btn dc-btn-sync" id="dc-sync-btn">Sincronizar ahora</button>' +
      '      <div class="dc-sync-row">' +
      '        <button class="dc-btn dc-btn-sync" id="dc-pause-all-btn">Pausar ambos</button>' +
      '        <button class="dc-btn dc-btn-sync" id="dc-play-all-btn">Reproducir ambos</button>' +
      '      </div>' +
      '    </div>' +

      '    <div class="dc-offset">' +
      '      <label class="dc-offset-label">' +
      '        Ajuste de audio TV 2 (a oído):' +
      '        <span id="dc-offset-value" class="dc-offset-val">0 ms</span>' +
      '        <button id="dc-offset-reset" class="dc-offset-reset" title="Volver a 0">reset</button>' +
      '      </label>' +
      '      <input type="range" id="dc-offset-slider" class="dc-offset-slider"' +
      '        min="' + OFFSET_MIN + '" max="' + OFFSET_MAX + '" value="0" step="' + OFFSET_STEP + '">' +
      '      <div class="dc-offset-hints">' +
      '        <span>&minus;3s · TV 2 suena antes</span>' +
      '        <span>+3s · TV 2 suena después</span>' +
      '      </div>' +
      '      <div class="dc-nudges">' +
      '        <button class="dc-nudge" data-ms="-100">&minus;100</button>' +
      '        <button class="dc-nudge" data-ms="-25">&minus;25</button>' +
      '        <button class="dc-nudge" data-ms="25">+25</button>' +
      '        <button class="dc-nudge" data-ms="100">+100</button>' +
      '      </div>' +
      '      <p class="dc-offset-tip">Si el TV 2 se oye con eco (retrasado), mueve hacia +. Si se adelanta, hacia &minus;.</p>' +
      '    </div>' +

      '    <p class="dc-sync-status" id="dc-sync-status"></p>' +
      '  </div>' +
      '</div>';
  }

  function buildSecondaryPanelHTML() {
    return '' +
      '<div class="dc-header">' +
      '  <span class="dc-title">YouTube Dual Cast — TV 2</span>' +
      '  <button class="dc-close">&times;</button>' +
      '</div>' +
      '<div class="dc-body">' +
      '  <p class="dc-info">Esta pestaña controla el <strong>TV 2</strong>. La sincronización se maneja desde la pestaña principal.</p>' +
      '  <div class="dc-step">' +
      '    <div class="dc-step-header">' +
      '      <span class="dc-step-num">2</span>' +
      '      <span>Transmitir a TV 2</span>' +
      '      <span class="dc-chip" id="dc-cast-chip">sin conectar</span>' +
      '    </div>' +
      '    <button class="dc-btn dc-cast-trigger" id="dc-cast-tv2-local">Elegir TV 2</button>' +
      '  </div>' +
      '</div>';
  }

  // === ACCIONES (pestaña primaria) ===

  async function castToTV2() {
    var st = await ytGetState();
    var videoId = st.videoId || getVideoId();

    if (!videoId) {
      showNotification('No se pudo obtener el ID del video.');
      return;
    }

    var btn = document.getElementById('dc-cast-tv2');
    if (btn) btn.textContent = 'Abriendo ventana…';

    var response = await safeSend({
      action: 'openSecondTab',
      videoId: videoId,
      currentTime: st.t
    });

    if (response && response.success) {
      if (btn) btn.textContent = 'Reabrir ventana para TV 2';
      updateSyncStatus('Ventana abierta — envía Cast al TV 2');
      // La sesión se activa del todo cuando la secundaria avise (secondaryReady)
    } else {
      if (btn) btn.textContent = 'Abrir ventana para TV 2';
      showNotification('Error al abrir la segunda ventana.');
    }
  }

  function activateSession(statusText) {
    sessionActive = true;
    var syncSection = document.getElementById('dc-sync-section');
    if (syncSection) syncSection.style.display = 'block';
    var btn = document.getElementById('dc-cast-tv2');
    if (btn) btn.textContent = 'Reabrir ventana para TV 2';
    if (statusText) updateSyncStatus(statusText);
    startAutoSync();
  }

  function onSecondaryClosed() {
    sessionActive = false;
    stopAutoSync();
    var btn = document.getElementById('dc-cast-tv2');
    if (btn) btn.textContent = 'Abrir ventana para TV 2';
    updateSyncStatus('La ventana del TV 2 se cerró');
  }

  // === SINCRONIZACIÓN ===

  function startAutoSync() {
    stopAutoSync();
    if (isSecondaryTab || !sessionActive || !autoSyncOn) return;
    autoSyncTimer = setInterval(function () { syncNow(false); }, SYNC_INTERVAL_MS);
  }

  function stopAutoSync() {
    if (autoSyncTimer) {
      clearInterval(autoSyncTimer);
      autoSyncTimer = null;
    }
  }

  var syncInFlight = false;
  async function syncNow(force) {
    if (syncInFlight) return;
    syncInFlight = true;
    try {
      var st = await ytGetState();
      if (!st || !st.videoId) return;

      var response = await safeSend({
        action: 'syncTime',
        currentTime: st.t,
        sentAt: Date.now(),
        offsetMs: offsetMs,
        isPlaying: isPlayingState(st.playerState),
        videoId: st.videoId,
        force: !!force
      });

      if (!response) return;
      if (!response.success) {
        if (response.error === 'secondary-closed') onSecondaryClosed();
        return;
      }

      var rep = response.report;
      if (rep && typeof rep.driftMs === 'number') {
        var d = Math.round(rep.driftMs);
        var abs = Math.abs(d);
        var label;
        if (rep.reloaded) {
          label = 'Cargando el video en el TV 2…';
        } else if (rep.corrected) {
          label = 'Desfase de ' + abs + ' ms corregido';
        } else if (rep.skipped === 'buffering') {
          label = 'TV 2 cargando…';
        } else if (rep.skipped === 'cooldown') {
          label = 'Esperando a que el TV 2 termine de buscar…';
        } else if (abs <= 100) {
          label = 'En sincronía (±' + abs + ' ms)';
        } else {
          label = 'Desfase: ' + (d > 0 ? '+' : '−') + abs + ' ms';
        }
        if (offsetMs !== 0) {
          label += ' · offset ' + (offsetMs > 0 ? '+' : '') + offsetMs + ' ms';
        }
        updateSyncStatus(label);
      }
    } finally {
      syncInFlight = false;
    }
  }

  function setOffset(ms) {
    offsetMs = Math.max(OFFSET_MIN, Math.min(OFFSET_MAX, ms));
    refreshOffsetUI();
    savePrefs();
    // Aplicar en vivo: un force-sync corto después de soltar el slider
    clearTimeout(offsetDebounce);
    offsetDebounce = setTimeout(function () {
      if (sessionActive) syncNow(true);
    }, 250);
  }

  function refreshOffsetUI() {
    var slider = document.getElementById('dc-offset-slider');
    var display = document.getElementById('dc-offset-value');
    if (slider) slider.value = String(offsetMs);
    if (display) display.textContent = (offsetMs > 0 ? '+' : '') + offsetMs + ' ms';
  }

  function pauseAll() {
    ytCmd('pause');
    safeSend({ action: 'pauseSecondTab' }).then(function () {
      updateSyncStatus('Ambos pausados');
    });
  }

  function playAll() {
    ytCmd('play');
    safeSend({ action: 'playSecondTab' }).then(function () {
      updateSyncStatus('Ambos reproduciendo');
      // tras reanudar, forzar una corrección en cuanto arranquen
      setTimeout(function () { syncNow(true); }, 1500);
    });
  }

  // === PESTAÑA SECUNDARIA: aplicar correcciones ===

  async function handleSyncMessage(request) {
    var st = await ytGetState();

    // Compensar el tiempo de tránsito del mensaje (misma máquina, mismo reloj)
    var transit = 0;
    if (request.sentAt && request.isPlaying) {
      transit = (Date.now() - request.sentAt) / 1000;
      if (transit < 0 || transit > 2) transit = 0; // valor anómalo: ignorar
    }

    var target = request.currentTime + transit + (request.offsetMs || 0) / 1000;
    var driftMs = (st.t - target) * 1000; // >0: TV 2 va adelantado

    // Si esta pestaña tiene OTRO video (alguien navegó aquí), recargar el
    // video de la principal en lugar de hacer seek dentro del equivocado.
    if (request.videoId && st.videoId && request.videoId !== st.videoId) {
      ytCmd('loadVideo', { videoId: request.videoId, t: Math.max(0, target) });
      updateBannerStatus('Cargando el video de la principal…');
      lastSeekAt = Date.now();
      return { driftMs: driftMs, corrected: true, reloaded: true };
    }

    // Igualar estado de reproducción
    var secPlaying = isPlayingState(st.playerState);
    if (typeof request.isPlaying === 'boolean' && request.isPlaying !== secPlaying) {
      ytCmd(request.isPlaying ? 'play' : 'pause');
    }

    if (!request.force) {
      if (st.playerState === 3) {
        updateBannerStatus('Cargando…');
        return { driftMs: driftMs, corrected: false, skipped: 'buffering' };
      }
      if (Date.now() - lastSeekAt < SEEK_COOLDOWN_MS) {
        return { driftMs: driftMs, corrected: false, skipped: 'cooldown' };
      }
      if (Math.abs(driftMs) <= DRIFT_THRESHOLD_S * 1000) {
        updateBannerStatus('En sincronía (' + Math.round(Math.abs(driftMs)) + ' ms)');
        return { driftMs: driftMs, corrected: false };
      }
    }

    lastSeekAt = Date.now();
    ytCmd('seek', { t: Math.max(0, target) });
    updateBannerStatus('Corrigiendo ' + Math.round(Math.abs(driftMs)) + ' ms…');
    return { driftMs: driftMs, corrected: true };
  }

  // Avisar a la primaria cuando el reproductor de esta pestaña esté listo,
  // para que haga el primer sync preciso (la URL solo admite segundos enteros).
  async function announceSecondaryReady() {
    for (var i = 0; i < 30; i++) {
      var st = await ytGetState();
      if (st && st.videoId && st.duration > 0) break;
      await sleep(1000);
    }
    safeSend({ action: 'secondaryReady' });
  }

  // === MENSAJES DEL BACKGROUND ===
  chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    switch (request.action) {
      case 'syncTime': // (secundaria)
        handleSyncMessage(request).then(sendResponse);
        return true; // respuesta asíncrona

      case 'pause':
        ytCmd('pause');
        updateBannerStatus('Pausado');
        sendResponse({ success: true });
        break;

      case 'play':
        ytCmd('play');
        sendResponse({ success: true });
        break;

      case 'loadVideo': // (secundaria) la primaria cambió de video
        ytCmd('loadVideo', { videoId: request.videoId, t: request.currentTime || 0 });
        updateBannerStatus('Cargando nuevo video…');
        sendResponse({ success: true });
        break;

      case 'secondaryReady': // (primaria) el TV 2 ya tiene el reproductor listo
        activateSession('TV 2 lista — sincronizando…');
        syncNow(true);
        sendResponse({ success: true });
        break;

      case 'secondaryClosed': // (primaria)
        onSecondaryClosed();
        sendResponse({ success: true });
        break;

      case 'primaryClosed': // (secundaria)
        updateBannerStatus('La ventana principal se cerró');
        // La sesión terminó: esta pestaña deja de ser "secundaria" para
        // poder usarse como una pestaña normal (o como nueva primaria).
        try { sessionStorage.removeItem('dcSecondary'); } catch (e) {}
        isSecondaryTab = false;
        sendResponse({ success: true });
        break;
    }
  });

  // === UTILIDADES DE UI ===

  function setCastStatus(text, kind) {
    var chip = document.getElementById('dc-cast-chip');
    if (!chip) return;
    chip.textContent = text;
    chip.className = 'dc-chip' + (kind ? ' dc-chip-' + kind : '');
  }

  function updateSyncStatus(text) {
    var el = document.getElementById('dc-sync-status');
    if (el) el.textContent = text;
  }

  function updateBannerStatus(text) {
    var el = document.getElementById('dc-banner-status');
    if (el) el.textContent = text;
  }

  function showNotification(message) {
    var existing = document.querySelector('.dc-notification');
    if (existing) existing.remove();

    var notif = document.createElement('div');
    notif.className = 'dc-notification';
    notif.textContent = message;

    var panel = document.getElementById('dual-cast-panel');
    if (panel) {
      panel.querySelector('.dc-body').prepend(notif);
      setTimeout(function () { notif.remove(); }, 5000);
    }
  }

  // === PESTAÑA SECUNDARIA: banner ===
  function addSecondaryBanner() {
    if (document.getElementById('dc-secondary-banner')) return;
    var banner = document.createElement('div');
    banner.id = 'dc-secondary-banner';
    banner.innerHTML =
      '<span class="dc-banner-text">Ventana para <strong>TV 2</strong> — envía Cast a tu segundo TV</span>' +
      '<span class="dc-banner-chip" id="dc-banner-status">esperando sync</span>' +
      '<button id="dc-banner-cast" class="dc-cast-trigger">Elegir TV 2</button>' +
      '<button id="dc-banner-close">&times;</button>';
    document.body.prepend(banner);

    // El clic en .dc-cast-trigger lo maneja page-script.js (user gesture)
    document.getElementById('dc-banner-close').addEventListener('click', function () {
      banner.remove();
    });
  }

  // === INICIALIZAR ===
  function init() {
    ensureButton();
    if (isSecondaryTab) {
      setTimeout(addSecondaryBanner, 1500);
      announceSecondaryReady();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
