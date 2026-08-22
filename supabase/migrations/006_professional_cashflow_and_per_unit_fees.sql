-- Freo Figures — gestão profissional de resultado, caixa e contas a pagar
-- Requer migrations 004 e 005. Seguro para reaplicação após elas.
-- Regra Shopee configurável: percentual POR UNIDADE + taxa fixa POR UNIDADE vendida.

begin;

-- Pré-requisitos: falha antes de qualquer alteração se 004/005 não estiverem presentes.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='fee_settings' and column_name='filament_price_per_kg'
  ) then
    raise exception 'Execute a migration 004_production_cost_by_usage.sql antes da 006';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='expenses' and column_name='payment_method'
  ) then
    raise exception 'Execute a migration 005_expense_payment_method_and_rls_fix.sql antes da 006';
  end if;
end
$$;

-- Regra padrão atual da Freo Figures: 20% + R$ 5,00 por unidade.
-- Apenas o DEFAULT é ajustado: configurações já salvas continuam sob controle do usuário.
alter table public.fee_settings alter column shopee_fixed_fee set default 5;

-- Classificação gerencial: compras já absorvidas no custo unitário não devem ser descontadas de novo do resultado.
alter table public.categories
  add column if not exists impacts_result boolean not null default true;

update public.categories
set impacts_result = false
where type='expense' and is_system=true and name in ('Filamento','Embalagens','Energia','Ferramentas');

update public.categories
set impacts_result = true
where type='expense' and is_system=true and name in ('Marketing / Ads','Outros');

-- Primeira aplicação desta migration alinha a Freo Figures à regra atual informada pelo negócio:
-- 20% de comissão + R$ 5,00 por UNIDADE vendida. Depois disso os campos continuam ajustáveis no painel.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='sale_items' and column_name='shopee_fixed_fee_unit'
  ) then
    update public.fee_settings
    set shopee_commission_percent=20,
        shopee_fixed_fee=5;
  end if;
end
$$;

-- Auditoria da regra Shopee por item/unidade.
alter table public.sale_items
  add column if not exists shopee_percent_fee_unit numeric(14,2) not null default 0,
  add column if not exists shopee_percent_fee_total numeric(16,2) not null default 0,
  add column if not exists shopee_fixed_fee_unit numeric(14,2) not null default 0,
  add column if not exists shopee_fixed_fee_total numeric(16,2) not null default 0,
  add column if not exists shopee_fee_total numeric(16,2) not null default 0,
  add column if not exists shopee_net_total numeric(16,2) not null default 0;

-- Conciliação real de liquidação Shopee por pedido.
alter table public.sales
  add column if not exists shopee_estimated_net_total numeric(16,2) not null default 0,
  add column if not exists shopee_actual_net_total numeric(16,2),
  add column if not exists shopee_actual_commission_fee numeric(16,2),
  add column if not exists shopee_actual_service_fee numeric(16,2),
  add column if not exists shopee_actual_transaction_fee numeric(16,2),
  add column if not exists shopee_reconciled_at timestamptz;

-- Garante chaves compostas para FKs por proprietário.
do $$
begin
  if not exists (select 1 from pg_constraint where conname='expenses_id_user_key' and conrelid='public.expenses'::regclass) then
    alter table public.expenses add constraint expenses_id_user_key unique(id,user_id);
  end if;
  if not exists (select 1 from pg_constraint where conname='income_id_user_key' and conrelid='public.income'::regclass) then
    alter table public.income add constraint income_id_user_key unique(id,user_id);
  end if;
end
$$;

-- Contas financeiras: Shopee, banco e outras contas reais.
create table if not exists public.cash_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  kind text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id,name),
  unique(id,user_id)
);

-- Tipo transit representa dinheiro já retirado da Carteira Shopee, mas ainda não creditado no banco.
alter table public.cash_accounts drop constraint if exists cash_accounts_kind_check;
alter table public.cash_accounts
  add constraint cash_accounts_kind_check check(kind in ('shopee_wallet','bank','other','transit'));

-- Cada compra gera obrigação; crédito/a prazo só vira caixa quando parcela é efetivamente paga.
alter table public.expenses
  add column if not exists installment_count integer not null default 1 check(installment_count between 1 and 120),
  add column if not exists first_due_date date,
  add column if not exists schedule_needs_review boolean not null default false;

create table if not exists public.cash_movements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null,
  occurred_at date not null,
  direction text not null check(direction in ('in','out')),
  amount numeric(16,2) not null check(amount > 0),
  movement_kind text not null default 'operating' check(movement_kind in ('operating','transfer','capital')),
  affects_result boolean not null default false,
  source_type text not null,
  source_key text not null,
  description text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key(account_id,user_id) references public.cash_accounts(id,user_id),
  unique(user_id,source_type,source_key,account_id,direction)
);

create table if not exists public.expense_installments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  expense_id uuid not null,
  installment_number integer not null check(installment_number > 0),
  due_date date not null,
  amount numeric(16,2) not null check(amount > 0),
  paid_at date,
  cash_account_id uuid,
  cash_movement_id uuid references public.cash_movements(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key(expense_id,user_id) references public.expenses(id,user_id) on delete cascade,
  foreign key(cash_account_id,user_id) references public.cash_accounts(id,user_id),
  unique(user_id,expense_id,installment_number),
  unique(id,user_id)
);

-- Espelho idempotente das transações da Carteira Shopee.
create table if not exists public.shopee_wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  shop_id text not null,
  external_key text not null,
  status text not null,
  transaction_type text not null,
  money_flow text,
  amount numeric(16,2) not null,
  current_balance numeric(16,2),
  transaction_fee numeric(16,2) not null default 0,
  occurred_at date not null,
  create_time bigint not null,
  order_sn text,
  refund_sn text,
  withdrawal_id text,
  root_withdrawal_id text,
  transaction_tab_type text,
  description text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id,shop_id,external_key)
);

create index if not exists cash_movements_user_date_idx on public.cash_movements(user_id,occurred_at desc);
create index if not exists cash_movements_user_account_date_idx on public.cash_movements(user_id,account_id,occurred_at desc);
create index if not exists expense_installments_user_due_idx on public.expense_installments(user_id,due_date,paid_at);
create index if not exists shopee_wallet_user_date_idx on public.shopee_wallet_transactions(user_id,occurred_at desc);
create index if not exists shopee_wallet_user_order_idx on public.shopee_wallet_transactions(user_id,order_sn);

-- Updated_at nas tabelas novas.
drop trigger if exists cash_accounts_updated on public.cash_accounts;
create trigger cash_accounts_updated before update on public.cash_accounts for each row execute function public.set_updated_at();
drop trigger if exists shopee_wallet_updated on public.shopee_wallet_transactions;
create trigger shopee_wallet_updated before update on public.shopee_wallet_transactions for each row execute function public.set_updated_at();

-- Bloqueia movimentos/baixas futuras; vencimentos futuros continuam permitidos.
create or replace function public.guard_not_future_cash_date() returns trigger
language plpgsql
as $$
begin
  if new.occurred_at > (now() at time zone 'America/Sao_Paulo')::date then
    raise exception 'Movimento de caixa futuro não permitido';
  end if;
  return new;
end
$$;

drop trigger if exists cash_movements_no_future on public.cash_movements;
create trigger cash_movements_no_future before insert or update on public.cash_movements
for each row execute function public.guard_not_future_cash_date();

create or replace function public.guard_installment_paid_date() returns trigger
language plpgsql
as $$
begin
  if new.paid_at is not null and new.paid_at > (now() at time zone 'America/Sao_Paulo')::date then
    raise exception 'Pagamento futuro não permitido';
  end if;
  return new;
end
$$;

drop trigger if exists expense_installments_no_future_paid on public.expense_installments;
create trigger expense_installments_no_future_paid before insert or update on public.expense_installments
for each row execute function public.guard_installment_paid_date();

-- Regra Shopee: comissão percentual é arredondada POR UNIDADE; taxa fixa é multiplicada pela quantidade.
create or replace function public.prepare_sale_item() returns trigger
language plpgsql
as $$
declare
  v public.product_variants%rowtype;
  f public.fee_settings%rowtype;
  v_power_watts numeric;
begin
  select * into v from public.product_variants where id=new.variant_id and user_id=new.user_id;
  if not found then raise exception 'Variação inválida'; end if;
  select * into f from public.fee_settings where user_id=new.user_id;
  if not found then raise exception 'Configuração financeira não encontrada'; end if;

  v_power_watts := coalesce(v.printer_power_watts,f.default_printer_power_watts,0);
  new.gross_total := round((new.unit_gross * new.quantity)::numeric,2);

  new.shopee_percent_fee_unit := round(new.unit_gross * coalesce(f.shopee_commission_percent,0) / 100::numeric,2);
  new.shopee_percent_fee_total := round(new.shopee_percent_fee_unit * new.quantity,2);
  new.shopee_fixed_fee_unit := round(coalesce(f.shopee_fixed_fee,0),2);
  new.shopee_fixed_fee_total := round(new.shopee_fixed_fee_unit * new.quantity,2);
  new.shopee_fee_total := round(new.shopee_percent_fee_total + new.shopee_fixed_fee_total,2);
  new.shopee_net_total := round(new.gross_total - new.shopee_fee_total,2);

  new.filament_cost_unit := round((coalesce(v.filament_grams,0)/1000::numeric)*coalesce(f.filament_price_per_kg,0),4);
  new.energy_cost_unit := round(coalesce(v.print_time_hours,0)*(v_power_watts/1000::numeric)*coalesce(f.energy_price_per_kwh,0),4);
  new.packaging_cost_unit := coalesce(v.packaging_cost,f.default_packaging_cost,0);
  new.production_cost_unit := round(new.filament_cost_unit+new.energy_cost_unit+new.packaging_cost_unit,4);
  new.production_cost_total := round(new.production_cost_unit*new.quantity,2);
  return new;
end
$$;

create or replace function public.recalculate_sale_totals(p_sale_id uuid) returns void
language plpgsql
as $$
declare
  v_gross numeric(16,2);
  v_fee numeric(16,2);
  v_estimated_net numeric(16,2);
  v_production numeric(16,2);
  v_actual_net numeric(16,2);
  v_effective_net numeric(16,2);
begin
  select coalesce(round(sum(gross_total),2),0),
         coalesce(round(sum(shopee_fee_total),2),0),
         coalesce(round(sum(shopee_net_total),2),0),
         coalesce(round(sum(production_cost_total),2),0)
    into v_gross,v_fee,v_estimated_net,v_production
  from public.sale_items where sale_id=p_sale_id;

  select shopee_actual_net_total into v_actual_net from public.sales where id=p_sale_id;
  v_effective_net := coalesce(v_actual_net,v_estimated_net);

  update public.sales
  set gross_total=v_gross,
      shopee_fee_total=v_fee,
      shopee_estimated_net_total=v_estimated_net,
      shopee_net_total=round(v_effective_net,2),
      production_cost_total=v_production,
      net_profit_total=round(v_effective_net-v_production,2)
  where id=p_sale_id;
end
$$;

create or replace function public.recalculate_all_sales_for_user(p_user_id uuid) returns void
language plpgsql
security definer
set search_path=public
as $$
declare
  r record;
begin
  if auth.uid() is distinct from p_user_id and coalesce(auth.role(),'')<>'service_role' then raise exception 'Não autorizado'; end if;

  update public.sale_items si
  set gross_total=round(si.unit_gross*si.quantity,2),
      shopee_percent_fee_unit=round(si.unit_gross*coalesce(fs.shopee_commission_percent,0)/100::numeric,2),
      shopee_percent_fee_total=round(round(si.unit_gross*coalesce(fs.shopee_commission_percent,0)/100::numeric,2)*si.quantity,2),
      shopee_fixed_fee_unit=round(coalesce(fs.shopee_fixed_fee,0),2),
      shopee_fixed_fee_total=round(coalesce(fs.shopee_fixed_fee,0)*si.quantity,2),
      shopee_fee_total=round(
        round(si.unit_gross*coalesce(fs.shopee_commission_percent,0)/100::numeric,2)*si.quantity
        + coalesce(fs.shopee_fixed_fee,0)*si.quantity,2),
      shopee_net_total=round(
        si.unit_gross*si.quantity
        - (round(si.unit_gross*coalesce(fs.shopee_commission_percent,0)/100::numeric,2)*si.quantity)
        - (coalesce(fs.shopee_fixed_fee,0)*si.quantity),2),
      filament_cost_unit=round((coalesce(v.filament_grams,0)/1000::numeric)*coalesce(fs.filament_price_per_kg,0),4),
      energy_cost_unit=round(coalesce(v.print_time_hours,0)*(coalesce(v.printer_power_watts,fs.default_printer_power_watts,0)/1000::numeric)*coalesce(fs.energy_price_per_kwh,0),4),
      packaging_cost_unit=coalesce(v.packaging_cost,fs.default_packaging_cost,0),
      production_cost_unit=round(
        ((coalesce(v.filament_grams,0)/1000::numeric)*coalesce(fs.filament_price_per_kg,0))
        +(coalesce(v.print_time_hours,0)*(coalesce(v.printer_power_watts,fs.default_printer_power_watts,0)/1000::numeric)*coalesce(fs.energy_price_per_kwh,0))
        +coalesce(v.packaging_cost,fs.default_packaging_cost,0),4),
      production_cost_total=round((
        ((coalesce(v.filament_grams,0)/1000::numeric)*coalesce(fs.filament_price_per_kg,0))
        +(coalesce(v.print_time_hours,0)*(coalesce(v.printer_power_watts,fs.default_printer_power_watts,0)/1000::numeric)*coalesce(fs.energy_price_per_kwh,0))
        +coalesce(v.packaging_cost,fs.default_packaging_cost,0))*si.quantity,2)
  from public.product_variants v, public.fee_settings fs
  where si.user_id=p_user_id and v.id=si.variant_id and v.user_id=p_user_id and fs.user_id=p_user_id;

  for r in select id from public.sales where user_id=p_user_id loop
    perform public.recalculate_sale_totals(r.id);
  end loop;
end
$$;

-- Atualiza configuração e recalcula na mesma transação.
drop function if exists public.update_financial_settings_transaction(uuid,numeric,numeric,numeric,numeric,numeric,numeric);
create function public.update_financial_settings_transaction(
  p_user_id uuid,p_commission numeric,p_fixed_fee numeric,p_filament_price_per_kg numeric,
  p_energy_price_per_kwh numeric,p_default_printer_power_watts numeric,p_default_packaging numeric
) returns void
language plpgsql security definer set search_path=public
as $$
begin
  if auth.uid() is distinct from p_user_id and coalesce(auth.role(),'')<>'service_role' then raise exception 'Não autorizado'; end if;
  if p_commission<0 or p_commission>100 then raise exception 'Comissão deve ficar entre 0 e 100'; end if;
  if p_fixed_fee<0 or p_filament_price_per_kg<0 or p_energy_price_per_kwh<0 or p_default_printer_power_watts<0 or p_default_packaging<0 then
    raise exception 'Taxas e parâmetros de produção não podem ser negativos';
  end if;
  update public.fee_settings set
    shopee_commission_percent=p_commission,
    shopee_fixed_fee=round(p_fixed_fee,2),
    filament_price_per_kg=p_filament_price_per_kg,
    energy_price_per_kwh=p_energy_price_per_kwh,
    default_printer_power_watts=p_default_printer_power_watts,
    default_packaging_cost=p_default_packaging,
    default_filament_cost=0,default_energy_cost=0
  where user_id=p_user_id;
  if not found then raise exception 'Configuração financeira não encontrada'; end if;
  perform public.recalculate_all_sales_for_user(p_user_id);
end
$$;

-- Edição em massa de consumo/custo por variação. Só altera campos explicitamente marcados.
create or replace function public.bulk_update_variant_usage_transaction(
  p_user_id uuid,
  p_variant_ids uuid[],
  p_apply_filament boolean,p_filament_grams numeric,
  p_apply_hours boolean,p_print_time_hours numeric,
  p_apply_power boolean,p_printer_power_watts numeric,
  p_apply_packaging boolean,p_packaging numeric
) returns integer
language plpgsql security definer set search_path=public
as $$
declare v_count integer;
begin
  if auth.uid() is distinct from p_user_id and coalesce(auth.role(),'')<>'service_role' then raise exception 'Não autorizado'; end if;
  if p_variant_ids is null or cardinality(p_variant_ids)=0 then raise exception 'Selecione ao menos uma variação'; end if;
  if not coalesce(p_apply_filament,false) and not coalesce(p_apply_hours,false) and not coalesce(p_apply_power,false) and not coalesce(p_apply_packaging,false) then
    raise exception 'Marque ao menos um campo para aplicar';
  end if;
  if (p_apply_filament and coalesce(p_filament_grams,0)<0) or (p_apply_hours and coalesce(p_print_time_hours,0)<0)
     or (p_apply_power and coalesce(p_printer_power_watts,0)<0) or (p_apply_packaging and coalesce(p_packaging,0)<0) then
    raise exception 'Valores não podem ser negativos';
  end if;

  update public.product_variants
  set filament_grams=case when p_apply_filament then p_filament_grams else filament_grams end,
      print_time_hours=case when p_apply_hours then p_print_time_hours else print_time_hours end,
      printer_power_watts=case when p_apply_power then p_printer_power_watts else printer_power_watts end,
      packaging_cost=case when p_apply_packaging then p_packaging else packaging_cost end,
      filament_cost=null,energy_cost=null
  where user_id=p_user_id and id=any(p_variant_ids);
  get diagnostics v_count=row_count;
  if v_count<>cardinality(p_variant_ids) then raise exception 'Uma ou mais variações não pertencem ao usuário'; end if;
  perform public.recalculate_all_sales_for_user(p_user_id);
  return v_count;
end
$$;

-- Aplica a liquidação real Shopee sem apagar a auditoria da regra percentual configurada + taxa fixa/unidade.
create or replace function public.apply_shopee_escrow(
  p_user_id uuid,p_order_sn text,p_actual_net numeric,p_commission numeric,p_service numeric,p_transaction numeric,p_reconciled_at timestamptz
) returns boolean
language plpgsql security definer set search_path=public
as $$
declare v_sale_id uuid;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Função restrita ao backend'; end if;
  if p_actual_net is null then raise exception 'Líquido real ausente'; end if;
  select id into v_sale_id from public.sales where user_id=p_user_id and order_sn=p_order_sn;
  if v_sale_id is null then return false; end if;
  update public.sales set
    shopee_actual_net_total=round(p_actual_net,2),
    shopee_actual_commission_fee=case when p_commission is null then null else round(p_commission,2) end,
    shopee_actual_service_fee=case when p_service is null then null else round(p_service,2) end,
    shopee_actual_transaction_fee=case when p_transaction is null then null else round(p_transaction,2) end,
    shopee_reconciled_at=coalesce(p_reconciled_at,now())
  where id=v_sale_id;
  perform public.recalculate_sale_totals(v_sale_id);
  return true;
end
$$;

-- Contas padrão para usuários existentes.
insert into public.cash_accounts(user_id,name,kind)
select id,'Carteira Shopee','shopee_wallet' from public.users
on conflict(user_id,name) do nothing;
insert into public.cash_accounts(user_id,name,kind)
select id,'Conta bancária','bank' from public.users
on conflict(user_id,name) do nothing;
insert into public.cash_accounts(user_id,name,kind)
select id,'Shopee - Saques em trânsito','transit' from public.users
on conflict(user_id,name) do nothing;

-- Helper para vencimentos mensais preservando o dia quando possível.
create or replace function public.add_months_clamped(p_date date,p_months integer) returns date
language sql immutable
as $$
  with x as (
    select (date_trunc('month',p_date)::date + make_interval(months=>p_months))::date as month_start,
           extract(day from p_date)::integer as wanted_day
  )
  select month_start + (least(wanted_day,extract(day from (month_start+interval '1 month-1 day'))::integer)-1)
  from x
$$;

create or replace function public.installment_amount(p_total numeric,p_count integer,p_number integer) returns numeric
language plpgsql immutable
as $$
declare v_cents bigint; v_base bigint; v_extra bigint;
begin
  if p_count<1 or p_number<1 or p_number>p_count then raise exception 'Parcela inválida'; end if;
  v_cents:=round(p_total*100)::bigint;
  v_base:=v_cents/p_count;
  v_extra:=v_cents%p_count;
  return (v_base + case when p_number<=v_extra then 1 else 0 end)::numeric/100::numeric;
end
$$;

create or replace function public.require_cash_account(p_user_id uuid,p_account_id uuid) returns void
language plpgsql stable
as $$
begin
  if not exists(select 1 from public.cash_accounts where id=p_account_id and user_id=p_user_id and active=true) then
    raise exception 'Conta financeira inválida';
  end if;
end
$$;

create or replace function public.create_expense_transaction(
  p_user_id uuid,p_category_id uuid,p_spent_at date,p_description text,p_amount numeric,p_custom_fields jsonb,
  p_payment_method text,p_installments integer,p_first_due_date date,p_cash_account_id uuid
) returns uuid
language plpgsql security definer set search_path=public
as $$
declare v_expense_id uuid; v_inst_id uuid; i integer; v_due date; v_part numeric; v_move uuid;
begin
  if auth.uid() is distinct from p_user_id and coalesce(auth.role(),'')<>'service_role' then raise exception 'Não autorizado'; end if;
  if p_spent_at is null or p_spent_at>(now() at time zone 'America/Sao_Paulo')::date then raise exception 'Data da compra inválida'; end if;
  if btrim(coalesce(p_description,''))='' then raise exception 'Descrição obrigatória'; end if;
  if p_amount is null or p_amount<=0 then raise exception 'Valor deve ser maior que zero'; end if;
  if p_payment_method not in ('credit','installment','debit','pix') then raise exception 'Forma de pagamento inválida'; end if;
  if not exists(select 1 from public.categories where id=p_category_id and user_id=p_user_id and type='expense') then raise exception 'Categoria inválida'; end if;
  if p_payment_method in ('pix','debit') then
    perform public.require_cash_account(p_user_id,p_cash_account_id);
    p_installments:=1; p_first_due_date:=p_spent_at;
  else
    if coalesce(p_installments,0)<1 or p_installments>120 then raise exception 'Número de parcelas inválido'; end if;
    if p_first_due_date is null or p_first_due_date<p_spent_at then raise exception 'Primeiro vencimento deve ser igual ou posterior à compra'; end if;
  end if;

  insert into public.expenses(user_id,category_id,spent_at,description,amount,custom_fields,payment_method,installment_count,first_due_date,schedule_needs_review)
  values(p_user_id,p_category_id,p_spent_at,btrim(p_description),round(p_amount,2),coalesce(p_custom_fields,'{}'::jsonb),p_payment_method,p_installments,p_first_due_date,false)
  returning id into v_expense_id;

  for i in 1..p_installments loop
    v_due:=public.add_months_clamped(p_first_due_date,i-1);
    v_part:=public.installment_amount(round(p_amount,2),p_installments,i);
    insert into public.expense_installments(user_id,expense_id,installment_number,due_date,amount,paid_at,cash_account_id)
    values(p_user_id,v_expense_id,i,v_due,v_part,case when p_payment_method in ('pix','debit') then p_spent_at else null end,
           case when p_payment_method in ('pix','debit') then p_cash_account_id else null end)
    returning id into v_inst_id;

    if p_payment_method in ('pix','debit') then
      insert into public.cash_movements(user_id,account_id,occurred_at,direction,amount,movement_kind,affects_result,source_type,source_key,description)
      values(p_user_id,p_cash_account_id,p_spent_at,'out',v_part,'operating',false,'expense_installment',v_inst_id::text,btrim(p_description)||' · pagamento')
      returning id into v_move;
      update public.expense_installments set cash_movement_id=v_move where id=v_inst_id;
    end if;
  end loop;
  return v_expense_id;
end
$$;

create or replace function public.pay_expense_installment(
  p_user_id uuid,p_installment_id uuid,p_paid_at date,p_cash_account_id uuid
) returns void
language plpgsql security definer set search_path=public
as $$
declare v public.expense_installments%rowtype; v_desc text; v_spent_at date; v_move uuid;
begin
  if auth.uid() is distinct from p_user_id and coalesce(auth.role(),'')<>'service_role' then raise exception 'Não autorizado'; end if;
  if p_paid_at is null or p_paid_at>(now() at time zone 'America/Sao_Paulo')::date then raise exception 'Data de pagamento inválida'; end if;
  perform public.require_cash_account(p_user_id,p_cash_account_id);
  select * into v from public.expense_installments where id=p_installment_id and user_id=p_user_id for update;
  if not found then raise exception 'Parcela não encontrada'; end if;
  if v.paid_at is not null then raise exception 'Parcela já está paga'; end if;
  select description,spent_at into v_desc,v_spent_at from public.expenses where id=v.expense_id and user_id=p_user_id;
  if p_paid_at<v_spent_at then raise exception 'Pagamento não pode ser anterior à compra'; end if;
  insert into public.cash_movements(user_id,account_id,occurred_at,direction,amount,movement_kind,affects_result,source_type,source_key,description)
  values(p_user_id,p_cash_account_id,p_paid_at,'out',v.amount,'operating',false,'expense_installment',v.id::text,v_desc||' · parcela '||v.installment_number)
  returning id into v_move;
  update public.expense_installments set paid_at=p_paid_at,cash_account_id=p_cash_account_id,cash_movement_id=v_move where id=v.id;
end
$$;

create or replace function public.unpay_expense_installment(p_user_id uuid,p_installment_id uuid) returns void
language plpgsql security definer set search_path=public
as $$
declare v_move uuid;
begin
  if auth.uid() is distinct from p_user_id and coalesce(auth.role(),'')<>'service_role' then raise exception 'Não autorizado'; end if;
  select cash_movement_id into v_move from public.expense_installments where id=p_installment_id and user_id=p_user_id for update;
  if not found then raise exception 'Parcela não encontrada'; end if;
  if v_move is not null then delete from public.cash_movements where id=v_move and user_id=p_user_id; end if;
  update public.expense_installments set paid_at=null,cash_account_id=null,cash_movement_id=null where id=p_installment_id and user_id=p_user_id;
end
$$;

create or replace function public.update_expense_transaction(
  p_user_id uuid,p_expense_id uuid,p_category_id uuid,p_spent_at date,p_description text,p_amount numeric,p_custom_fields jsonb,
  p_payment_method text,p_installments integer,p_first_due_date date,p_cash_account_id uuid
) returns void
language plpgsql security definer set search_path=public
as $$
declare
  old_exp public.expenses%rowtype;
  v_paid_count integer;
  v_inst_id uuid;
  v_move uuid;
  v_due date;
  v_part numeric;
  i integer;
begin
  if auth.uid() is distinct from p_user_id and coalesce(auth.role(),'')<>'service_role' then raise exception 'Não autorizado'; end if;
  select * into old_exp from public.expenses where id=p_expense_id and user_id=p_user_id for update;
  if not found then raise exception 'Compra não encontrada'; end if;
  if p_spent_at is null or p_spent_at>(now() at time zone 'America/Sao_Paulo')::date then raise exception 'Data da compra inválida'; end if;
  if btrim(coalesce(p_description,''))='' then raise exception 'Descrição obrigatória'; end if;
  if p_amount is null or p_amount<=0 then raise exception 'Valor deve ser maior que zero'; end if;
  if p_payment_method not in ('credit','installment','debit','pix') then raise exception 'Forma de pagamento inválida'; end if;
  if not exists(select 1 from public.categories where id=p_category_id and user_id=p_user_id and type='expense') then raise exception 'Categoria inválida'; end if;
  if p_payment_method in ('pix','debit') then
    perform public.require_cash_account(p_user_id,p_cash_account_id);
    p_installments:=1; p_first_due_date:=p_spent_at;
  else
    if coalesce(p_installments,0)<1 or p_installments>120 then raise exception 'Número de parcelas inválido'; end if;
    if p_first_due_date is null or p_first_due_date<p_spent_at then raise exception 'Primeiro vencimento deve ser igual ou posterior à compra'; end if;
  end if;

  select count(*) into v_paid_count
  from public.expense_installments
  where expense_id=p_expense_id and user_id=p_user_id and paid_at is not null;

  -- Parcela diferida já paga protege o histórico de caixa. Metadados ainda podem ser corrigidos.
  if v_paid_count>0 and old_exp.payment_method in ('credit','installment') then
    if old_exp.spent_at is distinct from p_spent_at
       or old_exp.amount is distinct from round(p_amount,2)
       or old_exp.payment_method is distinct from p_payment_method
       or old_exp.installment_count is distinct from p_installments
       or old_exp.first_due_date is distinct from p_first_due_date then
      raise exception 'Há parcelas pagas. Estorne as baixas antes de alterar valor, data ou parcelamento';
    end if;
    update public.expenses
    set category_id=p_category_id,description=btrim(p_description),custom_fields=coalesce(p_custom_fields,'{}'::jsonb)
    where id=p_expense_id and user_id=p_user_id;
    return;
  end if;

  -- Sem baixa protegida: remove movimentos/schedule e reconstrói mantendo o mesmo ID da compra.
  delete from public.expense_installments where expense_id=p_expense_id and user_id=p_user_id;

  update public.expenses
  set category_id=p_category_id,spent_at=p_spent_at,description=btrim(p_description),amount=round(p_amount,2),
      custom_fields=coalesce(p_custom_fields,'{}'::jsonb),payment_method=p_payment_method,
      installment_count=p_installments,first_due_date=p_first_due_date,schedule_needs_review=false
  where id=p_expense_id and user_id=p_user_id;

  for i in 1..p_installments loop
    v_due:=public.add_months_clamped(p_first_due_date,i-1);
    v_part:=public.installment_amount(round(p_amount,2),p_installments,i);
    insert into public.expense_installments(user_id,expense_id,installment_number,due_date,amount,paid_at,cash_account_id)
    values(p_user_id,p_expense_id,i,v_due,v_part,
      case when p_payment_method in ('pix','debit') then p_spent_at else null end,
      case when p_payment_method in ('pix','debit') then p_cash_account_id else null end)
    returning id into v_inst_id;

    if p_payment_method in ('pix','debit') then
      insert into public.cash_movements(user_id,account_id,occurred_at,direction,amount,movement_kind,affects_result,source_type,source_key,description)
      values(p_user_id,p_cash_account_id,p_spent_at,'out',v_part,'operating',false,'expense_installment',v_inst_id::text,btrim(p_description)||' · pagamento')
      returning id into v_move;
      update public.expense_installments set cash_movement_id=v_move where id=v_inst_id;
    end if;
  end loop;
end
$$;

-- Ao excluir parcela/entrada, remove também o movimento real ligado.
create or replace function public.delete_linked_cash_movement() returns trigger
language plpgsql
as $$
begin
  if old.cash_movement_id is not null then delete from public.cash_movements where id=old.cash_movement_id and user_id=old.user_id; end if;
  return old;
end
$$;
drop trigger if exists installment_delete_cash on public.expense_installments;
create trigger installment_delete_cash before delete on public.expense_installments for each row execute function public.delete_linked_cash_movement();

create or replace function public.create_income_transaction(
  p_user_id uuid,p_category_id uuid,p_received_at date,p_description text,p_amount numeric,p_custom_fields jsonb,p_cash_account_id uuid
) returns uuid
language plpgsql security definer set search_path=public
as $$
declare v_id uuid;
begin
  if auth.uid() is distinct from p_user_id and coalesce(auth.role(),'')<>'service_role' then raise exception 'Não autorizado'; end if;
  if p_received_at is null or p_received_at>(now() at time zone 'America/Sao_Paulo')::date then raise exception 'Data da entrada inválida'; end if;
  if p_amount is null or p_amount<=0 then raise exception 'Valor deve ser maior que zero'; end if;
  if btrim(coalesce(p_description,''))='' then raise exception 'Descrição obrigatória'; end if;
  if not exists(select 1 from public.categories where id=p_category_id and user_id=p_user_id and type='income') then raise exception 'Categoria inválida'; end if;
  perform public.require_cash_account(p_user_id,p_cash_account_id);
  insert into public.income(user_id,category_id,received_at,description,amount,custom_fields)
  values(p_user_id,p_category_id,p_received_at,btrim(p_description),round(p_amount,2),coalesce(p_custom_fields,'{}'::jsonb)) returning id into v_id;
  insert into public.cash_movements(user_id,account_id,occurred_at,direction,amount,movement_kind,affects_result,source_type,source_key,description)
  values(p_user_id,p_cash_account_id,p_received_at,'in',round(p_amount,2),'operating',false,'income',v_id::text,btrim(p_description));
  return v_id;
end
$$;

create or replace function public.update_income_transaction(
  p_user_id uuid,p_income_id uuid,p_category_id uuid,p_received_at date,p_description text,p_amount numeric,p_custom_fields jsonb,p_cash_account_id uuid
) returns void
language plpgsql security definer set search_path=public
as $$
begin
  if auth.uid() is distinct from p_user_id and coalesce(auth.role(),'')<>'service_role' then raise exception 'Não autorizado'; end if;
  if p_received_at is null or p_received_at>(now() at time zone 'America/Sao_Paulo')::date then raise exception 'Data da entrada inválida'; end if;
  if p_amount is null or p_amount<=0 then raise exception 'Valor deve ser maior que zero'; end if;
  if not exists(select 1 from public.categories where id=p_category_id and user_id=p_user_id and type='income') then raise exception 'Categoria inválida'; end if;
  perform public.require_cash_account(p_user_id,p_cash_account_id);
  update public.income set category_id=p_category_id,received_at=p_received_at,description=btrim(p_description),amount=round(p_amount,2),custom_fields=coalesce(p_custom_fields,'{}'::jsonb)
  where id=p_income_id and user_id=p_user_id;
  if not found then raise exception 'Entrada não encontrada'; end if;
  delete from public.cash_movements where user_id=p_user_id and source_type='income' and source_key=p_income_id::text;
  insert into public.cash_movements(user_id,account_id,occurred_at,direction,amount,movement_kind,affects_result,source_type,source_key,description)
  values(p_user_id,p_cash_account_id,p_received_at,'in',round(p_amount,2),'operating',false,'income',p_income_id::text,btrim(p_description));
end
$$;

create or replace function public.delete_income_cash() returns trigger
language plpgsql
as $$
begin
  delete from public.cash_movements where user_id=old.user_id and source_type='income' and source_key=old.id::text;
  return old;
end
$$;
drop trigger if exists income_delete_cash on public.income;
create trigger income_delete_cash before delete on public.income for each row execute function public.delete_income_cash();

-- Registra transação Shopee e o efeito no caixa. Retirada concluída é transferência, nunca nova receita.
create or replace function public.record_shopee_wallet_transaction(
  p_user_id uuid,p_shop_id text,p_external_key text,p_status text,p_transaction_type text,p_money_flow text,
  p_amount numeric,p_current_balance numeric,p_transaction_fee numeric,p_occurred_at date,p_create_time bigint,
  p_order_sn text,p_refund_sn text,p_withdrawal_id text,p_root_withdrawal_id text,p_transaction_tab_type text,
  p_description text,p_raw jsonb
) returns boolean
language plpgsql security definer set search_path=public
as $$
declare
  v_wallet uuid;
  v_bank uuid;
  v_transit uuid;
  v_type integer;
  v_type_norm text;
  v_affects boolean;
  v_kind text;
  v_direction text;
  v_amount numeric(16,2);
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Função restrita ao backend'; end if;
  if p_external_key is null or btrim(p_external_key)='' then raise exception 'Chave externa ausente'; end if;
  if p_occurred_at is null or p_occurred_at>(now() at time zone 'America/Sao_Paulo')::date then raise exception 'Transação Shopee futura inválida'; end if;
  if p_amount is null then raise exception 'Valor da transação Shopee ausente'; end if;
  v_amount:=round(abs(p_amount),2);

  select id into v_wallet from public.cash_accounts where user_id=p_user_id and kind='shopee_wallet' and active=true order by created_at limit 1;
  select id into v_bank from public.cash_accounts where user_id=p_user_id and kind='bank' and active=true order by created_at limit 1;
  select id into v_transit from public.cash_accounts where user_id=p_user_id and kind='transit' and active=true order by created_at limit 1;
  if v_wallet is null or v_bank is null or v_transit is null then raise exception 'Contas padrão não encontradas'; end if;

  insert into public.shopee_wallet_transactions(user_id,shop_id,external_key,status,transaction_type,money_flow,amount,current_balance,transaction_fee,occurred_at,create_time,order_sn,refund_sn,withdrawal_id,root_withdrawal_id,transaction_tab_type,description,raw)
  values(p_user_id,p_shop_id,p_external_key,p_status,p_transaction_type,nullif(p_money_flow,''),v_amount,p_current_balance,round(coalesce(p_transaction_fee,0),2),p_occurred_at,p_create_time,nullif(p_order_sn,''),nullif(p_refund_sn,''),nullif(p_withdrawal_id,''),nullif(p_root_withdrawal_id,''),nullif(p_transaction_tab_type,''),p_description,coalesce(p_raw,'{}'::jsonb))
  on conflict(user_id,shop_id,external_key) do update set
    status=excluded.status,transaction_type=excluded.transaction_type,money_flow=excluded.money_flow,amount=excluded.amount,
    current_balance=excluded.current_balance,transaction_fee=excluded.transaction_fee,occurred_at=excluded.occurred_at,create_time=excluded.create_time,
    order_sn=excluded.order_sn,refund_sn=excluded.refund_sn,withdrawal_id=excluded.withdrawal_id,root_withdrawal_id=excluded.root_withdrawal_id,
    transaction_tab_type=excluded.transaction_tab_type,description=excluded.description,raw=excluded.raw;

  delete from public.cash_movements
  where user_id=p_user_id and source_type in ('shopee_wallet','shopee_withdrawal') and source_key like p_external_key||'%';
  if upper(coalesce(p_status,''))<>'COMPLETED' then return false; end if;

  v_type_norm:=upper(btrim(coalesce(p_transaction_type,'')));
  begin v_type:=v_type_norm::integer; exception when others then v_type:=null; end;

  -- Aceita tanto os códigos numéricos documentados quanto os nomes textuais que alguns SDKs retornam.
  -- Fluxo oficial do saque: 201 desconta da carteira; 202 conclui no banco; 203 cancela e devolve à carteira.
  -- Conta intermediária evita duplicar receita e preserva o timing real do dinheiro.
  if v_type=201 or v_type_norm in ('WITHDRAWAL_CREATED','WITHDRAW_CREATED') then
    insert into public.cash_movements(user_id,account_id,occurred_at,direction,amount,movement_kind,affects_result,source_type,source_key,description,metadata)
    values(p_user_id,v_wallet,p_occurred_at,'out',v_amount,'transfer',false,'shopee_withdrawal',p_external_key||':wallet','Saque Shopee iniciado',jsonb_build_object('withdrawal_id',p_withdrawal_id,'root_withdrawal_id',p_root_withdrawal_id));
    insert into public.cash_movements(user_id,account_id,occurred_at,direction,amount,movement_kind,affects_result,source_type,source_key,description,metadata)
    values(p_user_id,v_transit,p_occurred_at,'in',v_amount,'transfer',false,'shopee_withdrawal',p_external_key||':transit','Saque Shopee em trânsito',jsonb_build_object('withdrawal_id',p_withdrawal_id,'root_withdrawal_id',p_root_withdrawal_id));
    return true;
  elsif v_type=202 or v_type_norm in ('WITHDRAWAL_COMPLETED','WITHDRAW_COMPLETED') then
    insert into public.cash_movements(user_id,account_id,occurred_at,direction,amount,movement_kind,affects_result,source_type,source_key,description,metadata)
    values(p_user_id,v_transit,p_occurred_at,'out',v_amount,'transfer',false,'shopee_withdrawal',p_external_key||':transit','Saque Shopee concluído',jsonb_build_object('withdrawal_id',p_withdrawal_id,'root_withdrawal_id',p_root_withdrawal_id));
    insert into public.cash_movements(user_id,account_id,occurred_at,direction,amount,movement_kind,affects_result,source_type,source_key,description,metadata)
    values(p_user_id,v_bank,p_occurred_at,'in',v_amount,'transfer',false,'shopee_withdrawal',p_external_key||':bank','Saque Shopee recebido no banco',jsonb_build_object('withdrawal_id',p_withdrawal_id,'root_withdrawal_id',p_root_withdrawal_id));
    return true;
  elsif v_type=203 or v_type_norm in ('WITHDRAWAL_CANCELLED','WITHDRAWAL_CANCELED','WITHDRAW_CANCELLED','WITHDRAW_CANCELED') then
    insert into public.cash_movements(user_id,account_id,occurred_at,direction,amount,movement_kind,affects_result,source_type,source_key,description,metadata)
    values(p_user_id,v_transit,p_occurred_at,'out',v_amount,'transfer',false,'shopee_withdrawal',p_external_key||':transit','Saque Shopee cancelado',jsonb_build_object('withdrawal_id',p_withdrawal_id,'root_withdrawal_id',p_root_withdrawal_id));
    insert into public.cash_movements(user_id,account_id,occurred_at,direction,amount,movement_kind,affects_result,source_type,source_key,description,metadata)
    values(p_user_id,v_wallet,p_occurred_at,'in',v_amount,'transfer',false,'shopee_withdrawal',p_external_key||':wallet','Saque cancelado · valor devolvido à carteira',jsonb_build_object('withdrawal_id',p_withdrawal_id,'root_withdrawal_id',p_root_withdrawal_id));
    return true;
  end if;

  -- Capital/topup/empréstimo não entra no resultado operacional.
  v_kind:=case
    when lower(coalesce(p_transaction_tab_type,'')) in ('seller_loan','corporate_loan')
      or lower(coalesce(p_description,'')) like '%topup%'
      or lower(coalesce(p_description,'')) like '%loan%'
    then 'capital' else 'operating' end;

  if upper(coalesce(p_money_flow,''))='MONEY_IN' then v_direction:='in';
  elsif upper(coalesce(p_money_flow,''))='MONEY_OUT' then v_direction:='out';
  else
    -- Fallback apenas para códigos documentados; desconhecido sem money_flow é armazenado, mas não inventa movimento.
    if v_type in (101,401,404,406,451,452,456,459)
       or v_type_norm in ('ESCROW_VERIFIED_ADD','ADJUSTMENT_ADD','FBS_ADJUSTMENT_ADD','ADJUSTMENT_CENTER_ADD','PAID_ADS_REFUND','FAST_ESCROW_DISBURSE','AFFILIATE_ADS_SELLER_FEE_REFUND','FAST_ESCROW_DISBURSE_REMAIN') then
      v_direction:='in';
    elsif v_type in (102,402,405,407,408,409,410,450,455,458,460)
       or v_type_norm in ('ESCROW_VERIFIED_MINUS','ADJUSTMENT_MINUS','FBS_ADJUSTMENT_MINUS','ADJUSTMENT_CENTER_DEDUCT','FSF_COST_PASSING_DEDUCT','PERCEPTION_VAT_TAX_DEDUCT','PERCEPTION_TURNOVER_TAX_DEDUCT','PAID_ADS_CHARGE','AFFILIATE_ADS_SELLER_FEE','FAST_ESCROW_DEDUCT','AFFILIATE_FEE_DEDUCT') then
      v_direction:='out';
    else return false;
    end if;
  end if;

  -- Pedido já conciliado no resultado não é somado de novo. Ajustes sem pedido e Ads afetam resultado.
  v_affects := v_kind='operating' and (
    v_type in (450,451)
    or v_type_norm in ('PAID_ADS_CHARGE','PAID_ADS_REFUND')
    or (
      nullif(btrim(coalesce(p_order_sn,'')),'') is null
      and coalesce(v_type,0) not in (101,102)
      and v_type_norm not in ('ESCROW_VERIFIED_ADD','ESCROW_VERIFIED_MINUS')
    )
  );

  insert into public.cash_movements(user_id,account_id,occurred_at,direction,amount,movement_kind,affects_result,source_type,source_key,description,metadata)
  values(p_user_id,v_wallet,p_occurred_at,v_direction,v_amount,v_kind,v_affects,'shopee_wallet',p_external_key,
    coalesce(nullif(p_description,''),'Movimento Carteira Shopee'),
    jsonb_build_object('transaction_type',p_transaction_type,'order_sn',p_order_sn,'tab',p_transaction_tab_type));
  return true;
end
$$;

-- Backfill seguro: entradas manuais históricas significam dinheiro recebido; saídas antigas sem forma/schedule ficam para revisão.
insert into public.cash_movements(user_id,account_id,occurred_at,direction,amount,movement_kind,affects_result,source_type,source_key,description)
select i.user_id,a.id,i.received_at,'in',i.amount,'operating',false,'income',i.id::text,i.description
from public.income i
join lateral (select id from public.cash_accounts where user_id=i.user_id and kind='bank' order by created_at limit 1) a on true
where i.amount>0
on conflict(user_id,source_type,source_key,account_id,direction) do nothing;

update public.expenses set schedule_needs_review=true
where payment_method is null;

-- Resumo mensal: resultado econômico separado do caixa efetivo.
drop function if exists public.get_month_summary(date);
create function public.get_month_summary(p_month date)
returns table(
  gross_total numeric,shopee_net_total numeric,production_cost_total numeric,net_profit_total numeric,
  operating_expenses_total numeric,business_net_result_total numeric,
  cashflow_result numeric,average_ticket numeric,orders_count bigint,
  cash_in_total numeric,cash_out_total numeric,bank_in_total numeric,bank_out_total numeric,
  payables_open_total numeric,shopee_wallet_balance numeric
)
language sql stable security invoker
as $$
with bounds as(
  select date_trunc('month',p_month)::date s,(date_trunc('month',p_month)+interval '1 month')::date e
), sales_value as(
  select coalesce(sum(gross_total),0) g,coalesce(sum(shopee_net_total),0)n,coalesce(sum(production_cost_total),0)c,
         coalesce(sum(net_profit_total),0)p,count(*) cnt
  from public.sales,bounds where sold_at>=s and sold_at<e and status='paid'
), inc_result as(
  select coalesce(sum(i.amount),0) x from public.income i join public.categories c on c.id=i.category_id and c.user_id=i.user_id,bounds
  where i.received_at>=s and i.received_at<e and c.impacts_result=true
), exp_result as(
  select coalesce(sum(exp.amount),0) x from public.expenses exp join public.categories c on c.id=exp.category_id and c.user_id=exp.user_id,bounds
  where exp.spent_at>=s and exp.spent_at<e and c.impacts_result=true
), wallet_result as(
  select coalesce(sum(case when cm.direction='in' then cm.amount else -cm.amount end),0) x
  from public.cash_movements cm,bounds where cm.occurred_at>=s and cm.occurred_at<e and cm.affects_result=true
), cash as(
  select coalesce(sum(case when direction='in' and movement_kind<>'transfer' then amount else 0 end),0) cash_in,
         coalesce(sum(case when direction='out' and movement_kind<>'transfer' then amount else 0 end),0) cash_out
  from public.cash_movements,bounds where occurred_at>=s and occurred_at<e
), bank as(
  select coalesce(sum(case when cm.direction='in' then cm.amount else 0 end),0) bin,
         coalesce(sum(case when cm.direction='out' then cm.amount else 0 end),0) bout
  from public.cash_movements cm join public.cash_accounts a on a.id=cm.account_id and a.user_id=cm.user_id,bounds
  where cm.occurred_at>=s and cm.occurred_at<e and a.kind='bank'
), payable as(
  select coalesce(sum(ei.amount),0) x from public.expense_installments ei,bounds
  where ei.due_date>=s and ei.due_date<e and ei.paid_at is null
), wallet_balance as(
  -- Saldo no fechamento do mês selecionado, nunca o saldo atual de outro mês.
  select coalesce((
    select sw.current_balance
    from public.shopee_wallet_transactions sw,bounds
    where sw.current_balance is not null and sw.occurred_at<bounds.e
    order by sw.create_time desc
    limit 1
  ),0) x
)
select round(sv.g,2),round(sv.n,2),round(sv.c,2),round(sv.p,2),
       round(exp_result.x,2),round(sv.p+inc_result.x-exp_result.x+wallet_result.x,2),
       round(cash.cash_in-cash.cash_out,2),case when sv.cnt=0 then 0 else round(sv.g/sv.cnt,2) end,sv.cnt,
       round(cash.cash_in,2),round(cash.cash_out,2),round(bank.bin,2),round(bank.bout,2),round(payable.x,2),round(wallet_balance.x,2)
from sales_value sv,inc_result,exp_result,wallet_result,cash,bank,payable,wallet_balance
$$;

-- Usuários futuros já recebem contas padrão e categorias com classificação gerencial.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path=public
as $$
begin
  insert into public.users(id) values(new.id);
  insert into public.fee_settings(user_id) values(new.id);
  insert into public.integration_settings(user_id) values(new.id);
  insert into public.categories(user_id,type,name,is_system,impacts_result) values
    (new.id,'expense','Filamento',true,false),(new.id,'expense','Marketing / Ads',true,true),
    (new.id,'expense','Ferramentas',true,false),(new.id,'expense','Embalagens',true,false),
    (new.id,'expense','Energia',true,false),(new.id,'expense','Outros',true,true),
    (new.id,'income','Outras entradas',true,true);
  insert into public.cash_accounts(user_id,name,kind) values(new.id,'Carteira Shopee','shopee_wallet'),(new.id,'Conta bancária','bank'),(new.id,'Shopee - Saques em trânsito','transit');
  return new;
end
$$;

-- RLS.
alter table public.cash_accounts enable row level security;
alter table public.cash_movements enable row level security;
alter table public.expense_installments enable row level security;
alter table public.shopee_wallet_transactions enable row level security;

drop policy if exists cash_accounts_owner on public.cash_accounts;
create policy cash_accounts_owner on public.cash_accounts for all to authenticated using((select auth.uid())=user_id) with check((select auth.uid())=user_id);
drop policy if exists cash_movements_owner on public.cash_movements;
create policy cash_movements_owner on public.cash_movements for all to authenticated using((select auth.uid())=user_id) with check((select auth.uid())=user_id);
drop policy if exists expense_installments_owner on public.expense_installments;
create policy expense_installments_owner on public.expense_installments for all to authenticated using((select auth.uid())=user_id) with check((select auth.uid())=user_id);
drop policy if exists shopee_wallet_owner on public.shopee_wallet_transactions;
create policy shopee_wallet_owner on public.shopee_wallet_transactions for all to authenticated using((select auth.uid())=user_id) with check((select auth.uid())=user_id);

-- Permissões RPC.
revoke all on function public.update_financial_settings_transaction(uuid,numeric,numeric,numeric,numeric,numeric,numeric) from public,anon;
grant execute on function public.update_financial_settings_transaction(uuid,numeric,numeric,numeric,numeric,numeric,numeric) to authenticated,service_role;
revoke all on function public.bulk_update_variant_usage_transaction(uuid,uuid[],boolean,numeric,boolean,numeric,boolean,numeric,boolean,numeric) from public,anon;
grant execute on function public.bulk_update_variant_usage_transaction(uuid,uuid[],boolean,numeric,boolean,numeric,boolean,numeric,boolean,numeric) to authenticated,service_role;
revoke all on function public.apply_shopee_escrow(uuid,text,numeric,numeric,numeric,numeric,timestamptz) from public,anon,authenticated;
grant execute on function public.apply_shopee_escrow(uuid,text,numeric,numeric,numeric,numeric,timestamptz) to service_role;
revoke all on function public.record_shopee_wallet_transaction(uuid,text,text,text,text,text,numeric,numeric,numeric,date,bigint,text,text,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_shopee_wallet_transaction(uuid,text,text,text,text,text,numeric,numeric,numeric,date,bigint,text,text,text,text,text,text,jsonb) to service_role;
revoke all on function public.create_expense_transaction(uuid,uuid,date,text,numeric,jsonb,text,integer,date,uuid) from public,anon;
grant execute on function public.create_expense_transaction(uuid,uuid,date,text,numeric,jsonb,text,integer,date,uuid) to authenticated,service_role;
revoke all on function public.update_expense_transaction(uuid,uuid,uuid,date,text,numeric,jsonb,text,integer,date,uuid) from public,anon;
grant execute on function public.update_expense_transaction(uuid,uuid,uuid,date,text,numeric,jsonb,text,integer,date,uuid) to authenticated,service_role;
revoke all on function public.pay_expense_installment(uuid,uuid,date,uuid) from public,anon;
grant execute on function public.pay_expense_installment(uuid,uuid,date,uuid) to authenticated,service_role;
revoke all on function public.unpay_expense_installment(uuid,uuid) from public,anon;
grant execute on function public.unpay_expense_installment(uuid,uuid) to authenticated,service_role;
revoke all on function public.create_income_transaction(uuid,uuid,date,text,numeric,jsonb,uuid) from public,anon;
grant execute on function public.create_income_transaction(uuid,uuid,date,text,numeric,jsonb,uuid) to authenticated,service_role;
revoke all on function public.update_income_transaction(uuid,uuid,uuid,date,text,numeric,jsonb,uuid) from public,anon;
grant execute on function public.update_income_transaction(uuid,uuid,uuid,date,text,numeric,jsonb,uuid) to authenticated,service_role;
grant execute on function public.get_month_summary(date) to authenticated;

-- Recalcula todos os snapshots existentes com a regra final por unidade.
-- A migration roda com privilégios do owner, portanto faz o recálculo direto sem depender de auth.uid().
update public.sale_items si
set gross_total=round(si.unit_gross*si.quantity,2),
    shopee_percent_fee_unit=round(si.unit_gross*coalesce(fs.shopee_commission_percent,0)/100::numeric,2),
    shopee_percent_fee_total=round(round(si.unit_gross*coalesce(fs.shopee_commission_percent,0)/100::numeric,2)*si.quantity,2),
    shopee_fixed_fee_unit=round(coalesce(fs.shopee_fixed_fee,0),2),
    shopee_fixed_fee_total=round(coalesce(fs.shopee_fixed_fee,0)*si.quantity,2),
    shopee_fee_total=round(round(si.unit_gross*coalesce(fs.shopee_commission_percent,0)/100::numeric,2)*si.quantity+coalesce(fs.shopee_fixed_fee,0)*si.quantity,2),
    shopee_net_total=round(si.unit_gross*si.quantity-round(si.unit_gross*coalesce(fs.shopee_commission_percent,0)/100::numeric,2)*si.quantity-coalesce(fs.shopee_fixed_fee,0)*si.quantity,2),
    filament_cost_unit=round((coalesce(v.filament_grams,0)/1000::numeric)*coalesce(fs.filament_price_per_kg,0),4),
    energy_cost_unit=round(coalesce(v.print_time_hours,0)*(coalesce(v.printer_power_watts,fs.default_printer_power_watts,0)/1000::numeric)*coalesce(fs.energy_price_per_kwh,0),4),
    packaging_cost_unit=coalesce(v.packaging_cost,fs.default_packaging_cost,0),
    production_cost_unit=round(((coalesce(v.filament_grams,0)/1000::numeric)*coalesce(fs.filament_price_per_kg,0))+(coalesce(v.print_time_hours,0)*(coalesce(v.printer_power_watts,fs.default_printer_power_watts,0)/1000::numeric)*coalesce(fs.energy_price_per_kwh,0))+coalesce(v.packaging_cost,fs.default_packaging_cost,0),4),
    production_cost_total=round((((coalesce(v.filament_grams,0)/1000::numeric)*coalesce(fs.filament_price_per_kg,0))+(coalesce(v.print_time_hours,0)*(coalesce(v.printer_power_watts,fs.default_printer_power_watts,0)/1000::numeric)*coalesce(fs.energy_price_per_kwh,0))+coalesce(v.packaging_cost,fs.default_packaging_cost,0))*si.quantity,2)
from public.product_variants v,public.fee_settings fs
where v.id=si.variant_id and v.user_id=si.user_id and fs.user_id=si.user_id;

with t as(
  select s.id,coalesce(round(sum(si.gross_total),2),0) gross,coalesce(round(sum(si.shopee_fee_total),2),0) fee,
         coalesce(round(sum(si.shopee_net_total),2),0) est_net,coalesce(round(sum(si.production_cost_total),2),0) prod
  from public.sales s left join public.sale_items si on si.sale_id=s.id and si.user_id=s.user_id group by s.id
)
update public.sales s set gross_total=t.gross,shopee_fee_total=t.fee,shopee_estimated_net_total=t.est_net,
  shopee_net_total=round(coalesce(s.shopee_actual_net_total,t.est_net),2),production_cost_total=t.prod,
  net_profit_total=round(coalesce(s.shopee_actual_net_total,t.est_net)-t.prod,2)
from t where t.id=s.id;

notify pgrst,'reload schema';
commit;
