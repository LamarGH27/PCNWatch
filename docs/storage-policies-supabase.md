# Storage policies on hosted Supabase

Migration `0006` cannot create these. This is the supported path, and the
deployment is not storage-ready until it is done.

## Why the migration cannot do it

`storage.objects` is owned by `supabase_storage_admin`. The role running
migrations owns the `public` schema but not that table, so
`ALTER TABLE … ENABLE ROW LEVEL SECURITY`, `DROP POLICY` and `CREATE POLICY`
against it all fail with `42501: must be owner of table objects`. Taking
ownership is not an option — the platform manages that schema and is entitled to
change it underneath us.

So `0006` attempts the setup, tolerates the privilege error, and records what is
actually true. Buckets are created by the migration (INSERT is a table
privilege, not ownership). The six object policies are created here.

## The six policies

Two buckets, three operations each. Role `authenticated` for all six. Object
paths are `<user_id>/<case_id>/<filename>`, so the owning user is the first path
segment and the check needs no join.

| Policy name | Operation | Expression |
| --- | --- | --- |
| `own objects read pcn-documents` | SELECT | `bucket_id = 'pcn-documents' and (storage.foldername(name))[1] = (select auth.uid())::text` |
| `own objects write pcn-documents` | INSERT | *(as above, as WITH CHECK)* |
| `own objects delete pcn-documents` | DELETE | *(as above)* |
| `own objects read pcn-evidence` | SELECT | `bucket_id = 'pcn-evidence' and (storage.foldername(name))[1] = (select auth.uid())::text` |
| `own objects write pcn-evidence` | INSERT | *(as above, as WITH CHECK)* |
| `own objects delete pcn-evidence` | DELETE | *(as above)* |

The names matter: `pcnwatch_storage_readiness()` looks for exactly these, and the
application refuses uploads until all six are present.

## Dashboard steps

Do this once per project, for each of the two buckets.

1. **Storage → Buckets.** Confirm `pcn-documents` and `pcn-evidence` exist and
   both show as **Private**. Migration 0006 creates them. If either is missing,
   create it with public access **off**, size limit `12582912` bytes, allowed
   MIME types `image/jpeg, image/png, image/webp, application/pdf`.
2. **Storage → Policies.** Select the bucket, then **New policy → For full
   customization**.
3. Create the SELECT policy: name it exactly as in the table above, tick
   **SELECT**, set target roles to **authenticated**, and paste the expression
   into the USING box.
4. Repeat for INSERT — the expression goes in the **WITH CHECK** box, not USING.
5. Repeat for DELETE — expression in USING.
6. Do steps 2–5 again for the second bucket, changing `bucket_id`.

You should end with six policies. Nothing is granted to `anon`, and there is no
UPDATE policy: a stored document is replaced by deleting and re-uploading.

## Verify

Run this in the SQL editor. It reads the catalogue, so it gives the same answer
however the policies were made:

```sql
select * from pcnwatch_storage_readiness();
```

`ready` must be `true`, `policies_present` `6`, `missing` empty. If `ready` is
false, `missing` names exactly which policies to create.

## Prove one user cannot read another's documents

Readiness says the policies exist. This says they work. Run it in the SQL editor;
it creates two objects, checks isolation from both sides, and cleans up.

```sql
insert into storage.objects (bucket_id, name, owner) values
  ('pcn-documents', '00000000-0000-0000-0000-00000000000a/case-a/notice.pdf',
   '00000000-0000-0000-0000-00000000000a'),
  ('pcn-documents', '00000000-0000-0000-0000-00000000000b/case-b/notice.pdf',
   '00000000-0000-0000-0000-00000000000b');

do $$
declare a_sees int; leaked int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
  select count(*) into a_sees  from storage.objects where name like '00000000-0000-0000-0000-00000000000a/%';
  select count(*) into leaked  from storage.objects where name like '00000000-0000-0000-0000-00000000000b/%';
  reset role;
  if leaked <> 0 then
    raise exception 'FAIL: user A can see % of user B''s objects', leaked;
  end if;
  if a_sees <> 1 then
    raise exception 'FAIL: user A cannot see their own object';
  end if;
  raise notice 'PASS: A sees own 1, sees 0 of B''s';
end;
$$;

delete from storage.objects
 where name like '00000000-0000-0000-0000-00000000000a/%'
    or name like '00000000-0000-0000-0000-00000000000b/%';
```

Expect `NOTICE: PASS: A sees own 1, sees 0 of B's`. Anything else means the
policies are wrong and documents are exposed — do not treat storage as ready.

The same checks run automatically against a local database as
`supabase/test/04_storage_readiness.test.sql` (`npm run db:test`), including a
case proving readiness turns false when a policy is removed.
