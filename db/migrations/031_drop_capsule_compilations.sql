-- Migration 031: drop the capsule compilation log.
--
-- capsule_compilations recorded one row per compiled capsule: budget, token
-- estimate, node counts and a JSON rationale for every included and omitted
-- node. Nothing read it back: no tool, no service, no script. It was written
-- on every capsule request and deleted only when a snapshot was re-ingested,
-- so on a busy server it was the one table that grew with reads rather than
-- with code. The compiler's decisions are already visible in the capsule it
-- returns (omission_rationale, fetch_handles, token_estimate).

DROP TABLE IF EXISTS capsule_compilations;
