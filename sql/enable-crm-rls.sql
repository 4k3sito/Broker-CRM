-- Ejecutar una sola vez en Supabase: SQL Editor.
--
-- Protege el CRM estático a nivel de la base de datos. Antes de aplicarlo,
-- este script elimina TODAS las políticas existentes de las tablas indicadas
-- y las reemplaza por las políticas de acceso definidas aquí.

begin;

do $$
declare
  target_table text;
  policy_record record;
begin
  foreach target_table in array array[
    'listings',
    'user_listing',
    'cliente',
    'ficha',
    'proceso',
    'ficha_documento'
  ]
  loop
    if to_regclass(format('public.%I', target_table)) is null then
      raise exception 'No existe la tabla public.%', target_table;
    end if;

    execute format('alter table public.%I enable row level security', target_table);
    execute format('revoke all on table public.%I from anon', target_table);

    for policy_record in
      select policyname
      from pg_policies
      where schemaname = 'public' and tablename = target_table
    loop
      execute format('drop policy %I on public.%I', policy_record.policyname, target_table);
    end loop;
  end loop;
end
$$;

-- El inventario es compartido entre agentes con sesión; nunca es público.
grant select on table public.listings to authenticated;

create policy "crm_authenticated_read_listings"
on public.listings
for select
to authenticated
using (true);

-- Los datos de seguimiento y de clientes pertenecen exclusivamente a quien los creó.
grant select, insert, update, delete on table public.user_listing, public.cliente,
  public.ficha, public.proceso, public.ficha_documento to authenticated;

create policy "crm_user_listing_owner"
on public.user_listing
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "crm_cliente_owner"
on public.cliente
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "crm_ficha_owner"
on public.ficha
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "crm_proceso_owner"
on public.proceso
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "crm_ficha_documento_owner"
on public.ficha_documento
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

-- Índices para que las políticas que filtran por user_id escalen correctamente.
create index if not exists user_listing_user_id_idx on public.user_listing (user_id);
create index if not exists cliente_user_id_idx on public.cliente (user_id);
create index if not exists ficha_user_id_idx on public.ficha (user_id);
create index if not exists proceso_user_id_idx on public.proceso (user_id);
create index if not exists ficha_documento_user_id_idx on public.ficha_documento (user_id);

commit;
