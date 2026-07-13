// Meseo — reset-pin (recuperación de PIN por correo, jul 2026)
// Backend de correo de recuperación. Tres acciones:
//   • set-email { name, pinHash, email }  → guarda el correo de recuperación,
//     PERO solo si pinHash coincide con el PIN guardado (prueba de identidad).
//     Así nadie puede atar su correo a la cuenta de otro y robarle el acceso.
//   • request   { email }                 → genera token de un solo uso, lo
//     guarda HASHEADO (nunca en claro) y envía un enlace mágico por correo.
//   • confirm   { token, newPinHash }      → valida el token (no usado, no
//     caducado) y fija el PIN nuevo (ya viene hasheado desde el móvil).
//
// Privacidad/seguridad:
//   • Los correos viven en employee_recovery, con RLS SIN políticas: la anon key
//     pública NO puede leerlos ni escribirlos. Solo este backend (service-role).
//   • El PIN nuevo se cifra en el cliente (SHA-256+salt) — el servidor jamás ve
//     el PIN en claro, igual que el login normal.
//   • Se guarda sha256(token): una fuga de BD no expone tokens válidos.
//   • request SIEMPRE responde ok:true (no revela si un correo existe) y limita
//     a 1 envío/60 s por empleado.
//
// SECRETO (definir antes de usar en producción):
//   supabase secrets set RESEND_API_KEY=<clave de resend.com>
//   supabase secrets set RESEND_FROM='Meseo <no-reply@meseo.es>'   (opcional)
// Para pruebas antes de verificar el dominio, Resend permite:
//   RESEND_FROM='Meseo <onboarding@resend.dev>'  (solo envía a tu propio correo)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPA_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || '';
const RESEND_FROM = Deno.env.get('RESEND_FROM') || 'Meseo <no-reply@meseo.es>';
const APP_ORIGIN = Deno.env.get('APP_ORIGIN') || 'https://meseo.es';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey'
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function randToken(): string {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}
function validEmail(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 120;
}
function maskEmail(e: string): string {
  const [u, d] = e.split('@');
  if (!d) return '***';
  const uu = u.length <= 2 ? u[0] + '*' : u[0] + '***' + u[u.length - 1];
  return uu + '@' + d;
}
const rest = (path: string, init: RequestInit = {}) =>
  fetch(`${SUPA_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      'apikey': SUPA_SERVICE_KEY,
      'Authorization': `Bearer ${SUPA_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  });

function emailHTML(name: string, link: string): string {
  return `<!doctype html><html lang="es"><body style="margin:0;background:#f4f1ea;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#2b2b2b">
  <div style="max-width:460px;margin:0 auto;padding:32px 24px">
    <div style="text-align:center;margin-bottom:24px">
      <span style="font-size:26px;font-weight:800;letter-spacing:.5px;color:#8a5a2b">Meseo</span>
    </div>
    <div style="background:#fff;border-radius:16px;padding:28px 24px;box-shadow:0 2px 10px rgba(0,0,0,.06)">
      <p style="margin:0 0 12px;font-size:17px;font-weight:700">Hola ${name},</p>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.5">Has pedido recuperar tu acceso. Pulsa el botón para elegir un PIN o contraseña nuevos. El enlace caduca en 30 minutos y solo se puede usar una vez.</p>
      <div style="text-align:center;margin:24px 0">
        <a href="${link}" style="display:inline-block;background:#8a5a2b;color:#fff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 28px;border-radius:10px">Elegir clave nueva</a>
      </div>
      <p style="margin:16px 0 0;font-size:12px;color:#888;line-height:1.5">Si no has sido tú, ignora este correo: tu clave no cambia hasta que abras el enlace y crees una nueva.</p>
    </div>
    <p style="text-align:center;margin:20px 0 0;font-size:11px;color:#a8a29a">Meseo · Formación de sala · meseo.es</p>
  </div></body></html>`;
}

async function sendEmail(to: string, name: string, link: string): Promise<void> {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY no configurada');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: RESEND_FROM, to: [to], subject: 'Recupera tu acceso · Meseo', html: emailHTML(name, link) })
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action;

    // ── Guardar/actualizar el correo de recuperación (requiere PIN) ──
    if (action === 'set-email') {
      const name = String(body.name || '').trim();
      const pinHash = String(body.pinHash || '');
      const email = String(body.email || '').trim().toLowerCase();
      if (!name || !/^[a-f0-9]{64}$/.test(pinHash) || !validEmail(email)) return json({ error: 'bad_request' }, 400);
      // prueba de identidad: el hash del PIN debe coincidir con el guardado
      const r = await rest(`employees?select=name,pin&name=eq.${encodeURIComponent(name)}`);
      const rows = await r.json();
      const emp = Array.isArray(rows) && rows.length ? rows[0] : null;
      if (!emp || emp.pin !== pinHash) return json({ error: 'auth' }, 401);
      // el correo no puede estar ya asociado a OTRO empleado
      const ex = await rest(`employee_recovery?select=employee_name&email=eq.${encodeURIComponent(email)}`);
      const exRows = await ex.json();
      if (Array.isArray(exRows) && exRows.some((x: any) => x.employee_name !== name)) return json({ error: 'email_taken' }, 409);
      const up = await rest('employee_recovery', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ employee_name: name, email, updated_at: new Date().toISOString() })
      });
      if (!up.ok) return json({ error: 'save_failed' }, 500);
      return json({ ok: true });
    }

    // ── Estado del correo de recuperación (Ajustes; requiere PIN) ──
    if (action === 'email-status') {
      const name = String(body.name || '').trim();
      const pinHash = String(body.pinHash || '');
      if (!name || !/^[a-f0-9]{64}$/.test(pinHash)) return json({ error: 'bad_request' }, 400);
      const r = await rest(`employees?select=name,pin&name=eq.${encodeURIComponent(name)}`);
      const rows = await r.json();
      const emp = Array.isArray(rows) && rows.length ? rows[0] : null;
      if (!emp || emp.pin !== pinHash) return json({ error: 'auth' }, 401);
      const er = await rest(`employee_recovery?select=email&employee_name=eq.${encodeURIComponent(name)}`);
      const erRows = await er.json();
      const email = Array.isArray(erRows) && erRows.length ? erRows[0].email : null;
      return json({ ok: true, hasEmail: !!email, masked: email ? maskEmail(email) : null });
    }

    // ── Cambiar PIN/contraseña estando dentro (Ajustes; requiere PIN actual) ──
    if (action === 'change-pin') {
      const name = String(body.name || '').trim();
      const pinHash = String(body.pinHash || '');
      const newPinHash = String(body.newPinHash || '');
      if (!name || !/^[a-f0-9]{64}$/.test(pinHash) || !/^[a-f0-9]{64}$/.test(newPinHash)) return json({ error: 'bad_request' }, 400);
      const r = await rest(`employees?select=name,pin&name=eq.${encodeURIComponent(name)}`);
      const rows = await r.json();
      const emp = Array.isArray(rows) && rows.length ? rows[0] : null;
      if (!emp || emp.pin !== pinHash) return json({ error: 'auth' }, 401);
      const up = await rest(`employees?name=eq.${encodeURIComponent(name)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ pin: newPinHash })
      });
      if (!up.ok) return json({ error: 'update_failed' }, 500);
      return json({ ok: true });
    }

    // ── Pedir enlace de recuperación ──
    if (action === 'request') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!validEmail(email)) return json({ ok: true }); // no filtrar
      const r = await rest(`employee_recovery?select=employee_name,email&email=eq.${encodeURIComponent(email)}`);
      const rows = await r.json();
      const rec = Array.isArray(rows) && rows.length ? rows[0] : null;
      if (!rec) return json({ ok: true }); // no revelar existencia

      const since = new Date(Date.now() - 60000).toISOString();
      const rl = await rest(`password_resets?select=id&employee_name=eq.${encodeURIComponent(rec.employee_name)}&used=eq.false&created_at=gt.${since}`);
      const rlRows = await rl.json();
      if (Array.isArray(rlRows) && rlRows.length) return json({ ok: true });

      const token = randToken();
      const token_hash = await sha256hex(token);
      const expires_at = new Date(Date.now() + 30 * 60000).toISOString();
      await rest('password_resets', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ employee_name: rec.employee_name, token_hash, expires_at })
      });
      try {
        await sendEmail(rec.email, rec.employee_name, `${APP_ORIGIN}/#reset=${token}`);
      } catch (e) {
        console.error('sendEmail falló:', String(e)); // queda en logs; no se revela al cliente
      }
      return json({ ok: true });
    }

    // ── Confirmar PIN nuevo con el token ──
    if (action === 'confirm') {
      const token = String(body.token || '');
      const newPinHash = String(body.newPinHash || '');
      if (!/^[a-f0-9]{64}$/.test(token) || !/^[a-f0-9]{64}$/.test(newPinHash)) return json({ error: 'bad_request' }, 400);
      const token_hash = await sha256hex(token);
      const now = new Date().toISOString();
      const r = await rest(`password_resets?select=id,employee_name,used,expires_at&token_hash=eq.${token_hash}`);
      const rows = await r.json();
      const row = Array.isArray(rows) && rows.length ? rows[0] : null;
      if (!row || row.used || row.expires_at <= now) return json({ error: 'invalid_or_expired' }, 400);

      const up = await rest(`employees?name=eq.${encodeURIComponent(row.employee_name)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ pin: newPinHash })
      });
      if (!up.ok) return json({ error: 'update_failed' }, 500);
      await rest(`password_resets?employee_name=eq.${encodeURIComponent(row.employee_name)}&used=eq.false`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ used: true })
      });
      return json({ ok: true, name: row.employee_name });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (e) {
    return json({ error: String(e) }, 400);
  }
});
