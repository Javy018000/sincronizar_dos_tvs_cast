// YouTube Dual Cast - Service Worker (Background)
// Maneja la comunicación entre pestañas y la gestión de sesiones
//
// IMPORTANTE: En Manifest V3, el service worker puede reiniciarse en cualquier
// momento y las variables en memoria se pierden. Por eso usamos
// chrome.storage.session para persistir los IDs de las pestañas.

let secondTabId = null;
let primaryTabId = null;

// Restaurar IDs al iniciar (por si el service worker se reinició)
chrome.storage.session.get(['secondTabId', 'primaryTabId'], (result) => {
  if (result.secondTabId) secondTabId = result.secondTabId;
  if (result.primaryTabId) primaryTabId = result.primaryTabId;
  console.log('DualCast bg: iniciado, tabs:', { primaryTabId, secondTabId });
});

function saveTabs() {
  chrome.storage.session.set({ secondTabId, primaryTabId });
}

// === ENVIAR MENSAJE A LA PESTAÑA SECUNDARIA (con reintentos) ===
function sendToSecondTab(message) {
  if (!secondTabId) {
    console.log('DualCast bg: no hay pestaña secundaria');
    return;
  }

  console.log('DualCast bg: enviando a tab', secondTabId, ':', message.action);

  chrome.tabs.sendMessage(secondTabId, message)
    .then(() => {
      console.log('DualCast bg: mensaje entregado a tab', secondTabId);
    })
    .catch((err) => {
      console.warn('DualCast bg: falló envío a tab', secondTabId, ':', err.message);
      // NO borrar secondTabId en el primer error - la pestaña puede seguir ahí
      // Solo verificar si la pestaña aún existe
      chrome.tabs.get(secondTabId).catch(() => {
        console.log('DualCast bg: tab', secondTabId, 'ya no existe, limpiando');
        secondTabId = null;
        saveTabs();
      });
    });
}

// === ESCUCHAR MENSAJES DE LOS CONTENT SCRIPTS ===
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('DualCast bg: recibido:', request.action, 'de tab', sender.tab?.id);

  switch (request.action) {

    // --- Abrir segunda pestaña con el mismo video ---
    case 'openSecondTab':
      primaryTabId = sender.tab.id;
      openSecondTab(request.videoId, request.currentTime)
        .then(tab => {
          secondTabId = tab.id;
          saveTabs();
          console.log('DualCast bg: segunda pestaña abierta, id:', tab.id);
          sendResponse({ success: true, tabId: tab.id });
        })
        .catch(err => {
          console.error('DualCast bg: error abriendo segunda pestaña:', err);
          sendResponse({ success: false, error: err.message });
        });
      return true; // Respuesta asíncrona

    // --- Sincronizar tiempo entre pestañas ---
    case 'syncTime':
      sendToSecondTab({ action: 'syncTime', currentTime: request.currentTime });
      sendResponse({ success: true });
      break;

    // --- Pausar pestaña secundaria ---
    case 'pauseSecondTab':
      sendToSecondTab({ action: 'pause' });
      sendResponse({ success: true });
      break;

    // --- Reproducir pestaña secundaria ---
    case 'playSecondTab':
      sendToSecondTab({ action: 'play' });
      sendResponse({ success: true });
      break;

    // --- Obtener estado actual ---
    case 'getStatus':
      sendResponse({
        primaryTabId: primaryTabId,
        secondTabId: secondTabId,
        active: primaryTabId !== null && secondTabId !== null
      });
      break;
  }
});

// === ABRIR SEGUNDA PESTAÑA ===
async function openSecondTab(videoId, currentTime) {
  const url = `https://www.youtube.com/watch?v=${videoId}&t=${currentTime}s&dualcast_secondary=1`;

  const tab = await chrome.tabs.create({
    url: url,
    active: true
  });

  return tab;
}

// === LIMPIAR CUANDO SE CIERRA UNA PESTAÑA ===
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === secondTabId) {
    console.log('DualCast bg: pestaña secundaria cerrada');
    secondTabId = null;
    saveTabs();
  }
  if (tabId === primaryTabId) {
    console.log('DualCast bg: pestaña principal cerrada');
    primaryTabId = null;
    secondTabId = null;
    saveTabs();
  }
});
