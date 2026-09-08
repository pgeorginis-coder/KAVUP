-- ---------- Σταθερή σειρά προϊόντων (πάνω/κάτω) ----------
alter table products add column if not exists sort_order bigint;
update products set sort_order = (extract(epoch from created_at) * 1000)::bigint where sort_order is null;
create index if not exists products_shop_sort_idx on products(shop_id, sort_order);

create or replace function move_product(p_product_id uuid, p_shop_id uuid, p_direction text)
returns void
language plpgsql
security definer
as $$
declare
  v_current bigint;
  v_neighbor_id uuid;
  v_neighbor_order bigint;
begin
  select sort_order into v_current from products where id = p_product_id and shop_id = p_shop_id;
  if v_current is null then
    return;
  end if;

  if p_direction = 'up' then
    select id, sort_order into v_neighbor_id, v_neighbor_order
    from products
    where shop_id = p_shop_id and sort_order < v_current
    order by sort_order desc
    limit 1;
  else
    select id, sort_order into v_neighbor_id, v_neighbor_order
    from products
    where shop_id = p_shop_id and sort_order > v_current
    order by sort_order asc
    limit 1;
  end if;

  if v_neighbor_id is null then
    return;
  end if;

  update products set sort_order = v_neighbor_order where id = p_product_id;
  update products set sort_order = v_current where id = v_neighbor_id;
end;
$$;
