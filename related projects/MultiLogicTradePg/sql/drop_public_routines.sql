-- Drop all user FUNCTIONs and PROCEDUREs in schema public.
-- Used on installer upgrade (No) before re-applying 02, so signature changes
-- are safe. Does not touch tables or data. Skips extension-owned routines.
-- Safe to run on empty / fresh databases.

DO $drop_public_routines$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT
            p.oid,
            p.proname,
            pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
            CASE p.prokind
                WHEN 'p' THEN 'PROCEDURE'
                ELSE 'FUNCTION'
            END AS kind
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        LEFT JOIN pg_catalog.pg_depend d
            ON d.objid = p.oid
           AND d.deptype = 'e'
        WHERE n.nspname = 'public'
          AND d.objid IS NULL
          AND p.prokind IN ('f', 'p', 'w', 'a')
        ORDER BY p.proname, p.oid
    LOOP
        EXECUTE format(
            'DROP %s IF EXISTS public.%I(%s) CASCADE',
            r.kind,
            r.proname,
            r.args
        );
    END LOOP;
END
$drop_public_routines$;
