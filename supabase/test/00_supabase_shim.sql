-- Local-only shim reproducing the parts of the Supabase platform our migrations
-- depend on: the auth schema, auth.uid(), the storage schema, and the anon /
-- authenticated / service_role roles.
--
-- This file is NEVER applied to a Supabase project — Supabase provides all of it.
-- It exists so the migrations and the RLS policy tests can run against a plain
-- PostgreSQL + PostGIS cluster in CI.

create schema if not exists auth;
create schema if not exists storage;

do $$ begin
  create role anon nologin noinherit;
exception when duplicate_object then null; end $$;
do $$ begin
  create role authenticated nologin noinherit;
exception when duplicate_object then null; end $$;
do $$ begin
  create role service_role nologin noinherit bypassrls;
exception when duplicate_object then null; end $$;

create table if not exists auth.users (
  id         uuid primary key default gen_random_uuid(),
  email      text unique,
  created_at timestamptz not null default now()
);

-- Supabase derives auth.uid() from the request JWT. Locally we read the same
-- GUC that Supabase populates, so policies are exercised exactly as written.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon');
$$;

create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz not null default now()
);

create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets(id),
  name       text not null,
  owner      uuid,
  created_at timestamptz not null default now()
);

create or replace function storage.foldername(name text)
returns text[]
language sql
immutable
as $$
  select string_to_array(name, '/');
$$;

grant usage on schema public, auth, storage to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;

-- Supabase grants these on the storage schema; reproduce them so the storage
-- policies in 0006 are exercised rather than masked by a missing grant.
grant select, insert, update, delete on storage.objects to authenticated;
grant select on storage.objects to anon;
grant select on storage.buckets to anon, authenticated;
