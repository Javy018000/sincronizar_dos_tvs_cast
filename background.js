// YouTube Dual Cast - Service Worker (Background)
// Maneja la comunicación entre pestañas y la gestión de sesiones.
//
// IMPORTANTE: En Manifest V3, el service worker puede reiniciarse en cualquier
// momento y las variables en memoria se pierden. Por eso usamos
// chrome.storage.session para persistir los IDs de las pestañas.

const state = { primaryTabId: null, secondTabId: null };

// Restaurar IDs al iniciar (por si el service worker se reinició).
// Todos los handlers esperan a esta promesa antes de tocar `state`.
const ready = chrome.storage.session
  .get(['primaryTabId', 'secondTabId'])
  .then((r) => {
    if (typeof r.primaryTabId === 'number') state.primaryTabId = r.primaryTabId;
    if (typeof r.secondTabId === 'number') state.secondTabId = r.secondTabId;
    console.log('DualCast bg: iniciado, tabs:', state);
  })
  .catch(() => {});

function saveTabs() {
  chrome.storage.session.set({
    primaryTabId: state.primaryTabId,
    secondTabId: state.secondTabId
  });
}

// === ENVIAR MENSAJE A UNA PESTAÑA (devuelve la respuesta o el motivo del fallo) ===
async function sendToTab(tabId, message) {
  if (!tabId) return { ok: false, reason: 'no-tab' };
  try {
    const res = await chrome.tabs.sendMessage(tabId, message);
    return { ok: true, res };
  } catch (err) {
    // No borrar el ID en el primer error: el content script puede estar
    // recargándose. Solo limpiar si la pestaña ya no existe.
    try {
      await chrome.tabs.get(tabId);
      console.warn('DualCast bg: tab', tabId, 'sin listener:', err.message);
      return { ok: false, reason: 'no-listener' };
    } catch (e) {
      console.log('DualCast bg: tab', tabId, 'ya no existe');
      return { ok: false, reason: 'gone' };
    }
  }
}

async function sendToSecondTab(message) {
  const r = await sendToTab(state.secondTabId, message);
  if (!r.ok && r.reason === 'gone') {
    state.secondTabId = null;
    saveTabs();
    if (state.primaryTabId) sendToTab(state.primaryTabId, { action: 'secondaryClosed' });
  }
  return r;
}

// === ESCUCHAR MENSAJES DE CONTENT SCRIPTS Y POPUP ===
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ success: false, error: String((err && err.message) || err) }));
  return true; // respuesta asíncrona siempre
});

async function handleMessage(request, sender) {
  await ready;
  const tabId = sender.tab ? sender.tab.id : null;
  console.log('DualCast bg: recibido:', request.action, 'de tab', tabId);

  switch (request.action) {

    // --- Abrir segunda pestaña con el mismo video ---
    case 'openSecondTab': {
      state.primaryTabId = tabId;
      // Si ya había una pestaña secundaria, cerrarla para no dejar huérfanas.
      // Se desregistra ANTES de cerrarla para que onRemoved no dispare
      // un 'secondaryClosed' espurio hacia la primaria.
      if (state.secondTabId) {
        const oldTabId = state.secondTabId;
        state.secondTabId = null;
        saveTabs();
        try { await chrome.tabs.remove(oldTabId); } catch (e) {}
      }
      const t = Math.max(0, Math.floor(request.currentTime || 0));
      const url = `https://www.youtube.com/watch?v=${request.videoId}&t=${t}s&dualcast_secondary=1`;
      const tab = await chrome.tabs.create({ url, active: true });
      state.secondTabId = tab.id;
      saveTabs();
      console.log('DualCast bg: segunda pestaña abierta, id:', tab.id);
      return { success: true, tabId: tab.id };
    }

    // --- La pestaña secundaria terminó de cargar su reproductor ---
    case 'secondaryReady': {
      // Re-registrar por si el service worker perdió el mapeo
      if (tabId) {
        state.secondTabId = tabId;
        saveTabs();
      }
      if (state.primaryTabId) {
        await sendToTab(state.primaryTabId, { action: 'secondaryReady' });
      }
      return { success: true };
    }

    // --- Sincronizar tiempo/estado entre pestañas ---
    // Devuelve el reporte de drift que calcula la secundaria.
    case 'syncTime': {
      if (tabId) {
        state.primaryTabId = tabId; // quien sincroniza es la primaria
        saveTabs();
      }
      const r = await sendToSecondTab({
        action: 'syncTime',
        currentTime: request.currentTime,
        sentAt: request.sentAt,
        offsetMs: request.offsetMs || 0,
        isPlaying: request.isPlaying,
        videoId: request.videoId,
        playbackRate: request.playbackRate || 1,
        calibrating: !!request.calibrating,
        force: !!request.force
      });
      if (r.ok) return { success: true, report: r.res };
      return { success: false, error: r.reason === 'gone' ? 'secondary-closed' : r.reason };
    }

    // --- La primaria cambió de video: cargar el mismo en la secundaria ---
    case 'videoChanged': {
      const r = await sendToSecondTab({
        action: 'loadVideo',
        videoId: request.videoId,
        currentTime: request.currentTime || 0
      });
      return { success: r.ok, error: r.ok ? undefined : r.reason };
    }

    // --- Pausar / reproducir pestaña secundaria ---
    case 'pauseSecondTab': {
      const r = await sendToSecondTab({ action: 'pause' });
      return { success: r.ok };
    }
    case 'playSecondTab': {
      const r = await sendToSecondTab({ action: 'play' });
      return { success: r.ok };
    }

    // --- Obtener estado actual (lo usan el panel y el popup) ---
    case 'getStatus':
      return {
        primaryTabId: state.primaryTabId,
        secondTabId: state.secondTabId,
        active: state.primaryTabId !== null && state.secondTabId !== null,
        isPrimary: tabId !== null && tabId === state.primaryTabId,
        isSecondary: tabId !== null && tabId === state.secondTabId
      };
  }

  return { success: false, error: 'unknown-action' };
}

// === LIMPIAR CUANDO SE CIERRA UNA PESTAÑA ===
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  if (tabId === state.secondTabId) {
    console.log('DualCast bg: pestaña secundaria cerrada');
    state.secondTabId = null;
    saveTabs();
    if (state.primaryTabId) sendToTab(state.primaryTabId, { action: 'secondaryClosed' });
  }
  if (tabId === state.primaryTabId) {
    console.log('DualCast bg: pestaña principal cerrada');
    state.primaryTabId = null;
    if (state.secondTabId) sendToTab(state.secondTabId, { action: 'primaryClosed' });
    state.secondTabId = null;
    saveTabs();
  }
});
