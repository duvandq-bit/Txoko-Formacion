# Txoko-Formacion

Aplicación interna de formación del equipo de sala — TXOKO by Martín Berasategui · Ritz-Carlton Abama.

PWA monolítica (`index.html` + `sw.js`) con sincronización vía Supabase, módulo de vinos con MapLibre, motor RPG ("La Leyenda de Txoko"), y notificaciones push.

## Versión actual

**v5.7 · May 2026**

La versión se expone en tres sitios sincronizados:
- `<meta name="app-version">` y `<meta name="app-build">` en el `<head>`
- Constantes `APP_VERSION` / `APP_BUILD` en JS (también en `window.*`)
- Banner en consola al arrancar

## CHANGELOG

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

## Despliegue

Sitio estático. Subir `index.html`, `sw.js`, `manifest.json` (raíz) a cualquier hosting estático (GitHub Pages, Netlify, etc.).

Requisito: HTTPS para que el service worker y push notifications funcionen.

## Licencia

© 2026 Duvan Stiven Ramírez Duque. Uso interno autorizado a Txoko by Martín Berasategui · Ritz-Carlton Abama.
