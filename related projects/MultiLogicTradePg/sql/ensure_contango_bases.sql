-- #1042: базовые бумаги (спот) для контанго и их связка с фьючерсами.
-- Курсы CNY/USD, золото и серебро грузятся из T-Bank по figi (MOEX ISS не
-- отдаёт intraday-свечи по валютному рынку). Скрипт идемпотентен.
--
-- Пары: CNYRUBF -> CNYRUB_TOM, USDRUBF -> USD000UTSTOM,
--       GLDRUBF -> GLDRUB_TOM, SILV -> SLVRUB_TOM.

DO $$
DECLARE
    v_index_type INTEGER;
    r RECORD;
    v_future INTEGER;
    v_base INTEGER;
    v_syn INTEGER;
BEGIN
    SELECT id INTO v_index_type FROM security_types WHERE name = 'Index' LIMIT 1;

    FOR r IN
        SELECT * FROM (VALUES
            ('CNYRUBF', 'CNY/RUB spot CETS', 'CNYRUB_TOM', 'BBG0013HRTL0', 'CTG:CNY'),
            ('USDRUBF', 'USD/RUB spot CETS', 'USD000UTSTOM', 'BBG0013HGFT4', 'CTG:USD'),
            ('GLDRUBF', 'Gold GLDRUB_TOM', 'GLDRUB_TOM', 'BBG000VJ5YR4', 'CTG:GOLD'),
            ('SILV',    'Silver SLVRUB_TOM', 'SLVRUB_TOM', 'BBG000VHQTD1', 'CTG:SILV')
        ) AS v(future_prefix, base_name, base_prefix, base_figi, syn_name)
    LOOP
        SELECT sp.security_id INTO v_future
        FROM security_prefixes sp
        WHERE upper(btrim(sp.prefix)) = r.future_prefix
          AND sp.instrument_market = 'futures'
        LIMIT 1;
        CONTINUE WHEN v_future IS NULL;

        -- базовая бумага (спот)
        SELECT s.id INTO v_base FROM securities s WHERE s.name = r.base_name LIMIT 1;
        IF v_base IS NULL THEN
            INSERT INTO securities(name, security_type_id, lot_size)
            VALUES (r.base_name, 11, 1)
            RETURNING id INTO v_base;
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM security_prefixes sp
            WHERE sp.security_id = v_base AND sp.exchange_id = 1
        ) THEN
            INSERT INTO security_prefixes
                (security_id, exchange_id, prefix, instrument_market, tbank_figi, note)
            VALUES (v_base, 1, r.base_prefix, 'other', r.base_figi, 'CETS currency');
        END IF;

        -- связка фьючерс → база: по ней бэктест грузит историю спота
        UPDATE security_prefixes sp
        SET underlying_security_id = v_base
        WHERE sp.security_id = v_future
          AND sp.exchange_id = 1
          AND sp.underlying_security_id IS DISTINCT FROM v_base;

        -- если пара уже есть — не трогаем
        CONTINUE WHEN EXISTS (
            SELECT 1 FROM contango_securities cs WHERE cs.future_security_id = v_future
        );

        -- синтетическая бумага CTG:*
        SELECT s.id INTO v_syn FROM securities s WHERE s.name = r.syn_name LIMIT 1;
        IF v_syn IS NULL THEN
            INSERT INTO securities(name, security_type_id, lot_size)
            VALUES (r.syn_name, COALESCE(v_index_type, 10), 1)
            RETURNING id INTO v_syn;
            INSERT INTO security_prefixes
                (security_id, exchange_id, prefix, instrument_market, underlying_security_id)
            VALUES (v_syn, 1, r.syn_name, 'other', v_future);
        END IF;

        INSERT INTO contango_securities
            (future_security_id, underlying_security_id, synthetic_security_id)
        VALUES (v_future, v_base, v_syn);
    END LOOP;
END;
$$;
