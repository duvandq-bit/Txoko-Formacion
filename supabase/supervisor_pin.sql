-- ═══════════════════════════════════════════════════════════════
-- TXOKO Formación · v5.6 · Supervisor PIN — server-side verification
-- ═══════════════════════════════════════════════════════════════
--
-- Problem this fixes:
--   Until v5.6 the supervisor PIN was checked client-side by comparing
--   SHA-256(pin + 'txoko_salt_2026') against a hash hardcoded in the
--   bundle (`SUP_PIN_HASH`). A 4-digit PIN has only 10 000 combinations,
--   so anyone reading the JS could brute-force it in milliseconds.
--
-- What this script does:
--   1. Creates a private table `supervisor_pin_secret` holding a single
--      bcrypt-hashed PIN. Only the `service_role` can read/write it.
--   2. Creates the RPC `verify_supervisor_pin(pin_input text)` that
--      compares the input against the stored hash. Returns boolean.
--   3. Grants EXECUTE on the RPC to the `anon` role (so the browser
--      bundle can call it) but does NOT expose the hash itself.
--   4. Adds rudimentary rate-limit logging (optional table).
--
-- HOW TO DEPLOY
--   a) Open the Supabase dashboard → SQL editor → New query.
--   b) Paste this whole file and run it.
--   c) Set the actual PIN with:
--        SELECT set_supervisor_pin('1234');   -- replace 1234 with the real PIN
--   d) In `index.html`, set `USE_SERVER_PIN_VERIFY = true` and remove
--      the `SUP_PIN_HASH` constant + `hashPin()` fallback inside
--      `verifySupervisorPin()`.
--
-- HOW TO ROTATE THE PIN
--   Just call `set_supervisor_pin('newpin')` again. No redeploy needed.
--
-- HOW TO ROLL BACK
--   Set `USE_SERVER_PIN_VERIFY = false` in the bundle. The legacy local
--   hash compare is preserved as fallback.
-- ═══════════════════════════════════════════════════════════════

-- Required extension for crypt() / gen_salt()
create extension if not exists pgcrypto;

-- ─── 1. Storage table (private) ──────────────────────────────────
create table if not exists public.supervisor_pin_secret (
  id          smallint primary key default 1,
  pin_hash    text not null,
  updated_at  timestamptz not null default now(),
  constraint single_row check (id = 1)
);

-- Lock it down: nobody except service_role reads/writes the hash.
alter table public.supervisor_pin_secret enable row level security;
revoke all on public.supervisor_pin_secret from anon, authenticated;

-- ─── 2. RPC to set the PIN (admin-only via service_role) ─────────
create or replace function public.set_supervisor_pin(new_pin text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if length(new_pin) < 4 then
    raise exception 'PIN must be at least 4 characters';
  end if;
  insert into public.supervisor_pin_secret (id, pin_hash, updated_at)
  values (1, crypt(new_pin, gen_salt('bf', 12)), now())
  on conflict (id) do update
    set pin_hash = excluded.pin_hash,
        updated_at = excluded.updated_at;
end;
$$;

-- Only service_role (Supabase dashboard / server) can rotate the PIN.
revoke all on function public.set_supervisor_pin(text) from public, anon, authenticated;

-- ─── 3. RPC to verify the PIN (callable by anon browser bundle) ──
create or replace function public.verify_supervisor_pin(pin_input text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  stored_hash text;
begin
  if pin_input is null or length(pin_input) = 0 or length(pin_input) > 64 then
    return false;
  end if;
  select pin_hash into stored_hash from public.supervisor_pin_secret where id = 1;
  if stored_hash is null then
    return false;
  end if;
  -- bcrypt comparison: constant-time inside crypt()
  return crypt(pin_input, stored_hash) = stored_hash;
end;
$$;

-- Allow the browser (anon role) to call the verifier, but not the setter.
grant execute on function public.verify_supervisor_pin(text) to anon, authenticated;

-- ─── 4. (Optional) Rate-limit log ────────────────────────────────
-- Uncomment if you want server-side logging of failed attempts.
-- create table if not exists public.supervisor_pin_attempts (
--   id          bigserial primary key,
--   ts          timestamptz not null default now(),
--   ip          inet,
--   succeeded   boolean not null
-- );
-- alter table public.supervisor_pin_attempts enable row level security;
-- revoke all on public.supervisor_pin_attempts from anon, authenticated;

-- ═══════════════════════════════════════════════════════════════
-- Done. Now run, in a separate SQL query, with the actual PIN:
--   SELECT set_supervisor_pin('1234');
-- ═══════════════════════════════════════════════════════════════
