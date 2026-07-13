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

-- ── A) Proteger el PIN de empleado (verificación en servidor) ──────
-- Problema: employees.pin (SHA-256, sal conocida, 4 dígitos) era legible Y
-- escribible por la anon key pública → volcar+crackear u overwrite = suplantar.
-- Solución (sin migrar datos, se mantiene SHA): la app verifica/fija el PIN por
-- RPC SECURITY DEFINER y deja de leer/escribir employees.pin; luego se CIERRA la
-- columna a la anon key (SELECT/INSERT/UPDATE por columnas, sin pin).
-- RPCs (ver migraciones employee_pin_server_verify_sha + employee_has_pin_rpc):
--   verify_employee_pin_sha(name, sha_hex) → true/false/null, rate-limit /cuenta
--     (emp_pin_attempts): 10 fallos/15 min → bloqueo 15 min.
--   set_employee_pin_sha(name, sha_hex)    → fija SOLO si pin IS NULL (anti-overwrite)
--   employee_has_pin(name)                 → boolean (entrar vs crear), sin revelar hash
-- Cliente: USE_SERVER_EMP_PIN_VERIFY=true; _EMP_COLS excluye pin en las lecturas;
-- los upserts/beacon no envían pin; centinela '__srv__' para cuentas de la nube.
--
-- PASO FINAL — APLICADO (migración employees_pin_column_lockdown): la columna
-- pin queda cerrada a la anon key. Verificado en producción: anon no tiene grant
-- de SELECT/INSERT/UPDATE sobre `pin`, solo sobre las 15 columnas no sensibles;
-- las RPCs SECURITY DEFINER y el service-role conservan acceso a pin. Login en
-- vivo confirmado funcionando tras el cierre.
--   REVOKE SELECT, INSERT, UPDATE ON public.employees FROM anon, authenticated;
--   GRANT SELECT (name,xp,streak,last_study_day,topic_scores,known_dishes,
--     exam_correct,sessions_count,txoko_record,updated_at,sessions_data,
--     duel_wins,avatar,last_active_at,last_login) ON public.employees TO anon, authenticated;
--   GRANT INSERT (name,xp,streak,last_study_day,topic_scores,known_dishes,
--     exam_correct,sessions_count,txoko_record,updated_at,sessions_data,
--     duel_wins,avatar,last_active_at,last_login) ON public.employees TO anon, authenticated;
--   GRANT UPDATE (xp,streak,last_study_day,topic_scores,known_dishes,exam_correct,
--     sessions_count,txoko_record,updated_at,sessions_data,duel_wins,avatar,
--     last_active_at,last_login) ON public.employees TO anon, authenticated;
--   -- service-role (Edge Functions) y las RPCs SECURITY DEFINER conservan pin.
