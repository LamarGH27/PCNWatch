-- ---------------------------------------------------------------------------
-- Stripe Checkout: durable payment state and webhook idempotency
-- ---------------------------------------------------------------------------
--
-- `payments` has existed since 0005 with the constraint that matters — a row
-- cannot reach PAID without `confirmed_by_webhook_at`, so a success redirect
-- cannot grant anything even if the application code is wrong. Nothing here
-- weakens that.
--
-- What is missing is everything before and after the moment of payment:
--
--   * a row when the Checkout Session is created, so a session that is
--     abandoned, cancelled or expired is a fact we hold rather than something
--     only Stripe knows;
--   * the identifiers a human needs to find and refund a payment later;
--   * whether the money was real, which is the difference between a Preview
--     test and a customer;
--   * a record of which webhook events have been processed.
--
-- The last one is worth being precise about. Idempotency today rests on
-- `stripe_checkout_session_id` being unique, which makes a repeated delivery of
-- the *same* event harmless. It does not help when two different events carry
-- the same session, which Stripe does — `checkout.session.completed` and
-- `checkout.session.async_payment_succeeded` are separate events about one
-- session. Keying on the event id records what was actually processed.
--
-- Expand-only and idempotent. Every column is added with a default that leaves
-- existing rows meaning exactly what they mean today.

alter table payments
  -- Reconciliation: which Price was charged, and the charge a refund is issued
  -- against. Stored because a support request six months from now starts with
  -- "which payment was this" and ends in the Stripe dashboard.
  add column if not exists stripe_price_id text,
  add column if not exists stripe_charge_id text,

  -- False for a Test-mode payment. Recorded from the webhook's own `livemode`
  -- rather than inferred from configuration, so a row says what actually
  -- happened rather than what the environment was set to at the time.
  add column if not exists livemode boolean,

  -- When the Checkout Session was created, and when it stopped being usable.
  add column if not exists session_created_at timestamptz,
  add column if not exists session_expires_at timestamptz,

  -- Why a payment did not complete. Never an error from Stripe verbatim:
  -- a short internal reason a support process can act on.
  add column if not exists failure_reason text;

comment on column payments.livemode is
  'Whether Stripe processed real money. Read from the webhook event, not from configuration, so the row records what happened rather than what was configured.';
comment on column payments.stripe_charge_id is
  'The charge a refund would be issued against. Stored for support, not used by the application.';

create index if not exists payments_session_idx on payments (stripe_checkout_session_id);
create index if not exists payments_pending_idx
  on payments (user_id, case_id, status)
  where status = 'PENDING';

-- ---------------------------------------------------------------------------
-- Webhook events
-- ---------------------------------------------------------------------------
--
-- One row per Stripe event id, written before the event is acted on. A second
-- delivery of the same event finds the row and stops.
--
-- Deliberately not RLS-enabled for user access: no user owns a webhook event,
-- and the service role is the only thing that touches this table. It is
-- revoked from every client role below rather than left to the default.

create table if not exists stripe_events (
  -- Stripe's own event id. The natural key, so a duplicate delivery collides.
  id            text primary key,
  type          text not null,
  livemode      boolean,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  -- ACTED, IGNORED or REJECTED. What we did, for reconciliation.
  outcome       text,
  payment_id    uuid references payments(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists stripe_events_received_idx on stripe_events (received_at desc);

comment on table stripe_events is
  'One row per Stripe event id, written before the event is acted on. Repeated delivery of the same event is a no-op. Service role only: no user owns a webhook event.';

alter table stripe_events enable row level security;

-- No policy is created, so RLS denies every authenticated and anonymous read.
-- The service role bypasses RLS and is the only thing that writes here.
revoke all on stripe_events from public;
do $$
begin
  execute 'revoke all on stripe_events from anon, authenticated';
exception when undefined_object then
  -- Local shim without the Supabase roles. Nothing to revoke.
  null;
end;
$$;
