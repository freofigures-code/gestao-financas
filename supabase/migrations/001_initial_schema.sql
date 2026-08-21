-- Freo Figures: schema financeiro e operacional
create extension if not exists pgcrypto;

create type public.sale_status as enum ('pending','paid','cancelled','refunded');
create type public.entry_type as enum ('income','expense');
create type public.sale_source as enum ('manual','csv','integration');

create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.months_control (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  year smallint not null check(year between 2000 and 2200), month smallint not null check(month between 1 and 12),
  created_at timestamptz not null default now(), unique(user_id,year,month)
);
create table public.fee_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  shopee_commission_percent numeric(7,4) not null default 20 check(shopee_commission_percent between 0 and 100),
  shopee_fixed_fee numeric(14,2) not null default 0 check(shopee_fixed_fee>=0),
  default_filament_cost numeric(14,4) not null default 0 check(default_filament_cost>=0),
  default_energy_cost numeric(14,4) not null default 0 check(default_energy_cost>=0),
  default_packaging_cost numeric(14,4) not null default 0 check(default_packaging_cost>=0),
  updated_at timestamptz not null default now()
);
create table public.integration_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  shopee_api_key_ciphertext text,
  ai_enabled boolean not null default false,
  ai_provider text not null default 'webhook' check(ai_provider in ('webhook','openai','anthropic','xai')),
  ai_model text,
  ai_api_key_ciphertext text,
  ai_webhook_url text,
  n8n_ingest_secret_hash text unique,
  updated_at timestamptz not null default now()
);
create table public.categories (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  type public.entry_type not null, name text not null, is_system boolean not null default false,
  created_at timestamptz not null default now(), unique(user_id,type,name), unique(id,user_id)
);
create table public.products (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  name text not null, description text, active boolean not null default true, source text not null default 'manual',
  custom_fields jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(user_id,name), unique(id,user_id)
);
create table public.product_variants (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null, name text not null, sku text, active boolean not null default true,
  filament_cost numeric(14,4) check(filament_cost>=0), energy_cost numeric(14,4) check(energy_cost>=0), packaging_cost numeric(14,4) check(packaging_cost>=0),
  stock_min_override integer check(stock_min_override>=0), stock_ideal_override integer check(stock_ideal_override>=0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(user_id,product_id,name), unique(user_id,sku), unique(id,user_id),
  foreign key(product_id,user_id) references public.products(id,user_id) on delete cascade
);
create table public.sales (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  order_sn text not null, sold_at date not null, status public.sale_status not null default 'paid', source public.sale_source not null default 'manual',
  gross_total numeric(16,2) not null default 0, shopee_fee_total numeric(16,2) not null default 0,
  shopee_net_total numeric(16,2) not null default 0, production_cost_total numeric(16,2) not null default 0, net_profit_total numeric(16,2) not null default 0,
  custom_fields jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(user_id,order_sn), unique(id,user_id)
);
create table public.sale_items (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  sale_id uuid not null, variant_id uuid not null, quantity integer not null check(quantity>0), unit_gross numeric(16,2) not null check(unit_gross>=0), gross_total numeric(16,2) not null default 0,
  filament_cost_unit numeric(14,4) not null default 0, energy_cost_unit numeric(14,4) not null default 0, packaging_cost_unit numeric(14,4) not null default 0,
  production_cost_unit numeric(14,4) not null default 0, production_cost_total numeric(16,2) not null default 0,
  product_name_snapshot text not null, variant_name_snapshot text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(sale_id,user_id) references public.sales(id,user_id) on delete cascade,
  foreign key(variant_id,user_id) references public.product_variants(id,user_id)
);
create table public.expenses (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  category_id uuid not null, spent_at date not null, description text not null, amount numeric(16,2) not null check(amount>=0),
  custom_fields jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(category_id,user_id) references public.categories(id,user_id)
);
create table public.income (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  category_id uuid not null, received_at date not null, description text not null, amount numeric(16,2) not null check(amount>=0),
  custom_fields jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(category_id,user_id) references public.categories(id,user_id)
);
create table public.stock_suggestions (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade, variant_id uuid not null,
  window_days smallint not null check(window_days in (30,60,90)), avg_daily_sales numeric(14,4) not null default 0,
  suggested_min integer not null default 0 check(suggested_min>=0), suggested_ideal integer not null default 0 check(suggested_ideal>=0), calculated_at timestamptz not null default now(),
  unique(user_id,variant_id,window_days), foreign key(variant_id,user_id) references public.product_variants(id,user_id) on delete cascade
);
create table public.ai_analyses (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade, month_date date not null,
  provider text not null, content text not null, payload jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create table public.custom_columns (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  table_name text not null check(table_name in ('sales','products','expenses','income')), key text not null check(key ~ '^[a-z][a-z0-9_]*$'), label text not null,
  data_type text not null default 'text' check(data_type in ('text','number','date','boolean')), position integer not null default 0, created_at timestamptz not null default now(),
  unique(user_id,table_name,key)
);

create index sales_user_date_idx on public.sales(user_id,sold_at desc);
create index sales_user_status_date_idx on public.sales(user_id,status,sold_at desc);
create index sale_items_user_sale_idx on public.sale_items(user_id,sale_id);
create index sale_items_user_variant_idx on public.sale_items(user_id,variant_id);
create index expenses_user_date_idx on public.expenses(user_id,spent_at desc);
create index income_user_date_idx on public.income(user_id,received_at desc);
create index variants_user_product_idx on public.product_variants(user_id,product_id);
create index ai_user_month_idx on public.ai_analyses(user_id,month_date desc);

create or replace function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end $$;
create trigger users_updated before update on public.users for each row execute function public.set_updated_at();
create trigger fees_updated before update on public.fee_settings for each row execute function public.set_updated_at();
create trigger integrations_updated before update on public.integration_settings for each row execute function public.set_updated_at();
create trigger products_updated before update on public.products for each row execute function public.set_updated_at();
create trigger variants_updated before update on public.product_variants for each row execute function public.set_updated_at();
create trigger sales_updated before update on public.sales for each row execute function public.set_updated_at();
create trigger sale_items_updated before update on public.sale_items for each row execute function public.set_updated_at();
create trigger expenses_updated before update on public.expenses for each row execute function public.set_updated_at();
create trigger income_updated before update on public.income for each row execute function public.set_updated_at();

create or replace function public.guard_not_future_date() returns trigger language plpgsql as $$
declare d date;
begin
  if tg_table_name='sales' then d:=new.sold_at; elsif tg_table_name='expenses' then d:=new.spent_at; elsif tg_table_name='income' then d:=new.received_at; elsif tg_table_name='ai_analyses' then d:=new.month_date; end if;
  if d>(now() at time zone 'America/Sao_Paulo')::date then raise exception 'Não é permitido cadastrar ou alterar dados em datas futuras'; end if;
  return new;
end $$;
create trigger sales_no_future before insert or update on public.sales for each row execute function public.guard_not_future_date();
create trigger expenses_no_future before insert or update on public.expenses for each row execute function public.guard_not_future_date();
create trigger income_no_future before insert or update on public.income for each row execute function public.guard_not_future_date();
create trigger ai_no_future before insert or update on public.ai_analyses for each row execute function public.guard_not_future_date();
create or replace function public.guard_not_future_month() returns trigger language plpgsql as $$ begin if make_date(new.year,new.month,1)>date_trunc('month',(now() at time zone 'America/Sao_Paulo'))::date then raise exception 'Mês futuro não permitido'; end if; return new; end $$;
create trigger months_no_future before insert or update on public.months_control for each row execute function public.guard_not_future_month();

create or replace function public.prepare_sale_item() returns trigger language plpgsql as $$
declare v public.product_variants%rowtype; f public.fee_settings%rowtype;
begin
 select * into v from public.product_variants where id=new.variant_id and user_id=new.user_id;
 if not found then raise exception 'Variação inválida'; end if;
 select * into f from public.fee_settings where user_id=new.user_id;
 new.gross_total:=round((new.unit_gross*new.quantity)::numeric,2);
 new.filament_cost_unit:=coalesce(v.filament_cost,f.default_filament_cost,0);
 new.energy_cost_unit:=coalesce(v.energy_cost,f.default_energy_cost,0);
 new.packaging_cost_unit:=coalesce(v.packaging_cost,f.default_packaging_cost,0);
 new.production_cost_unit:=new.filament_cost_unit+new.energy_cost_unit+new.packaging_cost_unit;
 new.production_cost_total:=round((new.production_cost_unit*new.quantity)::numeric,2);
 return new;
end $$;
create trigger sale_item_prepare before insert or update of variant_id,quantity,unit_gross on public.sale_items for each row execute function public.prepare_sale_item();

create or replace function public.recalculate_sale_totals(p_sale_id uuid) returns void language plpgsql as $$
declare s public.sales%rowtype; fs public.fee_settings%rowtype; g numeric(16,2); c numeric(16,2); pct_fee numeric(16,2); fees numeric(16,2);
begin
 select * into s from public.sales where id=p_sale_id; if not found then return; end if;
 select * into fs from public.fee_settings where user_id=s.user_id;
 select coalesce(round(sum(gross_total),2),0),coalesce(round(sum(production_cost_total),2),0) into g,c from public.sale_items where sale_id=p_sale_id;
 pct_fee:=round(g*coalesce(fs.shopee_commission_percent,0)/100,2);
 fees:=round(pct_fee+coalesce(fs.shopee_fixed_fee,0),2);
 update public.sales set gross_total=g,shopee_fee_total=fees,shopee_net_total=round(g-fees,2),production_cost_total=c,net_profit_total=round((g-fees)-c,2) where id=p_sale_id;
end $$;
create or replace function public.sale_item_recalc_trigger() returns trigger language plpgsql as $$ begin if tg_op='DELETE' then perform public.recalculate_sale_totals(old.sale_id); return old; else perform public.recalculate_sale_totals(new.sale_id); return new; end if; end $$;
create trigger sale_item_recalc after insert or update or delete on public.sale_items for each row execute function public.sale_item_recalc_trigger();

create or replace function public.recalculate_all_sales_for_user(p_user_id uuid) returns void language plpgsql security definer set search_path=public as $$
declare r record;
begin
 if auth.uid() is distinct from p_user_id and coalesce(auth.role(),'')<>'service_role' then raise exception 'Não autorizado'; end if;
 -- atualiza snapshot dos custos das peças com os custos atuais
 update public.sale_items si set filament_cost_unit=coalesce(v.filament_cost,fs.default_filament_cost,0),energy_cost_unit=coalesce(v.energy_cost,fs.default_energy_cost,0),packaging_cost_unit=coalesce(v.packaging_cost,fs.default_packaging_cost,0),production_cost_unit=coalesce(v.filament_cost,fs.default_filament_cost,0)+coalesce(v.energy_cost,fs.default_energy_cost,0)+coalesce(v.packaging_cost,fs.default_packaging_cost,0),production_cost_total=round((coalesce(v.filament_cost,fs.default_filament_cost,0)+coalesce(v.energy_cost,fs.default_energy_cost,0)+coalesce(v.packaging_cost,fs.default_packaging_cost,0))*si.quantity,2)
 from public.product_variants v,public.fee_settings fs where si.user_id=p_user_id and v.id=si.variant_id and fs.user_id=p_user_id;
 for r in select id from public.sales where user_id=p_user_id loop perform public.recalculate_sale_totals(r.id); end loop;
end $$;

create or replace function public.update_financial_settings_transaction(
  p_user_id uuid,
  p_commission numeric,
  p_fixed_fee numeric,
  p_default_filament numeric,
  p_default_energy numeric,
  p_default_packaging numeric
) returns void
language plpgsql
security definer
set search_path=public
as $$
begin
  if auth.uid() is distinct from p_user_id and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Não autorizado';
  end if;
  if p_commission < 0 or p_commission > 100 then raise exception 'Comissão deve ficar entre 0 e 100'; end if;
  if p_fixed_fee < 0 or p_default_filament < 0 or p_default_energy < 0 or p_default_packaging < 0 then
    raise exception 'Custos e taxa fixa não podem ser negativos';
  end if;

  update public.fee_settings
  set shopee_commission_percent=p_commission,
      shopee_fixed_fee=round(p_fixed_fee,2),
      default_filament_cost=p_default_filament,
      default_energy_cost=p_default_energy,
      default_packaging_cost=p_default_packaging
  where user_id=p_user_id;
  if not found then raise exception 'Configuração financeira não encontrada'; end if;

  perform public.recalculate_all_sales_for_user(p_user_id);
end $$;
revoke all on function public.update_financial_settings_transaction(uuid,numeric,numeric,numeric,numeric,numeric) from public,anon;
grant execute on function public.update_financial_settings_transaction(uuid,numeric,numeric,numeric,numeric,numeric) to authenticated,service_role;

create or replace function public.update_variant_settings_transaction(
  p_user_id uuid,
  p_variant_id uuid,
  p_name text,
  p_sku text,
  p_active boolean,
  p_filament numeric,
  p_energy numeric,
  p_packaging numeric,
  p_stock_min integer,
  p_stock_ideal integer
) returns void
language plpgsql
security definer
set search_path=public
as $$
begin
  if auth.uid() is distinct from p_user_id and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Não autorizado';
  end if;
  if btrim(coalesce(p_name,''))='' then raise exception 'Nome da variação é obrigatório'; end if;
  if coalesce(p_filament,0)<0 or coalesce(p_energy,0)<0 or coalesce(p_packaging,0)<0 then raise exception 'Custos não podem ser negativos'; end if;
  if coalesce(p_stock_min,0)<0 or coalesce(p_stock_ideal,0)<0 then raise exception 'Estoque não pode ser negativo'; end if;

  update public.product_variants
  set name=btrim(p_name),sku=nullif(btrim(coalesce(p_sku,'')),''),active=coalesce(p_active,true),
      filament_cost=p_filament,energy_cost=p_energy,packaging_cost=p_packaging,
      stock_min_override=p_stock_min,stock_ideal_override=p_stock_ideal
  where id=p_variant_id and user_id=p_user_id;
  if not found then raise exception 'Variação não encontrada'; end if;

  perform public.recalculate_all_sales_for_user(p_user_id);
end $$;
revoke all on function public.update_variant_settings_transaction(uuid,uuid,text,text,boolean,numeric,numeric,numeric,integer,integer) from public,anon;
grant execute on function public.update_variant_settings_transaction(uuid,uuid,text,text,boolean,numeric,numeric,numeric,integer,integer) to authenticated,service_role;

create or replace function public.create_product_with_variant_transaction(
  p_user_id uuid,
  p_product_name text,
  p_custom_fields jsonb,
  p_variant_name text,
  p_sku text,
  p_filament numeric,
  p_energy numeric,
  p_packaging numeric
) returns table(product_id uuid,variant_id uuid)
language plpgsql
security definer
set search_path=public
as $$
declare
  v_product_id uuid;
  v_variant_id uuid;
begin
  if auth.uid() is distinct from p_user_id and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Não autorizado';
  end if;
  if btrim(coalesce(p_product_name,''))='' or btrim(coalesce(p_variant_name,''))='' then raise exception 'Produto e variação são obrigatórios'; end if;
  if coalesce(p_filament,0)<0 or coalesce(p_energy,0)<0 or coalesce(p_packaging,0)<0 then raise exception 'Custos não podem ser negativos'; end if;

  insert into public.products(user_id,name,custom_fields)
  values(p_user_id,btrim(p_product_name),coalesce(p_custom_fields,'{}'::jsonb))
  returning id into v_product_id;

  insert into public.product_variants(user_id,product_id,name,sku,filament_cost,energy_cost,packaging_cost)
  values(p_user_id,v_product_id,btrim(p_variant_name),nullif(btrim(coalesce(p_sku,'')),''),p_filament,p_energy,p_packaging)
  returning id into v_variant_id;

  return query select v_product_id,v_variant_id;
end $$;
revoke all on function public.create_product_with_variant_transaction(uuid,text,jsonb,text,text,numeric,numeric,numeric) from public,anon;
grant execute on function public.create_product_with_variant_transaction(uuid,text,jsonb,text,text,numeric,numeric,numeric) to authenticated,service_role;


create or replace function public.ingest_sale_transaction(
  p_user_id uuid,
  p_order_sn text,
  p_sold_at date,
  p_status public.sale_status,
  p_source public.sale_source,
  p_items jsonb
) returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare
  v_sale_id uuid;
  v_product_id uuid;
  v_variant_id uuid;
  v_item jsonb;
  v_sku text;
  v_product text;
  v_variant text;
  v_qty integer;
  v_unit numeric(16,2);
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Função restrita ao backend de integração';
  end if;
  if p_order_sn is null or btrim(p_order_sn)='' then raise exception 'order_sn obrigatório'; end if;
  if p_sold_at is null then raise exception 'sold_at obrigatório'; end if;
  if p_status is null then raise exception 'status obrigatório'; end if;
  if p_sold_at > (now() at time zone 'America/Sao_Paulo')::date then raise exception 'Venda futura não permitida'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items)=0 then raise exception 'Pedido sem itens'; end if;

  insert into public.sales(user_id,order_sn,sold_at,status,source)
  values(p_user_id,btrim(p_order_sn),p_sold_at,p_status,p_source)
  on conflict(user_id,order_sn) do update set sold_at=excluded.sold_at,status=excluded.status,source=excluded.source
  returning id into v_sale_id;

  delete from public.sale_items where sale_id=v_sale_id and user_id=p_user_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_sku:=nullif(btrim(coalesce(v_item->>'sku','')),'');
    v_product:=btrim(coalesce(v_item->>'product',''));
    v_variant:=coalesce(nullif(btrim(coalesce(v_item->>'variant','')),''),'Padrão');
    if v_product='' then raise exception 'Nome de produto obrigatório'; end if;
    begin v_qty:=(v_item->>'quantity')::integer; exception when others then raise exception 'Quantidade inválida'; end;
    if v_qty<=0 then raise exception 'Quantidade deve ser maior que zero'; end if;
    begin v_unit:=(v_item->>'unit_gross')::numeric(16,2); exception when others then raise exception 'unit_gross inválido'; end;
    if v_unit<0 then raise exception 'unit_gross não pode ser negativo'; end if;

    v_variant_id:=null;
    if v_sku is not null then
      select id into v_variant_id from public.product_variants where user_id=p_user_id and sku=v_sku;
    end if;

    if v_variant_id is null then
      select id into v_product_id from public.products where user_id=p_user_id and name=v_product;
      if v_product_id is null then
        insert into public.products(user_id,name,source) values(p_user_id,v_product,'integration') returning id into v_product_id;
      end if;
      select id into v_variant_id from public.product_variants where user_id=p_user_id and product_id=v_product_id and name=v_variant;
      if v_variant_id is null then
        insert into public.product_variants(user_id,product_id,name,sku) values(p_user_id,v_product_id,v_variant,v_sku) returning id into v_variant_id;
      end if;
    end if;

    insert into public.sale_items(user_id,sale_id,variant_id,quantity,unit_gross,product_name_snapshot,variant_name_snapshot)
    values(p_user_id,v_sale_id,v_variant_id,v_qty,v_unit,v_product,v_variant);
  end loop;
  perform public.recalculate_sale_totals(v_sale_id);
  return v_sale_id;
end $$;
revoke all on function public.ingest_sale_transaction(uuid,text,date,public.sale_status,public.sale_source,jsonb) from public,anon,authenticated;
grant execute on function public.ingest_sale_transaction(uuid,text,date,public.sale_status,public.sale_source,jsonb) to service_role;


create or replace function public.ingest_sales_batch(
  p_user_id uuid,
  p_sales jsonb,
  p_source public.sale_source default 'csv'
) returns integer
language plpgsql
security definer
set search_path=public
as $$
declare
  v_sale jsonb;
  v_count integer:=0;
  v_status public.sale_status;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Função restrita ao backend de integração';
  end if;
  if jsonb_typeof(p_sales) <> 'array' or jsonb_array_length(p_sales)=0 then
    raise exception 'Lote de vendas vazio';
  end if;

  for v_sale in select value from jsonb_array_elements(p_sales)
  loop
    if nullif(btrim(coalesce(v_sale->>'status','')),'') is null then
      raise exception 'Status obrigatório no pedido %',coalesce(v_sale->>'order_sn','sem Order SN');
    end if;
    begin
      v_status:=(v_sale->>'status')::public.sale_status;
    exception when others then
      raise exception 'Status inválido no pedido %',coalesce(v_sale->>'order_sn','sem Order SN');
    end;

    perform public.ingest_sale_transaction(
      p_user_id,
      v_sale->>'order_sn',
      (v_sale->>'sold_at')::date,
      v_status,
      p_source,
      v_sale->'items'
    );
    v_count:=v_count+1;
  end loop;
  return v_count;
end $$;
revoke all on function public.ingest_sales_batch(uuid,jsonb,public.sale_source) from public,anon,authenticated;
grant execute on function public.ingest_sales_batch(uuid,jsonb,public.sale_source) to service_role;


create or replace function public.create_manual_sale_transaction(
  p_user_id uuid,
  p_order_sn text,
  p_sold_at date,
  p_status public.sale_status,
  p_custom_fields jsonb,
  p_items jsonb
) returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare
  v_sale_id uuid;
  v_item jsonb;
  v_variant_id uuid;
  v_quantity integer;
  v_unit_gross numeric(16,2);
  v_product_name text;
  v_variant_name text;
begin
  if auth.uid() is distinct from p_user_id and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Não autorizado';
  end if;
  if p_sold_at is null then raise exception 'sold_at obrigatório'; end if;
  if p_status is null then raise exception 'status obrigatório'; end if;
  if p_sold_at > (now() at time zone 'America/Sao_Paulo')::date then raise exception 'Venda futura não permitida'; end if;
  if p_order_sn is null or btrim(p_order_sn)='' then raise exception 'order_sn obrigatório'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items)=0 then raise exception 'Pedido sem itens'; end if;

  insert into public.sales(user_id,order_sn,sold_at,status,source,custom_fields)
  values(p_user_id,btrim(p_order_sn),p_sold_at,p_status,'manual',coalesce(p_custom_fields,'{}'::jsonb))
  returning id into v_sale_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    begin v_variant_id=(v_item->>'variant_id')::uuid; exception when others then raise exception 'Variação inválida'; end;
    begin v_quantity=(v_item->>'quantity')::integer; exception when others then raise exception 'Quantidade inválida'; end;
    begin v_unit_gross=(v_item->>'unit_gross')::numeric(16,2); exception when others then raise exception 'Valor unitário inválido'; end;
    if v_quantity<=0 then raise exception 'Quantidade deve ser maior que zero'; end if;
    if v_unit_gross<0 then raise exception 'Valor bruto não pode ser negativo'; end if;

    select p.name,v.name into v_product_name,v_variant_name
    from public.product_variants v
    join public.products p on p.id=v.product_id and p.user_id=v.user_id
    where v.id=v_variant_id and v.user_id=p_user_id and v.active=true and p.active=true;
    if not found then raise exception 'Variação inexistente ou inativa'; end if;

    insert into public.sale_items(user_id,sale_id,variant_id,quantity,unit_gross,product_name_snapshot,variant_name_snapshot)
    values(p_user_id,v_sale_id,v_variant_id,v_quantity,v_unit_gross,v_product_name,v_variant_name);
  end loop;

  perform public.recalculate_sale_totals(v_sale_id);
  return v_sale_id;
end $$;
revoke all on function public.create_manual_sale_transaction(uuid,text,date,public.sale_status,jsonb,jsonb) from public,anon;
grant execute on function public.create_manual_sale_transaction(uuid,text,date,public.sale_status,jsonb,jsonb) to authenticated,service_role;

create or replace function public.update_manual_sale_transaction(
  p_user_id uuid,
  p_sale_id uuid,
  p_sold_at date,
  p_status public.sale_status,
  p_custom_fields jsonb,
  p_items jsonb
) returns void
language plpgsql
security definer
set search_path=public
as $$
declare
  v_item jsonb;
  v_item_id uuid;
  v_quantity integer;
  v_unit_gross numeric(16,2);
begin
  if auth.uid() is distinct from p_user_id and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Não autorizado';
  end if;
  if p_sold_at is null then raise exception 'sold_at obrigatório'; end if;
  if p_status is null then raise exception 'status obrigatório'; end if;
  if p_sold_at > (now() at time zone 'America/Sao_Paulo')::date then raise exception 'Venda futura não permitida'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items)=0 then raise exception 'Pedido sem itens'; end if;

  update public.sales
  set sold_at=p_sold_at,status=p_status,custom_fields=coalesce(p_custom_fields,'{}'::jsonb)
  where id=p_sale_id and user_id=p_user_id;
  if not found then raise exception 'Venda não encontrada'; end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    begin v_item_id=(v_item->>'id')::uuid; exception when others then raise exception 'ID de item inválido'; end;
    begin v_quantity=(v_item->>'quantity')::integer; exception when others then raise exception 'Quantidade inválida'; end;
    begin v_unit_gross=(v_item->>'unit_gross')::numeric(16,2); exception when others then raise exception 'Valor unitário inválido'; end;
    if v_quantity<=0 then raise exception 'Quantidade deve ser maior que zero'; end if;
    if v_unit_gross<0 then raise exception 'Valor unitário não pode ser negativo'; end if;

    update public.sale_items
    set quantity=v_quantity,unit_gross=v_unit_gross
    where id=v_item_id and sale_id=p_sale_id and user_id=p_user_id;
    if not found then raise exception 'Item da venda não encontrado'; end if;
  end loop;

  perform public.recalculate_sale_totals(p_sale_id);
end $$;
revoke all on function public.update_manual_sale_transaction(uuid,uuid,date,public.sale_status,jsonb,jsonb) from public,anon;
grant execute on function public.update_manual_sale_transaction(uuid,uuid,date,public.sale_status,jsonb,jsonb) to authenticated,service_role;

create or replace function public.get_month_summary(p_month date) returns table(gross_total numeric,shopee_net_total numeric,production_cost_total numeric,net_profit_total numeric,cashflow_result numeric,average_ticket numeric,orders_count bigint) language sql stable security invoker as $$
with bounds as(select date_trunc('month',p_month)::date s,(date_trunc('month',p_month)+interval '1 month')::date e), sv as(select coalesce(sum(gross_total),0) g,coalesce(sum(shopee_net_total),0)n,coalesce(sum(production_cost_total),0)c,coalesce(sum(net_profit_total),0)p,count(*) cnt from public.sales,bounds where sold_at>=s and sold_at<e and status='paid'), inc as(select coalesce(sum(amount),0)x from public.income,bounds where received_at>=s and received_at<e), exp as(select coalesce(sum(amount),0)x from public.expenses,bounds where spent_at>=s and spent_at<e) select round(g,2),round(n,2),round(c,2),round(p,2),round(n+inc.x-exp.x,2),case when cnt=0 then 0 else round(g/cnt,2) end,cnt from sv,inc,exp $$;
create or replace function public.get_daily_sales(p_month date) returns table(day date,gross_total numeric,net_total numeric,profit_total numeric) language sql stable security invoker as $$ with b as(select date_trunc('month',p_month)::date s,(date_trunc('month',p_month)+interval '1 month')::date e) select sold_at,round(sum(gross_total),2),round(sum(shopee_net_total),2),round(sum(net_profit_total),2) from public.sales,b where sold_at>=s and sold_at<e and status='paid' group by sold_at order by sold_at $$;
create or replace function public.get_top_products(p_month date,p_limit integer default 5) returns table(product_id uuid,product_name text,quantity bigint,revenue numeric) language sql stable security invoker as $$ with b as(select date_trunc('month',p_month)::date s,(date_trunc('month',p_month)+interval '1 month')::date e) select p.id,p.name,sum(si.quantity)::bigint,round(sum(si.gross_total),2) from public.sale_items si join public.sales s on s.id=si.sale_id join public.product_variants v on v.id=si.variant_id join public.products p on p.id=v.product_id,b where s.sold_at>=b.s and s.sold_at<b.e and s.status='paid' group by p.id,p.name order by sum(si.quantity) desc,sum(si.gross_total) desc limit greatest(p_limit,1) $$;

create or replace function public.get_variant_sales_stats(p_month date) returns table(variant_id uuid,product_name text,variant_name text,quantity bigint,revenue numeric) language sql stable security invoker as $$ with b as(select date_trunc('month',p_month)::date s,(date_trunc('month',p_month)+interval '1 month')::date e) select v.id,p.name,v.name,sum(si.quantity)::bigint,round(sum(si.gross_total),2) from public.sale_items si join public.sales s on s.id=si.sale_id join public.product_variants v on v.id=si.variant_id join public.products p on p.id=v.product_id,b where s.sold_at>=b.s and s.sold_at<b.e and s.status='paid' group by v.id,p.name,v.name order by sum(si.quantity) desc,sum(si.gross_total) desc $$;

create or replace function public.refresh_stock_suggestions(p_user_id uuid) returns void language plpgsql security definer set search_path=public as $$
declare w int;
begin if auth.uid() is distinct from p_user_id and coalesce(auth.role(),'')<>'service_role' then raise exception 'Não autorizado'; end if; foreach w in array array[30,60,90] loop insert into public.stock_suggestions(user_id,variant_id,window_days,avg_daily_sales,suggested_min,suggested_ideal,calculated_at) select p_user_id,v.id,w,coalesce(sum(case when s.sold_at>(now() at time zone 'America/Sao_Paulo')::date-w then si.quantity else 0 end),0)::numeric/w,ceil(coalesce(sum(case when s.sold_at>(now() at time zone 'America/Sao_Paulo')::date-w then si.quantity else 0 end),0)::numeric/w*7)::int,ceil(coalesce(sum(case when s.sold_at>(now() at time zone 'America/Sao_Paulo')::date-w then si.quantity else 0 end),0)::numeric/w*21)::int,now() from public.product_variants v left join public.sale_items si on si.variant_id=v.id left join public.sales s on s.id=si.sale_id and s.status='paid' where v.user_id=p_user_id group by v.id on conflict(user_id,variant_id,window_days) do update set avg_daily_sales=excluded.avg_daily_sales,suggested_min=excluded.suggested_min,suggested_ideal=excluded.suggested_ideal,calculated_at=now(); end loop; end $$;

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path=public as $$ begin insert into public.users(id) values(new.id); insert into public.fee_settings(user_id) values(new.id); insert into public.integration_settings(user_id) values(new.id); insert into public.categories(user_id,type,name,is_system) values (new.id,'expense','Filamento',true),(new.id,'expense','Marketing / Ads',true),(new.id,'expense','Ferramentas',true),(new.id,'expense','Embalagens',true),(new.id,'expense','Energia',true),(new.id,'expense','Outros',true),(new.id,'income','Outras entradas',true); return new; end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

alter table public.users enable row level security; alter table public.months_control enable row level security; alter table public.fee_settings enable row level security; alter table public.integration_settings enable row level security; alter table public.categories enable row level security; alter table public.products enable row level security; alter table public.product_variants enable row level security; alter table public.sales enable row level security; alter table public.sale_items enable row level security; alter table public.expenses enable row level security; alter table public.income enable row level security; alter table public.stock_suggestions enable row level security; alter table public.ai_analyses enable row level security; alter table public.custom_columns enable row level security;

-- políticas simples e indexáveis: cada linha pertence diretamente a um user_id
create policy users_owner on public.users for all to authenticated using((select auth.uid())=id) with check((select auth.uid())=id);
create policy months_owner on public.months_control for all to authenticated using((select auth.uid())=user_id) with check((select auth.uid())=user_id);
create policy fees_owner on public.fee_settings for all to authenticated using((select auth.uid())=user_id) with check((select auth.uid())=user_id);
create policy integration_owner on public.integration_settings for all to authenticated using((select auth.uid())=user_id) with check((select auth.uid())=user_id);
create policy categories_owner on public.categories for all to authenticated using((select auth.uid())=user_id) with check((select auth.uid())=user_id);
create policy products_owner on public.products for all to authenticated using((select auth.uid())=user_id) with check((select auth.uid())=user_id);
create policy variants_owner on public.product_variants for all to authenticated using((select auth.uid())=user_id) with check((select auth.uid())=user_id);
create policy sales_owner on public.sales for all to authenticated using((select auth.uid())=user_id) with check((select auth.uid())=user_id);
create policy sale_items_owner on public.sale_items for all to authenticated using((select auth.uid())=user_id) with check((select auth.uid())=user_id);
create policy expenses_owner on public.expenses for all to authenticated using((select auth.uid())=user_id) with check((select auth.uid())=user_id);
create policy income_owner on public.income for all to authenticated using((select auth.uid())=user_id) with check((select auth.uid())=user_id);
create policy stock_owner on public.stock_suggestions for all to authenticated using((select auth.uid())=user_id) with check((select auth.uid())=user_id);
create policy ai_owner on public.ai_analyses for all to authenticated using((select auth.uid())=user_id) with check((select auth.uid())=user_id);
create policy custom_columns_owner on public.custom_columns for all to authenticated using((select auth.uid())=user_id) with check((select auth.uid())=user_id);

grant execute on function public.get_month_summary(date) to authenticated; grant execute on function public.get_daily_sales(date) to authenticated; grant execute on function public.get_top_products(date,integer) to authenticated; grant execute on function public.get_variant_sales_stats(date) to authenticated; grant execute on function public.recalculate_all_sales_for_user(uuid) to authenticated; grant execute on function public.refresh_stock_suggestions(uuid) to authenticated;
