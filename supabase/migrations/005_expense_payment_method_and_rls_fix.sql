-- Freo Figures
-- Corrige inserts autenticados de entradas/saídas sem desativar RLS
-- e adiciona forma de pagamento às saídas.

begin;

alter table public.expenses
  add column if not exists payment_method text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'expenses_payment_method_check'
      and conrelid = 'public.expenses'::regclass
  ) then
    alter table public.expenses
      add constraint expenses_payment_method_check
      check (
        payment_method is null
        or payment_method in ('credit', 'installment', 'debit', 'pix')
      );
  end if;
end
$$;

create index if not exists expenses_user_payment_method_idx
  on public.expenses(user_id, payment_method);

-- Mantém RLS habilitada. O trigger apenas preenche o dono da linha
-- com o usuário autenticado quando o front não enviar user_id.
create or replace function public.fill_user_id()
returns trigger
language plpgsql
as $$
begin
  if new.user_id is null then
    new.user_id := auth.uid();
  end if;

  if new.user_id is null then
    raise exception 'user_id ausente';
  end if;

  return new;
end
$$;

drop trigger if exists expenses_fill_user on public.expenses;
create trigger expenses_fill_user
before insert on public.expenses
for each row execute function public.fill_user_id();

drop trigger if exists income_fill_user on public.income;
create trigger income_fill_user
before insert on public.income
for each row execute function public.fill_user_id();

alter table public.expenses enable row level security;
alter table public.income enable row level security;

-- Recria as políticas de proprietário de forma idempotente.
drop policy if exists expenses_owner on public.expenses;
create policy expenses_owner
on public.expenses
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists income_owner on public.income;
create policy income_owner
on public.income
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

commit;
