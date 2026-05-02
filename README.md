# Txoko-Formacion

Aplicación interna de formación del equipo de sala — TXOKO by Martín Berasategui · Ritz-Carlton Abama.

PWA monolítica (`index.html` + `sw.js`) con sincronización vía Supabase, módulo de vinos con MapLibre, motor RPG ("La Leyenda de Txoko"), y notificaciones push.

## Versión actual

**v5.6 · May 2026**

La versión se expone en tres sitios sincronizados:
- `<meta name="app-version">` y `<meta name="app-build">` en el `<head>`
- Constantes `APP_VERSION` / `APP_BUILD` en JS (también en `window.*`)
- Banner en consola al arrancar

## CHANGELOG

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
