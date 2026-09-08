-- =========================================================
-- KAVUP — Database schema
-- Επικόλλησέ το ΟΛΟΚΛΗΡΟ στο: Supabase Dashboard → SQL Editor → New query → Run
-- =========================================================

create extension if not exists pgcrypto;

-- ---------- Shops ----------
create table if not exists shops (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_key text generated always as (lower(trim(name))) stored,
  admin_password_hash text not null,
  viewer_password_hash text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists shops_name_key_idx on shops (name_key);

-- ---------- Products ----------
create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  name text not null,
  category text not null default 'other',
  qty integer not null default 0,
  par integer not null default 0,
  price numeric,
  photo_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists products_shop_id_idx on products(shop_id);

-- ---------- History (κινήσεις ποσότητας) ----------
create table if not exists history (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  product_id uuid references products(id) on delete set null,
  product_name text,
  before integer,
  after integer,
  delta integer,
  role text,
  created_at timestamptz not null default now()
);
create index if not exists history_shop_id_idx on history(shop_id);

-- ---------- Sessions (αντί για JWT — απλό, ελεγχόμενο token) ----------
create table if not exists sessions (
  token uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  role text not null check (role in ('admin','viewer')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days')
);
create index if not exists sessions_shop_id_idx on sessions(shop_id);

-- ---------- Login attempts (rate limiting) ----------
create table if not exists login_attempts (
  id bigserial primary key,
  name_key text not null,
  success boolean not null,
  created_at timestamptz not null default now()
);
create index if not exists login_attempts_namekey_idx on login_attempts(name_key, created_at);

-- ---------- Audit log (χωρίς κωδικούς/tokens) ----------
create table if not exists audit_log (
  id bigserial primary key,
  shop_id uuid references shops(id) on delete set null,
  role text,
  action text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_shop_id_idx on audit_log(shop_id);

-- =========================================================
-- Row Level Security: ενεργό παντού, ΧΩΡΙΣ κανένα policy.
-- Αυτό σημαίνει: καμία απευθείας πρόσβαση από τον browser (anon key),
-- ό,τι κι αν προσπαθήσει κανείς. Μόνο ο server-side κώδικας (Edge Function),
-- που χρησιμοποιεί το service_role key ΕΣΩΤΕΡΙΚΑ στο Supabase, μπορεί να διαβάσει/γράψει.
-- =========================================================
alter table shops enable row level security;
alter table products enable row level security;
alter table history enable row level security;
alter table sessions enable row level security;
alter table login_attempts enable row level security;
alter table audit_log enable row level security;

-- ---------- Storage bucket για φωτογραφίες προϊόντων (ιδιωτικό) ----------
insert into storage.buckets (id, name, public)
values ('product-photos', 'product-photos', false)
on conflict (id) do nothing;

-- ---------- Γρήγορη, ατομική αλλαγή ποσότητας (ένα round-trip αντί για δύο) ----------
create or replace function adjust_product_qty(p_product_id uuid, p_shop_id uuid, p_delta int)
returns table(name text, before_qty int, after_qty int)
language plpgsql
security definer
as $$
declare
  v_before int;
  v_name text;
  v_after int;
begin
  select qty, products.name into v_before, v_name
  from products where id = p_product_id and shop_id = p_shop_id
  for update;

  if not found then
    return;
  end if;

  v_after := greatest(0, v_before + p_delta);
  update products set qty = v_after, updated_at = now() where id = p_product_id;

  return query select v_name, v_before, v_after;
end;
$$;
