-- Meseo — Endurecimiento de seguridad (jul 2026)
-- Documenta las migraciones de seguridad aplicadas a producción. El modelo
-- histórico usaba "anon key pública + allow_all" en muchas tablas (sin auth
-- real): confidencialidad e integridad nulas. Se va cerrando por partes.

-- ── B) custom_dishes: SOLO-LECTURA para anon ──────────────────────
-- Antes: allow_all (ALL) → cualquiera con la anon key podía inyectar/alterar
-- platos y sus ALÉRGENOS (relevante para seguridad alimentaria). Ahora las
-- escrituras van por la Edge Function `manage-content` (service-role), gateada
-- por el PIN de supervisor (verify_supervisor_pin). La anon key solo lee.
DROP POLICY IF EXISTS "allow_all" ON public.custom_dishes;
DROP POLICY IF EXISTS "custom_dishes_read" ON public.custom_dishes;
CREATE POLICY "custom_dishes_read" ON public.custom_dishes
  FOR SELECT TO anon, authenticated USING (true);
-- sin política de escritura → INSERT/UPDATE/DELETE denegados salvo service-role.

-- ── C) Rate-limit del PIN de supervisor ───────────────────────────
-- El hash del PIN de supervisor es bcrypt en tabla privada (no crackeable
-- offline). El único vector era fuerza bruta ONLINE contra verify_supervisor_pin
-- (sin límite). Ahora la RPC lleva rate-limit POR IP: 10 fallos/15 min → bloqueo
-- de 15 min; el acierto limpia el contador. La IP se lee de request.headers.
-- OJO: la RPC necesita search_path = public, extensions (pgcrypto vive en
-- 'extensions'); sin ello, crypt() no se resuelve.
CREATE TABLE IF NOT EXISTS public.sup_pin_attempts (
  ip           text PRIMARY KEY,
  fails        int NOT NULL DEFAULT 0,
  window_start timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz
);
ALTER TABLE public.sup_pin_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sup_pin_attempts FROM anon, authenticated;
-- verify_supervisor_pin(text) recreada con SET search_path = public, extensions
-- y el contador por IP (ver migración supervisor_pin_rate_limit). El grant a
-- anon/authenticated se mantiene (la app la sigue llamando igual).
