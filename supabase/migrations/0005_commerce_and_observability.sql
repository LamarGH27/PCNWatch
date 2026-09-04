-- PCNWatch schema — 0005: products, payments, AI logs, audit.

create table products (
  id                uuid primary key default gen_random_uuid(),
  sku               text not null unique,
  name              text not null,
  description       text not null default '',
  price_pence       integer not null,
  currency          text not null default 'GBP',
  stripe_price_id   text,
  active            boolean not null default true,
  -- What purchasing this unlocks, e.g. ["DETAILED_ASSESSMENT","DRAFT","EXPORT"].
  entitlements      text[] not null default '{}',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint products_price_positive check (price_pence > 0)
);

create table payments (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null references auth.users(id) on delete cascade,
  case_id                   uuid references pcn_cases(id) on delete set null,
  product_id                uuid not null references products(id) on delete restrict,
  status                    payment_status not null default 'PENDING',
  amount_pence              integer not null,
  currency                  text not null default 'GBP',
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id  text,
  -- Set only by the webhook handler. A success redirect never writes this.
  confirmed_by_webhook_at   timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint payments_paid_requires_webhook
    check (status <> 'PAID' or confirmed_by_webhook_at is not null)
);
create index payments_user_idx on payments (user_id, created_at desc);
create index payments_case_idx on payments (case_id);
comment on constraint payments_paid_requires_webhook on payments is
  'A payment can only reach PAID via the Stripe webhook. Enforced in the database so a redirect parameter cannot grant entitlement even if application code is wrong.';

create table entitlements (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  case_id      uuid references pcn_cases(id) on delete cascade,
  entitlement  text not null,
  payment_id   uuid references payments(id) on delete set null,
  granted_at   timestamptz not null default now(),
  expires_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, case_id, entitlement)
);
create index entitlements_lookup_idx on entitlements (user_id, case_id);

-- Subscriptions are not sold in V1. The table exists so adding them later does not
-- require a schema redesign, and is intentionally left empty.
create table subscriptions (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users(id) on delete cascade,
  product_id              uuid references products(id) on delete set null,
  stripe_subscription_id  text unique,
  status                  text not null default 'INACTIVE',
  current_period_end      timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- AI observability
-- ---------------------------------------------------------------------------

create table ai_logs (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid references auth.users(id) on delete set null,
  case_id             uuid references pcn_cases(id) on delete set null,
  job_type            ai_job_type not null,
  model               text not null,
  prompt_version      text not null,
  -- Hash of the input, not the input itself. Personal data never lands here.
  input_fingerprint   text not null,
  input_token_estimate integer,
  output              jsonb,
  validation_result   ai_validation_result not null,
  validation_errors   jsonb,
  latency_ms          integer,
  created_at          timestamptz not null default now()
);
create index ai_logs_job_created_idx on ai_logs (job_type, created_at desc);
create index ai_logs_failures_idx on ai_logs (created_at desc) where validation_result <> 'ACCEPTED';
comment on table ai_logs is
  'Model call audit. `output` is retained for accepted and rejected calls alike so failures are visible; raw personal input is never stored, only a fingerprint.';

alter table pcn_assessments add constraint pcn_assessments_ai_log_fkey
  foreign key (ai_log_id) references ai_logs(id) on delete set null;
alter table pcn_drafts add constraint pcn_drafts_ai_log_fkey
  foreign key (ai_log_id) references ai_logs(id) on delete set null;

create table audit_events (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users(id) on delete set null,
  actor        text not null default 'USER',
  action       text not null,
  entity_type  text,
  entity_id    uuid,
  correlation_id text,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index audit_events_user_idx on audit_events (user_id, created_at desc);
create index audit_events_action_idx on audit_events (action, created_at desc);

create table rate_limit_counters (
  key         text not null,
  window_start timestamptz not null,
  count       integer not null default 0,
  primary key (key, window_start)
);
create index rate_limit_counters_window_idx on rate_limit_counters (window_start);

select add_touch_trigger('products');
select add_touch_trigger('payments');
select add_touch_trigger('entitlements');
select add_touch_trigger('subscriptions');
