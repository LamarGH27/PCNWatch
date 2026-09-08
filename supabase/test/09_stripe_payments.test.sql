-- Stripe payments: what the database refuses regardless of the application.
--
-- The whole payments design rests on three things the database enforces, and
-- the application is written assuming all three. 0020 adds columns and a table
-- to schemas that had barely been written to, which is exactly when an assumed
-- guarantee turns out not to hold.
--
--   1. A payment cannot reach PAID without a webhook confirmation. This is what
--      makes the success redirect harmless: even if a route were wrong, the row
--      it tried to write would be refused.
--   2. `stripe_events.id` is a primary key. `claimEvent` inserts and expects a
--      23505 collision on a repeat delivery — if the constraint were missing,
--      duplicate webhooks would each grant.
--   3. A user may look at their payments and entitlements and never write one.
--
-- Every insert here uses the columns the application actually sends, which is
-- the discipline suite 07 was written without.

\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email) values
  ('a1000000-0000-0000-0000-00000000000a', null),
  ('b1000000-0000-0000-0000-00000000000b', null);

insert into products (sku, name, description, price_pence, entitlements)
values ('TEST_DEFENCE', 'Test Defence Pack', 'Fixture product', 599, '{CHALLENGE_DRAFT}');

-- ---------------------------------------------------------------------------
-- 1. PAID still requires a webhook confirmation, with 0020's columns present
-- ---------------------------------------------------------------------------

do $$
declare
  failed boolean := false;
  prod   uuid;
begin
  select id into prod from products where sku = 'TEST_DEFENCE';

  begin
    insert into payments (user_id, product_id, status, amount_pence, livemode)
    values ('a1000000-0000-0000-0000-00000000000a', prod, 'PAID', 599, true);
  exception when check_violation then
    failed := true;
  end;

  assert failed,
    'A PAID payment was accepted with no webhook confirmation. The redirect could grant.';
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The webhook's own write is accepted, and the new columns hold what it records
-- ---------------------------------------------------------------------------

do $$
declare
  prod    uuid;
  written payments%rowtype;
begin
  select id into prod from products where sku = 'TEST_DEFENCE';

  insert into payments
    (user_id, product_id, status, amount_pence, currency,
     stripe_checkout_session_id, stripe_payment_intent_id, stripe_price_id,
     stripe_charge_id, livemode, confirmed_by_webhook_at)
  values
    ('a1000000-0000-0000-0000-00000000000a', prod, 'PAID', 599, 'GBP',
     'cs_test_suite_1', 'pi_test_suite_1', 'price_test_suite', 'ch_test_suite',
     false, now())
  returning * into written;

  assert written.livemode = false,
    'livemode did not survive the write; a Test payment would be indistinguishable from a real one.';
  assert written.stripe_charge_id = 'ch_test_suite',
    'The charge id was not stored, so a refund has nothing to reference.';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. One session, one payment row
-- ---------------------------------------------------------------------------
--
-- The webhook upserts on this column. Without the unique constraint the upsert
-- would insert a second PAID row for one payment.

do $$
declare
  failed boolean := false;
  prod   uuid;
begin
  select id into prod from products where sku = 'TEST_DEFENCE';

  begin
    insert into payments
      (user_id, product_id, status, amount_pence, stripe_checkout_session_id,
       confirmed_by_webhook_at)
    values
      ('b1000000-0000-0000-0000-00000000000b', prod, 'PAID', 599, 'cs_test_suite_1', now());
  exception when unique_violation then
    failed := true;
  end;

  assert failed, 'Two payment rows were accepted for one Checkout Session.';
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. A repeated webhook event collides, which is what makes it a no-op
-- ---------------------------------------------------------------------------

do $$
declare
  failed boolean := false;
begin
  insert into stripe_events (id, type, livemode) values ('evt_suite_1', 'checkout.session.completed', false);

  begin
    insert into stripe_events (id, type, livemode) values ('evt_suite_1', 'checkout.session.completed', false);
  exception when unique_violation then
    failed := true;
  end;

  assert failed,
    'A repeated Stripe event id was accepted. Duplicate deliveries would each be processed.';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. A repeated grant of the same entitlement collides
-- ---------------------------------------------------------------------------
--
-- What makes `grantEntitlementsForPayment` idempotent. Note the case_id is
-- present: a null there would not conflict in Postgres, which is why the
-- webhook only grants when the session names a case.

do $$
declare
  failed     boolean := false;
  owned_case uuid;
begin
  insert into pcn_cases (user_id, pcn_number, notice_type, procedural_stage, status)
  values ('a1000000-0000-0000-0000-00000000000a', 'WM91000001', 'PCN_POSTAL', 'NEW', 'ASSESSED')
  returning id into owned_case;

  insert into entitlements (user_id, case_id, entitlement)
  values ('a1000000-0000-0000-0000-00000000000a', owned_case, 'CHALLENGE_DRAFT');

  begin
    insert into entitlements (user_id, case_id, entitlement)
    values ('a1000000-0000-0000-0000-00000000000a', owned_case, 'CHALLENGE_DRAFT');
  exception when unique_violation then
    failed := true;
  end;

  assert failed, 'The same entitlement was granted twice on one case.';
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. A user may read their own payments and write none
-- ---------------------------------------------------------------------------

do $$
declare
  failed  boolean := false;
  visible integer;
  prod    uuid;
begin
  select id into prod from products where sku = 'TEST_DEFENCE';

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-00000000000a', true);

  select count(*) into visible from payments;
  assert visible = 1, format('Expected to see one own payment, saw %s.', visible);

  begin
    insert into payments (user_id, product_id, status, amount_pence, confirmed_by_webhook_at)
    values ('a1000000-0000-0000-0000-00000000000a', prod, 'PAID', 599, now());
  exception when insufficient_privilege then
    failed := true;
  end;

  assert failed, 'A user wrote their own PAID payment row.';
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. A user cannot see another user's payment
-- ---------------------------------------------------------------------------

do $$
declare
  visible integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-00000000000b', true);

  select count(*) into visible from payments;
  assert visible = 0, format('Another user''s payments were visible: %s rows.', visible);

  select count(*) into visible from entitlements;
  assert visible = 0, format('Another user''s entitlements were visible: %s rows.', visible);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. A user cannot grant themselves an entitlement
-- ---------------------------------------------------------------------------

do $$
declare
  failed     boolean := false;
  owned_case uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-00000000000b', true);

  insert into pcn_cases (pcn_number, notice_type, procedural_stage, status)
  values ('WM91000002', 'PCN_POSTAL', 'NEW', 'ASSESSED')
  returning id into owned_case;

  begin
    insert into entitlements (user_id, case_id, entitlement)
    values ('b1000000-0000-0000-0000-00000000000b', owned_case, 'CHALLENGE_DRAFT');
  exception when insufficient_privilege then
    failed := true;
  end;

  assert failed, 'A user granted themselves the paid entitlement.';
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Webhook events are invisible to every client role
-- ---------------------------------------------------------------------------
--
-- No user owns a webhook event, so there is no policy that could make one
-- visible. The table is revoked outright rather than left to RLS alone.

do $$
declare
  failed boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-00000000000a', true);

  begin
    perform count(*) from stripe_events;
  exception when insufficient_privilege then
    failed := true;
  end;

  assert failed, 'A signed-in user could read the Stripe event log.';
end;
$$;

do $$
declare
  failed boolean := false;
begin
  set local role anon;

  begin
    insert into stripe_events (id, type) values ('evt_forged', 'checkout.session.completed');
  exception when insufficient_privilege then
    failed := true;
  end;

  assert failed, 'An anonymous client could write to the Stripe event log.';
end;
$$;

rollback;

\echo '✓ 09_stripe_payments'
