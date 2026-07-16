// YouTube Dual Cast - Content Script (v3)
// Se inyecta en YouTube. Maneja la UI (botón, panel, banner) y la sincronización.
// Se comunica con page-script.js (MAIN world) via postMessage para Cast y Player API.
// Se comunica con background.js via chrome.runtime para hablar con la otra pestaña.
//
// === MOTOR DE SINCRONIZACIÓN v3 ===
// El problema de v2: cada corrección era un seek, pero (a) la posición que
// reporta el reproductor durante un Cast es una ESTIMACIÓN ruidosa que se
// actualiza cada ~1 s, y (b) un seek en Chromecast aterriza con un error de
// cientos de ms. Resultado: el sistema perseguía ruido, corregía de más y
// rompía la sincronía que el usuario había logrado a oído.
//
// v3 lo arregla con cuatro ideas:
//   1. ESTADÍSTICA: la primaria envía muestras cada segundo; la secundaria
//      guarda una ventana deslizante y decide con la MEDIANA + una regresión
//      lineal (velocidad de deriva), nunca con una lectura suelta.
//   2. MODO LOCK: cuando está en sincronía, sube el umbral de ruptura
//      ("si ya suena bien, no lo toques"). Solo un desfase grande y
//      SOSTENIDO lo rompe.
//   3. APRENDIZAJE: tras cada seek mide dónde aterrizó de verdad y guarda el
//      sesgo promedio del TV (persistido); el siguiente seek lo compensa.
//   4. CORRECCIÓN SUAVE: desfases pequeños se corrigen acelerando/frenando
//      el TV 2 un momento (playbackRate), sin rebuffering ni corte de audio.
//      Si el TV no obedece cambios de velocidad, lo detecta y vuelve a seeks.

(function () {
  'use strict';

  // --- Cadencia y ventana de medición ---
  var SAMPLE_INTERVAL_MS = 1000;   // la primaria envía una muestra por segundo
  var WINDOW_MAX_SAMPLES = 12;     // tamaño máximo de la ventana deslizante
  var WINDOW_MAX_AGE_MS = 15000;   // descartar muestras más viejas que esto
  var MIN_SAMPLES = 5;             // mínimo de muestras para decidir
  var MIN_SPAN_MS = 4000;          // la ventana debe cubrir al menos este tiempo

  // --- Umbrales de corrección ---
  var THRESH_TRACK_MS = 400;       // umbral en modo tracking
  var THRESH_LOCK_MS = 700;        // umbral en modo lock (histéresis)
  var LOCK_ENTER_MS = 150;         // mediana bajo esto (sostenida) → entrar en lock
  var LOCK_MIN_SPAN_MS = 6000;     // estabilidad mínima para entrar en lock
  var VEL_TRIGGER_MS_S = 2;        // deriva sostenida (ms/s) → corrección predictiva
  var VEL_MIN_LEVEL_MS = 250;      // ...pero solo si la mediana ya pasa de esto

  // --- Actuadores ---
  var NUDGE_MAX_MS = 1200;         // hasta aquí se corrige con velocidad (suave)
  var NUDGE_RATE_UP = 1.25;        // TV 2 atrás → acelerar
  var NUDGE_RATE_DOWN = 0.75;      // TV 2 adelantado → frenar
  var NUDGE_MAX_DURATION_MS = 8000;
  var CORRECTION_GAP_MS = 8000;    // separación mínima entre correcciones
  var SETTLE_MS = 2500;            // ignorar muestras tras un seek/nudge

  // --- Offset manual (ajuste de audio a oído) ---
  var OFFSET_MIN = -3000;
  var OFFSET_MAX = 3000;
  var OFFSET_STEP = 25;
  var CALIBRATE_HOLD_MS = 2500;    // congelar correcciones tras tocar el slider

  var dualCastPanel = null;
  var autoSyncTimer = null;
  var sessionActive = false;
  var autoSyncOn = true;
  var offsetMs = 0;
  var offsetDebounce = null;
  var calibratingUntil = 0;        // (primaria) usuario ajustando a oído
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

  // === MOTOR DE SINCRONIZACIÓN (vive en la pestaña secundaria) ===
  var engine = {
    samples: [],            // {at, drift} — ventana deslizante en ms
    mode: 'tracking',       // 'tracking' | 'locked'
    seekBiasMs: 0,          // sesgo de aterrizaje del seek, aprendido (EMA)
    rateNudgeOk: null,      // null=desconocido, true/false=aprendido
    nudge: null,            // corrección por velocidad en curso
    pendingSeek: false,     // esperando medir dónde aterrizó el último seek
    pendingNudgeCheck: null,// esperando validar si el nudge funcionó
    settleUntil: 0,         // no muestrear hasta este instante
    lastCorrectionAt: 0
  };

  // === PREFERENCIAS PERSISTIDAS ===
  try {
    chrome.storage.local.get(
      ['dcOffsetMs', 'dcAutoSync', 'dcSeekBias', 'dcRateNudgeOk'],
      function (r) {
        if (chrome.runtime.lastError || !r) return;
        if (typeof r.dcOffsetMs === 'number') offsetMs = r.dcOffsetMs;
        if (typeof r.dcAutoSync === 'boolean') autoSyncOn = r.dcAutoSync;
        if (typeof r.dcSeekBias === 'number') engine.seekBiasMs = r.dcSeekBias;
        if (typeof r.dcRateNudgeOk === 'boolean') engine.rateNudgeOk = r.dcRateNudgeOk;
        refreshOffsetUI();
      }
    );
  } catch (e) {}

  function savePrefs() {
    try {
      chrome.storage.local.set({ dcOffsetMs: offsetMs, dcAutoSync: autoSyncOn });
    } catch (e) {}
  }

  function saveLearned() {
    try {
      chrome.storage.local.set({
        dcSeekBias: engine.seekBiasMs,
        dcRateNudgeOk: engine.rateNudgeOk
      });
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
          duration: v && !isNaN(v.duration) ? v.duration : 0,
          playbackRate: v ? v.playbackRate : 1
        });
      }, 500);
      ytCmd('getState', { reqId: reqId });
    });
  }

  function isPlayingState(playerState) {
    return playerState === 1 || playerState === 3; // playing o buffering
  }

  // === ESTADÍSTICA DE LA VENTANA ===

  function median(values) {
    if (!values.length) return 0;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // Pendiente (ms de drift por segundo) por mínimos cuadrados.
  function slopeMsPerSec(samples) {
    var n = samples.length;
    if (n < 3) return 0;
    var t0 = samples[0].at;
    var sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var i = 0; i < n; i++) {
      var x = (samples[i].at - t0) / 1000;
      var y = samples[i].drift;
      sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    var denom = n * sxx - sx * sx;
    if (Math.abs(denom) < 1e-6) return 0;
    return (n * sxy - sx * sy) / denom;
  }

  function pushSample(driftMs) {
    var now = Date.now();
    engine.samples.push({ at: now, drift: driftMs });
    while (engine.samples.length > WINDOW_MAX_SAMPLES) engine.samples.shift();
    while (engine.samples.length && now - engine.samples[0].at > WINDOW_MAX_AGE_MS) {
      engine.samples.shift();
    }
  }

  function resetWindow() {
    engine.samples = [];
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
        updateSyncStatus('Video cambiado — sincronizando TV 2…', 'info');
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
      updateSyncStatus(autoSyncOn ? 'Auto-sync activado' : 'Auto-sync desactivado', 'info');
    });

    // Slider de offset: se aplica EN VIVO (con debounce corto) para poder
    // ajustar a oído hasta que el sonido de los dos TVs coincida. Mientras
    // se calibra, el motor congela las correcciones automáticas.
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
      '      <label class="dc-toggle" title="Vigila el desfase en tiempo real y corrige solo cuando hace falta">' +
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
      '      <p class="dc-offset-tip">Si el TV 2 se oye con eco (retrasado), mueve hacia +. Si se adelanta, hacia &minus;. Mientras ajustas, el auto-sync espera.</p>' +
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
      updateSyncStatus('Ventana abierta — envía Cast al TV 2', 'info');
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
    if (statusText) updateSyncStatus(statusText, 'info');
    startAutoSync();
  }

  function onSecondaryClosed() {
    sessionActive = false;
    stopAutoSync();
    var btn = document.getElementById('dc-cast-tv2');
    if (btn) btn.textContent = 'Abrir ventana para TV 2';
    updateSyncStatus('La ventana del TV 2 se cerró', 'warn');
  }

  // === BUCLE DE MUESTREO (pestaña primaria) ===

  function startAutoSync() {
    stopAutoSync();
    if (isSecondaryTab || !sessionActive || !autoSyncOn) return;
    autoSyncTimer = setInterval(function () { syncNow(false); }, SAMPLE_INTERVAL_MS);
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
        playbackRate: st.playbackRate || 1,
        calibrating: Date.now() < calibratingUntil,
        force: !!force
      });

      if (!response) return;
      if (!response.success) {
        if (response.error === 'secondary-closed') onSecondaryClosed();
        return;
      }
      if (response.report) displayReport(response.report);
    } finally {
      syncInFlight = false;
    }
  }

  function fmtMs(x) {
    var v = Math.round(x);
    return (v > 0 ? '+' : '') + v + ' ms';
  }

  function displayReport(rep) {
    var text = '';
    var kind = 'info';
    switch (rep.action) {
      case 'measuring':
        text = 'Midiendo… (' + (rep.samples || 0) + '/' + MIN_SAMPLES + ' muestras)';
        kind = 'warn';
        break;
      case 'none':
        if (rep.mode === 'locked') {
          text = 'Estable · drift ' + fmtMs(rep.driftMs) + ' · deriva ' + fmtMs(rep.velMsMin) + '/min';
          kind = 'ok';
        } else {
          text = 'En sincronía · drift ' + fmtMs(rep.driftMs);
          kind = 'ok';
        }
        break;
      case 'seek':
        text = rep.forced
          ? 'Sincronizado (seek manual)'
          : 'Desfase de ' + fmtMs(rep.correctedMs) + ' corregido con salto';
        kind = 'info';
        break;
      case 'nudge':
        text = 'Corrigiendo ' + fmtMs(rep.correctedMs) + ' con velocidad (suave)';
        kind = 'info';
        break;
      case 'nudging':
        text = 'Ajuste suave en curso…';
        kind = 'info';
        break;
      case 'settling':
        text = 'Esperando a que el TV 2 se asiente…';
        kind = 'warn';
        break;
      case 'buffering':
        text = 'TV 2 cargando…';
        kind = 'warn';
        break;
      case 'calibrating':
        text = 'Calibrando a oído — correcciones en pausa';
        kind = 'warn';
        break;
      case 'state-sync':
        text = 'Igualando play/pausa…';
        kind = 'info';
        break;
      case 'rate-sync':
        text = 'Igualando velocidad de reproducción…';
        kind = 'info';
        break;
      case 'reload':
        text = 'Cargando el video en el TV 2…';
        kind = 'info';
        break;
      default:
        return;
    }
    if (offsetMs !== 0) {
      text += ' · offset ' + (offsetMs > 0 ? '+' : '') + offsetMs + ' ms';
    }
    updateSyncStatus(text, kind);
  }

  function setOffset(ms) {
    offsetMs = Math.max(OFFSET_MIN, Math.min(OFFSET_MAX, ms));
    refreshOffsetUI();
    savePrefs();
    // Congelar correcciones automáticas mientras se calibra a oído
    calibratingUntil = Date.now() + CALIBRATE_HOLD_MS;
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
      updateSyncStatus('Ambos pausados', 'info');
    });
  }

  function playAll() {
    ytCmd('play');
    safeSend({ action: 'playSecondTab' }).then(function () {
      updateSyncStatus('Ambos reproduciendo', 'info');
      // tras reanudar, forzar una corrección en cuanto arranquen
      setTimeout(function () { syncNow(true); }, 1500);
    });
  }

  // === PESTAÑA SECUNDARIA: motor de decisión ===

  function uiFields(med, vel, instant) {
    return {
      driftMs: med,
      instantMs: instant,
      velMsMin: vel * 60,
      mode: engine.mode,
      samples: engine.samples.length
    };
  }

  function doSeek(target) {
    // Compensar el sesgo de aterrizaje aprendido: si este TV suele quedar
    // atrás tras un seek (bias negativo), apuntamos un poco por delante.
    var adjusted = Math.max(0, target - engine.seekBiasMs / 1000);
    ytCmd('seek', { t: adjusted });
    engine.lastCorrectionAt = Date.now();
    engine.settleUntil = Date.now() + SETTLE_MS;
    engine.pendingSeek = true;
    resetWindow();
  }

  function startRateNudge(medMs) {
    var rate = medMs < 0 ? NUDGE_RATE_UP : NUDGE_RATE_DOWN;
    // A ±0.25x se recuperan 250 ms por segundo de reproducción
    var durationMs = Math.min(NUDGE_MAX_DURATION_MS, Math.abs(medMs) * 4);
    engine.nudge = { rate: rate, medBefore: medMs };
    engine.lastCorrectionAt = Date.now();
    ytCmd('setRate', { rate: rate });
    updateBannerStatus('Ajuste suave en curso…');
    setTimeout(endRateNudge, durationMs);
  }

  async function endRateNudge() {
    if (!engine.nudge) return;
    var nudge = engine.nudge;
    var st = await ytGetState();
    ytCmd('setRate', { rate: 1 });
    engine.nudge = null;
    engine.settleUntil = Date.now() + SETTLE_MS;
    resetWindow();

    // Detección rápida: si el reproductor nunca reflejó la velocidad pedida,
    // este TV no soporta cambios de velocidad durante el Cast → usar seeks.
    var applied = Math.abs((st.playbackRate || 1) - nudge.rate) < 0.01;
    if (!applied) {
      engine.rateNudgeOk = false;
      saveLearned();
      console.log('DualCast engine: el TV no obedece playbackRate; usando seeks');
      return;
    }
    // Validación decisiva: comparar el drift antes/después con muestras nuevas
    engine.pendingNudgeCheck = { medBefore: nudge.medBefore };
  }

  function cancelRateNudge() {
    if (engine.nudge) {
      ytCmd('setRate', { rate: 1 });
      engine.nudge = null;
      engine.settleUntil = Date.now() + SETTLE_MS;
      resetWindow();
    }
    engine.pendingNudgeCheck = null;
  }

  async function handleSyncMessage(request) {
    var st = await ytGetState();

    // Compensar el tiempo de tránsito del mensaje (misma máquina, mismo reloj)
    var transit = 0;
    if (request.sentAt && request.isPlaying) {
      transit = (Date.now() - request.sentAt) / 1000;
      if (transit < 0 || transit > 2) transit = 0; // valor anómalo: ignorar
    }

    var target = request.currentTime + transit + (request.offsetMs || 0) / 1000;
    var instant = (st.t - target) * 1000; // >0: TV 2 va adelantado

    // Si esta pestaña tiene OTRO video (alguien navegó aquí), recargar el
    // video de la principal en lugar de hacer seek dentro del equivocado.
    if (request.videoId && st.videoId && request.videoId !== st.videoId) {
      cancelRateNudge();
      ytCmd('loadVideo', { videoId: request.videoId, t: Math.max(0, target) });
      updateBannerStatus('Cargando el video de la principal…');
      engine.settleUntil = Date.now() + SETTLE_MS;
      engine.mode = 'tracking';
      resetWindow();
      return { action: 'reload', driftMs: instant };
    }

    // Sync manual u offset recién ajustado: corregir YA con seek compensado
    if (request.force) {
      cancelRateNudge();
      engine.mode = 'tracking';
      doSeek(target);
      updateBannerStatus('Sincronizando…');
      return { action: 'seek', driftMs: instant, forced: true };
    }

    // Usuario calibrando a oído: congelar todo, no acumular muestras viejas
    if (request.calibrating) {
      resetWindow();
      updateBannerStatus('Calibración en curso…');
      return { action: 'calibrating', driftMs: instant };
    }

    // Corrección suave en curso: las muestras durante el nudge no valen
    if (engine.nudge) {
      return Object.assign({ action: 'nudging' }, uiFields(instant, 0, instant));
    }

    // Igualar velocidad de reproducción (si el usuario ve a 1.5x en la
    // principal, el TV 2 debe ir a 1.5x o el desfase crece sin parar)
    var reqRate = request.playbackRate || 1;
    if (Math.abs((st.playbackRate || 1) - reqRate) > 0.01) {
      ytCmd('setRate', { rate: reqRate });
      engine.settleUntil = Date.now() + SETTLE_MS;
      resetWindow();
      updateBannerStatus('Igualando velocidad…');
      return { action: 'rate-sync', driftMs: instant };
    }

    // Igualar estado de reproducción antes de muestrear
    var secPlaying = isPlayingState(st.playerState);
    if (typeof request.isPlaying === 'boolean' && request.isPlaying !== secPlaying) {
      ytCmd(request.isPlaying ? 'play' : 'pause');
      engine.settleUntil = Date.now() + 1000;
      resetWindow();
      updateBannerStatus(request.isPlaying ? 'Reanudando…' : 'Pausando…');
      return { action: 'state-sync', driftMs: instant };
    }

    // Asentamiento tras seek/nudge, o TV 2 rebufferizando: no muestrear
    if (st.playerState === 3) {
      updateBannerStatus('Cargando…');
      return Object.assign({ action: 'buffering' }, uiFields(instant, 0, instant));
    }
    if (Date.now() < engine.settleUntil) {
      return Object.assign({ action: 'settling' }, uiFields(instant, 0, instant));
    }

    // --- Muestrear ---
    pushSample(instant);

    // Medir dónde aterrizó el último seek y aprender el sesgo (EMA)
    if (engine.pendingSeek && engine.samples.length >= 3) {
      var landing = median(engine.samples.map(function (s) { return s.drift; }));
      engine.seekBiasMs = Math.max(-1500, Math.min(1500,
        0.6 * engine.seekBiasMs + 0.4 * landing));
      engine.pendingSeek = false;
      saveLearned();
      console.log('DualCast engine: aterrizaje del seek', Math.round(landing),
        'ms → sesgo aprendido', Math.round(engine.seekBiasMs), 'ms');
    }

    // Validar si el último nudge de velocidad funcionó de verdad.
    // Zona gris entre 60% y 85%: sin veredicto (pudo ser ruido) — así una
    // sola medición mala no deshabilita los nudges para siempre.
    if (engine.pendingNudgeCheck && engine.samples.length >= 3) {
      var medAfter = median(engine.samples.map(function (s) { return s.drift; }));
      var before = Math.abs(engine.pendingNudgeCheck.medBefore);
      if (Math.abs(medAfter) < before * 0.6) {
        engine.rateNudgeOk = true;
        saveLearned();
      } else if (Math.abs(medAfter) > before * 0.85) {
        engine.rateNudgeOk = false;
        saveLearned();
      }
      engine.pendingNudgeCheck = null;
      console.log('DualCast engine: validación de nudge — antes',
        Math.round(before), 'ms, después', Math.round(medAfter),
        'ms → rateNudgeOk =', engine.rateNudgeOk);
    }

    // --- Estadística de la ventana ---
    var n = engine.samples.length;
    var span = n ? engine.samples[n - 1].at - engine.samples[0].at : 0;
    var med = median(engine.samples.map(function (s) { return s.drift; }));
    var vel = slopeMsPerSec(engine.samples);

    if (n < MIN_SAMPLES || span < MIN_SPAN_MS) {
      updateBannerStatus('Midiendo… (' + n + ')');
      return Object.assign({ action: 'measuring' }, uiFields(med, vel, instant));
    }

    // Entrar en modo lock: sincronía estable y sostenida
    if (engine.mode === 'tracking' && Math.abs(med) <= LOCK_ENTER_MS && span >= LOCK_MIN_SPAN_MS) {
      engine.mode = 'locked';
      console.log('DualCast engine: LOCK — sincronía estable, umbral elevado');
    }

    var thresh = engine.mode === 'locked' ? THRESH_LOCK_MS : THRESH_TRACK_MS;

    // Sostenido: las últimas 4 muestras con el mismo signo que la mediana
    // y magnitud relevante — una lectura ruidosa no dispara nada.
    var last4 = engine.samples.slice(-4);
    var sustained = last4.length === 4 && last4.every(function (s) {
      return (s.drift > 0) === (med > 0) && Math.abs(s.drift) > thresh * 0.5;
    });

    var overThreshold = Math.abs(med) > thresh && sustained;
    // Predictivo: deriva clara y sostenida en la misma dirección que el
    // desfase → corregir antes de que se haga notorio.
    var predictive = Math.abs(vel) > VEL_TRIGGER_MS_S &&
      Math.abs(med) > VEL_MIN_LEVEL_MS &&
      (vel > 0) === (med > 0) &&
      span >= LOCK_MIN_SPAN_MS;

    var needCorrection = overThreshold || predictive;

    if (!needCorrection || Date.now() - engine.lastCorrectionAt < CORRECTION_GAP_MS) {
      updateBannerStatus(
        (engine.mode === 'locked' ? 'Estable · ' : 'En sincronía · ') +
        Math.round(Math.abs(med)) + ' ms'
      );
      return Object.assign({ action: 'none' }, uiFields(med, vel, instant));
    }

    // --- Corregir ---
    engine.mode = 'tracking';
    var canNudge = engine.rateNudgeOk !== false &&
      Math.abs(med) <= NUDGE_MAX_MS &&
      reqRate === 1 &&
      request.isPlaying && secPlaying;

    if (canNudge) {
      startRateNudge(med);
      return Object.assign({ action: 'nudge', correctedMs: med }, uiFields(med, vel, instant));
    }

    doSeek(target);
    updateBannerStatus('Corrigiendo ' + Math.round(Math.abs(med)) + ' ms…');
    return Object.assign({ action: 'seek', correctedMs: med }, uiFields(med, vel, instant));
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
        handleSyncMessage(request).then(sendResponse, function (err) {
          sendResponse({ action: 'error', error: String((err && err.message) || err) });
        });
        return true; // respuesta asíncrona

      case 'pause':
        cancelRateNudge();
        ytCmd('pause');
        updateBannerStatus('Pausado');
        sendResponse({ success: true });
        break;

      case 'play':
        cancelRateNudge();
        ytCmd('play');
        sendResponse({ success: true });
        break;

      case 'loadVideo': // (secundaria) la primaria cambió de video
        cancelRateNudge();
        resetWindow();
        engine.mode = 'tracking';
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
        cancelRateNudge();
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

  function updateSyncStatus(text, kind) {
    var el = document.getElementById('dc-sync-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'dc-sync-status' + (kind ? ' dc-ss-' + kind : '');
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
