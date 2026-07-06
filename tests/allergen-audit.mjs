// ═══ AUDITOR DE COHERENCIA ALÉRGENOS ↔ INGREDIENTES ═══
// Cruza la base única de ingredientes (data/ingredients.json) contra los
// alérgenos declarados a mano en cada plato (DISHES en index.html).
//
//   node tests/allergen-audit.mjs          → informe completo
//   node tests/allergen-audit.mjs --json   → salida máquina (para tests)
//
// Dos direcciones:
//   ⛔ NO DECLARADO  un ingrediente etiquetado implica un alérgeno que el
//                    plato NO declara — la dirección peligrosa (huésped en
//                    riesgo). Cada caso es un bug de datos o una etiqueta de
//                    ingrediente que corregir.
//   ⚠ SIN ORIGEN    el plato declara un alérgeno que ningún ingrediente
//                    etiquetado explica — o falta etiquetar un ingrediente
//                    (pendiente) o la declaración sobra.
// La declaración manual de los platos NO se toca: este auditor solo informa.
// Cuando el propietario valide la base, la derivación podrá ser automática.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf-8');
const base = JSON.parse(readFileSync(join(root, 'data/ingredients.json'), 'utf-8'));

const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// ── Extrae DISHES (mismo criterio de tokenización que el builder de la base) ──
const i0 = html.indexOf('const DISHES = [');
const i1 = html.indexOf('\n];', i0);
const block = html.slice(i0, i1);
const dishRe = /\{id:(\d+),cat:'([^']*)',name:'((?:[^'\\]|\\.)*)',allergens:\[([^\]]*)\],(?:baseAllergens:\[[^\]]*\],)?(?:variants:\[.*?\],)?ingredients:'((?:[^'\\]|\\.)*)'/g;
const dishes = [];
let m;
while ((m = dishRe.exec(block)) !== null) {
  const [, id, cat, name, alg, ings] = m;
  const declared = [...alg.matchAll(/'([^']+)'/g)].map(x => x[1]);
  const tokens = ings.split(/[,.:;]/)
    .map(t => t.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(t => t.length > 2 && t.length < 40);
  dishes.push({ id: +id, cat, name, declared, tokens });
}

const ING = base.ingredientes;
const results = { no_declarado: [], sin_origen: [], pendientes_usados: new Set() };

for (const d of dishes) {
  const computed = new Map(); // alérgeno -> [ingredientes que lo aportan]
  for (const t of d.tokens) {
    const e = ING[norm(t)];
    if (!e) continue;
    // 'pendiente' y 'propuesta' NO son autoritativas: no computan alérgenos
    // (una propuesta espera la palabra del propietario).
    if (e.fuente === 'pendiente' || e.fuente === 'propuesta') { results.pendientes_usados.add(norm(t)); continue; }
    for (const a of e.alergenos) {
      if (!computed.has(a)) computed.set(a, []);
      computed.get(a).push(e.nombre);
    }
  }
  for (const [a, sources] of computed) {
    if (!d.declared.includes(a)) {
      results.no_declarado.push({ id: d.id, plato: d.name, alergeno: a, por: sources });
    }
  }
  for (const a of d.declared) {
    if (!computed.has(a)) {
      results.sin_origen.push({ id: d.id, plato: d.name, alergeno: a });
    }
  }
}

const out = {
  platos: dishes.length,
  no_declarado: results.no_declarado,
  sin_origen: results.sin_origen,
  ingredientes_pendientes_en_uso: results.pendientes_usados.size
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(out));
} else {
  console.log(`Platos auditados: ${dishes.length}\n`);
  console.log(`⛔ NO DECLARADO (${out.no_declarado.length}) — ingrediente etiquetado implica alérgeno ausente del plato:`);
  out.no_declarado.forEach(r => console.log(`   [${r.id}] ${r.plato} → falta ${r.alergeno} (por: ${r.por.join(', ')})`));
  console.log(`\n⚠ SIN ORIGEN (${out.sin_origen.length}) — alérgeno declarado que ningún ingrediente etiquetado explica:`);
  const byA = {};
  out.sin_origen.forEach(r => { (byA[r.alergeno] = byA[r.alergeno] || []).push(`[${r.id}] ${r.plato}`); });
  Object.entries(byA).forEach(([a, list]) => console.log(`   ${a} (${list.length}): ${list.join(' · ')}`));
  console.log(`\nIngredientes 'pendiente' aún en uso: ${out.ingredientes_pendientes_en_uso} (revisar en data/ingredients.json)`);
}
