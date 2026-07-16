# YouTube Dual Cast

Extensión de Chrome para transmitir un mismo video de YouTube a **dos TVs a la vez**, con sincronización automática y ajuste de audio para televisores con distinta latencia (WiFi, señal o redes diferentes).

---

## ¿Qué problema resuelve?

Chrome solo permite castear una pestaña a **un** dispositivo. Esta extensión abre una segunda pestaña sincronizada para que puedas enviar el mismo video a un segundo TV, y mantiene ambas reproducciones alineadas.

El reto real es el **audio**: dos TVs casi nunca reciben el stream con la misma latencia, así que aunque el tiempo del video coincida, el sonido llega con eco. Como esa latencia **no se puede medir por software**, la extensión incluye un ajuste manual *a oído* que se aplica en vivo y se guarda para la próxima vez.

---

## Instalación (modo desarrollador)

1. Descarga o clona este repositorio.
2. Abre `chrome://extensions` en Chrome (o Edge/Brave).
3. Activa el **Modo de desarrollador** (arriba a la derecha).
4. Pulsa **Cargar descomprimida** y selecciona la carpeta del proyecto.
5. Listo: aparecerá el icono de la extensión en la barra.

> Requiere Chrome con soporte de Cast/Chromecast y ambos TVs visibles en tu red.

---

## Cómo usar

1. Abre un video en **YouTube**.
2. Pulsa el botón con **dos TVs** en los controles del reproductor (abajo a la derecha).
3. En el panel:
   - **Paso 1 — TV 1:** pulsa *Elegir TV 1* y selecciona tu primer televisor.
   - **Paso 2 — TV 2:** pulsa *Abrir ventana para TV 2*. Se abre una nueva pestaña con el mismo video; desde ahí envía Cast a tu segundo televisor.
4. Cuando ambos estén conectados, aparece la sección de **Sincronización**.

### Sincronización

- **Auto-sync inteligente** (activado por defecto): vigila el desfase en tiempo real (una muestra por segundo) y **solo corrige cuando hace falta de verdad** — decide con estadística, no con lecturas sueltas. Puedes desactivarlo con el interruptor *auto*.
- **Modo estable (lock):** cuando la sincronía es buena, el sistema la protege — sube el umbral de corrección para no romper lo que ya suena bien.
- **Sincronizar ahora / Pausar ambos / Reproducir ambos:** control manual inmediato.

### Ajuste de audio (lo importante)

Si el video va sincronizado pero el **sonido no coincide**, usa el slider **Ajuste de audio TV 2**:

- Si el **TV 2 se oye con eco** (va detrás) → mueve hacia **+**.
- Si el **TV 2 se adelanta** → mueve hacia **−**.
- El cambio se aplica **al instante** mientras mueves el slider: ajusta a oído hasta que suenen a la vez.
- Usa los botones `±25` / `±100` para el ajuste fino.
- El valor se **guarda automáticamente** para tu próxima sesión.

---

## Características

- ✅ Cast de un video a dos TVs desde una sola pestaña de origen.
- 🧠 **Sync inteligente**: decide con la mediana de una ventana de muestras y la velocidad de deriva (regresión lineal), nunca con una lectura suelta.
- 🔒 **Modo estable con histéresis**: si ya suena bien, no lo toca — solo un desfase grande y sostenido rompe el lock.
- 📚 **Aprende de tus TVs**: mide dónde aterriza cada seek y compensa el sesgo en el siguiente (se guarda entre sesiones).
- 🌊 **Corrección suave**: desfases pequeños se corrigen acelerando/frenando un instante el TV 2 (sin rebuffering ni corte de audio), con detección automática de si el TV lo soporta.
- 🔊 Ajuste de audio en vivo y persistente para TVs con distinta latencia; mientras calibras a oído, las correcciones automáticas se congelan.
- ⏩ Sincroniza también la velocidad de reproducción (si ves a 1.5x, el TV 2 va a 1.5x).
- 📺 Detección de Cast en cascada: botón nativo de YouTube → CAF SDK → Cast SDK v2.
- 🟢 Estado en tiempo real: TV conectado, desfase actual y deriva en ms/min.
- 🎬 Si cambias de video en la pestaña principal, el TV 2 carga el mismo video solo.
- ♻️ Recuperación ante cierres de pestaña, recargas y reinicios del service worker.

---

## Cómo funciona (arquitectura)

| Archivo | Rol |
|---|---|
| `manifest.json` | Manifest V3. Declara permisos (`tabs`, `storage`) y los content scripts. |
| `content.js` | UI (botón, panel, banner) y **lógica de sincronización**. Corre en el mundo aislado. |
| `page-script.js` | Corre en el mundo **MAIN** de la página: accede al Cast SDK y a la Player API de YouTube (`seekTo`, `getCurrentTime`…), que sí funcionan durante un Cast activo. |
| `background.js` | Service worker: enruta mensajes entre la pestaña principal y la secundaria, y gestiona su ciclo de vida. |
| `popup.html/js/css` | Popup del icono: estado de YouTube y de la sesión dual. |

**Motor de sincronización (v3):** la pestaña **principal** envía una muestra por segundo (tiempo, estado, velocidad). La **secundaria** mantiene una ventana deslizante de desfases y decide con la **mediana** y la **velocidad de deriva** (regresión lineal) — así el ruido de medición del Cast (la posición reportada es una estimación que se actualiza cada ~1 s) no dispara correcciones falsas. Correcciones:

1. **Suave** (desfase < 1,2 s): acelera/frena el TV 2 un instante con `setPlaybackRate` — sin rebuffering. Si el TV no obedece, lo detecta y lo recuerda.
2. **Seek** (desfases grandes): con compensación del **sesgo de aterrizaje aprendido** — tras cada seek mide dónde cayó de verdad y ajusta el siguiente.
3. **Lock**: con sincronía estable, el umbral sube de 400 a 700 ms sostenidos — el sistema protege la calibración de audio que hiciste a oído en lugar de destruirla.

El offset de audio manual se suma a cada muestra, y mientras mueves el slider las correcciones automáticas se congelan.

---

## Limitaciones conocidas

- La **latencia de audio de cada TV no es medible por software** — por eso el ajuste es a oído. La ventaja es que ahora es en vivo, fino y persistente.
- Si dejas ambas pestañas ocultas mucho tiempo, Chrome puede ralentizar los temporizadores en segundo plano (limitación del navegador); las correcciones siguen llegando, solo más espaciadas.
- Requiere que ambos TVs estén accesibles para Chrome vía Cast.

---

## Privacidad

La extensión no recopila ni envía datos a ningún servidor. Solo usa `chrome.storage` local para guardar tu preferencia de ajuste de audio y los IDs de pestaña de la sesión.

---

## Licencia

MIT
