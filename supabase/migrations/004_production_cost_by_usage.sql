-- Freo Figures - custos de produção por consumo real
-- Filamento: R$/kg global x gramas da variação
-- Energia: R$/kWh global x horas da variação x potência (W) / 1000
-- Embalagem: R$/un da variação, com fallback para o padrão global

alter table public.fee_settings
  add column if not exists filament_price_per_kg numeric(14,4) not null default 0 check (filament_price_per_kg >= 0),
  add column if not exists energy_price_per_kwh numeric(14,4) not null default 0 check (energy_price_per_kwh >= 0),
  add column if not exists default_printer_power_watts numeric(14,4) not null default 0 check (default_printer_power_watts >= 0);

alter table public.product_variants
  add column if not exists filament_grams numeric(14,3) check (filament_grams >= 0),
  add column if not exists print_time_hours numeric(14,4) check (print_time_hours >= 0),
  add column if not exists printer_power_watts numeric(14,4) check (printer_power_watts >= 0);

-- Migra os valores globais existentes para a nova semântica.
-- No projeto atual, default_filament_cost/default_energy_cost eram os campos usados
-- para os valores informados em Configurações. Depois desta migração, os campos
-- legados ficam zerados e deixam de participar dos cálculos.
update public.fee_settings
set filament_price_per_kg = case
      when filament_price_per_kg = 0 then default_filament_cost
      else filament_price_per_kg
    end,
    energy_price_per_kwh = case
      when energy_price_per_kwh = 0 then default_energy_cost
      else energy_price_per_kwh
    end,
    default_filament_cost = 0,
    default_energy_cost = 0;

create or replace function public.prepare_sale_item() returns trigger
language plpgsql
as $$
declare
  v public.product_variants%rowtype;
  f public.fee_settings%rowtype;
  v_power_watts numeric;
begin
  select * into v
  from public.product_variants
  where id = new.variant_id and user_id = new.user_id;
  if not found then raise exception 'Variação inválida'; end if;

  select * into f
  from public.fee_settings
  where user_id = new.user_id;
  if not found then raise exception 'Configuração financeira não encontrada'; end if;

  v_power_watts := coalesce(v.printer_power_watts, f.default_printer_power_watts, 0);

  new.gross_total := round((new.unit_gross * new.quantity)::numeric, 2);
  new.filament_cost_unit := round(
    (coalesce(v.filament_grams, 0) / 1000::numeric) * coalesce(f.filament_price_per_kg, 0),
    4
  );
  new.energy_cost_unit := round(
    coalesce(v.print_time_hours, 0) * (v_power_watts / 1000::numeric) * coalesce(f.energy_price_per_kwh, 0),
    4
  );
  new.packaging_cost_unit := coalesce(v.packaging_cost, f.default_packaging_cost, 0);
  new.production_cost_unit := round(
    new.filament_cost_unit + new.energy_cost_unit + new.packaging_cost_unit,
    4
  );
  new.production_cost_total := round((new.production_cost_unit * new.quantity)::numeric, 2);
  return new;
end
$$;

create or replace function public.recalculate_all_sales_for_user(p_user_id uuid) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  if auth.uid() is distinct from p_user_id and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Não autorizado';
  end if;

  update public.sale_items si
  set filament_cost_unit = round(
        (coalesce(v.filament_grams, 0) / 1000::numeric) * coalesce(fs.filament_price_per_kg, 0),
        4
      ),
      energy_cost_unit = round(
        coalesce(v.print_time_hours, 0)
        * (coalesce(v.printer_power_watts, fs.default_printer_power_watts, 0) / 1000::numeric)
        * coalesce(fs.energy_price_per_kwh, 0),
        4
      ),
      packaging_cost_unit = coalesce(v.packaging_cost, fs.default_packaging_cost, 0),
      production_cost_unit = round(
        ((coalesce(v.filament_grams, 0) / 1000::numeric) * coalesce(fs.filament_price_per_kg, 0))
        + (coalesce(v.print_time_hours, 0)
           * (coalesce(v.printer_power_watts, fs.default_printer_power_watts, 0) / 1000::numeric)
           * coalesce(fs.energy_price_per_kwh, 0))
        + coalesce(v.packaging_cost, fs.default_packaging_cost, 0),
        4
      ),
      production_cost_total = round(
        (
          ((coalesce(v.filament_grams, 0) / 1000::numeric) * coalesce(fs.filament_price_per_kg, 0))
          + (coalesce(v.print_time_hours, 0)
             * (coalesce(v.printer_power_watts, fs.default_printer_power_watts, 0) / 1000::numeric)
             * coalesce(fs.energy_price_per_kwh, 0))
          + coalesce(v.packaging_cost, fs.default_packaging_cost, 0)
        ) * si.quantity,
        2
      )
  from public.product_variants v, public.fee_settings fs
  where si.user_id = p_user_id
    and v.id = si.variant_id
    and v.user_id = p_user_id
    and fs.user_id = p_user_id;

  for r in select id from public.sales where user_id = p_user_id loop
    perform public.recalculate_sale_totals(r.id);
  end loop;
end
$$;

-- Substitui a assinatura antiga pela nova para evitar ambiguidade no PostgREST.
drop function if exists public.update_financial_settings_transaction(uuid,numeric,numeric,numeric,numeric,numeric);

create function public.update_financial_settings_transaction(
  p_user_id uuid,
  p_commission numeric,
  p_fixed_fee numeric,
  p_filament_price_per_kg numeric,
  p_energy_price_per_kwh numeric,
  p_default_printer_power_watts numeric,
  p_default_packaging numeric
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is distinct from p_user_id and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Não autorizado';
  end if;
  if p_commission < 0 or p_commission > 100 then
    raise exception 'Comissão deve ficar entre 0 e 100';
  end if;
  if p_fixed_fee < 0
     or p_filament_price_per_kg < 0
     or p_energy_price_per_kwh < 0
     or p_default_printer_power_watts < 0
     or p_default_packaging < 0 then
    raise exception 'Taxas e parâmetros de produção não podem ser negativos';
  end if;

  update public.fee_settings
  set shopee_commission_percent = p_commission,
      shopee_fixed_fee = round(p_fixed_fee, 2),
      filament_price_per_kg = p_filament_price_per_kg,
      energy_price_per_kwh = p_energy_price_per_kwh,
      default_printer_power_watts = p_default_printer_power_watts,
      default_packaging_cost = p_default_packaging,
      default_filament_cost = 0,
      default_energy_cost = 0
  where user_id = p_user_id;

  if not found then raise exception 'Configuração financeira não encontrada'; end if;
  perform public.recalculate_all_sales_for_user(p_user_id);
end
$$;

revoke all on function public.update_financial_settings_transaction(uuid,numeric,numeric,numeric,numeric,numeric,numeric) from public, anon;
grant execute on function public.update_financial_settings_transaction(uuid,numeric,numeric,numeric,numeric,numeric,numeric) to authenticated, service_role;

drop function if exists public.update_variant_settings_transaction(uuid,uuid,text,text,boolean,numeric,numeric,numeric,integer,integer);

create function public.update_variant_settings_transaction(
  p_user_id uuid,
  p_variant_id uuid,
  p_name text,
  p_sku text,
  p_active boolean,
  p_filament_grams numeric,
  p_print_time_hours numeric,
  p_printer_power_watts numeric,
  p_packaging numeric,
  p_stock_min integer,
  p_stock_ideal integer
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is distinct from p_user_id and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Não autorizado';
  end if;
  if btrim(coalesce(p_name, '')) = '' then raise exception 'Nome da variação é obrigatório'; end if;
  if coalesce(p_filament_grams, 0) < 0
     or coalesce(p_print_time_hours, 0) < 0
     or coalesce(p_printer_power_watts, 0) < 0
     or coalesce(p_packaging, 0) < 0 then
    raise exception 'Consumo e custos não podem ser negativos';
  end if;
  if coalesce(p_stock_min, 0) < 0 or coalesce(p_stock_ideal, 0) < 0 then
    raise exception 'Estoque não pode ser negativo';
  end if;

  update public.product_variants
  set name = btrim(p_name),
      sku = nullif(btrim(coalesce(p_sku, '')), ''),
      active = coalesce(p_active, true),
      filament_grams = p_filament_grams,
      print_time_hours = p_print_time_hours,
      printer_power_watts = p_printer_power_watts,
      packaging_cost = p_packaging,
      filament_cost = null,
      energy_cost = null,
      stock_min_override = p_stock_min,
      stock_ideal_override = p_stock_ideal
  where id = p_variant_id and user_id = p_user_id;

  if not found then raise exception 'Variação não encontrada'; end if;
  perform public.recalculate_all_sales_for_user(p_user_id);
end
$$;

revoke all on function public.update_variant_settings_transaction(uuid,uuid,text,text,boolean,numeric,numeric,numeric,numeric,integer,integer) from public, anon;
grant execute on function public.update_variant_settings_transaction(uuid,uuid,text,text,boolean,numeric,numeric,numeric,numeric,integer,integer) to authenticated, service_role;

drop function if exists public.create_product_with_variant_transaction(uuid,text,jsonb,text,text,numeric,numeric,numeric);

create function public.create_product_with_variant_transaction(
  p_user_id uuid,
  p_product_name text,
  p_custom_fields jsonb,
  p_variant_name text,
  p_sku text,
  p_filament_grams numeric,
  p_print_time_hours numeric,
  p_printer_power_watts numeric,
  p_packaging numeric
) returns table(product_id uuid, variant_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_id uuid;
  v_variant_id uuid;
begin
  if auth.uid() is distinct from p_user_id and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Não autorizado';
  end if;
  if btrim(coalesce(p_product_name, '')) = '' or btrim(coalesce(p_variant_name, '')) = '' then
    raise exception 'Produto e variação são obrigatórios';
  end if;
  if coalesce(p_filament_grams, 0) < 0
     or coalesce(p_print_time_hours, 0) < 0
     or coalesce(p_printer_power_watts, 0) < 0
     or coalesce(p_packaging, 0) < 0 then
    raise exception 'Consumo e custos não podem ser negativos';
  end if;

  insert into public.products(user_id, name, custom_fields)
  values(p_user_id, btrim(p_product_name), coalesce(p_custom_fields, '{}'::jsonb))
  returning id into v_product_id;

  insert into public.product_variants(
    user_id, product_id, name, sku,
    filament_grams, print_time_hours, printer_power_watts, packaging_cost,
    filament_cost, energy_cost
  ) values(
    p_user_id, v_product_id, btrim(p_variant_name), nullif(btrim(coalesce(p_sku, '')), ''),
    p_filament_grams, p_print_time_hours, p_printer_power_watts, p_packaging,
    null, null
  )
  returning id into v_variant_id;

  return query select v_product_id, v_variant_id;
end
$$;

revoke all on function public.create_product_with_variant_transaction(uuid,text,jsonb,text,text,numeric,numeric,numeric,numeric) from public, anon;
grant execute on function public.create_product_with_variant_transaction(uuid,text,jsonb,text,text,numeric,numeric,numeric,numeric) to authenticated, service_role;

-- Recalcula todos os snapshots já existentes imediatamente, sem depender da sessão do usuário.
update public.sale_items si
set filament_cost_unit = round(
      (coalesce(v.filament_grams, 0) / 1000::numeric) * coalesce(fs.filament_price_per_kg, 0),
      4
    ),
    energy_cost_unit = round(
      coalesce(v.print_time_hours, 0)
      * (coalesce(v.printer_power_watts, fs.default_printer_power_watts, 0) / 1000::numeric)
      * coalesce(fs.energy_price_per_kwh, 0),
      4
    ),
    packaging_cost_unit = coalesce(v.packaging_cost, fs.default_packaging_cost, 0),
    production_cost_unit = round(
      ((coalesce(v.filament_grams, 0) / 1000::numeric) * coalesce(fs.filament_price_per_kg, 0))
      + (coalesce(v.print_time_hours, 0)
         * (coalesce(v.printer_power_watts, fs.default_printer_power_watts, 0) / 1000::numeric)
         * coalesce(fs.energy_price_per_kwh, 0))
      + coalesce(v.packaging_cost, fs.default_packaging_cost, 0),
      4
    ),
    production_cost_total = round(
      (
        ((coalesce(v.filament_grams, 0) / 1000::numeric) * coalesce(fs.filament_price_per_kg, 0))
        + (coalesce(v.print_time_hours, 0)
           * (coalesce(v.printer_power_watts, fs.default_printer_power_watts, 0) / 1000::numeric)
           * coalesce(fs.energy_price_per_kwh, 0))
        + coalesce(v.packaging_cost, fs.default_packaging_cost, 0)
      ) * si.quantity,
      2
    )
from public.product_variants v, public.fee_settings fs
where v.id = si.variant_id
  and v.user_id = si.user_id
  and fs.user_id = si.user_id;

with totals as (
  select
    s.id,
    coalesce(round(sum(si.gross_total), 2), 0)::numeric(16,2) as gross_total,
    coalesce(round(sum(si.production_cost_total), 2), 0)::numeric(16,2) as production_cost_total,
    fs.shopee_commission_percent,
    fs.shopee_fixed_fee
  from public.sales s
  join public.fee_settings fs on fs.user_id = s.user_id
  left join public.sale_items si on si.sale_id = s.id
  group by s.id, fs.shopee_commission_percent, fs.shopee_fixed_fee
), calculated as (
  select
    id,
    gross_total,
    production_cost_total,
    round(gross_total * coalesce(shopee_commission_percent, 0) / 100, 2) as percent_fee,
    round(round(gross_total * coalesce(shopee_commission_percent, 0) / 100, 2) + coalesce(shopee_fixed_fee, 0), 2) as fee_total
  from totals
)
update public.sales s
set gross_total = c.gross_total,
    shopee_fee_total = c.fee_total,
    shopee_net_total = round(c.gross_total - c.fee_total, 2),
    production_cost_total = c.production_cost_total,
    net_profit_total = round((c.gross_total - c.fee_total) - c.production_cost_total, 2)
from calculated c
where c.id = s.id;

notify pgrst, 'reload schema';
