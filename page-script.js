// YouTube Dual Cast - Page Script (MAIN world)
// Este script corre en el contexto de la PÁGINA (no del content script),
// por lo que tiene acceso a:
//   - el botón nativo de Cast del reproductor (.ytp-remote-button)
//   - chrome.cast (Cast SDK v2) y cast.framework (CAF SDK v3)
//   - la Player API de YouTube (#movie_player: seekTo, getCurrentTime, etc.),
//     que SÍ funciona durante un Cast activo (a diferencia del <video> local).
//
// Se comunica con content.js via window.postMessage.

(function () {
  'use strict';

  console.log('DualCast page-script: cargado en MAIN world');

  function $player() {
    return document.getElementById('movie_player');
  }

  // === UTILIDAD: enviar eventos de Cast al content script ===
  function notify(event, data) {
    window.postMessage(Object.assign(
      { from: 'dc-page', cmd: 'castEvent', event: event },
      data || {}
    ), '*');
  }

  // === CAST: abrir el selector de dispositivos ===
  // Orden de intentos (del más fiable al menos):
  //   1. Clic en el botón nativo de Cast de YouTube → abre el picker propio
  //      de YouTube, que siempre lista los dispositivos que Chrome detecta.
  //   2. CAF SDK v3 (cast.framework)
  //   3. Cast SDK v2 (chrome.cast)
  function tryCast() {
    // Intento 1: botón nativo del reproductor
    try {
      var nativeBtn = document.querySelector('button.ytp-remote-button');
      if (nativeBtn && nativeBtn.offsetParent !== null && !nativeBtn.disabled) {
        console.log('DualCast page-script: usando botón nativo de Cast');
        nativeBtn.click();
        notify('pickerOpened', { method: 'native' });
        return;
      }
    } catch (e) {
      console.log('DualCast page-script: botón nativo falló:', e.message);
    }

    // Intento 2: CAF SDK v3 (Cast Application Framework)
    try {
      if (window.cast && cast.framework && cast.framework.CastContext) {
        var ctx = cast.framework.CastContext.getInstance();
        if (ctx) {
          console.log('DualCast page-script: intentando CAF requestSession...');
          notify('pickerOpened', { method: 'caf' });
          ctx.requestSession().then(function () {
            var device = '';
            try {
              var s = ctx.getCurrentSession();
              device = (s && s.getCastDevice().friendlyName) || '';
            } catch (e2) {}
            console.log('DualCast page-script: CAF session started', device);
            notify('castSuccess', { device: device });
          }).catch(function (err) {
            console.log('DualCast page-script: CAF session error:', err);
            notify('castError', { detail: String(err) });
          });
          return;
        }
      }
    } catch (e) {
      console.log('DualCast page-script: CAF no disponible:', e.message);
    }

    // Intento 3: Cast SDK v2 (legacy)
    try {
      if (typeof chrome !== 'undefined' && chrome.cast && chrome.cast.isAvailable) {
        console.log('DualCast page-script: intentando chrome.cast.requestSession...');
        notify('pickerOpened', { method: 'v2' });
        chrome.cast.requestSession(
          function (session) {
            var device = '';
            try { device = (session.receiver && session.receiver.friendlyName) || ''; } catch (e2) {}
            console.log('DualCast page-script: Cast v2 session started', device);
            notify('castSuccess', { device: device });
          },
          function (err) {
            console.log('DualCast page-script: Cast v2 session error:', err);
            notify('castError', { detail: err ? err.code : 'unknown' });
          }
        );
        return;
      }
    } catch (e) {
      console.log('DualCast page-script: Cast v2 no disponible:', e.message);
    }

    console.log('DualCast page-script: ningún método de Cast disponible');
    notify('castUnavailable');
  }

  // === CAST: monitor del estado de la sesión (conexión/desconexión) ===
  // El CAF SDK carga tarde en YouTube; reintentamos unas cuantas veces.
  var monitorAttached = false;
  function attachCastMonitor() {
    if (monitorAttached) return true;
    try {
      if (window.cast && cast.framework &&
          cast.framework.CastContext && cast.framework.CastContextEventType) {
        var ctx = cast.framework.CastContext.getInstance();
        ctx.addEventListener(
          cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
          function (ev) {
            try {
              var S = cast.framework.SessionState;
              var device = '';
              try {
                device = (ev.session && ev.session.getCastDevice().friendlyName) || '';
              } catch (e2) {}
              if (ev.sessionState === S.SESSION_STARTED || ev.sessionState === S.SESSION_RESUMED) {
                notify('castState', { connected: true, device: device });
              } else if (ev.sessionState === S.SESSION_ENDED) {
                notify('castState', { connected: false });
              }
            } catch (e3) {}
          }
        );
        monitorAttached = true;
        console.log('DualCast page-script: monitor de sesión Cast activo');
        return true;
      }
    } catch (e) {}
    return false;
  }

  var monitorAttempts = 0;
  var monitorTimer = setInterval(function () {
    if (attachCastMonitor() || ++monitorAttempts >= 20) clearInterval(monitorTimer);
  }, 1500);

  // === CLICK: escuchar clics en los botones de Cast de la extensión ===
  // Delegación en document para capturar clics sin importar cuándo se creen
  // los botones. Esto preserva el user gesture necesario para requestSession().
  document.addEventListener('click', function (e) {
    var target = e.target.closest ? e.target.closest('.dc-cast-trigger') : null;
    if (target) {
      console.log('DualCast page-script: clic en botón de cast:', target.id);
      tryCast();
    }
  }, true);

  // === PLAYER API: controlar el reproductor de YouTube ===
  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data || e.data.from !== 'dc-content') return;

    var p = $player();
    switch (e.data.cmd) {
      case 'pause':
        try { if (p && p.pauseVideo) p.pauseVideo(); } catch (err) {}
        break;

      case 'play':
        try { if (p && p.playVideo) p.playVideo(); } catch (err) {}
        break;

      case 'seek':
        try {
          if (p && p.seekTo) {
            p.seekTo(Math.max(0, e.data.t), true);
            console.log('DualCast page-script: seek a', e.data.t);
          }
        } catch (err) {}
        break;

      case 'loadVideo':
        try {
          if (p && p.loadVideoById) {
            p.loadVideoById(e.data.videoId, e.data.t || 0);
            console.log('DualCast page-script: cargando video', e.data.videoId);
          }
        } catch (err) {}
        break;

      // Estado completo del reproductor (con reqId para emparejar respuestas)
      case 'getState': {
        var st = { t: 0, playerState: -1, videoId: null, duration: 0 };
        try {
          if (p) {
            if (p.getCurrentTime) st.t = p.getCurrentTime();
            if (p.getPlayerState) st.playerState = p.getPlayerState();
            if (p.getDuration) st.duration = p.getDuration();
            if (p.getVideoData) st.videoId = (p.getVideoData() || {}).video_id || null;
          }
        } catch (err) {}
        window.postMessage({ from: 'dc-page', cmd: 'state', reqId: e.data.reqId, state: st }, '*');
        break;
      }

      case 'castRequest':
        tryCast();
        break;

      case 'diagnoseCast': {
        var info = {
          nativeCastButton: !!document.querySelector('button.ytp-remote-button'),
          castFramework: !!(window.cast && cast.framework),
          chromeCast: !!(typeof chrome !== 'undefined' && chrome.cast),
          chromeCastAvailable: !!(typeof chrome !== 'undefined' && chrome.cast && chrome.cast.isAvailable),
          castMonitor: monitorAttached,
          playerExists: !!p,
          playerHasSeek: !!(p && p.seekTo),
          playerHasGetTime: !!(p && p.getCurrentTime)
        };
        console.log('DualCast page-script: diagnóstico:', info);
        window.postMessage({ from: 'dc-page', cmd: 'diagnosis', info: info }, '*');
        break;
      }
    }
  });
})();
