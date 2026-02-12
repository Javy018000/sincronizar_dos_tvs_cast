// YouTube Dual Cast - Service Worker (Background)
// Maneja la comunicación entre pestañas y la gestión de sesiones

let secondTabId = null;
let primaryTabId = null;

// === ESCUCHAR MENSAJES DE LOS CONTENT SCRIPTS ===
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {

    // --- Abrir segunda pestaña con el mismo video ---
    case 'openSecondTab':
      primaryTabId = sender.tab.id;
      openSecondTab(request.videoId, request.currentTime)
        .then(tab => {
          secondTabId = tab.id;
          sendResponse({ success: true, tabId: tab.id });
        })
        .catch(err => {
          sendResponse({ success: false, error: err.message });
        });
      return true; // Respuesta asíncrona

    // --- Sincronizar tiempo entre pestañas ---
    case 'syncTime':
      if (secondTabId) {
        chrome.tabs.sendMessage(secondTabId, {
          action: 'syncTime',
          currentTime: request.currentTime
        }).catch(() => {
          // La pestaña secundaria puede haberse cerrado
          secondTabId = null;
        });
      }
      sendResponse({ success: true });
      break;

    // --- Pausar pestaña secundaria ---
    case 'pauseSecondTab':
      if (secondTabId) {
        chrome.tabs.sendMessage(secondTabId, { action: 'pause' }).catch(() => {
          secondTabId = null;
        });
      }
      sendResponse({ success: true });
      break;

    // --- Reproducir pestaña secundaria ---
    case 'playSecondTab':
      if (secondTabId) {
        chrome.tabs.sendMessage(secondTabId, { action: 'play' }).catch(() => {
          secondTabId = null;
        });
      }
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
  // Construir URL con el tiempo actual y marcador de pestaña secundaria
  const url = `https://www.youtube.com/watch?v=${videoId}&t=${currentTime}s&dualcast_secondary=1`;

  const tab = await chrome.tabs.create({
    url: url,
    active: true // Activar para que el usuario pueda hacer Cast
  });

  return tab;
}

// === LIMPIAR CUANDO SE CIERRA UNA PESTAÑA ===
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === secondTabId) {
    secondTabId = null;
  }
  if (tabId === primaryTabId) {
    primaryTabId = null;
    // Si se cierra la principal, la secundaria ya no tiene sentido trackear
    secondTabId = null;
  }
});
