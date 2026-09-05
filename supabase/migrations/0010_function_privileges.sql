-- ---------------------------------------------------------------------------
-- Function privileges: close what hosting on Supabase opens.
--
-- PostgREST publishes EVERY function in the `public` schema as an RPC endpoint,
-- callable by anyone holding the anon key — which is public by design, shipped
-- in the browser bundle. PostgreSQL grants EXECUTE to PUBLIC on new functions by
-- default, and 0007 revokes table privileges but not function ones. Locally
-- there is no PostgREST, so none of this is reachable and none of it showed.
--
-- On a hosted project it means an anonymous request could, before this file:
--
--   * call pcnwatch_rebuild_aggregates() — a SECURITY DEFINER function that
--     rewrites every aggregate row for an authority. Repeated calls are a
--     denial-of-service against our own database, from an unauthenticated
--     client, at no cost to the caller.
--   * call pcnwatch_bump_rate_limit() — writing to the table the rate limiter
--     depends on, so the mechanism meant to stop abuse could itself be driven
--     by an abuser.
--   * call pcnwatch_scoring_inputs() — reading the full scoring input set for
--     every location in one request.
--
-- All three are only ever called by PCNWatch itself through the service-role
-- client. None is called with the anon or authenticated key. So EXECUTE is
-- revoked from everyone and granted back to service_role alone.
--
-- The three read functions behind the map and hotspot pages are deliberately
-- untouched: they are the public API of a public dataset, and anon must keep
-- calling them.
-- ---------------------------------------------------------------------------

revoke execute on function pcnwatch_rebuild_aggregates(uuid) from public, anon, authenticated;
revoke execute on function pcnwatch_scoring_inputs(text, date) from public, anon, authenticated;
revoke execute on function pcnwatch_bump_rate_limit(text, timestamptz) from public, anon, authenticated;

grant execute on function pcnwatch_rebuild_aggregates(uuid) to service_role;
grant execute on function pcnwatch_scoring_inputs(text, date) to service_role;
grant execute on function pcnwatch_bump_rate_limit(text, timestamptz) to service_role;

-- New functions must not inherit the permissive default either.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
