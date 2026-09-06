-- Migration 027: record who reviewed an inferred relation, and when.
--
-- reviewHomolog wrote `updated_at = NOW()` to inferred_relations, a column the
-- table has never had, so every review failed on the column and the tool had
-- never once recorded a review. The reviewer's name was accepted and logged
-- but not stored. A review is a decision worth keeping: which relation, what
-- state, who decided it, when. Both columns are nullable — rows reviewed
-- before this migration carry no author or time, which is the truth about
-- them — and nothing else in the schema changes.

ALTER TABLE inferred_relations ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE inferred_relations ADD COLUMN IF NOT EXISTS reviewed_by TEXT;

COMMENT ON COLUMN inferred_relations.reviewed_at IS
    'When review_state was last set through a review. NULL for rows never reviewed.';
COMMENT ON COLUMN inferred_relations.reviewed_by IS
    'Who set review_state, as supplied by the reviewing tool call. NULL when not given.';
