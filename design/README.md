# Txoko · Banco de pruebas de diseño

Biblioteca de componentes **aislados** para iterar el diseño visual sin tocar la
app en producción. Cada archivo de `components/` es un HTML autónomo que carga las
fuentes y tokens reales de Txoko y se abre directamente en el móvil/navegador.

**Esto no es la app.** `index.html` y `styles.css` no se tocan desde aquí. Cuando
una variante convence, se porta a mano a `styles.css` con el flujo normal de
PR + smoke tests.

## Cómo se usa

1. Abre cualquier `design/components/*.html` en el navegador (o en el móvil con
   un servidor estático: `python3 -m http.server` desde la raíz del repo).
2. Cada archivo muestra el estado **actual** del componente y, debajo, variantes
   de rediseño propuestas lado a lado.
3. Eliges la que te gusta; portamos solo esa a `styles.css`.

## Componentes

| Archivo | Qué cubre | Estado |
|---------|-----------|--------|
| `foundations.html` | Paleta, tipografía, radios, sombras, espaciado, motion — los tokens reales | ✅ referencia |
| `exam-options.html` | Opciones de examen (`.choice`): actual + 2 variantes de rediseño, 4 estados cada una | 🔬 a decidir |

## Conexión con Claude Design (claude.ai/design)

Cada preview lleva en su primera línea un marcador `<!-- @dsCard group="…" name="…" -->`.
Eso permite sincronizar esta carpeta como **design system** en claude.ai/design y
ver cada componente como una tarjeta renderizada.

> **Nota de entorno:** desde Claude Code web/remoto **no** se puede autenticar
> contra Claude Design (requiere terminal interactiva). Para sincronizar:
> - usa el botón **"Send to Claude Code Web"** desde Claude Design, **o**
> - ejecuta el flujo `/design-sync` desde un Claude Code local con sesión iniciada.

## Hallazgos detectados al construir esto

- **`--font-read` (Cormorant Garamond) nunca se carga.** El token existe en
  `styles.css` pero el `<link>` de fuentes solo trae Cinzel, Quicksand y DM Mono.
  Donde se use cae a `serif` genérico. Candidato a fix (añadir la fuente o cambiar
  el token). Ver nota dentro de `foundations.html`.
