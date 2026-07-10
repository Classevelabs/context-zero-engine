-- 018: widen chk_de_resolution_method to the FULL DispatchResolver RESOLUTION enum.
--
-- The dispatch resolver (src/analysis-engine/dispatch-resolver.ts) legitimately emits
-- factory_return / dependency_injection / dataclass_attr / local_flow in addition to the
-- six methods migration 012 allowed — so EVERY snapshot whose dispatch resolution used one
-- of those threw a chk_de_resolution_method violation and silently dropped all its dispatch
-- edges (the whole batch insert rolled back). This constraint now lists exactly the values
-- ALLOWED_RESOLUTION_METHODS in that file permits; the code also normalizes any out-of-set
-- value (e.g. an unbounded points-to fact.source) to 'unresolved' before insert, so the two
-- can never drift again.

ALTER TABLE dispatch_edges DROP CONSTRAINT IF EXISTS chk_de_resolution_method;

DO $$ BEGIN
    ALTER TABLE dispatch_edges ADD CONSTRAINT chk_de_resolution_method
        CHECK (resolution_method IN (
            'type_annotation', 'constructor_assignment', 'field_inference',
            'inheritance_mro', 'factory_return', 'dependency_injection',
            'dataclass_attr', 'runtime_observed', 'local_flow', 'unresolved'
        ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
