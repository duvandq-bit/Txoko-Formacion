#!/usr/bin/env node
// ═══ ROBOT DE NOTICIAS GASTRO (jul 2026) ═══
// Corre en GitHub Actions cada 6 h (.github/workflows/noticias.yml).
// Lee RSS públicos (Google News con búsquedas fijas), filtra, etiqueta,
// deduplica y escribe data/noticias.json — la app lo carga en perezoso en
// Aprender → Actualidad. Sin dependencias, sin claves, sin servidores.
//
// Desde jul 2026 además ENRIQUECE cada noticia: resuelve el enlace real
// del artículo (los del RSS van con redirección de Google News) y extrae
// su imagen principal (og:image) para pintar miniaturas en la app. Todo
// el enriquecimiento es opcional por diseño: si falla, la noticia sale
// igual que antes (enlace de Google, sin foto).
//
// A PRUEBA DE FALLOS: si las fuentes devuelven poca cosa (<5 noticias),
// NO se escribe nada y la app conserva la edición anterior.

import { writeFileSync, readFileSync } from 'node:fs';

const FEEDS = [
  { q: 'gastronomía Canarias',        tags: ['CANARIAS'] },
  { q: 'gastronomía Tenerife',        tags: ['CANARIAS'] },
  { q: 'restaurantes Tenerife',       tags: ['CANARIAS'] },
  { q: '"Guía Michelin" España',      tags: ['MICHELIN'] },
  { q: '"Martín Berasategui"',        tags: ['CHEF'] },
  { q: 'vinos Canarias bodega',       tags: ['VINO', 'CANARIAS'] },
  { q: 'alta cocina España chef',     tags: ['ALTA COCINA'] },
];

// Titulares que no pintan nada en una app de formación de sala.
const BLOCKLIST = ['muere', 'muert', 'asesin', 'accident', 'incendi', 'crimen', 'agresi', 'apuñal', 'violen',
  // deporte (se cuela por «estrella»/«chef de la selección» en las búsquedas)
  'fútbol', 'futbol', 'scaloni', 'mundial', 'champions', 'la liga', 'partido', 'selección española', 'final contra'];

const MAX_ITEMS = 30;
const MIN_ITEMS = 5;          // por debajo de esto: conservar la edición anterior
const ENRICH_WORKERS = 5;     // páginas de artículo en paralelo
const UA = 'Mozilla/5.0 (compatible; MeseoNoticias/1.0; +https://meseo.es)';
const OUT = new URL('../data/noticias.json', import.meta.url).pathname;

function feedUrl(q){
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:14d')}&hl=es&gl=ES&ceid=ES:es`;
}

function decode(s){
  return (s||'')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'")
    .replace(/<[^>]+>/g,'').trim();
}

function parseItems(xml){
  const out = [];
  const items = xml.split(/<item[\s>]/).slice(1);
  for(const chunk of items){
    const grab = tag => { const m = chunk.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return m ? decode(m[1]) : ''; };
    const title = grab('title');
    const link = grab('link');
    const pub = grab('pubDate');
    const source = grab('source');
    if(!title || !link) continue;
    out.push({ title, link, pub, source });
  }
  return out;
}

function tagFor(title, base){
  const t = title.toLowerCase();
  const tags = new Set(base);
  if(/michelin/.test(t)) tags.add('MICHELIN');
  if(/canari|tenerife|lanzarote|gran canaria|la palma|fuerteventura|el hierro|la gomera/.test(t)) tags.add('CANARIAS');
  if(/vino|bodega|enolog|vendimia|maridaje|sumiller/.test(t)) tags.add('VINO');
  if(/berasategui/.test(t)) tags.add('CHEF');
  if(!tags.size) tags.add('GASTRO');
  return [...tags].slice(0, 3);
}

function normTitle(title, source){
  let t = title;
  if(source && t.endsWith(' - ' + source)) t = t.slice(0, -(' - ' + source).length);
  return t.trim();
}

// fetch con tope de tiempo — nada puede colgar el robot entero.
async function fetchText(url, opts = {}, ms = 9000){
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal, headers: { 'User-Agent': UA, ...(opts.headers||{}) } });
    if(!res.ok) return null;
    return await res.text();
  } catch(e){ return null; }
  finally { clearTimeout(timer); }
}

// ── Resolver el enlace real del artículo ──────────────────────────────
// Los <link> del RSS son news.google.com/rss/articles/<id>. En los ids
// antiguos (CBMi…) la URL va embebida en el protobuf del propio id; en
// los nuevos hay que pedírsela al endpoint batchexecute con las señales
// data-n-a-sg / data-n-a-ts de la página del artículo. Si nada funciona,
// devolvemos null y la noticia conserva el enlace de Google.

export function decodeGnewsId(id){
  try {
    const bin = Buffer.from(id.replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('latin1');
    const m = bin.match(/https?:\/\/[\x21-\x7e]+/);
    if(m && /^https?:\/\/[^\s]+\.[a-z]/i.test(m[0]) && !/news\.google\./.test(m[0])) return m[0];
  } catch(e){}
  return null;
}

async function decodeGnewsRemote(id){
  const page = await fetchText(`https://news.google.com/rss/articles/${id}`);
  if(!page) return null;
  const sg = (page.match(/data-n-a-sg="([^"]+)"/)||[])[1];
  const ts = (page.match(/data-n-a-ts="([^"]+)"/)||[])[1];
  if(!sg || !ts) return null;
  const inner = `["garturlreq",[["X","X",["X","X"],null,null,1,1,"ES:es",null,180,null,null,null,null,null,0,null,null,[1,8]],"X","X",1,[1,25,30],1,1,null,0,0,null,0],"${id}",${ts},"${sg}"]`;
  const body = 'f.req=' + encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]]));
  const res = await fetchText('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body
  });
  if(!res) return null;
  const i = res.indexOf('garturlres');
  if(i < 0) return null;
  const m = res.slice(i, i + 2000).match(/https?:\/\/[^"\\]+/);
  return m ? m[0] : null;
}

export async function resolveArticle(link){
  const id = (link.match(/\/articles\/([^?/]+)/)||[])[1];
  if(!id) return null;
  return decodeGnewsId(id) || await decodeGnewsRemote(id);
}

// ── Imagen principal del artículo (la misma que usan WhatsApp/Twitter
//    para las previsualizaciones). https obligatorio, nada de svg. ──
// REGLA DEL PROPIETARIO: si la foto no es la propia de la noticia, mejor
// sin foto. De ahí los tres cedazos: nombres que delatan logo/placeholder,
// dimensiones declaradas de icono, y (en enrich) la misma foto repetida en
// dos noticias distintas = cabecera genérica del medio, fuera de todas.
// Ojo: nada de vetar «default» a secas — los CDN de Prensa Ibérica llevan
// «aspect-ratio_default_0» en fotos reales de artículo.
const IMG_GENERIC = /(logo|logotipo|favicon|placeholder|sprite|avatar|fallback|og[-_.]?default|default[-_.]?(og|share|social)|share[-_.]?image|imagen[-_.]?generica)/i;

export function extractOgImage(html){
  let og = null, tw = null, w = null, h = null;
  for(const tag of (html.match(/<meta\s[^>]*>/gi) || [])){
    const prop = ((tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i)||[])[1]||'').toLowerCase();
    const content = (tag.match(/content\s*=\s*["']([^"']*)["']/i)||[])[1];
    if(!prop || !content) continue;
    if(!og && (prop === 'og:image' || prop === 'og:image:secure_url')) og = content;
    if(!tw && (prop === 'twitter:image' || prop === 'twitter:image:src')) tw = content;
    if(!w && prop === 'og:image:width') w = parseInt(content, 10) || null;
    if(!h && prop === 'og:image:height') h = parseInt(content, 10) || null;
  }
  const u = (og || tw || '').replace(/&amp;/g,'&').trim();
  if(!/^https:\/\//.test(u)) return null;
  if(/\.svg(\?|#|$)/i.test(u)) return null;
  if(IMG_GENERIC.test(u)) return null;
  if((w && w < 300) || (h && h < 200)) return null;   // tamaño de logo/icono, no de foto
  return u.length <= 500 ? u : null;
}

async function enrich(items){
  const queue = [...items];
  const workers = Array.from({ length: ENRICH_WORKERS }, async () => {
    while(queue.length){
      const it = queue.shift();
      try {
        const real = await resolveArticle(it.u);
        if(!real) continue;
        it.u = real;                       // enlace directo al medio, sin pasar por Google
        const html = await fetchText(real);
        const img = html && extractOgImage(html.slice(0, 400000));
        if(img) it.img = img;
      } catch(e){}
    }
  });
  await Promise.all(workers);
  // La misma foto en dos noticias distintas no es la foto de ninguna: es la
  // imagen de cabecera genérica del medio → se quita de todas.
  const byImg = {};
  items.forEach(i => { if(i.img) byImg[i.img] = (byImg[i.img]||0) + 1; });
  items.forEach(i => { if(i.img && byImg[i.img] > 1) delete i.img; });
  const withImg = items.filter(i => i.img).length;
  const direct = items.filter(i => !/news\.google\./.test(i.u)).length;
  console.log(`Enriquecido: ${direct}/${items.length} enlaces directos, ${withImg}/${items.length} con imagen`);
}

async function main(){
  const seen = new Set();
  const items = [];
  for(const feed of FEEDS){
    try {
      const res = await fetch(feedUrl(feed.q), { headers: { 'User-Agent': 'MeseoNoticias/1.0 (+https://meseo.es)' } });
      if(!res.ok){ console.log(`[skip] ${feed.q}: HTTP ${res.status}`); continue; }
      const xml = await res.text();
      for(const it of parseItems(xml)){
        const t = normTitle(it.title, it.source);
        const key = t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
        if(seen.has(key)) continue;
        const lower = t.toLowerCase();
        if(BLOCKLIST.some(w => lower.includes(w))) continue;
        seen.add(key);
        const d = it.pub ? new Date(it.pub) : null;
        items.push({
          t,
          u: it.link,
          s: it.source || 'Google News',
          d: (d && !isNaN(d)) ? d.toISOString() : null,
          tags: tagFor(t, feed.tags)
        });
      }
      console.log(`[ok] ${feed.q}: ${items.length} acumuladas`);
    } catch(e){ console.log(`[skip] ${feed.q}: ${e.message}`); }
  }

  items.sort((a,b) => (b.d||'').localeCompare(a.d||''));
  const top = items.slice(0, MAX_ITEMS);

  if(top.length < MIN_ITEMS){
    console.log(`Solo ${top.length} noticias — se conserva la edición anterior sin escribir.`);
    process.exit(0);
  }

  await enrich(top);

  let prev = null;
  try { prev = JSON.parse(readFileSync(OUT, 'utf8')); } catch(e){}
  const payload = { updated: new Date().toISOString(), items: top };
  // No reescribir si el contenido es idéntico (evita commits vacíos de solo-fecha).
  if(prev && JSON.stringify(prev.items) === JSON.stringify(payload.items)){
    console.log('Sin novedades — no se escribe.');
    process.exit(0);
  }
  writeFileSync(OUT, JSON.stringify(payload, null, 1) + '\n');
  console.log(`Escritas ${top.length} noticias en data/noticias.json`);
}

// MESEO_ROBOT_IMPORT=1 permite importar las funciones puras en tests
// sin disparar las descargas.
if(process.env.MESEO_ROBOT_IMPORT !== '1') await main();
