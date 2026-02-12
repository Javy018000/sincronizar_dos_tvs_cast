// YouTube Dual Cast - Page Script (MAIN world)
// Este script corre en el contexto de la PÁGINA (no del content script),
// por lo que tiene acceso a:
//   - chrome.cast (Cast SDK de YouTube) → para abrir el picker de Cast
//   - cast.framework (CAF SDK) → versión moderna del Cast SDK
//   - document.getElementById('movie_player').pauseVideo() etc → Player API de YouTube
//
// Se comunica con content.js via window.postMessage.

(function () {
  'use strict';

  console.log('DualCast page-script: cargado en MAIN world');

  // === CAST: Abrir el picker de dispositivos ===
  function tryCast() {
    // Intento 1: CAF SDK v3 (Cast Application Framework - versión moderna)
    try {
      if (window.cast && cast.framework && cast.framework.CastContext) {
        var ctx = cast.framework.CastContext.getInstance();
        if (ctx) {
          console.log('DualCast page-script: intentando CAF requestSession...');
          ctx.requestSession().then(function () {
            console.log('DualCast page-script: CAF session started');
            notify('castSuccess');
          }).catch(function (err) {
            console.log('DualCast page-script: CAF session error:', err);
            notify('castError', { detail: String(err) });
          });
          return true;
        }
      }
    } catch (e) {
      console.log('DualCast page-script: CAF no disponible:', e.message);
    }

    // Intento 2: Cast SDK v2 (legacy)
    try {
      if (typeof chrome !== 'undefined' && chrome.cast && chrome.cast.isAvailable) {
        console.log('DualCast page-script: intentando chrome.cast.requestSession...');
        chrome.cast.requestSession(
          function (session) {
            console.log('DualCast page-script: Cast v2 session started');
            notify('castSuccess');
          },
          function (err) {
            console.log('DualCast page-script: Cast v2 session error:', err);
            notify('castError', { detail: err ? err.code : 'unknown' });
          }
        );
        return true;
      }
    } catch (e) {
      console.log('DualCast page-script: Cast v2 no disponible:', e.message);
    }

    console.log('DualCast page-script: ningun Cast SDK disponible');
    notify('castUnavailable');
    return false;
  }

  // === CLICK: Escuchar clics en los botones de Cast ===
  // Usamos event delegation en document para capturar clics sin importar
  // cuándo se creen los botones. Esto preserva el user gesture necesario
  // para chrome.cast.requestSession().
  document.addEventListener('click', function (e) {
    var target = e.target.closest('#dc-cast-tv1, #dc-banner-cast');
    if (target) {
      console.log('DualCast page-script: clic en botón de cast:', target.id);
      tryCast();
    }
  }, true);

  // === PLAYER API: Controlar el reproductor de YouTube ===
  // Escuchamos comandos del content script via postMessage.
  // Usamos player.pauseVideo(), player.playVideo(), player.seekTo() que
  // SÍ funcionan durante Cast activo (a diferencia de video.pause() etc).
  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data || e.data.from !== 'dc-content') return;

    var p = document.getElementById('movie_player');
    if (!p) {
      console.log('DualCast page-script: movie_player no encontrado');
      return;
    }

    console.log('DualCast page-script: comando recibido:', e.data.cmd);

    switch (e.data.cmd) {
      case 'pause':
        if (p.pauseVideo) {
          p.pauseVideo();
          console.log('DualCast page-script: pausado');
        }
        break;

      case 'play':
        if (p.playVideo) {
          p.playVideo();
          console.log('DualCast page-script: reproduciendo');
        }
        break;

      case 'seek':
        if (p.seekTo) {
          p.seekTo(e.data.t, true);
          console.log('DualCast page-script: seek a', e.data.t);
        }
        break;

      case 'getTime':
        var t = p.getCurrentTime ? p.getCurrentTime() : 0;
        window.postMessage({ from: 'dc-page', cmd: 'time', t: t }, '*');
        break;

      case 'diagnoseCast':
        // Diagnóstico: qué Cast SDKs están disponibles
        var info = {
          castFramework: !!(window.cast && cast.framework),
          chromeCast: !!(typeof chrome !== 'undefined' && chrome.cast),
          chromeCastAvailable: !!(typeof chrome !== 'undefined' && chrome.cast && chrome.cast.isAvailable),
          playerExists: !!p,
          playerHasPause: !!(p && p.pauseVideo),
          playerHasPlay: !!(p && p.playVideo),
          playerHasSeek: !!(p && p.seekTo),
          playerHasGetTime: !!(p && p.getCurrentTime),
        };
        console.log('DualCast page-script: diagnóstico:', info);
        window.postMessage({ from: 'dc-page', cmd: 'diagnosis', info: info }, '*');
        break;
    }
  });

  // === UTILIDAD: enviar notificaciones al content script ===
  function notify(event, data) {
    window.postMessage({
      from: 'dc-page',
      cmd: 'castEvent',
      event: event,
      ...(data || {})
    }, '*');
  }
})();
