-- Idempotente: garante defaults para usuários Auth que já existiam antes da migration 001.
insert into public.users(id) select id from auth.users on conflict do nothing;
insert into public.fee_settings(user_id) select id from auth.users on conflict do nothing;
insert into public.integration_settings(user_id) select id from auth.users on conflict do nothing;
insert into public.categories(user_id,type,name,is_system) select u.id,v.type::public.entry_type,v.name,true from auth.users u cross join (values ('expense','Filamento'),('expense','Marketing / Ads'),('expense','Ferramentas'),('expense','Embalagens'),('expense','Energia'),('expense','Outros'),('income','Outras entradas')) v(type,name) on conflict do nothing;
