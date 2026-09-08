-- ---------- Αυτόματα καθημερινά backups ----------
create extension if not exists pg_cron;

create table if not exists backups (
  id bigserial primary key,
  shop_id uuid not null references shops(id) on delete cascade,
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists backups_shop_id_idx on backups(shop_id, created_at desc);
alter table backups enable row level security;

create or replace function create_daily_backups()
returns void
language plpgsql
security definer
as $$
declare
  r record;
begin
  for r in select id from shops loop
    insert into backups (shop_id, snapshot)
    values (
      r.id,
      jsonb_build_object(
        'products', (select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) from products p where p.shop_id = r.id),
        'history', (select coalesce(jsonb_agg(to_jsonb(h)), '[]'::jsonb) from history h where h.shop_id = r.id)
      )
    );
  end loop;

  -- κράτα μόνο τα τελευταία 14 αντίγραφα ανά μαγαζί
  delete from backups b
  where b.id in (
    select id from (
      select id, row_number() over (partition by shop_id order by created_at desc) as rn
      from backups
    ) t
    where t.rn > 14
  );
end;
$$;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'kavup-daily-backup') then
    perform cron.schedule('kavup-daily-backup', '0 3 * * *', 'select create_daily_backups();');
  end if;
end $$;
