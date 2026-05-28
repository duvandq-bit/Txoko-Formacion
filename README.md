# Txoko-Formacion

Aplicación interna de formación del equipo de sala — TXOKO by Martín Berasategui · Ritz-Carlton Abama.

PWA monolítica (`index.html` + `sw.js`) con sincronización vía Supabase, módulo de vinos con MapLibre, motor RPG ("La Leyenda de Txoko"), y notificaciones push.

## Versión actual

**v5.8 · May 2026**

La versión se expone en tres sitios sincronizados:
- `<meta name="app-version">` y `<meta name="app-build">` en el `<head>`
- Constantes `APP_VERSION` / `APP_BUILD` en JS (también en `window.*`)
- Banner en consola al arrancar

## CHANGELOG

### v5.8 — May 2026 · "LQA simulator polish"

Refactor completo del módulo LQA (Examen, Situaciones, Auditor) tras auditoría de v5.7. Sin cambios en el contenido (preguntas y situaciones intactas); todo el trabajo es en el motor, la UX y la analítica.

**Motor compartido (`_lqaEngine`)**
- Estado encapsulado por modo (`lqaSitState`, `lqaExamState`, `lqaAudState`) — antes había `let` globales por modo (`lqaSituationIndex`, `lqaExamIndex`, `lqaAuditorIndex` + sus arrays/scores) que se contaminaban entre sesiones, recargas y pestañas.
- Helper `_lqaShuffle()` con Fisher-Yates correcto — antes `sort(()=>Math.random()-.5)` que es sesgado.
- Helper `_lqaPushScore()` que persiste resultados a `emp.lqaScores` con cap rodante de **50 entradas** (parity con `emp.sessions.slice(-50)` introducido en v5.7).
- Helpers `_lqaInstallKbd()` / `_lqaUninstallKbd()` para gestionar el listener de teclado entre pantallas sin leaks.
- `_lqaConfirmExit()` para el botón `←` / tecla `Esc` con `confirm()` antes de descartar progreso a media sesión.

**Feedback enriquecido (U1)**
Antes: `✓` / `✗` + explicación. Las 4 opciones desaparecían — el usuario no veía qué eligió mal frente a la correcta.
Ahora: las 4 opciones (o las 2 verdictos del Auditor) se muestran tras cada respuesta con borde verde (correcta), borde rojo (la del usuario si era errónea) y marker `✓`/`✗`. Aplicado a Examen, Situaciones y Auditor.

**Pantalla "Revisar respuestas" (U5)**
Nueva en los 3 modos. Al final de la sesión hay un botón "Revisar respuestas" que lista las 10 preguntas en `<details>` colapsibles, cada una con: enunciado, opciones marcadas con verde/rojo (con el escenario completo en Situaciones), explicación, y referencia al estándar LQA cuando aplica.

**Desglose por categoría — Situaciones (A1)**
Cada situación tiene `cat` (`llegada/servicio/vino/carta/montaje/comportamiento`). Ahora:
- La pantalla de resultados muestra una barra horizontal por categoría con `<acertadas>/<total>` para esa sesión, ordenadas por % ascendente (zonas débiles primero).
- Se acumula en `emp.lqaSitByCat = {<cat>: {correct, total}}` a lo largo del tiempo. Datos disponibles para el dashboard de supervisor y para futuras features de "modo zona débil".

**Atajos de teclado (U2)**
Aplicados a los 3 modos:
- `1`–`4` (o `1`–`2` en Auditor) → seleccionar opción / verdicto
- `Enter` o `Espacio` → avanzar a la siguiente
- `Esc` → confirmar salida de la sesión

**Captura de tiempo (E3)**
`time_sec` se persiste en `emp.lqaScores[].time_sec` y se muestra en la pantalla de resultados (`+X XP · Ys`). Antes solo se capturaba en el módulo de exámenes de platos; los modos LQA quedaban sin esa señal.

**Resultados idempotentes**
Antes: `renderLqaSituationResults` re-persistía a `emp` y re-otorgaba XP cada vez que se llamaba. Si volvías de "Revisar respuestas" a la pantalla de resultados se duplicaba el XP. Ahora `_lqaCompleteX()` persiste una única vez y marca `state.completed = true`; las re-renders son puras.

**Cambios secundarios**
- Headings semánticos (`<h1 tabindex="-1">`) en pantallas de resultados con `.focus()` para anuncio del lectores de pantalla.
- `aria-live="polite"` en pantallas de feedback.
- `role="radiogroup"` en grupos de opciones.
- `min-height: 48px` en botones de opción (cumple WCAG touch target).
- Tag de categoría visible en cada situación durante el quiz.

**Compatibilidad**
- El shape de `emp.lqaScores` ahora incluye `time_sec` adicional. Lecturas anteriores (pre-v5.8) siguen funcionando: el campo es ignorado donde no se usa.
- `emp.lqaSitByCat` es nuevo; código que no lo lee no se ve afectado.
- Los 3 modos siguen interpelando `LQA_SITUATIONS`, `LQA_EXAM_QUESTIONS`, `LQA_AUDIT_SCENARIOS` igual que antes — no hay cambios en el contenido.

**Diferido a v5.9**
- Spaced repetition / evitar "recently seen" entre sesiones consecutivas
- "Modo zona débil" en hub LQA usando `emp.lqaSitByCat`
- Streak diaria específica de LQA
- Sparkline de progreso histórico en pantalla de resultados

### v5.7.1 — May 2026

Ampliación de contenido del simulador LQA basada en la auditoría LQA del 01-may-2026 (78.7% global).

**Nuevas situaciones (22) en `LQA_SITUATIONS` — array pasa de 25 a 47 entradas**
- **16 situaciones de error-prevention** (ids 26-41) cubriendo los 16 incumplimientos detectados en la auditoría: uso de "hola" en vez de "buenas tardes/noches", tutear cuando hay que mantener "ustedes", omisión de café/té al pedir postre, fallo de personalización (revista vs. recordar preferencias), tiempo de comanda > 3 min, pinzas saturadas con moscas, retirada incorrecta de plato sin posición de "terminado" en cubertería, inconsistencia de explicación entre mesas, no chequeo proactivo en mesas silenciosas, agua no local servida (Solán de Cabras), saleros vacíos o atascados, opciones veganas no ofrecidas, saludo de bienvenida con "hola".
- **6 situaciones de buenas prácticas auditadas** (ids 42-47) reforzando los positivos del informe: esperar a que la huésped termine una conversación antes de acompañarla, naturalidad consistente entre mesas, modificación razonable sin fricción, oferta proactiva de vela anti-insectos, conocimiento profundo de carta, mención de origen local del pescado.

**Distribución final por categoría** (47 totales): comportamiento ×13 · servicio ×10 · vino ×9 · montaje ×6 · carta ×5 · llegada ×4. **Real-vs-pedagógicas**: 28 reales · 19 pedagógicas.

**No hay cambios en código motor** — `startLqaSituations()`, `renderLqaSituationQuestion()`, `lqaSituationAnswer()`, `renderLqaSituationResults()` siguen idénticos. La sesión sigue eligiendo 10 situaciones aleatorias del pool ampliado.

### v5.7 — May 2026

Auditoría post-v5.6 detectó 20 hallazgos. Este release los resuelve todos los factibles.

**Seguridad**
- **XSS en leaderboard** — los nombres de empleados se interpolaban sin escapar en `lb-avatar` y `lb-name`. Ahora pasan por `escapeHTML()`. Un nombre con `<script>…</script>` ya no ejecuta JS en cada espectador del ranking.
- **Bypass del rate-limit del PIN** — el IIFE de `_pinAttempts` reseteaba el campo `streak` cuando un lockout expiraba, neutralizando el backoff exponencial (30 s → 60 s → 5 min → 15 min). Ahora el estado se preserva intacto entre recargas; sólo `recordPinSuccess` lo limpia.
- **`SUPA_KEY` en query string vía sendBeacon** — `sendBeacon` no soporta headers, así que el código metía la apikey en la URL (queda en logs de proxies, history exporters, Referer). Sustituido por `fetch(..., {keepalive:true})` con apikey en headers.
- **`awardXP` toast** — `${reason}` se interpolaba sin escapar; algunos callers concatenan títulos de logros/misiones que en el futuro podrían contener `<`. Escapado con `escapeHTML()`.
- **`window.txokoDiag` siempre expuesto** — la función global de diagnóstico mostraba el usuario actual, su XP/streak y los top-5 de la nube por `console.log`. Ahora se expone solo cuando `DEBUG === true` (localhost o `?debug=1`).

**Limpieza de datos en logout**
- Las suscripciones push no se desuscribían al cerrar sesión: el siguiente usuario en el mismo dispositivo recibía notificaciones del anterior y los endpoints stale se acumulaban en Supabase. Ahora `logout()` llama a `pushManager.getSubscription().unsubscribe()` y borra la fila correspondiente vía `DELETE /push_subscriptions?endpoint=eq.…` con `keepalive:true`.

**Lógica de negocio**
- **Duelo local** — el `duelWins++` siempre iba a `currentUser` aunque ganase el segundo jugador en pass-and-play. Ahora se acredita al ganador real; el XP solo se otorga cuando coincide con el usuario logueado.
- **Hitos de racha** — `if(emp.streak===N)` con igualdad estricta perdía bonuses si la racha saltaba un valor (p. ej., al hacer `Math.max(local, remote)` en cloud restore). Ahora hay un mapa `streakMilestones` que registra qué hitos ya pagaron, así un salto 0→7 cobra 3 + 7 días retroactivamente, sin pagar dos veces.
- **Ranking sin tie-breaker** — empates en XP producían orden aleatorio entre renders (dependía del motor V8/Spider/JS). Sort secundario por nombre añadido, ahora estable.

**Robustez**
- **Timeouts en fetch** — `fetchT(url, opts, ms)` con `AbortController` (default 10 s, 8 s en login). En WiFi mala el flujo de login ya no cuelga indefinidamente.
- **`crypto.subtle` no disponible** — en orígenes inseguros (HTTP, IPs locales) `crypto.subtle` es `undefined` y `hashPin` lanzaba un `TypeError` críptico. Ahora un guard explícito tira un `Error` claro.
- **Cache de restore sin límite** — `_restoreCache` crecía sin bound. Sweep periódico cada 60 s + cap duro de 50 entradas.
- **`sessions[]` local sin trim** — la nube trunca a 20 entradas en upload pero local crecía sin límite hasta romper la quota de localStorage. Trim a 50 tras cada examen.
- **Favicon 404 en notificaciones** — `showBrowserNotif` apuntaba a `/favicon.ico` que no existe. Ahora usa `icon.svg`.

**Refactors**
- **MutationObserver global eliminado** — el observer sobre `document.body subtree:true` recalculaba ripples en cada cambio del DOM (drain continuo de CPU en móviles). Sustituido por una sola delegación en `document` que captura `pointerdown` y matchea por selector con `closest`. `addRipple` acepta un `explicitTarget` para que la delegación le pase el botón matched en lugar de `event.currentTarget` (que sería `document`).
- **Cross-tab storage merge** — el handler de `storage` reemplazaba `DB` entero, perdiendo escrituras en vuelo (p. ej., examScores incrementados en otra pestaña). Ahora hay un merge por empleado con `Math.max` para counters (XP, streak, txokoRecord, duelWins), unión para mapas (`knownDishes`, `examCorrect`, `streakMilestones`) y la sesión más larga gana.
- **Migración v3/v2/v1 → v4** — `loadDB` ahora intenta leer `txoko_data_v3`, `_v2`, `_v1` si no encuentra v4, promueve los datos al esquema actual y elimina la clave legacy. Usuarios offline en versiones antiguas conservan XP/streaks tras actualizar.

**Higiene**
- `escapeHtml` y `escapeHTML` consolidados — el segundo (legacy) ahora delega al primero. El bug de tratar `0`/`false` como cadena vacía está corregido.
- Bloque comentado muerto "RP LA LEYENDA DE TXOKO — Motor Generativo v2.0" eliminado (línea ~35790, sin código asociado).
- Strings hardcodeados en español dentro del modo EN traducidos: `↻ actualizando…` y `alert('Error')` del flujo de duelo.

### v5.6 — May 2026

**Seguridad**
- Errores en `try/catch` ya no se inyectan crudos vía `innerHTML` — se escapan con `escapeHtml()` (mitiga un posible vector XSS y deja de filtrar stack traces a usuarios finales).
- Dependencias CDN pinneadas a versión exacta y marcadas `crossorigin="anonymous"` para permitir SRI. Los hashes SRI deben añadirse en el deploy (`integrity="sha384-..."`) — ver nota al pie del bucket de scripts en `index.html`.
- Verificación del PIN de supervisor preparada para validación server-side. El hash sigue como fallback local (compatibilidad), pero ahora hay un flag `USE_SERVER_PIN_VERIFY`. Para activarlo:
  1. Ejecuta `supabase/supervisor_pin.sql` en tu proyecto Supabase.
  2. Cambia `USE_SERVER_PIN_VERIFY = false` por `true` en `index.html` (línea cercana a la definición de `SUP_PIN_HASH`).
  3. Cuando el RPC esté operativo, **elimina** la constante `SUP_PIN_HASH` del bundle.

**PWA**
- Nuevo `manifest.json` con icons SVG embebidos (data URL) — la app es ahora "Add to Home Screen" en iOS/Android.
- `sw.js` ahora cachea el shell con estrategia *stale-while-revalidate* — la app abre offline.
- `notificationclick` ya no depende de que la URL contenga la cadena `"Txoko"` (rompía si se desplegaba bajo otro path); usa el scope del SW.

**Bugs**
- Llamadas a Supabase en el flujo de login deduplicadas (evita el doble query name-exact + ilike en cada intento).
- `JSON.parse` silencioso reemplazado por warnings reales (`console.warn`) detrás del flag `DEBUG`, para detectar regresiones de schema sin spamear al usuario.

**Accesibilidad**
- Botones icon-only (cerrar, pad PIN, etc.) ahora llevan `aria-label`.
- Modales de PIN/login/borrar perfil tienen focus trap + tecla `ESC` para cerrar.

**Hygiene**
- 35 `console.*` ruidosos reemplazados por `dbg(...)` que solo emite si `DEBUG === true` (localhost o `?debug=1`).
- `escapeHtml()` global expuesto en `window` para uso futuro.

### v4.6 — March 2026

Versión anterior. Ver historial git para detalles.

## Tests

Suite de *smoke tests* sin dependencias (Node ≥18) que protege un PWA de un solo
archivo sin paso de build. Se ejecuta en cada push/PR vía GitHub Actions
(`.github/workflows/ci.yml`).

```bash
npm test        # node tests/smoke.mjs
```

Comprueba: sintaxis del `<script>` principal, validez/estructura de los JSON en
`data/`, que toda ruta de `showTab` apunte a una función existente, que las rutas
de `loadLazyData` existan en disco, versión del service worker, `crossorigin` en
dependencias CDN y ausencia de marcadores de conflicto de git.

## Despliegue

Sitio estático. Subir `index.html`, `sw.js`, `manifest.json` (raíz) a cualquier hosting estático (GitHub Pages, Netlify, etc.).

Requisito: HTTPS para que el service worker y push notifications funcionen.

## Licencia

© 2026 Duvan Stiven Ramírez Duque. Uso interno autorizado a Txoko by Martín Berasategui · Ritz-Carlton Abama.
