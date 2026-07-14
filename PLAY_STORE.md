# Publicar Meseo en Google Play Store

Guía completa para llevar la PWA de Meseo (meseo.es) a la Play Store como
**TWA** (Trusted Web Activity: una app Android que es un envoltorio de la web,
sin barra de navegador). No hay que reescribir nada de la app.

> **iOS / App Store:** Apple suele rechazar PWAs envueltas (regla 4.2, «poca
> funcionalidad nativa»). No se recomienda intentar iOS por esta vía; en iPhone
> el equipo puede instalarla igual desde Safari → Compartir → «Añadir a
> pantalla de inicio» (gratis, sin tienda).

---

## ✅ Ya está preparado en el repo (hecho)

| Requisito | Estado |
|---|---|
| HTTPS + dominio propio (meseo.es) | ✅ |
| `manifest.json` (nombre, colores, standalone) | ✅ |
| Service worker (offline) | ✅ |
| Icono 192×192 y **512×512** (`icon-512.png`) | ✅ |
| `.well-known/assetlinks.json` (verificación de dominio) | ✅ *(falta pegar la huella, ver paso 3)* |
| `.nojekyll` (para que GitHub Pages sirva `.well-known/`) | ✅ |
| Política de privacidad (`privacidad.html` → meseo.es/privacidad.html) | ✅ |

## ⏳ Lo que tienes que hacer tú

### Paso 1 — Cuenta de Google Play Console
- Ve a <https://play.google.com/console> y crea una cuenta de desarrollador.
- **25 $ pago único** (de por vida, no anual). Requiere verificación de identidad
  (documento) y puede tardar 1–2 días en aprobarse.

### Paso 2 — Generar el paquete Android (.aab)
La forma más fácil, sin instalar nada:
1. Entra en <https://www.pwabuilder.com>
2. Pega la URL: `https://meseo.es`
3. Pulsa **Package for stores → Android → Google Play**.
4. Ajustes recomendados:
   - **Package ID:** `es.meseo.twa`  *(debe coincidir con assetlinks.json)*
   - **App name:** `Meseo`
   - **Launcher name:** `Meseo`
   - Deja que genere la **clave de firma** (signing key) y **guárdala bien**
     (el archivo `.keystore` + contraseñas). Sin ella no podrás publicar
     actualizaciones nunca más.
5. Descarga el `.zip`: contiene el `app-release-bundle.aab` (lo que se sube) y
   un archivo con la **huella SHA-256** de tu clave de firma.

### Paso 3 — Pegar la huella en assetlinks.json
1. Abre el archivo del paquete que trae la huella (`assetlinks.json` o
   `signing-key-info`), copia el valor `sha256_cert_fingerprints`.
2. En este repo, edita `.well-known/assetlinks.json` y sustituye
   `REEMPLAZAR_CON_LA_HUELLA_SHA256_DE_LA_CLAVE_DE_FIRMA` por esa huella.
3. Haz commit y push → se publica en `https://meseo.es/.well-known/assetlinks.json`.
   *(Esto es lo que quita la barra del navegador dentro de la app.)*

### Paso 4 — Ficha de la tienda (en Play Console)
- **Descripción corta** (80 car.) y **larga** (4000 car.) — ver borrador abajo.
- **Política de privacidad:** `https://meseo.es/privacidad.html`
- **Icono de la tienda:** 512×512 → usa `icon-512.png` de este repo.
- **Gráfico destacado (feature graphic):** 1024×500 → ver prompt de Grok abajo.
- **Capturas de pantalla:** 2–8 imágenes de móvil. **Deben ser reales de la app.**
  Lo más fácil: ábrela en tu móvil y haz capturas de estas pantallas:
  1. Inicio (dashboard con el anillo de progreso)
  2. La Carta / una ficha de plato
  3. Aprender → Técnicas
  4. Un examen o el Simulacro de alérgenos
  5. Un juego (Mr. Shoesmith o Camarero Survivors)
- **Clasificación de contenido:** rellena el cuestionario (es una app educativa,
  sin contenido sensible → apta para todos).
- **Sección "Seguridad de los datos":** declara lo que recoge la app
  (nombre, correo opcional, progreso) — coincide con `privacidad.html`.

### Paso 5 — Subir y enviar a revisión
- Sube el `.aab`, completa la ficha y envía. Google revisa en **unos días**.

---

## Borrador de textos para la ficha

**Descripción corta (≤80):**
> Formación de sala: carta, alérgenos, vinos, exámenes y juegos para tu equipo.

**Descripción larga:**
> Meseo es la app de formación para equipos de sala de restaurante. Aprende y
> repasa toda la carta —platos, ingredientes, alérgenos y su gestión—, la carta
> de vinos y el maridaje, los protocolos de servicio y los estándares de calidad
> (LQA). Pon a prueba lo aprendido con exámenes por tema, el simulacro de
> alérgenos y situaciones reales de sala. Y hazlo jugando: modo supervivencia
> «Mr. Shoesmith», «Camarero Survivors», duelos 1v1 y ranking del equipo.
>
> Incluye una sección de Técnicas de cocina, guía visual de emplatado, repaso
> inteligente (repetición espaciada) y notificaciones para retos del equipo.
> Funciona sin conexión y sincroniza tu progreso entre dispositivos.

## Prompt de Grok — gráfico destacado (1024×500)

> A wide promotional banner (1024x500) for a fine-dining restaurant staff
> training app called "Meseo". Elegant, premium, Michelin-star mood. Deep
> dark forest-green background (#1c2a22) with subtle gold filigree. On the
> left, the word "Meseo" in an elegant gold serif; below it, smaller, "Formación
> de sala". On the right, a tasteful golden line-art composition: a serving
> cloche, a wine glass and a chef's plate. Lots of negative space, high
> contrast, flat vector illustration, no photo, no clutter. Gold (#c49a3c to
> #e4be68) on dark green.

---

## Notas
- **Package ID `es.meseo.twa`** debe ser idéntico en PWABuilder y en
  `assetlinks.json`. Si lo cambias, cámbialo en los dos sitios.
- Guarda la **clave de firma** en un sitio seguro y con copia. Es intransferible.
- Las **actualizaciones** de la app no requieren volver a subir nada: como es un
  TWA, al abrirse carga meseo.es en vivo. Solo subes un `.aab` nuevo si cambias
  el nombre, el icono o el package.
