-- ============================================
-- MultiLogicTrade — шаг 1: таблицы и справочники
-- Версия: v54 (идемпотентный запуск)
-- v54: install-on-top ensure всех seed-логик (в т.ч. LinReg Fade Optimized); бумаги Optimized после назначения LinReg Fade
--      + sql/ensure_seed_logics.sql (post-01, installer проверяет наличие LinReg Fade Optimized)
-- v53: logic_backtest_runs.last_opt_eval_bar_dt — курсор OPT в тесте (не трогает live param)
-- v52: logic_opt_param_history — снимок/promote параметров OPT для отчёта теста
-- v51: position_size_base default = free_cash (свободные деньги)
-- v50: order_execution — тип заявок market|limit (по умолчанию market)
-- v49: logic_backtest_reports — сохранённые HTML-отчёты тестов (async, не в hot loop)
-- v47: +8 контртренд OsEngine Custom (прокси на calc-индикаторы; без DELETE)
-- v46: неторговые периоды MOEX; close_positions_eod; use_non_trading_periods
-- v45: +5 тренд +10 контртренд OsEngine; seed без DELETE (INSERT IF NOT EXISTS / DO NOTHING)
-- v44: logics.note — примечание; +5 контртрендовых OsEngine; подписи типа стратегии у seed
-- v43c: logic_trades.run_id — привязка тестовых сделок к прогону (изоляция финреза)
-- v43: комиссия default 0.03; L1–L4 из MultiLogicTradeA; LINREG/ADX/CCI calc
-- v42: rating_lookback_days — окно предрасчёта боевого рейтинга сигналов при enable
-- v41: пакет из 10 классических логик (OsEngine-style) + демо; все на FAKE, все акции
-- v40: сигналы AND (все open/close стороны); rating; base_annual_rate_pct; pending рейтинга
-- v39: DROP logics_detail; убраны дубликаты колонок logics → logic_params;
--      legacy-поля indicator_values/parameter_*; prices.trades
-- v38: logic_indicator_signals.position_event (open|close); logic_trades.position_event
-- ============================================
-- Подключение: база multilogictrade
-- Можно выполнять многократно: объекты и строки не дублируются.
-- Используются CREATE IF NOT EXISTS и INSERT ... ON CONFLICT DO NOTHING/UPDATE.
--
-- ================================================================
-- ПЕРЕД ЗАПУСКОМ ЭТОГО СКРИПТА
-- ================================================================
--
-- 1. Выполнен 00_create_database.sql (база multilogictrade создана).
-- 2. Query Tool / psql подключены к multilogictrade, НЕ к postgres.
-- 3. Расширения PostgreSQL для этого шага НЕ нужны
--    (ни http, ни postgis, ни pg_cron).
--
-- Следующий шаг после успешного выполнения:
--   02_multilogictrade_functions_and_procedures.sql
--   Перед HTTP-блоком в 02 — установить pgsql-http (см. комментарии в 02).
--
-- psql:
--   psql -U postgres -d multilogictrade -f 01_multilogictrade_tables_and_data.sql
-- ================================================================
-- ============================================

-- ============================================

-- Блок миграции: v36 — стоп-лосс (security_resume), is_shadow, pause/resume по бумаге
-- ============================================
DO $$
BEGIN
    ALTER TABLE logic_stops DROP CONSTRAINT IF EXISTS logic_stops_scope_type_check;
    ALTER TABLE logic_stops ADD CONSTRAINT logic_stops_scope_type_check
        CHECK (scope_type IN (
            'security', 'security_resume', 'security_inversion', 'portfolio', 'portfolio_resume',
            'portfolio_ltp_renew', 'security_ltp_renew'
        ));
EXCEPTION
    WHEN undefined_table THEN NULL;
    WHEN duplicate_object THEN NULL;
END $$;

-- Блок миграции: обновление существующей схемы v16 → v17
-- ============================================
DO $$
BEGIN
    NULL;
END $$;

-- Блок миграции: обновление существующей схемы v15 → v16
-- ============================================
DO $$
BEGIN
    NULL;
END $$;

-- Блок миграции: обновление существующей схемы v14 → v15
-- ============================================
DO $$
BEGIN
    UPDATE logic_stops SET scope_type = 'security' WHERE scope_type = 'logic';
EXCEPTION
    WHEN undefined_table THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE logic_stops DROP CONSTRAINT IF EXISTS logic_stops_scope_type_check;
    ALTER TABLE logic_stops ADD CONSTRAINT logic_stops_scope_type_check
        CHECK (scope_type IN (
            'security', 'security_resume', 'security_inversion', 'portfolio', 'portfolio_resume',
            'portfolio_ltp_renew', 'security_ltp_renew'
        ));
EXCEPTION
    WHEN undefined_table THEN NULL;
    WHEN duplicate_object THEN NULL;
END $$;

-- Блок миграции: обновление существующей схемы v13 → v14
-- ============================================
DO $$
BEGIN
    NULL;
END $$;

-- Блок миграции: обновление существующей схемы v12 → v13
-- ============================================
DO $$
BEGIN
    NULL;
END $$;

-- Блок миграции: обновление существующей схемы v11 → v12
-- ============================================
DO $$
BEGIN
    -- Убираем глобальный UNIQUE(prefix): один тикер может быть у акции и фьючерса
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'security_prefixes_prefix_key'
          AND conrelid = 'security_prefixes'::regclass
    ) THEN
        ALTER TABLE security_prefixes DROP CONSTRAINT security_prefixes_prefix_key;
    END IF;
EXCEPTION
    WHEN undefined_table THEN NULL;
END $$;

-- ============================================
-- Таблица: security_types (типы ценных бумаг)
-- ============================================
CREATE TABLE IF NOT EXISTS security_types (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE security_types ADD COLUMN IF NOT EXISTS name VARCHAR(50);

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.




INSERT INTO security_types (name) VALUES
    ('Stock'),
    ('Bond'),
    ('Futures'),
    ('Options'),
    ('ETF'),
    ('CFD'),
    ('Warrant'),
    ('Swap'),
    ('Commodity'),
    ('Index'),
    ('Forex'),
    ('MutualFund'),
    ('PreferredStock'),
    ('ConvertibleBond')
ON CONFLICT (name) DO NOTHING;

ALTER TABLE security_types DROP COLUMN IF EXISTS note;

COMMENT ON TABLE security_types IS 'Таблица типов ценных бумаг';

-- ============================================
-- Таблица: exchanges (торговые площадки)
-- ============================================
CREATE TABLE IF NOT EXISTS exchanges (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS name VARCHAR(50);

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.




INSERT INTO exchanges (name) VALUES ('MOEX'), ('SPB')
ON CONFLICT (name) DO NOTHING;

COMMENT ON TABLE exchanges IS 'Таблица торговых площадок';

-- ============================================
-- Таблица: securities (ценные бумаги)
-- ============================================
CREATE TABLE IF NOT EXISTS securities (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    security_type_id INTEGER REFERENCES security_types(id),
    lot_size INTEGER NOT NULL DEFAULT 1 CHECK (lot_size >= 1)
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE securities ADD COLUMN IF NOT EXISTS name VARCHAR(200);
ALTER TABLE securities ADD COLUMN IF NOT EXISTS security_type_id INTEGER REFERENCES security_types(id);
ALTER TABLE securities ADD COLUMN IF NOT EXISTS lot_size INTEGER NOT NULL DEFAULT 1 CHECK (lot_size >= 1);

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.




ALTER TABLE securities DROP CONSTRAINT IF EXISTS securities_lot_size_check;
ALTER TABLE securities ADD CONSTRAINT securities_lot_size_check CHECK (lot_size >= 1);

COMMENT ON COLUMN securities.lot_size IS 'Лотность: минимальный шаг объёма сделки в штуках (MOEX TQBR)';
CREATE UNIQUE INDEX IF NOT EXISTS idx_securities_name_unique ON securities(name);

COMMENT ON TABLE securities IS 'Таблица ценных бумаг';

-- ============================================
-- Таблица: security_prefixes (тикеры на площадках)
-- ============================================
-- Решение для одинаковых тикеров (VTBR, LKOH у акции и фьючерса):
--   • UNIQUE(security_id, exchange_id) — одна запись на инструмент и биржу
--   • instrument_market — рынок: stock / futures / bonds / index
--   • prefix — тикер MOEX; у акции и фьючерса может совпадать
--   • tbank_figi — FIGI для T-Bank API (для акций заполняется, для фьючерсов — в futures_expirations)
-- ============================================
CREATE TABLE IF NOT EXISTS security_prefixes (
    id SERIAL PRIMARY KEY,
    security_id INTEGER NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
    exchange_id INTEGER NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
    prefix VARCHAR(50) NOT NULL,
    instrument_market VARCHAR(20) NOT NULL DEFAULT 'stock'
        CHECK (instrument_market IN ('stock', 'futures', 'bonds', 'index', 'other')),
    tbank_figi VARCHAR(50),
    note VARCHAR(200)
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE security_prefixes ADD COLUMN IF NOT EXISTS security_id INTEGER REFERENCES securities(id) ON DELETE CASCADE;
ALTER TABLE security_prefixes ADD COLUMN IF NOT EXISTS exchange_id INTEGER REFERENCES exchanges(id) ON DELETE CASCADE;
ALTER TABLE security_prefixes ADD COLUMN IF NOT EXISTS prefix VARCHAR(50);
ALTER TABLE security_prefixes ADD COLUMN IF NOT EXISTS instrument_market VARCHAR(20) NOT NULL DEFAULT 'stock' CHECK (instrument_market IN ('stock', 'futures', 'bonds', 'index', 'other'));
ALTER TABLE security_prefixes ADD COLUMN IF NOT EXISTS tbank_figi VARCHAR(50);
ALTER TABLE security_prefixes ADD COLUMN IF NOT EXISTS note VARCHAR(200);

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.




UPDATE security_prefixes SET instrument_market = 'stock' WHERE instrument_market IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_security_prefixes_security_exchange
    ON security_prefixes(security_id, exchange_id);
CREATE INDEX IF NOT EXISTS idx_security_prefixes_prefix
    ON security_prefixes(exchange_id, prefix, instrument_market);

COMMENT ON TABLE security_prefixes IS 'Тикеры на торговых площадках; акция и фьючерс различаются security_id и instrument_market';
COMMENT ON COLUMN security_prefixes.instrument_market IS 'Рынок: stock, futures, bonds, index — различает VTBR-акцию и VTBR-фьючерс';
COMMENT ON COLUMN security_prefixes.tbank_figi IS 'FIGI инструмента в T-Bank Invest API';

-- ============================================
-- Справочник: 34 акции ММВБ
-- ============================================
INSERT INTO securities (name, security_type_id)
SELECT v.name, st.id
FROM (VALUES
    ('Сбербанк (обыкновенные)', 'Stock'),
    ('Сбербанк (привилегированные)', 'PreferredStock'),
    ('Газпром', 'Stock'),
    ('ЛУКОЙЛ', 'Stock'),
    ('Роснефть', 'Stock'),
    ('НОВАТЭК', 'Stock'),
    ('Норникель', 'Stock'),
    ('Татнефть (обыкновенные)', 'Stock'),
    ('Татнефть (привилегированные)', 'PreferredStock'),
    ('Сургутнефтегаз (обыкновенные)', 'Stock'),
    ('Сургутнефтегаз (привилегированные)', 'PreferredStock'),
    ('Полюс', 'Stock'),
    ('Алроса', 'Stock'),
    ('Северсталь', 'Stock'),
    ('НЛМК', 'Stock'),
    ('ММК', 'Stock'),
    ('Мечел (обыкновенные)', 'Stock'),
    ('Мечел (привилегированные)', 'PreferredStock'),
    ('Магнит', 'Stock'),
    ('МТС', 'Stock'),
    ('ВТБ', 'Stock'),
    ('РУСАЛ', 'Stock'),
    ('РусГидро', 'Stock'),
    ('Интер РАО', 'Stock'),
    ('ФСК-Россети', 'Stock'),
    ('Транснефть (привилегированные)', 'PreferredStock'),
    ('Юнипро', 'Stock'),
    ('Московская биржа', 'Stock'),
    ('Ростелеком', 'Stock'),
    ('Яндекс', 'Stock'),
    ('Аэрофлот', 'Stock'),
    ('Совкомфлот', 'Stock'),
    ('ФосАгро', 'Stock'),
    ('АФК Система', 'Stock')
) AS v(name, type_name)
JOIN security_types st ON st.name = v.type_name
ON CONFLICT (name) DO NOTHING;

-- ============================================
-- Справочник: 20 фьючерсов ММВБ
-- ============================================
INSERT INTO securities (name, security_type_id)
SELECT v.name, st.id
FROM (VALUES
    ('USD/RUB (доллар/рубль)', 'Futures'),
    ('EUR/RUB (евро/рубль)', 'Futures'),
    ('CNY/RUB (юань/рубль)', 'Futures'),
    ('CNY/RUB вечный фьючерс', 'Futures'),
    ('USD/RUB вечный фьючерс', 'Futures'),
    ('Природный газ', 'Futures'),
    ('Нефть Brent', 'Futures'),
    ('Золото (USD)', 'Futures'),
    ('Серебро (USD)', 'Futures'),
    ('Золото (рублевый)', 'Futures'),
    ('Золото вечный фьючерс', 'Futures'),
    ('Сбербанк (фьючерс на акции)', 'Futures'),
    ('ВТБ (фьючерс на акции)', 'Futures'),
    ('Газпром (фьючерс на акции)', 'Futures'),
    ('ЛУКОЙЛ (фьючерс на акции)', 'Futures'),
    ('Индекс Мосбиржи (IMOEX)', 'Futures'),
    ('Индекс РТС', 'Futures'),
    ('Индекс Мосбиржи (дневной фьючерс)', 'Futures'),
    ('Серебро (квартальный)', 'Futures'),
    ('Золото (квартальный)', 'Futures')
) AS v(name, type_name)
JOIN security_types st ON st.name = v.type_name
ON CONFLICT (name) DO NOTHING;

-- ============================================
-- Префиксы ММВБ (exchange MOEX = id 1)
-- instrument_market отделяет акцию от фьючерса при одинаковом prefix
-- ============================================
INSERT INTO security_prefixes (security_id, exchange_id, prefix, instrument_market, tbank_figi, note)
SELECT s.id, e.id, v.prefix, v.instrument_market, v.tbank_figi, v.note
FROM exchanges e
CROSS JOIN (VALUES
    ('Сбербанк (обыкновенные)', 'SBER', 'stock', 'BBG004730N88', 'Акция MOEX TQBR'),
    ('Сбербанк (привилегированные)', 'SBERP', 'stock', 'BBG0047315Y7', NULL),
    ('Газпром', 'GAZP', 'stock', 'BBG004730RP0', NULL),
    ('ЛУКОЙЛ', 'LKOH', 'stock', 'BBG004731032', 'Акция; тикер LKOH'),
    ('Роснефть', 'ROSN', 'stock', 'BBG004731354', NULL),
    ('НОВАТЭК', 'NVTK', 'stock', 'BBG00475KKY8', NULL),
    ('Норникель', 'GMKN', 'stock', 'BBG004731489', NULL),
    ('Татнефть (обыкновенные)', 'TATN', 'stock', 'BBG004RVFFC0', NULL),
    ('Татнефть (привилегированные)', 'TATNP', 'stock', 'BBG004S681W1', NULL),
    ('Сургутнефтегаз (обыкновенные)', 'SNGS', 'stock', 'BBG0047315D0', NULL),
    ('Сургутнефтегаз (привилегированные)', 'SNGSP', 'stock', 'BBG004S681M2', NULL),
    ('Полюс', 'PLZL', 'stock', 'BBG000R607Y3', NULL),
    ('Алроса', 'ALRS', 'stock', 'BBG004S68B31', NULL),
    ('Северсталь', 'CHMF', 'stock', 'BBG00475KHX6', NULL),
    ('НЛМК', 'NLMK', 'stock', 'BBG004S681BH', NULL),
    ('ММК', 'MAGN', 'stock', 'BBG004S68507', NULL),
    ('Мечел (обыкновенные)', 'MTLR', 'stock', 'BBG004S68598', NULL),
    ('Мечел (привилегированные)', 'MTLRP', 'stock', 'BBG004S686N0', NULL),
    ('Магнит', 'MGNT', 'stock', 'BBG004RVFCY3', NULL),
    ('МТС', 'MTSS', 'stock', 'BBG004S681W1', NULL),
    ('ВТБ', 'VTBR', 'stock', 'BBG004730ZJ9', 'Акция; тикер VTBR'),
    ('РУСАЛ', 'RUAL', 'stock', 'BBG008F2T3T2', NULL),
    ('РусГидро', 'HYDR', 'stock', 'BBG00475K2X9', NULL),
    ('Интер РАО', 'IRAO', 'stock', 'BBG004S68473', NULL),
    ('ФСК-Россети', 'FEES', 'stock', 'BBG00475JZZ6', NULL),
    ('Транснефть (привилегированные)', 'TRNFP', 'stock', 'BBG00475KHX6', NULL),
    ('Юнипро', 'UPRO', 'stock', 'BBG004S686W0', NULL),
    ('Московская биржа', 'MOEX', 'stock', 'BBG004730JJ5', NULL),
    ('Ростелеком', 'RTKM', 'stock', 'BBG004S682Z6', NULL),
    ('Яндекс', 'YDEX', 'stock', NULL, NULL),
    ('Аэрофлот', 'AFLT', 'stock', 'BBG004S683W7', NULL),
    ('Совкомфлот', 'FLOT', 'stock', NULL, NULL),
    ('ФосАгро', 'PHOR', 'stock', 'BBG004S689R0', NULL),
    ('АФК Система', 'AFKS', 'stock', 'BBG004S68614', NULL),
    ('USD/RUB (доллар/рубль)', 'Si', 'futures', NULL, 'Базовый код MOEX FORTS'),
    ('EUR/RUB (евро/рубль)', 'Eu', 'futures', NULL, NULL),
    ('CNY/RUB (юань/рубль)', 'CR', 'futures', NULL, NULL),
    ('CNY/RUB вечный фьючерс', 'CNYRUBF', 'futures', NULL, 'Вечный фьючерс'),
    ('USD/RUB вечный фьючерс', 'USDRUBF', 'futures', NULL, 'Вечный фьючерс'),
    ('Природный газ', 'NG', 'futures', NULL, NULL),
    ('Нефть Brent', 'Br', 'futures', NULL, NULL),
    ('Золото (USD)', 'GD', 'futures', NULL, NULL),
    ('Серебро (USD)', 'SV', 'futures', NULL, NULL),
    ('Золото (рублевый)', 'GL', 'futures', NULL, NULL),
    ('Золото вечный фьючерс', 'GLDRUBF', 'futures', NULL, NULL),
    ('Сбербанк (фьючерс на акции)', 'SBRF', 'futures', NULL, 'Фьючерс MOEX FORTS'),
    ('ВТБ (фьючерс на акции)', 'VTBR', 'futures', NULL, 'Фьючерс; тот же prefix, другой security_id'),
    ('Газпром (фьючерс на акции)', 'GAZR', 'futures', NULL, NULL),
    ('ЛУКОЙЛ (фьючерс на акции)', 'LKOH', 'futures', NULL, 'Фьючерс; тот же prefix, другой security_id'),
    ('Индекс Мосбиржи (IMOEX)', 'MX', 'futures', NULL, NULL),
    ('Индекс РТС', 'RI', 'futures', NULL, NULL),
    ('Индекс Мосбиржи (дневной фьючерс)', 'IMOEXF', 'futures', NULL, NULL),
    ('Серебро (квартальный)', 'SILV', 'futures', NULL, NULL),
    ('Золото (квартальный)', 'GOLD', 'futures', NULL, NULL)
) AS v(security_name, prefix, instrument_market, tbank_figi, note)
JOIN securities s ON s.name = v.security_name
WHERE e.name = 'MOEX'
ON CONFLICT (security_id, exchange_id) DO UPDATE SET
    prefix = EXCLUDED.prefix,
    instrument_market = EXCLUDED.instrument_market,
    tbank_figi = COALESCE(EXCLUDED.tbank_figi, security_prefixes.tbank_figi),
    note = EXCLUDED.note;

-- ============================================
-- Денежные фонды (парк кэша): TMON / LQDT / SBMM
-- ============================================
INSERT INTO securities (name, security_type_id, lot_size)
SELECT v.name, st.id, 1
FROM (VALUES
    ('Т-Капитал денежный рынок (TMON)', 'ETF'),
    ('ВИМ Ликвидность (LQDT)', 'ETF'),
    ('Сбер Первый / Сберегательный (SBMM)', 'ETF')
) AS v(name, type_name)
JOIN security_types st ON st.name = v.type_name
ON CONFLICT (name) DO NOTHING;

INSERT INTO security_prefixes (security_id, exchange_id, prefix, instrument_market, tbank_figi, note)
SELECT s.id, e.id, v.prefix, 'other', NULL, v.note
FROM exchanges e
CROSS JOIN (VALUES
    ('Т-Капитал денежный рынок (TMON)', 'TMON', 'БПИФ денежного рынка; парковка кэша'),
    ('ВИМ Ликвидность (LQDT)', 'LQDT', 'БПИФ денежного рынка; парковка кэша'),
    ('Сбер Первый / Сберегательный (SBMM)', 'SBMM', 'БПИФ денежного рынка; парковка кэша')
) AS v(security_name, prefix, note)
JOIN securities s ON s.name = v.security_name
WHERE e.name = 'MOEX'
ON CONFLICT (security_id, exchange_id) DO UPDATE SET
    prefix = EXCLUDED.prefix,
    instrument_market = EXCLUDED.instrument_market,
    note = EXCLUDED.note;

-- Лотность акций MOEX (штук в лоте TQBR; фьючерсы — 1 контракт)
UPDATE securities s
SET lot_size = v.lot
FROM security_prefixes sp
JOIN exchanges e ON e.id = sp.exchange_id
JOIN (VALUES
    ('SBER', 10), ('SBERP', 10), ('GAZP', 10), ('LKOH', 10),
    ('ROSN', 10), ('NVTK', 10), ('GMKN', 10), ('TATN', 10), ('TATNP', 10),
    ('PLZL', 10), ('ALRS', 10), ('CHMF', 10), ('NLMK', 10), ('MAGN', 10),
    ('MTLR', 10), ('MTLRP', 10), ('MGNT', 10), ('MTSS', 10), ('RUAL', 10),
    ('HYDR', 10), ('PHOR', 10), ('MOEX', 10), ('TRNFP', 10), ('UPRO', 10),
    ('SNGS', 1), ('SNGSP', 1), ('VTBR', 1), ('IRAO', 1), ('FEES', 1),
    ('RTKM', 1), ('YDEX', 1), ('AFLT', 1), ('FLOT', 1), ('AFKS', 1)
) AS v(prefix, lot) ON sp.prefix = v.prefix
WHERE s.id = sp.security_id
  AND e.name = 'MOEX'
  AND sp.instrument_market = 'stock';

-- ============================================
-- Таблица: timeframes (таймфреймы)
-- ============================================
CREATE TABLE IF NOT EXISTS timeframes (
    id SERIAL PRIMARY KEY,
    tf VARCHAR(20) NOT NULL UNIQUE,
    full_name VARCHAR(50) NOT NULL,
    sec INTEGER NOT NULL CHECK (sec > 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE timeframes ADD COLUMN IF NOT EXISTS tf VARCHAR(20);
ALTER TABLE timeframes ADD COLUMN IF NOT EXISTS full_name VARCHAR(50);
ALTER TABLE timeframes ADD COLUMN IF NOT EXISTS sec INTEGER CHECK (sec > 0);
ALTER TABLE timeframes ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.




INSERT INTO timeframes (tf, full_name, sec, is_active) VALUES
    ('M1', '1 минута', 60, TRUE), ('M2', '2 минуты', 120, TRUE), ('M3', '3 минуты', 180, TRUE),
    ('M5', '5 минут', 300, TRUE), ('M10', '10 минут', 600, TRUE), ('M15', '15 минут', 900, TRUE),
    ('M20', '20 минут', 1200, TRUE), ('M30', '30 минут', 1800, TRUE),
    ('H1', '1 час', 3600, TRUE), ('H2', '2 часа', 7200, TRUE), ('H4', '4 часа', 14400, TRUE),
    ('H6', '6 часов', 21600, TRUE), ('H8', '8 часов', 28800, TRUE), ('H12', '12 часов', 43200, TRUE),
    ('D1', '1 день', 86400, TRUE), ('D2', '2 дня', 172800, TRUE), ('D3', '3 дня', 259200, TRUE),
    ('W1', '1 неделя', 604800, TRUE), ('W2', '2 недели', 1209600, TRUE), ('W3', '3 недели', 1814400, TRUE),
    ('MN1', '1 месяц', 2592000, TRUE), ('MN2', '2 месяца', 5184000, TRUE), ('MN3', '3 месяца', 7776000, TRUE),
    ('MN6', '6 месяцев', 15552000, TRUE), ('Y1', '1 год', 31536000, TRUE)
ON CONFLICT (tf) DO UPDATE SET
    full_name = EXCLUDED.full_name,
    sec = EXCLUDED.sec,
    is_active = EXCLUDED.is_active;

COMMENT ON TABLE timeframes IS 'Таблица таймфреймов';
COMMENT ON COLUMN timeframes.is_active IS 'Использовать при массовой загрузке load_all_timeframes*';

-- ============================================
-- Таблица: brokers (брокеры)
-- ============================================
CREATE TABLE IF NOT EXISTS brokers (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    api_url VARCHAR(255),
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS code VARCHAR(50);
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS name VARCHAR(100);
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS api_url VARCHAR(255);
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.




ALTER TABLE brokers DROP COLUMN IF EXISTS created_at;

INSERT INTO brokers (code, name, api_url) VALUES
    ('T-BANK', 'T-Bank (Т-Банк)', 'https://invest-public-api.tinkoff.ru/rest')
ON CONFLICT (code) DO NOTHING;

-- ============================================
-- Таблица: accounts (счета)
-- ============================================
CREATE TABLE IF NOT EXISTS accounts (
    id SERIAL PRIMARY KEY,
    broker_id INTEGER NOT NULL REFERENCES brokers(id) ON DELETE CASCADE,
    account_code VARCHAR(100) NOT NULL,
    name VARCHAR(100) NOT NULL,
    account_type VARCHAR(20) NOT NULL CHECK (account_type IN ('real', 'fake')),
    is_efficient BOOLEAN NOT NULL DEFAULT FALSE,
    token_encrypted TEXT,
    token_hash VARCHAR(64),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS broker_id INTEGER REFERENCES brokers(id) ON DELETE CASCADE;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS account_code VARCHAR(100);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS name VARCHAR(100);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS account_type VARCHAR(20) CHECK (account_type IN ('real', 'fake'));
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_efficient BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS token_encrypted TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS token_hash VARCHAR(64);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.




ALTER TABLE accounts DROP COLUMN IF EXISTS created_at;

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_broker_account_code ON accounts(broker_id, account_code);

INSERT INTO accounts (broker_id, account_code, name, account_type, is_efficient, token_encrypted, token_hash)
SELECT b.id, 'FAKE-EFF-001', 'Демо-счет T-Bank (эффективный)', 'fake', TRUE, NULL, NULL
FROM brokers b WHERE b.code = 'T-BANK'
ON CONFLICT (broker_id, account_code) DO NOTHING;

-- ============================================
-- Таблица: prices (цены OHLCV)
-- ============================================
CREATE TABLE IF NOT EXISTS prices (
    id BIGSERIAL PRIMARY KEY,
    security_id INTEGER NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
    timeframe_id INTEGER NOT NULL REFERENCES timeframes(id) ON DELETE CASCADE,
    dt TIMESTAMP NOT NULL,
    open_price NUMERIC(18, 6) NOT NULL,
    high_price NUMERIC(18, 6) NOT NULL,
    low_price NUMERIC(18, 6) NOT NULL,
    close_price NUMERIC(18, 6) NOT NULL,
    volume NUMERIC(20, 2),
    value NUMERIC(20, 2),
    contract_prefix VARCHAR(50)
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE prices ADD COLUMN IF NOT EXISTS security_id INTEGER REFERENCES securities(id) ON DELETE CASCADE;
ALTER TABLE prices ADD COLUMN IF NOT EXISTS timeframe_id INTEGER REFERENCES timeframes(id) ON DELETE CASCADE;
ALTER TABLE prices ADD COLUMN IF NOT EXISTS dt TIMESTAMP;
ALTER TABLE prices ADD COLUMN IF NOT EXISTS open_price NUMERIC(18, 6);
ALTER TABLE prices ADD COLUMN IF NOT EXISTS high_price NUMERIC(18, 6);
ALTER TABLE prices ADD COLUMN IF NOT EXISTS low_price NUMERIC(18, 6);
ALTER TABLE prices ADD COLUMN IF NOT EXISTS close_price NUMERIC(18, 6);
ALTER TABLE prices ADD COLUMN IF NOT EXISTS volume NUMERIC(20, 2);
ALTER TABLE prices ADD COLUMN IF NOT EXISTS value NUMERIC(20, 2);
ALTER TABLE prices ADD COLUMN IF NOT EXISTS contract_prefix VARCHAR(50);

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.




-- Существующие БД: CREATE TABLE IF NOT EXISTS не добавляет новые колонки
ALTER TABLE prices DROP COLUMN IF EXISTS trades;
ALTER TABLE prices DROP COLUMN IF EXISTS created_at;

CREATE INDEX IF NOT EXISTS idx_prices_security_id ON prices(security_id);
CREATE INDEX IF NOT EXISTS idx_prices_timeframe_id ON prices(timeframe_id);
CREATE INDEX IF NOT EXISTS idx_prices_dt ON prices(dt);
CREATE INDEX IF NOT EXISTS idx_prices_security_timeframe ON prices(security_id, timeframe_id);
CREATE INDEX IF NOT EXISTS idx_prices_security_timeframe_dt ON prices(security_id, timeframe_id, dt);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prices_unique_candle ON prices(security_id, timeframe_id, dt);
CREATE INDEX IF NOT EXISTS idx_prices_contract_prefix ON prices(contract_prefix)
    WHERE contract_prefix IS NOT NULL;

COMMENT ON TABLE prices IS 'Таблица цен (OHLCV)';
COMMENT ON COLUMN prices.contract_prefix IS 'Тикер конкретного контракта (Si-6.26); NULL для акций. Групповой префикс — в security_prefixes.prefix';

-- ============================================
-- Таблица: parameter_types (типы параметров)
-- ============================================
CREATE TABLE IF NOT EXISTS parameter_types (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    short_name VARCHAR(20) NOT NULL UNIQUE,
    value_type VARCHAR(20) NOT NULL,
    default_value TEXT
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE parameter_types ADD COLUMN IF NOT EXISTS name VARCHAR(100);
ALTER TABLE parameter_types ADD COLUMN IF NOT EXISTS short_name VARCHAR(20);
ALTER TABLE parameter_types ADD COLUMN IF NOT EXISTS value_type VARCHAR(20);
ALTER TABLE parameter_types ADD COLUMN IF NOT EXISTS default_value TEXT;

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.




ALTER TABLE parameter_types DROP COLUMN IF EXISTS is_control;
ALTER TABLE parameter_types DROP COLUMN IF EXISTS is_fake_only;
ALTER TABLE parameter_types DROP COLUMN IF EXISTS description;
ALTER TABLE parameter_types DROP COLUMN IF EXISTS min_value;
ALTER TABLE parameter_types DROP COLUMN IF EXISTS max_value;
ALTER TABLE parameter_types DROP COLUMN IF EXISTS created_at;

CREATE UNIQUE INDEX IF NOT EXISTS idx_parameter_types_short_name ON parameter_types(short_name);

INSERT INTO parameter_types (name, short_name, value_type, default_value) VALUES
    ('RSI период', 'RSI_PERIOD', 'integer', '14'),
    ('SMA период', 'SMA_PERIOD', 'integer', '20'),
    ('EMA период', 'EMA_PERIOD', 'integer', '20'),
    ('BB период', 'BB_PERIOD', 'integer', '20'),
    ('ATR период', 'ATR_PERIOD', 'integer', '14'),
    ('STOCH период K', 'STOCH_PERIOD', 'integer', '14'),
    ('T-Bank API токен', 'TBANK_API_TOKEN', 'secret', ''),
    ('Техническое логирование', 'APP_TECH_LOGGING', 'boolean', '0'),
    ('Очистка лишних данных (диск)', 'APP_CLEANUP_DISK', 'boolean', '0'),
    ('Последняя автоочистка диска', 'APP_CLEANUP_LAST_AT', 'text', ''),
    ('Heartbeat UI trade runner', 'APP_TRADE_RUNNER_HB', 'text', '')
ON CONFLICT (short_name) DO NOTHING;

-- ============================================
-- Таблица: parameter_sets (наборы параметров)
-- ============================================
CREATE TABLE IF NOT EXISTS parameter_sets (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE parameter_sets ADD COLUMN IF NOT EXISTS name VARCHAR(100);

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.




ALTER TABLE parameter_sets DROP COLUMN IF EXISTS description;
ALTER TABLE parameter_sets DROP COLUMN IF EXISTS is_active;
ALTER TABLE parameter_sets DROP COLUMN IF EXISTS created_at;

CREATE UNIQUE INDEX IF NOT EXISTS idx_parameter_sets_name ON parameter_sets(name);

INSERT INTO parameter_sets (name) VALUES
    ('Default')
ON CONFLICT (name) DO NOTHING;

-- ============================================
-- Таблица: parameter_values (значения параметров)
-- ============================================
CREATE TABLE IF NOT EXISTS parameter_values (
    id SERIAL PRIMARY KEY,
    parameter_set_id INTEGER NOT NULL REFERENCES parameter_sets(id) ON DELETE CASCADE,
    parameter_type_id INTEGER NOT NULL REFERENCES parameter_types(id) ON DELETE CASCADE,
    value TEXT NOT NULL
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE parameter_values ADD COLUMN IF NOT EXISTS parameter_set_id INTEGER REFERENCES parameter_sets(id) ON DELETE CASCADE;
ALTER TABLE parameter_values ADD COLUMN IF NOT EXISTS parameter_type_id INTEGER REFERENCES parameter_types(id) ON DELETE CASCADE;
ALTER TABLE parameter_values ADD COLUMN IF NOT EXISTS value TEXT;

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.




ALTER TABLE parameter_values DROP COLUMN IF EXISTS record_date;
ALTER TABLE parameter_values DROP COLUMN IF EXISTS created_at;

CREATE UNIQUE INDEX IF NOT EXISTS idx_parameter_values_unique ON parameter_values(parameter_set_id, parameter_type_id);

INSERT INTO parameter_values (parameter_set_id, parameter_type_id, value)
SELECT ps.id, pt.id, pt.default_value
FROM parameter_sets ps
CROSS JOIN parameter_types pt
WHERE ps.name = 'Default'
ON CONFLICT (parameter_set_id, parameter_type_id) DO NOTHING;

INSERT INTO parameter_values (parameter_set_id, parameter_type_id, value)
SELECT ps.id, pt.id, ''
FROM parameter_sets ps
JOIN parameter_types pt ON pt.short_name = 'TBANK_API_TOKEN'
WHERE ps.name = 'Default'
ON CONFLICT (parameter_set_id, parameter_type_id) DO NOTHING;

-- ============================================
-- Таблица: indicators (справочник индикаторов)
-- ============================================
CREATE TABLE IF NOT EXISTS indicators (
    id SERIAL PRIMARY KEY,
    code VARCHAR(20) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    -- Шаблон вызова функции расчёта (EXECUTE в PostgreSQL / EXECUTE IMMEDIATE в Oracle).
    -- Плейсхолдеры :period, :fast_period, :series, :security_id, :timeframe_id, :dt, :indicator_id и др.
    -- :series — код серии из indicator_value_types (RSI, MACD, UPPER, …).
    script TEXT,
    -- Многочленная формула для массивного расчёта (sync / calc_poly_formula_array):
    -- pp, sma(pp), pp * (1;-2;1), @RSI, sma() * sma() * sma() и т.д.
    formula TEXT,
    is_custom BOOLEAN NOT NULL DEFAULT FALSE,
    -- Подробное описание: полное название, расчёт, сигналы, применение (многострочный TEXT).
    description TEXT,
    category VARCHAR(50),
    -- Шаблоны follow/fade и профиль двоичности сигнала (logic_indicator_signals).
    sig_trend_def TEXT,
    sig_ct_def TEXT,
    sig_profile VARCHAR(20),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE indicators ADD COLUMN IF NOT EXISTS code VARCHAR(20);
ALTER TABLE indicators ADD COLUMN IF NOT EXISTS name VARCHAR(100);
ALTER TABLE indicators ADD COLUMN IF NOT EXISTS script TEXT;
ALTER TABLE indicators ADD COLUMN IF NOT EXISTS formula TEXT;
ALTER TABLE indicators ADD COLUMN IF NOT EXISTS is_custom BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE indicators ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE indicators ADD COLUMN IF NOT EXISTS category VARCHAR(50);
ALTER TABLE indicators ADD COLUMN IF NOT EXISTS sig_trend_def TEXT;
ALTER TABLE indicators ADD COLUMN IF NOT EXISTS sig_ct_def TEXT;
ALTER TABLE indicators ADD COLUMN IF NOT EXISTS sig_profile VARCHAR(20);
ALTER TABLE indicators ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE indicators ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.




COMMENT ON COLUMN indicators.script IS
'Устаревший per-bar шаблон SELECT calc_ind_*(…). Для новых индикаторов — поле formula.';

COMMENT ON COLUMN indicators.formula IS
'Многочленная формула массивного расчёта: pp, sma, @SMA, pp * (1;-2;1). Код индикатора (SMA, RSI) = ссылка @CODE в других формулах.';

COMMENT ON COLUMN indicators.is_custom IS
'TRUE — пользовательская/составная формула (подсветка в списке индикаторов).';

COMMENT ON COLUMN indicators.description IS
'Справочное описание: полное наименование, расчёт, типичные сигналы и область применения.';

INSERT INTO indicators (code, name, description, category) VALUES
    ('SMA', 'Simple Moving Average', 'Простое скользящее среднее', 'trend'),
    ('EMA', 'Exponential Moving Average', 'Экспоненциальное скользящее среднее', 'trend'),
    ('WMA', 'Weighted Moving Average', 'Взвешенное скользящее среднее', 'trend'),
    ('RSI', 'Relative Strength Index', 'Индекс относительной силы (0-100)', 'momentum'),
    ('MACD', 'Moving Average Convergence Divergence', 'Схождение/расхождение скользящих средних', 'momentum'),
    ('STOCH', 'Stochastic Oscillator', 'Стохастический осциллятор (%K, %D)', 'momentum'),
    ('BB', 'Bollinger Bands', 'Полосы Боллинджера', 'volatility'),
    ('ATR', 'Average True Range', 'Средний истинный диапазон', 'volatility'),
    ('PACC', 'Price Acceleration', 'Ускорение цены', 'momentum'),
    ('ADX', 'Average Directional Index', 'Индекс среднего направления', 'trend'),
    ('OBV', 'On-Balance Volume', 'Накопленный объем', 'volume'),
    ('VWAP', 'Volume Weighted Average Price', 'Объемно-взвешенная средняя цена', 'volume'),
    ('MFI', 'Money Flow Index', 'Индекс денежного потока', 'momentum'),
    ('CCI', 'Commodity Channel Index', 'Индекс товарного канала', 'momentum'),
    ('WILLR', 'Williams %R', 'Процентный диапазон Вильямса', 'momentum'),
    ('PSAR', 'Parabolic SAR', 'Параболическая система SAR', 'trend'),
    ('ICHIMOKU', 'Ichimoku Cloud', 'Облако Ишимоку', 'trend'),
    ('KDJ', 'KDJ Indicator', 'Индикатор KDJ', 'momentum'),
    ('DMI', 'Directional Movement Index', 'Индекс направленного движения', 'trend'),
    ('KELTNER', 'Keltner Channels', 'Каналы Кельтнера', 'volatility'),
    ('DONCHIAN', 'Donchian Channels', 'Каналы Дончиана', 'volatility'),
    ('ROC', 'Rate of Change', 'Темп изменения', 'momentum'),
    ('TRIX', 'Triple Exponential Average', 'Тройное экспоненциальное среднее', 'momentum'),
    ('CMO', 'Chande Momentum Oscillator', 'Осциллятор моментума Чанде', 'momentum'),
    ('RVI', 'Relative Vigor Index', 'Индекс относительной бодрости', 'momentum'),
    ('TSI', 'True Strength Index', 'Индекс истинной силы', 'momentum'),
    ('UO', 'Ultimate Oscillator', 'Ультимативный осциллятор', 'momentum'),
    ('AROON', 'Aroon Indicator', 'Индикатор Арун', 'trend'),
    ('SAR', 'Stop And Reverse', 'Стоп и реверс', 'trend'),
    ('HMA', 'Hull Moving Average', 'Скользящее среднее Халла', 'trend'),
    ('ZLEMA', 'Zero Lag EMA', 'EMA с нулевым запаздыванием', 'trend'),
    ('SMAT3', 'SMA Triple', 'Тройное SMA (тройная свёртка)', 'trend'),
    ('LINREG', 'Linear Regression Channel', 'Канал линейной регрессии (mid ± Dev·σ остатков)', 'trend'),
    ('SQUARE', 'Quadratic Regression Channel', 'Квадратичный канал (b+a·x+c·x²; mid ± Dev·σ остатков)', 'trend')
ON CONFLICT (code) DO NOTHING;

-- Шаблоны расчёта (функция + параметры; :series подставляется для каждой линии индикатора)
UPDATE indicators SET script = 'SELECT calc_ind_rsi(:period, :series, :security_id, :timeframe_id, :dt, :indicator_id)' WHERE code = 'RSI';
UPDATE indicators SET script = 'SELECT calc_ind_sma(:period, :series, :security_id, :timeframe_id, :dt, :indicator_id)' WHERE code = 'SMA';
UPDATE indicators SET script = 'SELECT calc_ind_ema(:period, :series, :security_id, :timeframe_id, :dt, :indicator_id)' WHERE code = 'EMA';
UPDATE indicators SET script = 'SELECT calc_ind_macd(:fast_period, :slow_period, :signal_period, :series, :security_id, :timeframe_id, :dt, :indicator_id)' WHERE code = 'MACD';
UPDATE indicators SET script = 'SELECT calc_ind_bb(:period, :std_dev, :series, :security_id, :timeframe_id, :dt, :indicator_id)' WHERE code = 'BB';
UPDATE indicators SET script = 'SELECT calc_ind_atr(:period, :series, :security_id, :timeframe_id, :dt, :indicator_id)' WHERE code = 'ATR';
UPDATE indicators SET script = 'SELECT calc_ind_stoch(:k_period, :d_period, :smooth, :series, :security_id, :timeframe_id, :dt, :indicator_id)' WHERE code = 'STOCH';
UPDATE indicators SET script = 'SELECT calc_ind_cci(:period, :series, :security_id, :timeframe_id, :dt, :indicator_id)' WHERE code = 'CCI';
UPDATE indicators SET script = 'SELECT calc_ind_adx(:period, :series, :security_id, :timeframe_id, :dt, :indicator_id)' WHERE code = 'ADX';
UPDATE indicators SET script = 'SELECT calc_ind_linreg(:period, :std_dev, :series, :security_id, :timeframe_id, :dt, :indicator_id)' WHERE code = 'LINREG';
UPDATE indicators SET script = 'SELECT calc_ind_square(:period, :std_dev, :series, :security_id, :timeframe_id, :dt, :indicator_id)' WHERE code = 'SQUARE';

-- Профиль шаблонов сигнала: какие двоичные смыслы «по течению / против» типичны для индикатора

COMMENT ON COLUMN indicators.sig_trend_def IS
'Шаблон follow («по течению»): пробой/импульс/бычья половина. В logic_indicator_signals.signal_kind=trend';

COMMENT ON COLUMN indicators.sig_ct_def IS
'Шаблон fade («против»): возврат от края/перепроданность. В logic_indicator_signals.signal_kind=counter';

COMMENT ON COLUMN indicators.sig_profile IS
'Как читать двоичность follow/fade: trend_line | oscillator | channel | zero_line | strength | volume';

-- Многочленные формулы (массивный расчёт — единый парсер, без SELECT)
UPDATE indicators SET formula = 'sma', is_custom = FALSE WHERE code = 'SMA';
UPDATE indicators SET formula = 'ema', is_custom = FALSE WHERE code = 'EMA';
UPDATE indicators SET formula = 'pp * (1; -2; 1)', is_custom = TRUE WHERE code = 'PACC';
UPDATE indicators SET formula = 'sma(period=20, series=VALUE) * sma(period=20, series=VALUE) * sma(period=20, series=VALUE)', is_custom = TRUE WHERE code = 'SMAT3';
-- Как у STOCH/ATR/MACD: пустая formula → calc_indicator_series_array / calc_ind_*_array (не poly)
UPDATE indicators SET formula = NULL, is_custom = FALSE WHERE code IN ('CCI', 'ADX', 'LINREG', 'SQUARE', 'ATR', 'STOCH', 'MACD', 'BB', 'RSI');

-- Профили + шаблоны follow(trend) / fade(counter)
-- trend_line: цена относительно линии
UPDATE indicators SET
    sig_profile = 'trend_line',
    sig_trend_def = 'pp > VALUE',
    sig_ct_def = 'pp < VALUE'
WHERE code IN ('SMA', 'EMA', 'WMA', 'HMA', 'ZLEMA', 'SMAT3', 'ICHIMOKU', 'PSAR', 'SAR', 'LINREG', 'SQUARE');

-- oscillator 0..100: follow = бычья половина / кросс; fade = зона перепроданности
UPDATE indicators SET
    sig_profile = 'oscillator',
    sig_trend_def = 'VALUE > 50',
    sig_ct_def = 'VALUE < 30'
WHERE code IN ('RSI', 'CCI', 'CMO', 'MFI', 'WILLR', 'UO', 'RVI', 'ROC', 'TRIX', 'TSI', 'KDJ');

UPDATE indicators SET
    sig_profile = 'oscillator',
    sig_trend_def = 'K > D',
    sig_ct_def = 'K < 20'
WHERE code = 'STOCH';

-- channel: follow = пробой верхней (breakout up); fade = цена у нижней (reversion long-zone)
UPDATE indicators SET
    sig_profile = 'channel',
    sig_trend_def = 'pp > UPPER',
    sig_ct_def = 'pp < LOWER'
WHERE code IN ('BB', 'KELTNER', 'DONCHIAN');

-- zero_line: выше/ниже нуля
UPDATE indicators SET
    sig_profile = 'zero_line',
    sig_trend_def = 'VALUE > 0',
    sig_ct_def = 'VALUE < 0'
WHERE code IN ('MACD', 'PACC', 'ATR', 'OBV', 'VWAP');

UPDATE indicators SET sig_profile = 'volume' WHERE category = 'volume' AND sig_profile IS NULL;

-- strength: сила тренда / направление
UPDATE indicators SET
    sig_profile = 'strength',
    sig_trend_def = 'VALUE > 25',
    sig_ct_def = 'VALUE < 20'
WHERE code IN ('ADX', 'DMI');

UPDATE indicators SET
    sig_profile = 'strength',
    sig_trend_def = 'UP > DOWN',
    sig_ct_def = 'DOWN > UP'
WHERE code = 'AROON';

UPDATE indicators SET
    sig_trend_def = COALESCE(sig_trend_def, 'VALUE > 50'),
    sig_ct_def = COALESCE(sig_ct_def, 'VALUE < 50'),
    sig_profile = COALESCE(sig_profile, 'oscillator')
WHERE sig_trend_def IS NULL OR sig_ct_def IS NULL OR sig_profile IS NULL;

-- Подробные описания индикаторов с функциями расчёта в PostgreSQL
UPDATE indicators SET description = $desc$
Relative Strength Index (RSI) — индекс относительной силы

Расчёт: за период N (по умолчанию 14) суммируются приросты и падения цены закрытия; RS = средний прирост / среднее падение; RSI = 100 − 100/(1+RS). Значения в диапазоне 0–100.

Сигналы: RSI выше 70 — зона перекупленности (риск коррекции вниз); ниже 30 — перепроданность (возможен отскок); пересечение уровня 50 — смена краткосрочного импульса; расхождение RSI и цены предупреждает о ослаблении тренда.

Применение: фильтр входов в тренд и контртренд, оценка силы движения, тайминг на боковом рынке, комбинация с MA и объёмом.
$desc$ WHERE code = 'RSI';

UPDATE indicators SET description = $desc$
Simple Moving Average (SMA) — простое скользящее среднее

Расчёт: среднее арифметическое цен закрытия за последние N свечей (по умолчанию 20). Каждая свеча в окне имеет одинаковый вес.

Сигналы: цена выше SMA — бычий фон, ниже — медвежий; пересечение цены и линии SMA — возможная смена краткосрочного тренда; наклон SMA показывает направление и силу тренда; несколько SMA разного периода дают «золотой/мёртвый крест».

Применение: определение тренда, динамические уровни поддержки и сопротивления, trailing stop, база для MACD, полос Боллинджера и других индикаторов.
$desc$ WHERE code = 'SMA';

UPDATE indicators SET description = $desc$
Exponential Moving Average (EMA) — экспоненциальное скользящее среднее

Расчёт: рекурсивное сглаживание цены закрытия; последним свечам присваивается больший вес (множитель 2/(N+1), по умолчанию N=20). Быстрее реагирует на изменения, чем SMA.

Сигналы: цена выше EMA — восходящий импульс, ниже — нисходящий; пересечение быстрой и медленной EMA — классический трендовый сигнал; резкий отрыв цены от EMA — перегрев движения.

Применение: трендовые системы, основа MACD, фильтр направления сделок, короткие и среднесрочные стратегии на ликвидных инструментах.
$desc$ WHERE code = 'EMA';

UPDATE indicators SET description = $desc$
Moving Average Convergence Divergence (MACD) — схождение/расхождение скользящих средних

Расчёт: линия MACD = EMA(12) − EMA(26); сигнальная линия = EMA(9) от MACD; гистограмма = MACD − Signal. Серии: MACD, SIGNAL, HISTOGRAM, ZERO.

Сигналы: пересечение MACD и Signal снизу вверх — бычий сигнал, сверху вниз — медвежий; гистограмма выше/ниже нуля подтверждает импульс; дивергенция MACD и цены — предупреждение о развороте; пересечение нулевой линии — смена доминирующего тренда.

Применение: определение момента входа в тренд, подтверждение пробоев, фильтр для swing- и позиционной торговли, сочетание с RSI и объёмом.
$desc$ WHERE code = 'MACD';

UPDATE indicators SET description = $desc$
Bollinger Bands (BB) — полосы Боллинджера

Расчёт: средняя полоса = SMA(N), по умолчанию N=20; верхняя и нижняя = SMA ± k·σ (k=2 стандартных отклонения); bandwidth — относительная ширина канала. Серии: UPPER, MIDDLE, LOWER, BANDWIDTH.

Сигналы: касание/пробой верхней полосы — перекупленность или сильный тренд; нижней — перепроданность или падение; сжатие полос (низкий bandwidth) — ожидание всплеска волатильности; «walking the bands» — устойчивый тренд вдоль границы.

Применение: оценка волатильности, mean-reversion на боковике, подтверждение пробоев при расширении полос, постановка стопов относительно полос.
$desc$ WHERE code = 'BB';

UPDATE indicators SET description = $desc$
Average True Range (ATR) — средний истинный диапазон

Расчёт: True Range = max(High−Low, |High−Close_prev|, |Low−Close_prev|); ATR — сглаженное среднее TR за N периодов (Wilder, по умолчанию 14). ATR_PCT — ATR в процентах от цены.

Сигналы: рост ATR — усиление волатильности и движения; падение ATR — затишье и сжатие; резкий скачок ATR после консолидации — начало импульса. Сам по себе не даёт направления buy/sell.

Применение: расчёт стоп-лоссов и тейк-профитов в пунктах цены, sizing позиции, фильтр «достаточной» волатильности для входа, сравнение активности инструментов.
$desc$ WHERE code = 'ATR';

UPDATE indicators SET description = $desc$
Stochastic Oscillator (STOCH) — стохастический осциллятор

Расчёт: %K = (Close − Low_N) / (High_N − Low_N) × 100 за период N (по умолчанию 14); %D — SMA(%K) за 3 периода. Значения 0–100. Серии: K, D, пороги 80/20.

Сигналы: %K и %D выше 80 — перекупленность; ниже 20 — перепроданность; пересечение %K и %D в зонах экстремумов — сигнал разворота; бычья/медвежья дивергенция с ценой — предупреждение о смене импульса.

Применение: тайминг входа на коррекциях в тренде, скальпинг и intraday, комбинация с уровнями и трендовыми фильтрами (MA, ADX).
$desc$ WHERE code = 'STOCH';

UPDATE indicators SET description = $desc$
Price Acceleration (PACC) — ускорение цены

Расчёт: вторая разность цены закрытия — дискретный аналог второй производной по времени.
Формула в терминах многочленов MultiLogic: pp * (1; -2; 1), где pp — ряд Close, оператор * — свёртка (см. MultiLogic PolynomialIndicators).
На баре k: a_k = p_k − 2·p_{k−1} + p_{k−2}. Показывает, ускоряется или замедляется движение цены.

Сигналы: смена знака ускорения — возможный разворот импульса; положительное ускорение на растущей цене — усиление тренда; отрицательное — замедление роста или усиление падения.

Применение: фильтр импульса, подтверждение пробоев, оценка «кривизны» траектории цены; линия строится на шкале цены (как SMA).
$desc$ WHERE code = 'PACC';

UPDATE indicators SET description = $desc$
SMA Triple (SMAT3) — тройная свёртка ряда SMA

Расчёт: sma(period=20, series=VALUE) * … (трижды). В () — параметры: позиционно (20, VALUE) или period=20, series=VALUE; без () — дефолты серии на бумаге.
S = sma(…), затем ((S * S) * S) с нормализацией при равной длине рядов.

Сигналы: усиленное сглаживание на шкале цены; отлично от одинарного SMA.

Применение: тройная свёртка многочленов; запись через * без скобок и без композиции.
$desc$ WHERE code = 'SMAT3';

-- SMAT3COMP удалён (композиция sma(sma(...)) не используется)

-- ============================================
-- Таблица: indicator_value_types (линии индикаторов)
-- ============================================
CREATE TABLE IF NOT EXISTS indicator_value_types (
    id SERIAL PRIMARY KEY,
    indicator_id INTEGER NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
    code VARCHAR(20) NOT NULL,
    name VARCHAR(50) NOT NULL,
    value_type VARCHAR(20) NOT NULL DEFAULT 'float',
    is_threshold BOOLEAN NOT NULL DEFAULT FALSE,
    threshold_value NUMERIC(18, 6),
    description TEXT,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE indicator_value_types ADD COLUMN IF NOT EXISTS indicator_id INTEGER REFERENCES indicators(id) ON DELETE CASCADE;
ALTER TABLE indicator_value_types ADD COLUMN IF NOT EXISTS code VARCHAR(20);
ALTER TABLE indicator_value_types ADD COLUMN IF NOT EXISTS name VARCHAR(50);
ALTER TABLE indicator_value_types ADD COLUMN IF NOT EXISTS value_type VARCHAR(20) NOT NULL DEFAULT 'float';
ALTER TABLE indicator_value_types ADD COLUMN IF NOT EXISTS is_threshold BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE indicator_value_types ADD COLUMN IF NOT EXISTS threshold_value NUMERIC(18, 6);
ALTER TABLE indicator_value_types ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE indicator_value_types ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE indicator_value_types ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.




CREATE UNIQUE INDEX IF NOT EXISTS idx_indicator_value_types_unique ON indicator_value_types(indicator_id, code);

-- Типы значений (привязка по коду индикатора, не по id)
INSERT INTO indicator_value_types (indicator_id, code, name, value_type, is_threshold, threshold_value, description, display_order)
SELECT i.id, v.code, v.name, v.value_type, v.is_threshold, v.threshold_value, v.description, v.display_order
FROM indicators i
JOIN (VALUES
    ('RSI', 'RSI', 'Значение RSI', 'float', FALSE, NULL, 'Основное значение RSI', 1),
    ('RSI', 'OVERBOUGHT', 'Перекупленность', 'float', TRUE, 70, 'Порог перекупленности', 2),
    ('RSI', 'OVERSOLD', 'Перепроданность', 'float', TRUE, 30, 'Порог перепроданности', 3),
    ('RSI', 'NEUTRAL', 'Нейтральная зона', 'float', TRUE, 50, 'Нейтральный уровень', 4),
    ('MACD', 'MACD', 'MACD линия', 'float', FALSE, NULL, 'Разница EMA', 1),
    ('MACD', 'SIGNAL', 'Сигнальная линия', 'float', FALSE, NULL, 'Signal line', 2),
    ('MACD', 'HISTOGRAM', 'Гистограмма', 'float', FALSE, NULL, 'MACD - Signal', 3),
    ('MACD', 'ZERO', 'Нулевая линия', 'float', TRUE, 0, 'Нулевой уровень', 4),
    ('STOCH', 'K', '%K линия', 'float', FALSE, NULL, 'Быстрая линия', 1),
    ('STOCH', 'D', '%D линия', 'float', FALSE, NULL, 'Медленная линия', 2),
    ('STOCH', 'OVERBOUGHT', 'Перекупленность', 'float', TRUE, 80, 'Порог 80', 3),
    ('STOCH', 'OVERSOLD', 'Перепроданность', 'float', TRUE, 20, 'Порог 20', 4),
    ('BB', 'UPPER', 'Верхняя полоса', 'float', FALSE, NULL, 'Upper band', 1),
    ('BB', 'MIDDLE', 'Средняя полоса', 'float', FALSE, NULL, 'Middle band', 2),
    ('BB', 'LOWER', 'Нижняя полоса', 'float', FALSE, NULL, 'Lower band', 3),
    ('BB', 'BANDWIDTH', 'Ширина полос', 'float', FALSE, NULL, 'Bandwidth', 4),
    ('ATR', 'ATR', 'Значение ATR', 'float', FALSE, NULL, 'ATR', 1),
    ('ATR', 'ATR_PCT', 'ATR в процентах', 'float', FALSE, NULL, 'ATR %', 2),
    ('ATR', 'GROWTH5', 'Рост ATR за 5 баров %', 'float', FALSE, NULL, 'Бывший GrOk: (ATR/ATR[-5]-1)*100', 3),
    ('CCI', 'VALUE', 'Значение CCI', 'float', FALSE, NULL, 'CCI', 1),
    ('ADX', 'ADX', 'Значение ADX', 'float', FALSE, NULL, 'ADX Wilder', 1),
    ('ADX', 'PDI', '+DI', 'float', FALSE, NULL, 'Plus DI', 2),
    ('ADX', 'MDI', '−DI', 'float', FALSE, NULL, 'Minus DI', 3),
    ('LINREG', 'MIDDLE', 'Линия LinReg', 'float', FALSE, NULL, 'Середина канала', 1),
    ('LINREG', 'UPPER', 'Верхняя граница', 'float', FALSE, NULL, 'mid + Dev·σ', 2),
    ('LINREG', 'LOWER', 'Нижняя граница', 'float', FALSE, NULL, 'mid − Dev·σ', 3),
    ('LINREG', 'SLOPE', 'Наклон LinReg', 'float', FALSE, NULL, 'Наклон регрессии', 4),
    ('SQUARE', 'MIDDLE', 'Линия Square', 'float', FALSE, NULL, 'Середина квадратичного канала', 1),
    ('SQUARE', 'UPPER', 'Верхняя граница', 'float', FALSE, NULL, 'mid + Dev·σ', 2),
    ('SQUARE', 'LOWER', 'Нижняя граница', 'float', FALSE, NULL, 'mid − Dev·σ', 3),
    ('SQUARE', 'SLOPE', 'Наклон Square', 'float', FALSE, NULL, 'Мгновенный наклон a+2·c·x на конце окна', 4),
    ('SQUARE', 'C', 'Коэффициент C', 'float', FALSE, NULL, 'Квадратичный коэффициент c в b+a·x+c·x²', 5),
    ('PACC', 'VALUE', 'Ускорение цены', 'float', FALSE, NULL, 'pp * (1;-2;1)', 1),
    ('SMAT3', 'VALUE', 'SMA³ свёртка', 'float', FALSE, NULL, 'sma(period=20,series=VALUE)*3', 1),
    ('SMA', 'VALUE', 'Значение MA', 'float', FALSE, NULL, 'SMA value', 1),
    ('EMA', 'VALUE', 'Значение EMA', 'float', FALSE, NULL, 'EMA value', 1),
    ('WMA', 'VALUE', 'Значение WMA', 'float', FALSE, NULL, 'WMA value', 1)
) AS v(indicator_code, code, name, value_type, is_threshold, threshold_value, description, display_order)
    ON i.code = v.indicator_code
ON CONFLICT (indicator_id, code) DO NOTHING;

-- ============================================
-- Таблица: security_indicator_series (серии индикаторов на бумаге)
-- Одна строка = одна линия на графике (серия) с формулой вызова calc_ind_*_array
-- ============================================
CREATE TABLE IF NOT EXISTS security_indicator_series (
    id SERIAL PRIMARY KEY,
    security_id INTEGER NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
    indicator_id INTEGER NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
    series_code VARCHAR(20) NOT NULL,
    invoke_formula TEXT NOT NULL,
    param_period INTEGER,
    param_fast_period INTEGER,
    param_slow_period INTEGER,
    param_signal_period INTEGER,
    param_std_dev NUMERIC(10, 4) DEFAULT 2.0,
    param_k_period INTEGER,
    param_d_period INTEGER,
    param_smooth INTEGER,
    point_count INTEGER NOT NULL DEFAULT 100,
    display_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE security_indicator_series ADD COLUMN IF NOT EXISTS security_id INTEGER REFERENCES securities(id) ON DELETE CASCADE;
ALTER TABLE security_indicator_series ADD COLUMN IF NOT EXISTS indicator_id INTEGER REFERENCES indicators(id) ON DELETE CASCADE;
ALTER TABLE security_indicator_series ADD COLUMN IF NOT EXISTS series_code VARCHAR(20);
ALTER TABLE security_indicator_series ADD COLUMN IF NOT EXISTS invoke_formula TEXT;
ALTER TABLE security_indicator_series ADD COLUMN IF NOT EXISTS param_period INTEGER;
ALTER TABLE security_indicator_series ADD COLUMN IF NOT EXISTS param_fast_period INTEGER;
ALTER TABLE security_indicator_series ADD COLUMN IF NOT EXISTS param_slow_period INTEGER;
ALTER TABLE security_indicator_series ADD COLUMN IF NOT EXISTS param_signal_period INTEGER;
ALTER TABLE security_indicator_series ADD COLUMN IF NOT EXISTS param_std_dev NUMERIC(10, 4) DEFAULT 2.0;
ALTER TABLE security_indicator_series ADD COLUMN IF NOT EXISTS param_k_period INTEGER;
ALTER TABLE security_indicator_series ADD COLUMN IF NOT EXISTS param_d_period INTEGER;
ALTER TABLE security_indicator_series ADD COLUMN IF NOT EXISTS param_smooth INTEGER;
ALTER TABLE security_indicator_series ADD COLUMN IF NOT EXISTS point_count INTEGER NOT NULL DEFAULT 100;
ALTER TABLE security_indicator_series ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE security_indicator_series ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE security_indicator_series ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.




CREATE UNIQUE INDEX IF NOT EXISTS idx_security_indicator_series_unique
    ON security_indicator_series(security_id, indicator_id, series_code);
CREATE INDEX IF NOT EXISTS idx_security_indicator_series_security_id
    ON security_indicator_series(security_id);
CREATE INDEX IF NOT EXISTS idx_security_indicator_series_indicator_id
    ON security_indicator_series(indicator_id);

COMMENT ON TABLE security_indicator_series IS
'Привязка серий индикатора к бумаге: invoke_formula — calc_ind_*_array(…) или многочленная формула (pp * (1;-2;1), @SMA, …)';

-- Пример: SBER + STOCH, серии %K и %D с параметрами по умолчанию
INSERT INTO security_indicator_series (
    security_id, indicator_id, series_code, invoke_formula,
    param_k_period, param_d_period, param_smooth, point_count, display_order
)
SELECT s.id, i.id, v.series_code, v.formula, 14, 3, 3, 100, v.ord
FROM securities s
JOIN security_prefixes sp ON sp.security_id = s.id AND sp.prefix = 'SBER'
JOIN indicators i ON i.code = 'STOCH'
CROSS JOIN (
    VALUES
        ('K', 'calc_ind_stoch_array(:param_k_period, :param_d_period, :param_smooth, :series, :security_id, :timeframe_id, :point_count, :end_dt)', 1),
        ('D', 'calc_ind_stoch_array(:param_k_period, :param_d_period, :param_smooth, :series, :security_id, :timeframe_id, :point_count, :end_dt)', 2)
) AS v(series_code, formula, ord)
ON CONFLICT (security_id, indicator_id, series_code) DO NOTHING;

-- Пример: SBER + PACC (ускорение цены), многочленная формула по умолчанию
INSERT INTO security_indicator_series (
    security_id, indicator_id, series_code, invoke_formula,
    point_count, display_order
)
SELECT s.id, i.id, 'VALUE', 'pp * (1; -2; 1)', 100, 3
FROM securities s
JOIN security_prefixes sp ON sp.security_id = s.id AND sp.prefix = 'SBER'
JOIN indicators i ON i.code = 'PACC'
ON CONFLICT (security_id, indicator_id, series_code) DO NOTHING;

-- ============================================
-- Таблица: indicator_values (рассчитанные значения)
-- ============================================
CREATE TABLE IF NOT EXISTS indicator_values (
    id BIGSERIAL PRIMARY KEY,
    indicator_id INTEGER NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
    indicator_value_type_id INTEGER NOT NULL REFERENCES indicator_value_types(id) ON DELETE CASCADE,
    security_id INTEGER NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
    timeframe_id INTEGER NOT NULL REFERENCES timeframes(id) ON DELETE CASCADE,
    dt TIMESTAMP NOT NULL,
    value NUMERIC(18, 6)
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE indicator_values ADD COLUMN IF NOT EXISTS indicator_id INTEGER REFERENCES indicators(id) ON DELETE CASCADE;
ALTER TABLE indicator_values ADD COLUMN IF NOT EXISTS indicator_value_type_id INTEGER REFERENCES indicator_value_types(id) ON DELETE CASCADE;
ALTER TABLE indicator_values ADD COLUMN IF NOT EXISTS security_id INTEGER REFERENCES securities(id) ON DELETE CASCADE;
ALTER TABLE indicator_values ADD COLUMN IF NOT EXISTS timeframe_id INTEGER REFERENCES timeframes(id) ON DELETE CASCADE;
ALTER TABLE indicator_values ADD COLUMN IF NOT EXISTS dt TIMESTAMP;
ALTER TABLE indicator_values ADD COLUMN IF NOT EXISTS value NUMERIC(18, 6);

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.




ALTER TABLE indicator_values DROP COLUMN IF EXISTS is_signal;
ALTER TABLE indicator_values DROP COLUMN IF EXISTS signal_type;
ALTER TABLE indicator_values DROP COLUMN IF EXISTS created_at;

CREATE INDEX IF NOT EXISTS idx_indicator_values_indicator_id ON indicator_values(indicator_id);
CREATE INDEX IF NOT EXISTS idx_indicator_values_security_id ON indicator_values(security_id);
CREATE INDEX IF NOT EXISTS idx_indicator_values_timeframe_id ON indicator_values(timeframe_id);
CREATE INDEX IF NOT EXISTS idx_indicator_values_dt ON indicator_values(dt);
CREATE UNIQUE INDEX IF NOT EXISTS idx_indicator_values_unique
    ON indicator_values(indicator_id, indicator_value_type_id, security_id, timeframe_id, dt);

-- ============================================
-- Таблицы торговой логики (заготовка)
-- logics — основная сущность: одна строка = одна торговля (трейд)
-- ============================================
CREATE TABLE IF NOT EXISTS logics (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    note TEXT
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE logics ADD COLUMN IF NOT EXISTS name VARCHAR(100);
ALTER TABLE logics ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES accounts(id) ON DELETE RESTRICT;
ALTER TABLE logics ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE logics ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE logics ADD COLUMN IF NOT EXISTS portfolio_trading_paused BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE logics ADD COLUMN IF NOT EXISTS portfolio_equity_peak NUMERIC(20, 6);
ALTER TABLE logics ADD COLUMN IF NOT EXISTS portfolio_stop_resume_equity NUMERIC(20, 6);
ALTER TABLE logics ADD COLUMN IF NOT EXISTS portfolio_stop_resume_baseline NUMERIC(20, 6);
ALTER TABLE logics ADD COLUMN IF NOT EXISTS portfolio_stop_resume_at TIMESTAMP;
ALTER TABLE logics ADD COLUMN IF NOT EXISTS portfolio_linear_tp_armed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE logics ADD COLUMN IF NOT EXISTS portfolio_linear_tp_peak_equity NUMERIC(20, 6);
ALTER TABLE logics ADD COLUMN IF NOT EXISTS portfolio_linear_tp_arm_bar_dt TIMESTAMP;
ALTER TABLE logics ADD COLUMN IF NOT EXISTS portfolio_linear_tp_latched BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN logics.portfolio_linear_tp_latched IS
'После срабатывания portfolio_ltp_renew: не взводить снова, пока track% не уйдёт ниже arm% (анти-чоп)';

COMMENT ON COLUMN logics.portfolio_trading_paused IS
'portfolio_resume SL: реал остановлен, сделки идут в shadow до восстановления equity';
COMMENT ON COLUMN logics.portfolio_equity_peak IS
'Пик equity портфеля (обновляется на баре, пока нет portfolio pause)';
COMMENT ON COLUMN logics.portfolio_stop_resume_equity IS
'Цель возобновления реальной торговли (уровень до срабатывания portfolio_resume)';
COMMENT ON COLUMN logics.portfolio_stop_resume_baseline IS
'Equity после закрытия реальных позиций при portfolio_resume';

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.





CREATE INDEX IF NOT EXISTS idx_logics_account_id ON logics(account_id);
-- Старые БД: CREATE TABLE IF NOT EXISTS не добавит UNIQUE(name) — ON CONFLICT (name) иначе падает.
CREATE UNIQUE INDEX IF NOT EXISTS logics_name_key ON logics (name);

COMMENT ON TABLE logics IS 'Торговые логики: одна строка — одна торговля (трейд); параметры — в logic_params';
COMMENT ON COLUMN logics.name IS 'Уникальное имя логики';
COMMENT ON COLUMN logics.account_id IS 'Счёт (accounts), на котором выполняется эта торговля';
COMMENT ON COLUMN logics.is_enabled IS 'Логика включена (активна) или выключена';
COMMENT ON COLUMN logics.note IS 'Примечание: тип стратегии, источник (OsEngine и т.д.), комментарий в свободной форме';

-- Пример: SMA Price Cross Demo (фейковый счёт T-Bank); параметры — в logic_params ниже
INSERT INTO logics (name, account_id, is_enabled)
SELECT
    'SMA Price Cross Demo',
    a.id,
    FALSE
FROM accounts a
JOIN brokers b ON b.id = a.broker_id
WHERE b.code = 'T-BANK' AND a.account_code = 'FAKE-EFF-001'
ON CONFLICT (name) DO NOTHING;

-- ============================================
-- Параметры торговой логики (EAV: logic_param_defs + logic_params)
-- ============================================
CREATE TABLE IF NOT EXISTS logic_param_defs (
    param_key VARCHAR(64) PRIMARY KEY,
    name_ru VARCHAR(200) NOT NULL,
    value_type VARCHAR(20) NOT NULL CHECK (value_type IN ('number', 'integer', 'money', 'boolean', 'text')),
    default_value TEXT NOT NULL DEFAULT '',
    description TEXT,
    display_order INTEGER NOT NULL DEFAULT 0
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE logic_param_defs ADD COLUMN IF NOT EXISTS param_key VARCHAR(64);
ALTER TABLE logic_param_defs ADD COLUMN IF NOT EXISTS name_ru VARCHAR(200);
ALTER TABLE logic_param_defs ADD COLUMN IF NOT EXISTS value_type VARCHAR(20) CHECK (value_type IN ('number', 'integer', 'money', 'boolean', 'text'));
ALTER TABLE logic_param_defs ADD COLUMN IF NOT EXISTS default_value TEXT NOT NULL DEFAULT '';
ALTER TABLE logic_param_defs ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE logic_param_defs ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0;

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.




INSERT INTO logic_param_defs (param_key, name_ru, value_type, default_value, description, display_order) VALUES
    ('timeframe', 'Таймфрейм', 'text', 'M15',
     'Таймфрейм цен, индикаторов и цикла сделок (M15, H1, D1 …)', 0),
    ('position_size_base', 'База расчёта лота', 'text', 'free_cash',
     'free_cash (по умолчанию) — % от свободных денег; portfolio — % от портфеля без ден. фонда; portfolio_incl_fund — весь портфель с фондом', 1),
    ('position_size_pct', '% депозита на сделку', 'number', '10',
     'Доля выбранной базы (портфель или свободные) на одну покупку (1–100)', 2),
    ('max_open_positions', 'Макс. открытых позиций', 'integer', '5',
     'Число одновременных позиций; плечо ≈ (макс × % / 100)', 3),
    ('max_order_amount', 'Макс. сумма на сделку, ₽', 'money', '',
     'Потолок номинала одной покупки (пусто = без лимита), после расчёта %', 4),
    ('initial_balance', 'Начальный остаток', 'money', '',
     'Тест (fake): значение из параметров. Real: всегда с брокера (или 0), не из формы/теста', 5),
    ('current_balance', 'Текущий остаток', 'money', '',
     'Тест (fake): свободный кэш. Real: свободный кэш T-Bank (или 0). Не база лота при режиме portfolio', 6),
    ('commission_pct', '% комиссии от сделки', 'number', '0.03',
     'Только фейковый счёт/тест: комиссия = цена × количество × % / 100. Real: комиссия с T-Bank (executedCommission), этот % не используется', 7),
    ('cost_method', 'Метод расчёта PnL', 'text', 'FIFO',
     'FIFO — по очереди покупок; AVERAGE — по средней цене остатка', 8),
    ('stop_loss_timeframe', 'Таймфрейм стоп-лосса', 'text', 'M5',
     'TF для проверки стоп-лоссов (по умолчанию M5)', 9),
    ('base_annual_rate_pct', 'Базовая ставка (% годовых)', 'number', '20',
     'Порог для рейтинга сигнала: ход цены на следующей свече в годовых ≥ этой ставки', 10),
    ('rating_lookback_days', 'Дней предрасчёта рейтинга', 'integer', '7',
     'При включении боя: предрасчёт боевых рейтингов сигналов по свечам за N дней (фон)', 11),
    ('inversion', 'Инверсия', 'boolean', 'false',
     'Инверсия логики: условия наоборот (≥↔≤, >↔<) и сделки в противоположную сторону (Long↔Short)', 12),
    ('warmup_pretest', 'Прогрев (предварительное тестирование)', 'boolean', 'true',
     'Перед включением боя: прогнать тест за rating_lookback_days и перенести состояния бумаг для security_resume/security_inversion', 13),
    ('cash_fund_code', 'Денежный фонд (парк кэша)', 'text', '',
     'Пусто = не покупать. TMON / LQDT / SBMM — runner паркует избыток кэша на реальном счёте (1 раз на закрытую свечу TF)', 14),
    ('cash_fund_threshold', 'Порог портфеля (equity), ₽', 'money', '1000000',
     'Если equity выше порога и выбран фонд — парковать избыток (buy-only). По умолчанию = начальный остаток теста (1 000 000)', 15),
    ('use_non_trading_periods', 'Учитывать неторговые периоды', 'boolean', 'true',
     'Не открывать сделки в интервалах из блока «Торговые периоды» (шаблон MOEX TQBR по умолчанию)', 16),
    ('close_positions_eod', 'Закрывать позиции в конце дня (кроме фондов)', 'boolean', 'false',
     'В конце торговой сессии (или на последней свече дня) закрыть все позиции, кроме денежного фонда TMON/LQDT/SBMM', 17),
    ('order_execution', 'Тип исполнения заявок', 'text', 'market',
     'market — рыночная заявка (сразу в сессию); limit — лимитная по цене сигнала (может висеть в стакане). По умолчанию market', 18),
    ('opt_eval_candles', 'Свечей окна OPT', 'integer', '20',
     'Через сколько закрытых свечей TF сравнить FinRes чемпиона и OPT-веток (±%) и подставить лучшие значения параметров в формулы', 19),
    ('last_opt_eval_bar_dt', 'Последняя оценка OPT', 'text', '',
     'Служебный: open time свечи TF последней смены OPT-параметров', 95),
    ('last_cash_fund_bar_dt', 'Последняя парковка кэша', 'text', '',
     'Служебный: open time закрытой свечи TF последней попытки парковки в фонд', 96),
    ('last_stop_bar_dt', 'Последняя свеча стоп-лосса', 'text', '',
     'Служебный: open time закрытой свечи TF стоп-лосса', 97),
    ('last_trade_check_at', 'Последняя проверка сигналов', 'text', '',
     'Служебный: время последнего run_trade_cycle (не редактировать)', 98),
    ('last_trade_bar_dt', 'Последняя обработанная свеча', 'text', '',
     'Служебный: open time закрытой свечи TF (не редактировать)', 99)
ON CONFLICT (param_key) DO UPDATE SET
    name_ru = EXCLUDED.name_ru,
    value_type = EXCLUDED.value_type,
    default_value = EXCLUDED.default_value,
    description = EXCLUDED.description,
    display_order = EXCLUDED.display_order;

CREATE TABLE IF NOT EXISTS logic_params (
    id SERIAL PRIMARY KEY,
    logic_id INTEGER NOT NULL REFERENCES logics(id) ON DELETE CASCADE,
    param_key VARCHAR(64) NOT NULL REFERENCES logic_param_defs(param_key) ON DELETE RESTRICT,
    param_value TEXT NOT NULL DEFAULT '',
    value_type VARCHAR(20) NOT NULL CHECK (value_type IN ('number', 'integer', 'money', 'boolean', 'text')),
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (logic_id, param_key)
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE logic_params ADD COLUMN IF NOT EXISTS logic_id INTEGER REFERENCES logics(id) ON DELETE CASCADE;
ALTER TABLE logic_params ADD COLUMN IF NOT EXISTS param_key VARCHAR(64) REFERENCES logic_param_defs(param_key) ON DELETE RESTRICT;
ALTER TABLE logic_params ADD COLUMN IF NOT EXISTS param_value TEXT NOT NULL DEFAULT '';
ALTER TABLE logic_params ADD COLUMN IF NOT EXISTS value_type VARCHAR(20) CHECK (value_type IN ('number', 'integer', 'money', 'boolean', 'text'));
ALTER TABLE logic_params ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Upgrade: старый дефолт порога TMON 100000 → 1000000 (= initial_balance теста)
-- Must run AFTER CREATE logic_params (fresh DBs / wipe recreate public schema).
UPDATE logic_params
SET param_value = '1000000',
    updated_at = CURRENT_TIMESTAMP
WHERE param_key = 'cash_fund_threshold'
  AND replace(replace(btrim(param_value), ' ', ''), ',', '.') IN ('100000', '100000.0', '100000.00');

-- Upgrade v51: старый дефолт portfolio → free_cash (явный portfolio_incl_fund не трогаем)
UPDATE logic_params
SET param_value = 'free_cash',
    updated_at = CURRENT_TIMESTAMP
WHERE param_key = 'position_size_base'
  AND lower(btrim(COALESCE(param_value, ''))) IN ('', 'portfolio');

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.




CREATE INDEX IF NOT EXISTS idx_logic_params_logic_id ON logic_params(logic_id);

COMMENT ON TABLE logic_param_defs IS 'Справочник ключей параметров торговой логики';
COMMENT ON TABLE logic_params IS 'Значения параметров logics: одна строка = один параметр одной логики';
COMMENT ON COLUMN logic_params.param_key IS 'Имя параметра (ссылка на logic_param_defs)';
COMMENT ON COLUMN logic_params.param_value IS 'Значение в текстовом виде';
COMMENT ON COLUMN logic_params.value_type IS 'Тип значения: number | integer | money | boolean | text';

-- v39: перенос из legacy-колонок logics (если ещё есть) → logic_params, затем DROP
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'logics' AND column_name = 'position_size_pct'
    ) THEN
        INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
        SELECT l.id, 'position_size_pct', l.position_size_pct::text, 'number'
        FROM logics l
        ON CONFLICT (logic_id, param_key) DO NOTHING;

        INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
        SELECT l.id, 'max_open_positions', l.max_open_positions::text, 'integer'
        FROM logics l
        ON CONFLICT (logic_id, param_key) DO NOTHING;

        INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
        SELECT l.id, 'initial_balance', l.initial_balance::text, 'money'
        FROM logics l
        WHERE l.initial_balance IS NOT NULL
        ON CONFLICT (logic_id, param_key) DO NOTHING;

        INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
        SELECT l.id, 'current_balance', l.current_balance::text, 'money'
        FROM logics l
        WHERE l.current_balance IS NOT NULL
        ON CONFLICT (logic_id, param_key) DO NOTHING;
    END IF;
END $$;

ALTER TABLE logics DROP CONSTRAINT IF EXISTS chk_logics_position_size_pct;
ALTER TABLE logics DROP CONSTRAINT IF EXISTS chk_logics_max_open_positions;
ALTER TABLE logics DROP COLUMN IF EXISTS position_size_pct;
ALTER TABLE logics DROP COLUMN IF EXISTS max_open_positions;
ALTER TABLE logics DROP COLUMN IF EXISTS initial_balance;
ALTER TABLE logics DROP COLUMN IF EXISTS current_balance;

-- Дефолты для всех логик без строк в logic_params
INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
SELECT l.id, d.param_key, d.default_value, d.value_type
FROM logics l
CROSS JOIN logic_param_defs d
ON CONFLICT (logic_id, param_key) DO NOTHING;

-- Upgrade / install-over: на real — сбросить paper-остатки в 0 (в т.ч. «миллион» после теста).
-- Затем 02 вызовет logic_sync_all_real_account_balances() → кэш брокера или 0.
UPDATE logic_params lp
SET param_value = '0',
    updated_at = CURRENT_TIMESTAMP
FROM logics l
JOIN accounts a ON a.id = l.account_id
WHERE lp.logic_id = l.id
  AND lower(COALESCE(a.account_type, 'fake')) <> 'fake'
  AND lp.param_key IN ('initial_balance', 'current_balance');

-- Демо SMA: параметры в logic_params
INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
SELECT l.id, v.param_key, v.param_value, v.value_type
FROM logics l
CROSS JOIN (VALUES
    ('timeframe', 'M15', 'text'),
    ('position_size_pct', '10', 'number'),
    ('max_open_positions', '3', 'integer'),
    ('initial_balance', '1000000', 'money'),
    ('current_balance', '1000000', 'money'),
    ('commission_pct', '0.03', 'number'),
    ('cost_method', 'FIFO', 'text'),
    ('stop_loss_timeframe', 'M5', 'text'),
    ('base_annual_rate_pct', '20', 'number'),
    ('rating_lookback_days', '7', 'integer')
) AS v(param_key, param_value, value_type)
WHERE l.name = 'SMA Price Cross Demo'
ON CONFLICT (logic_id, param_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS sides (
    id SERIAL PRIMARY KEY,
    name VARCHAR(20) NOT NULL UNIQUE
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE sides ADD COLUMN IF NOT EXISTS name VARCHAR(20);

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.




INSERT INTO sides (name) VALUES ('Open'), ('Close') ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS actions (
    id SERIAL PRIMARY KEY,
    name VARCHAR(20) NOT NULL UNIQUE
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE actions ADD COLUMN IF NOT EXISTS name VARCHAR(20);

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.




INSERT INTO actions (name) VALUES ('Long'), ('Short') ON CONFLICT (name) DO NOTHING;

-- v39: устаревшая logics_detail удалена (заменена logic_indicator_signals)
DROP TABLE IF EXISTS logics_detail;

-- Сигналы индикаторов, привязанные к торговой логике
CREATE TABLE IF NOT EXISTS logic_indicator_signals (
    id SERIAL PRIMARY KEY,
    logic_id INTEGER NOT NULL REFERENCES logics(id) ON DELETE CASCADE,
    indicator_id INTEGER NOT NULL REFERENCES indicators(id) ON DELETE RESTRICT,
    position_event VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (position_event IN ('open', 'close')),
    position_side VARCHAR(10) NOT NULL DEFAULT 'long' CHECK (position_side IN ('long', 'short')),
    signal_kind VARCHAR(10) NOT NULL CHECK (signal_kind IN ('trend', 'counter')),
    formula TEXT NOT NULL,
    rating INTEGER NOT NULL DEFAULT 0,
    rating_test INTEGER NOT NULL DEFAULT 0,
    display_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (logic_id, indicator_id, position_event, position_side, signal_kind)
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE logic_indicator_signals ADD COLUMN IF NOT EXISTS logic_id INTEGER REFERENCES logics(id) ON DELETE CASCADE;
ALTER TABLE logic_indicator_signals ADD COLUMN IF NOT EXISTS indicator_id INTEGER REFERENCES indicators(id) ON DELETE RESTRICT;
ALTER TABLE logic_indicator_signals ADD COLUMN IF NOT EXISTS position_event VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (position_event IN ('open', 'close'));
ALTER TABLE logic_indicator_signals ADD COLUMN IF NOT EXISTS position_side VARCHAR(10) NOT NULL DEFAULT 'long' CHECK (position_side IN ('long', 'short'));
ALTER TABLE logic_indicator_signals ADD COLUMN IF NOT EXISTS signal_kind VARCHAR(10) CHECK (signal_kind IN ('trend', 'counter'));
ALTER TABLE logic_indicator_signals ADD COLUMN IF NOT EXISTS formula TEXT;
ALTER TABLE logic_indicator_signals ADD COLUMN IF NOT EXISTS rating INTEGER NOT NULL DEFAULT 0;
ALTER TABLE logic_indicator_signals ADD COLUMN IF NOT EXISTS rating_test INTEGER NOT NULL DEFAULT 0;
ALTER TABLE logic_indicator_signals ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE logic_indicator_signals ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE logic_indicator_signals ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.




-- Рейтинг может быть отрицательным (успех +1 / неуспех −1 по следующей свече)
ALTER TABLE logic_indicator_signals DROP CONSTRAINT IF EXISTS logic_indicator_signals_rating_check;
ALTER TABLE logic_indicator_signals DROP CONSTRAINT IF EXISTS logic_indicator_signals_rating_test_check;
UPDATE logic_indicator_signals SET rating = 0 WHERE rating IS NULL;
UPDATE logic_indicator_signals SET rating_test = 0 WHERE rating_test IS NULL;

-- Миграция v18 → v19: position_side (long | short)

-- Миграция v38: position_event (open | close) — явно открытие/закрытие

DO $$
BEGIN
    ALTER TABLE logic_indicator_signals ADD CONSTRAINT logic_indicator_signals_position_side_check
        CHECK (position_side IN ('long', 'short'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE logic_indicator_signals ADD CONSTRAINT logic_indicator_signals_position_event_check
        CHECK (position_event IN ('open', 'close'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

UPDATE logic_indicator_signals SET position_side = 'long' WHERE position_side IS NULL OR position_side = '';

-- Backfill v38 один раз: если ещё нет ни одного close — старая модель (counter = закрытие)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM logic_indicator_signals WHERE position_event = 'close' LIMIT 1
    ) THEN
        RETURN;
    END IF;
    UPDATE logic_indicator_signals
    SET position_event = CASE WHEN signal_kind = 'counter' THEN 'close' ELSE 'open' END;
END $$;

ALTER TABLE logic_indicator_signals DROP CONSTRAINT IF EXISTS logic_indicator_signals_logic_id_indicator_id_signal_kind_key;
ALTER TABLE logic_indicator_signals DROP CONSTRAINT IF EXISTS logic_indicator_signals_logic_id_indicator_id_position_side_signal_kind_key;
ALTER TABLE logic_indicator_signals DROP CONSTRAINT IF EXISTS logic_indicator_signals_logic_id_indicator_id_position_event_position_side_signal_kind_key;

DROP INDEX IF EXISTS logic_indicator_signals_logic_id_indicator_id_signal_kind_key;
DROP INDEX IF EXISTS idx_logic_indicator_signals_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_logic_indicator_signals_unique
    ON logic_indicator_signals (logic_id, indicator_id, position_event, position_side, signal_kind);

CREATE INDEX IF NOT EXISTS idx_logic_indicator_signals_logic_id
    ON logic_indicator_signals(logic_id);
CREATE INDEX IF NOT EXISTS idx_logic_indicator_signals_indicator_id
    ON logic_indicator_signals(indicator_id);

COMMENT ON TABLE logic_indicator_signals IS
'Сигналы индикаторов для logics: position_event open|close, сторона long|short, тип trend|counter. '
'В одной логике для сделки нужны ВСЕ активные сигналы той же стороны и того же open/close (AND).';
COMMENT ON COLUMN logic_indicator_signals.position_event IS 'open | close — открытие или закрытие позиции';
COMMENT ON COLUMN logic_indicator_signals.position_side IS 'long | short — сторона позиции сигнала';
COMMENT ON COLUMN logic_indicator_signals.signal_kind IS 'trend | counter';
COMMENT ON COLUMN logic_indicator_signals.formula IS
'Редактируемая формула: @RSI(period=14,series=VALUE) VALUE > 50';
COMMENT ON COLUMN logic_indicator_signals.rating IS
'Боевой рейтинг сигнала на логике (может быть <0): сработал → pending; на следующей свече '
'ход → % годовых vs base_annual_rate_pct → +1/−1. Не рейтинг индикатора из справочника.';
COMMENT ON COLUMN logic_indicator_signals.rating_test IS
'Тестовый рейтинг сигнала (is_test), сумма по бумагам; не смешивается с rating.';

-- Ожидание проверки рейтинга сигнала: сработал на баре → на следующей свече TF оцениваем ход цены
CREATE TABLE IF NOT EXISTS logic_signal_rating_pending (
    id BIGSERIAL PRIMARY KEY,
    signal_id INTEGER NOT NULL REFERENCES logic_indicator_signals(id) ON DELETE CASCADE,
    logic_id INTEGER NOT NULL REFERENCES logics(id) ON DELETE CASCADE,
    security_id INTEGER NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
    timeframe_id INTEGER NOT NULL REFERENCES timeframes(id) ON DELETE RESTRICT,
    bar_dt TIMESTAMP NOT NULL,
    price NUMERIC(18, 6) NOT NULL CHECK (price > 0),
    position_side VARCHAR(10) NOT NULL CHECK (position_side IN ('long', 'short')),
    signal_kind VARCHAR(10) NOT NULL CHECK (signal_kind IN ('trend', 'counter')),
    is_test BOOLEAN NOT NULL DEFAULT FALSE,
    run_id BIGINT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE logic_signal_rating_pending ADD COLUMN IF NOT EXISTS signal_id INTEGER REFERENCES logic_indicator_signals(id) ON DELETE CASCADE;
ALTER TABLE logic_signal_rating_pending ADD COLUMN IF NOT EXISTS logic_id INTEGER REFERENCES logics(id) ON DELETE CASCADE;
ALTER TABLE logic_signal_rating_pending ADD COLUMN IF NOT EXISTS security_id INTEGER REFERENCES securities(id) ON DELETE CASCADE;
ALTER TABLE logic_signal_rating_pending ADD COLUMN IF NOT EXISTS timeframe_id INTEGER REFERENCES timeframes(id) ON DELETE RESTRICT;
ALTER TABLE logic_signal_rating_pending ADD COLUMN IF NOT EXISTS bar_dt TIMESTAMP;
ALTER TABLE logic_signal_rating_pending ADD COLUMN IF NOT EXISTS price NUMERIC(18, 6) CHECK (price > 0);
ALTER TABLE logic_signal_rating_pending ADD COLUMN IF NOT EXISTS position_side VARCHAR(10) CHECK (position_side IN ('long', 'short'));
ALTER TABLE logic_signal_rating_pending ADD COLUMN IF NOT EXISTS signal_kind VARCHAR(10) CHECK (signal_kind IN ('trend', 'counter'));
ALTER TABLE logic_signal_rating_pending ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE logic_signal_rating_pending ADD COLUMN IF NOT EXISTS run_id BIGINT;
ALTER TABLE logic_signal_rating_pending ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.





ALTER TABLE logic_signal_rating_pending
    DROP CONSTRAINT IF EXISTS logic_signal_rating_pending_signal_id_security_id_bar_dt_key;
DROP INDEX IF EXISTS logic_signal_rating_pending_signal_id_security_id_bar_dt_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_logic_signal_rating_pending_uniq
    ON logic_signal_rating_pending (signal_id, security_id, bar_dt, is_test);

CREATE INDEX IF NOT EXISTS idx_logic_signal_rating_pending_logic
    ON logic_signal_rating_pending(logic_id, timeframe_id, is_test);

COMMENT ON TABLE logic_signal_rating_pending IS
'Срабатывания сигналов логики, ожидающие проверки на следующей свече TF; is_test отделяет тест от боя.';

-- История рейтинга для графиков (шаг на каждом resolve)
CREATE TABLE IF NOT EXISTS logic_signal_rating_history (
    id BIGSERIAL PRIMARY KEY,
    signal_id INTEGER NOT NULL REFERENCES logic_indicator_signals(id) ON DELETE CASCADE,
    logic_id INTEGER NOT NULL REFERENCES logics(id) ON DELETE CASCADE,
    security_id INTEGER REFERENCES securities(id) ON DELETE SET NULL,
    run_id BIGINT,
    bar_dt TIMESTAMP NOT NULL,
    rating INTEGER NOT NULL,
    delta SMALLINT NOT NULL CHECK (delta IN (-1, 1)),
    is_test BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE logic_signal_rating_history ADD COLUMN IF NOT EXISTS signal_id INTEGER REFERENCES logic_indicator_signals(id) ON DELETE CASCADE;
ALTER TABLE logic_signal_rating_history ADD COLUMN IF NOT EXISTS logic_id INTEGER REFERENCES logics(id) ON DELETE CASCADE;
ALTER TABLE logic_signal_rating_history ADD COLUMN IF NOT EXISTS security_id INTEGER REFERENCES securities(id) ON DELETE SET NULL;
ALTER TABLE logic_signal_rating_history ADD COLUMN IF NOT EXISTS run_id BIGINT;
ALTER TABLE logic_signal_rating_history ADD COLUMN IF NOT EXISTS bar_dt TIMESTAMP;
ALTER TABLE logic_signal_rating_history ADD COLUMN IF NOT EXISTS rating INTEGER;
ALTER TABLE logic_signal_rating_history ADD COLUMN IF NOT EXISTS delta SMALLINT CHECK (delta IN (-1, 1));
ALTER TABLE logic_signal_rating_history ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE logic_signal_rating_history ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.




ALTER TABLE logic_signal_rating_history DROP CONSTRAINT IF EXISTS logic_signal_rating_history_rating_check;

CREATE INDEX IF NOT EXISTS idx_logic_signal_rating_history_signal
    ON logic_signal_rating_history (signal_id, is_test, bar_dt);
CREATE INDEX IF NOT EXISTS idx_logic_signal_rating_history_run
    ON logic_signal_rating_history (run_id, signal_id, bar_dt)
    WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_logic_signal_rating_history_logic_test
    ON logic_signal_rating_history (logic_id, is_test, bar_dt);
CREATE INDEX IF NOT EXISTS idx_logic_signal_rating_history_sec
    ON logic_signal_rating_history (logic_id, security_id, is_test, signal_id, bar_dt);

COMMENT ON TABLE logic_signal_rating_history IS
'Рейтинг сигнала на бумаге во времени: rating — кумулятив по (signal×security), delta ±1 после проверки следующей свечи';

-- Стоп-лосс и тейк-профит по торговой логике
CREATE TABLE IF NOT EXISTS logic_stops (
    id SERIAL PRIMARY KEY,
    logic_id INTEGER NOT NULL REFERENCES logics(id) ON DELETE CASCADE,
    rule_kind VARCHAR(20) NOT NULL CHECK (rule_kind IN ('stop_loss', 'take_profit')),
    scope_type VARCHAR(40) NOT NULL CHECK (scope_type IN (
        'security', 'security_resume', 'security_inversion', 'portfolio', 'portfolio_resume',
        'portfolio_ltp_renew', 'security_ltp_renew'
    )),
    value NUMERIC(18, 6) NOT NULL CHECK (value > 0),
    value_unit VARCHAR(10) NOT NULL CHECK (value_unit IN ('percent', 'atr')),
    display_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE logic_stops ADD COLUMN IF NOT EXISTS logic_id INTEGER REFERENCES logics(id) ON DELETE CASCADE;
ALTER TABLE logic_stops ADD COLUMN IF NOT EXISTS rule_kind VARCHAR(20) CHECK (rule_kind IN ('stop_loss', 'take_profit'));
ALTER TABLE logic_stops ADD COLUMN IF NOT EXISTS scope_type VARCHAR(40);
ALTER TABLE logic_stops ADD COLUMN IF NOT EXISTS value NUMERIC(18, 6) CHECK (value > 0);
ALTER TABLE logic_stops ADD COLUMN IF NOT EXISTS value_unit VARCHAR(10) CHECK (value_unit IN ('percent', 'atr'));
ALTER TABLE logic_stops ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE logic_stops ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE logic_stops ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.




CREATE INDEX IF NOT EXISTS idx_logic_stops_logic_id ON logic_stops(logic_id);
CREATE INDEX IF NOT EXISTS idx_logic_stops_rule_kind ON logic_stops(logic_id, rule_kind);

COMMENT ON TABLE logic_stops IS
'Стоп-лосс и тейк-профит для logics: security (по бумаге) или portfolio (портфель логики)';
COMMENT ON COLUMN logic_stops.rule_kind IS 'stop_loss | take_profit';
COMMENT ON COLUMN logic_stops.scope_type IS
'stop_loss: security|security_resume|security_inversion|portfolio|portfolio_resume; take_profit: security|portfolio|portfolio_ltp_renew';

-- v48: portfolio_ltp_renew (replaces security_ltp_renew)
ALTER TABLE logic_stops ALTER COLUMN scope_type TYPE VARCHAR(40);
ALTER TABLE logic_stops DROP CONSTRAINT IF EXISTS logic_stops_scope_type_check;
DO $mlt$
BEGIN
    ALTER TABLE logic_stops ADD CONSTRAINT logic_stops_scope_type_check
        CHECK (scope_type IN (
            'security', 'security_resume', 'security_inversion', 'portfolio', 'portfolio_resume',
            'portfolio_ltp_renew', 'security_ltp_renew'
        ));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $mlt$;

UPDATE logic_stops
SET scope_type = 'portfolio_ltp_renew'
WHERE scope_type = 'security_ltp_renew';

UPDATE logic_stops
SET scope_type = 'security'
WHERE rule_kind = 'take_profit'
  AND scope_type IN ('security_resume', 'security_inversion', 'portfolio_resume');

DO $mlt$
BEGIN
    ALTER TABLE logic_stops DROP CONSTRAINT IF EXISTS logic_stops_tp_scope_check;
    ALTER TABLE logic_stops ADD CONSTRAINT logic_stops_tp_scope_check
        CHECK (
            rule_kind = 'stop_loss'
            OR scope_type IN ('security', 'portfolio', 'portfolio_ltp_renew')
        );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $mlt$;

-- Drop legacy name from scope check after migrate
ALTER TABLE logic_stops DROP CONSTRAINT IF EXISTS logic_stops_scope_type_check;
DO $mlt$
BEGIN
    ALTER TABLE logic_stops ADD CONSTRAINT logic_stops_scope_type_check
        CHECK (scope_type IN (
            'security', 'security_resume', 'security_inversion', 'portfolio', 'portfolio_resume',
            'portfolio_ltp_renew'
        ));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $mlt$;

COMMENT ON COLUMN logic_stops.value_unit IS 'percent | atr';

-- Неторговые интервалы логики (MSK): сделки в эти окна не открываются при use_non_trading_periods
CREATE TABLE IF NOT EXISTS logic_non_trading_intervals (
    id SERIAL PRIMARY KEY,
    logic_id INTEGER NOT NULL REFERENCES logics(id) ON DELETE CASCADE,
    day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
    time_from TIME NOT NULL,
    time_to TIME NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    display_order INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (time_from <= time_to)
);
ALTER TABLE logic_non_trading_intervals ADD COLUMN IF NOT EXISTS logic_id INTEGER REFERENCES logics(id) ON DELETE CASCADE;
ALTER TABLE logic_non_trading_intervals ADD COLUMN IF NOT EXISTS day_of_week SMALLINT;
ALTER TABLE logic_non_trading_intervals ADD COLUMN IF NOT EXISTS time_from TIME;
ALTER TABLE logic_non_trading_intervals ADD COLUMN IF NOT EXISTS time_to TIME;
ALTER TABLE logic_non_trading_intervals ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE logic_non_trading_intervals ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE logic_non_trading_intervals ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE logic_non_trading_intervals ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_logic_non_trading_logic_id
    ON logic_non_trading_intervals(logic_id);

COMMENT ON TABLE logic_non_trading_intervals IS
'Неторговые окна логики (день недели ISO 1=Пн…7=Вс + интервал времени MSK)';
COMMENT ON COLUMN logic_non_trading_intervals.day_of_week IS '1=понедельник … 7=воскресенье (ISO)';

-- Ценные бумаги, привязанные к торговой логике (портфель логики)
CREATE TABLE IF NOT EXISTS logic_securities (
    id SERIAL PRIMARY KEY,
    logic_id INTEGER NOT NULL REFERENCES logics(id) ON DELETE CASCADE,
    security_id INTEGER NOT NULL REFERENCES securities(id) ON DELETE RESTRICT,
    display_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    real_trading_paused BOOLEAN NOT NULL DEFAULT FALSE,
    real_trading_paused_long BOOLEAN NOT NULL DEFAULT FALSE,
    real_trading_paused_short BOOLEAN NOT NULL DEFAULT FALSE,
    real_trading_inverted BOOLEAN NOT NULL DEFAULT FALSE,
    stop_resume_equity NUMERIC(20, 6),
    stop_resume_baseline NUMERIC(20, 6),
    stop_resume_triggered_at TIMESTAMP,
    stop_resume_equity_long NUMERIC(20, 6),
    stop_resume_baseline_long NUMERIC(20, 6),
    stop_resume_triggered_at_long TIMESTAMP,
    stop_resume_equity_short NUMERIC(20, 6),
    stop_resume_baseline_short NUMERIC(20, 6),
    stop_resume_triggered_at_short TIMESTAMP,
    linear_tp_armed BOOLEAN NOT NULL DEFAULT FALSE,
    linear_tp_last_price NUMERIC(18, 6),
    linear_tp_arm_bar_dt TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (logic_id, security_id)
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE logic_securities ADD COLUMN IF NOT EXISTS logic_id INTEGER REFERENCES logics(id) ON DELETE CASCADE;
ALTER TABLE logic_securities ADD COLUMN IF NOT EXISTS security_id INTEGER REFERENCES securities(id) ON DELETE RESTRICT;
ALTER TABLE logic_securities ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE logic_securities ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE logic_securities ADD COLUMN IF NOT EXISTS real_trading_paused BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE logic_securities ADD COLUMN IF NOT EXISTS real_trading_paused_long BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE logic_securities ADD COLUMN IF NOT EXISTS real_trading_paused_short BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE logic_securities ADD COLUMN IF NOT EXISTS real_trading_inverted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE logic_securities ADD COLUMN IF NOT EXISTS stop_resume_equity NUMERIC(20, 6);
ALTER TABLE logic_securities ADD COLUMN IF NOT EXISTS stop_resume_baseline NUMERIC(20, 6);
ALTER TABLE logic_securities ADD COLUMN IF NOT EXISTS stop_resume_triggered_at TIMESTAMP;
ALTER TABLE logic_securities ADD COLUMN IF NOT EXISTS stop_resume_equity_long NUMERIC(20, 6);
ALTER TABLE logic_securities ADD COLUMN IF NOT EXISTS stop_resume_baseline_long NUMERIC(20, 6);
ALTER TABLE logic_securities ADD COLUMN IF NOT EXISTS stop_resume_triggered_at_long TIMESTAMP;
ALTER TABLE logic_securities ADD COLUMN IF NOT EXISTS stop_resume_equity_short NUMERIC(20, 6);
ALTER TABLE logic_securities ADD COLUMN IF NOT EXISTS stop_resume_baseline_short NUMERIC(20, 6);
ALTER TABLE logic_securities ADD COLUMN IF NOT EXISTS stop_resume_triggered_at_short TIMESTAMP;
ALTER TABLE logic_securities ADD COLUMN IF NOT EXISTS linear_tp_armed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE logic_securities ADD COLUMN IF NOT EXISTS linear_tp_last_price NUMERIC(18, 6);
ALTER TABLE logic_securities ADD COLUMN IF NOT EXISTS linear_tp_arm_bar_dt TIMESTAMP;
ALTER TABLE logic_securities ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- v48: migrate paper-level security_resume pause → both sides (once)
UPDATE logic_securities
SET
    real_trading_paused_long = TRUE,
    real_trading_paused_short = TRUE,
    stop_resume_equity_long = COALESCE(stop_resume_equity_long, stop_resume_equity),
    stop_resume_baseline_long = COALESCE(stop_resume_baseline_long, stop_resume_baseline),
    stop_resume_triggered_at_long = COALESCE(stop_resume_triggered_at_long, stop_resume_triggered_at),
    stop_resume_equity_short = COALESCE(stop_resume_equity_short, stop_resume_equity),
    stop_resume_baseline_short = COALESCE(stop_resume_baseline_short, stop_resume_baseline),
    stop_resume_triggered_at_short = COALESCE(stop_resume_triggered_at_short, stop_resume_triggered_at)
WHERE COALESCE(real_trading_paused, FALSE)
  AND NOT COALESCE(real_trading_paused_long, FALSE)
  AND NOT COALESCE(real_trading_paused_short, FALSE);

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.




CREATE INDEX IF NOT EXISTS idx_logic_securities_logic_id ON logic_securities(logic_id);
CREATE INDEX IF NOT EXISTS idx_logic_securities_security_id ON logic_securities(security_id);

COMMENT ON TABLE logic_securities IS
'Портфель ценных бумаг торговой логики: одна строка — одна бумага в logics';
COMMENT ON COLUMN logic_securities.display_order IS 'Порядок отображения в UI';
COMMENT ON COLUMN logic_securities.real_trading_paused IS
'TRUE если пауза long и/или short (OR); теневой режим security_resume по сторонам — см. *_long/*_short';
COMMENT ON COLUMN logic_securities.real_trading_paused_long IS
'TRUE — реальная торговля Long по бумаге в тени после security_resume (Short может оставаться боевой)';
COMMENT ON COLUMN logic_securities.real_trading_paused_short IS
'TRUE — реальная торговля Short по бумаге в тени после security_resume (Long может оставаться боевой)';
COMMENT ON COLUMN logic_securities.real_trading_inverted IS
'TRUE — по этой бумаге включена локальная инверсия логики после security_inversion SL';
COMMENT ON COLUMN logic_securities.stop_resume_equity IS
'Устарело: цель resume по бумаге целиком; актуальные — stop_resume_equity_long/short';
COMMENT ON COLUMN logic_securities.stop_resume_baseline IS
'Устарело: база resume по бумаге; актуальные — stop_resume_baseline_long/short';
COMMENT ON COLUMN logic_securities.stop_resume_equity_long IS
'Цель возобновления реальной Long-торговли (track до SL по стороне)';
COMMENT ON COLUMN logic_securities.stop_resume_baseline_long IS
'Track Long сразу после SL (база для теневого восстановления)';
COMMENT ON COLUMN logic_securities.stop_resume_equity_short IS
'Цель возобновления реальной Short-торговли (track до SL по стороне)';
COMMENT ON COLUMN logic_securities.stop_resume_baseline_short IS
'Track Short сразу после SL (база для теневого восстановления)';
COMMENT ON COLUMN logic_securities.linear_tp_armed IS
'TRUE — линейный TP (security_ltp_renew) взведён: ждём снижения цены для продажи';
COMMENT ON COLUMN logic_securities.linear_tp_last_price IS
'Цена закрытия бара при взведении / последняя цена пока TP взведён (для детекта падения)';
COMMENT ON COLUMN logic_securities.linear_tp_arm_bar_dt IS
'Бар, на котором взвели линейный TP';


-- Демо (v40b): follow/breakout — SMA + подтверждение BB/STOCH на OPEN; CLOSE только по SMA
-- (mean-reversion BB/STOCH вместе с SMA в AND почти никогда не срабатывает)
-- Демо-сигналы: не удаляем при upgrade; вставка только если сигналов ещё нет

INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    -- Open long (AND follow): выше SMA + пробой верхней BB + импульс STOCH
    ('SMA',   'open',  'long',  'trend',   '@SMA(period=20,series=VALUE) pp > VALUE', 0),
    ('BB',    'open',  'long',  'trend',   '@BB(period=20,series=UPPER) pp > VALUE', 1),
    ('STOCH', 'open',  'long',  'trend',   '@STOCH(series=K) VALUE > 50', 2),
    -- Close long: только потеря тренда по SMA (без жёсткого AND по коридору)
    ('SMA',   'close', 'long',  'counter', '@SMA(period=20,series=VALUE) pp < VALUE', 3),
    -- Open short (AND follow): ниже SMA + пробой нижней BB + слабый STOCH
    ('SMA',   'open',  'short', 'trend',   '@SMA(period=20,series=VALUE) pp < VALUE', 4),
    ('BB',    'open',  'short', 'trend',   '@BB(period=20,series=LOWER) pp < VALUE', 5),
    ('STOCH', 'open',  'short', 'trend',   '@STOCH(series=K) VALUE < 50', 6),
    -- Close short: только SMA
    ('SMA',   'close', 'short', 'counter', '@SMA(period=20,series=VALUE) pp > VALUE', 7)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'SMA Price Cross Demo'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id)
ON CONFLICT (logic_id, indicator_id, position_event, position_side, signal_kind) DO NOTHING;

-- Все акции (stock) в портфель демо-логики (без дублей при нескольких prefix)
INSERT INTO logic_securities (logic_id, security_id, display_order)
SELECT l.id, q.security_id, ROW_NUMBER() OVER (ORDER BY q.sort_key) - 1
FROM logics l
CROSS JOIN LATERAL (
    SELECT DISTINCT ON (s.id)
        s.id AS security_id,
        COALESCE(sp.prefix, s.name) AS sort_key
    FROM securities s
    JOIN security_prefixes sp ON sp.security_id = s.id AND sp.instrument_market = 'stock'
    ORDER BY s.id, sp.prefix
) q
WHERE l.name = 'SMA Price Cross Demo'
ON CONFLICT (logic_id, security_id) DO NOTHING;

-- Стоп-лосс 1% security_resume; тейк 5% portfolio_ltp_renew (линейный TP с renew)
-- Демо-стопы: insert only if empty

INSERT INTO logic_stops (logic_id, rule_kind, scope_type, value, value_unit, display_order, is_active)
SELECT l.id, v.rule_kind, v.scope_type, v.value, v.value_unit, v.display_order, TRUE
FROM logics l
CROSS JOIN (VALUES
    ('stop_loss',   'security_resume', 1.0, 'percent', 0),
    ('take_profit', 'portfolio_ltp_renew', 5.0, 'percent', 1)
) AS v(rule_kind, scope_type, value, value_unit, display_order)
WHERE l.name = 'SMA Price Cross Demo'
  AND NOT EXISTS (SELECT 1 FROM logic_stops z WHERE z.logic_id = l.id);

-- =====================================================================
-- v41: классические стратегии (по мотивам OsEngine Robots / Custom)
-- Демо «SMA Price Cross Demo» выше не трогаем.
-- Все на FAKE-EFF-001, выключены, все акции, SL 1% security_resume / TP 5% portfolio_ltp_renew.
-- =====================================================================

INSERT INTO logics (name, account_id, is_enabled)
SELECT v.name, a.id, FALSE
FROM accounts a
JOIN brokers b ON b.id = a.broker_id
CROSS JOIN (VALUES
    ('RSI Mean Reversion'),
    ('Bollinger Bounce'),
    ('Bollinger Breakout'),
    ('MACD Zero Line'),
    ('Stochastic Levels'),
    ('EMA Price Cross'),
    ('Dual MA Trend'),
    ('SMA Stoch Pullback'),
    ('BB Stoch Bounce'),
    ('SMAT3 Trend')
) AS v(name)
WHERE b.code = 'T-BANK' AND a.account_code = 'FAKE-EFF-001'
ON CONFLICT (name) DO NOTHING;

-- Параметры как у демо (перекрывают пустые default_value из logic_param_defs)
INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
SELECT l.id, v.param_key, v.param_value, v.value_type
FROM logics l
CROSS JOIN (VALUES
    ('timeframe', 'M15', 'text'),
    ('position_size_pct', '10', 'number'),
    ('max_open_positions', '3', 'integer'),
    ('initial_balance', '1000000', 'money'),
    ('current_balance', '1000000', 'money'),
    ('commission_pct', '0.03', 'number'),
    ('cost_method', 'FIFO', 'text'),
    ('stop_loss_timeframe', 'M5', 'text'),
    ('base_annual_rate_pct', '20', 'number'),
    ('rating_lookback_days', '7', 'integer')
) AS v(param_key, param_value, value_type)
WHERE l.name IN (
    'RSI Mean Reversion', 'Bollinger Bounce', 'Bollinger Breakout', 'MACD Zero Line',
    'Stochastic Levels', 'EMA Price Cross', 'Dual MA Trend', 'SMA Stoch Pullback',
    'BB Stoch Bounce', 'SMAT3 Trend'
)
ON CONFLICT (logic_id, param_key) DO NOTHING;

-- Дозаполнение любых отсутствующих ключей из справочника
INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
SELECT l.id, d.param_key, d.default_value, d.value_type
FROM logics l
CROSS JOIN logic_param_defs d
WHERE l.name IN (
    'RSI Mean Reversion', 'Bollinger Bounce', 'Bollinger Breakout', 'MACD Zero Line',
    'Stochastic Levels', 'EMA Price Cross', 'Dual MA Trend', 'SMA Stoch Pullback',
    'BB Stoch Bounce', 'SMAT3 Trend'
)
ON CONFLICT (logic_id, param_key) DO NOTHING;

-- Сигналы seed: только если у логики ещё нет сигналов (не затираем копии и правки)

-- RSI Mean Reversion (OsEngine RsiTrade)
INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('RSI', 'open',  'long',  'counter', '@RSI(period=14,series=VALUE) VALUE < 30', 0),
    ('RSI', 'close', 'long',  'trend',   '@RSI(period=14,series=VALUE) VALUE > 50', 1),
    ('RSI', 'open',  'short', 'counter', '@RSI(period=14,series=VALUE) VALUE > 70', 2),
    ('RSI', 'close', 'short', 'trend',   '@RSI(period=14,series=VALUE) VALUE < 50', 3)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'RSI Mean Reversion'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

-- Bollinger Bounce (OsEngine StrategyBollinger)
INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('BB',  'open',  'long',  'counter', '@BB(period=20,series=LOWER) pp < VALUE', 0),
    ('BB',  'close', 'long',  'trend',   '@BB(period=20,series=MIDDLE) pp > VALUE', 1),
    ('BB',  'open',  'short', 'counter', '@BB(period=20,series=UPPER) pp > VALUE', 2),
    ('BB',  'close', 'short', 'trend',   '@BB(period=20,series=MIDDLE) pp < VALUE', 3)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'Bollinger Bounce'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

-- Bollinger Breakout (OsEngine BollingerRevers)
INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('BB',  'open',  'long',  'trend',   '@BB(period=20,series=UPPER) pp > VALUE', 0),
    ('BB',  'close', 'long',  'counter', '@BB(period=20,series=MIDDLE) pp < VALUE', 1),
    ('BB',  'open',  'short', 'trend',   '@BB(period=20,series=LOWER) pp < VALUE', 2),
    ('BB',  'close', 'short', 'counter', '@BB(period=20,series=MIDDLE) pp > VALUE', 3)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'Bollinger Breakout'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

-- MACD Zero Line (OsEngine MacdRevers упрощённо: пересечение нуля)
INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('MACD', 'open',  'long',  'trend',   '@MACD(series=MACD) VALUE > 0', 0),
    ('MACD', 'close', 'long',  'counter', '@MACD(series=MACD) VALUE < 0', 1),
    ('MACD', 'open',  'short', 'trend',   '@MACD(series=MACD) VALUE < 0', 2),
    ('MACD', 'close', 'short', 'counter', '@MACD(series=MACD) VALUE > 0', 3)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'MACD Zero Line'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

-- Stochastic Levels (контртренд по уровням, как RsiTrade для Stoch)
INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('STOCH', 'open',  'long',  'counter', '@STOCH(series=K) VALUE < 20', 0),
    ('STOCH', 'close', 'long',  'trend',   '@STOCH(series=K) VALUE > 50', 1),
    ('STOCH', 'open',  'short', 'counter', '@STOCH(series=K) VALUE > 80', 2),
    ('STOCH', 'close', 'short', 'trend',   '@STOCH(series=K) VALUE < 50', 3)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'Stochastic Levels'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

-- EMA Price Cross (OsEngine SmaTrendSample на EMA)
INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('EMA', 'open',  'long',  'trend',   '@EMA(period=20,series=VALUE) pp > VALUE', 0),
    ('EMA', 'close', 'long',  'counter', '@EMA(period=20,series=VALUE) pp < VALUE', 1),
    ('EMA', 'open',  'short', 'trend',   '@EMA(period=20,series=VALUE) pp < VALUE', 2),
    ('EMA', 'close', 'short', 'counter', '@EMA(period=20,series=VALUE) pp > VALUE', 3)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'EMA Price Cross'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

-- Dual MA Trend (SMA+EMA как в SmaWithAShift: фильтр «цена выше/ниже обеих»)
INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('SMA', 'open',  'long',  'trend',   '@SMA(period=20,series=VALUE) pp > VALUE', 0),
    ('EMA', 'open',  'long',  'trend',   '@EMA(period=50,series=VALUE) pp > VALUE', 1),
    ('SMA', 'close', 'long',  'counter', '@SMA(period=20,series=VALUE) pp < VALUE', 2),
    ('SMA', 'open',  'short', 'trend',   '@SMA(period=20,series=VALUE) pp < VALUE', 3),
    ('EMA', 'open',  'short', 'trend',   '@EMA(period=50,series=VALUE) pp < VALUE', 4),
    ('SMA', 'close', 'short', 'counter', '@SMA(period=20,series=VALUE) pp > VALUE', 5)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'Dual MA Trend'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

-- SMA Stoch Pullback (OsEngine SmaStochastic: тренд SMA + откат Stoch)
INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('SMA',   'open',  'long',  'trend',   '@SMA(period=20,series=VALUE) pp > VALUE', 0),
    ('STOCH', 'open',  'long',  'counter', '@STOCH(series=K) VALUE < 30', 1),
    ('SMA',   'close', 'long',  'counter', '@SMA(period=20,series=VALUE) pp < VALUE', 2),
    ('SMA',   'open',  'short', 'trend',   '@SMA(period=20,series=VALUE) pp < VALUE', 3),
    ('STOCH', 'open',  'short', 'counter', '@STOCH(series=K) VALUE > 70', 4),
    ('SMA',   'close', 'short', 'counter', '@SMA(period=20,series=VALUE) pp > VALUE', 5)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'SMA Stoch Pullback'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

-- BB Stoch Bounce (OsEngine StrategyBollingerAndStochastic)
INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('BB',    'open',  'long',  'counter', '@BB(period=20,series=LOWER) pp < VALUE', 0),
    ('STOCH', 'open',  'long',  'counter', '@STOCH(series=K) VALUE < 20', 1),
    ('BB',    'close', 'long',  'trend',   '@BB(period=20,series=MIDDLE) pp > VALUE', 2),
    ('BB',    'open',  'short', 'counter', '@BB(period=20,series=UPPER) pp > VALUE', 3),
    ('STOCH', 'open',  'short', 'counter', '@STOCH(series=K) VALUE > 80', 4),
    ('BB',    'close', 'short', 'trend',   '@BB(period=20,series=MIDDLE) pp < VALUE', 5)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'BB Stoch Bounce'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

-- SMAT3 Trend (тройное SMA как сглаженный тренд)
INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('SMAT3', 'open',  'long',  'trend',   '@SMAT3(series=VALUE) pp > VALUE', 0),
    ('SMAT3', 'close', 'long',  'counter', '@SMAT3(series=VALUE) pp < VALUE', 1),
    ('SMAT3', 'open',  'short', 'trend',   '@SMAT3(series=VALUE) pp < VALUE', 2),
    ('SMAT3', 'close', 'short', 'counter', '@SMAT3(series=VALUE) pp > VALUE', 3)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'SMAT3 Trend'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

-- Все акции во все seed-логики (включая уже существующие строки)
INSERT INTO logic_securities (logic_id, security_id, display_order)
SELECT l.id, q.security_id, ROW_NUMBER() OVER (PARTITION BY l.id ORDER BY q.sort_key) - 1
FROM logics l
CROSS JOIN LATERAL (
    SELECT DISTINCT ON (s.id)
        s.id AS security_id,
        COALESCE(sp.prefix, s.name) AS sort_key
    FROM securities s
    JOIN security_prefixes sp ON sp.security_id = s.id AND sp.instrument_market = 'stock'
    ORDER BY s.id, sp.prefix
) q
WHERE l.name IN (
    'RSI Mean Reversion', 'Bollinger Bounce', 'Bollinger Breakout', 'MACD Zero Line',
    'Stochastic Levels', 'EMA Price Cross', 'Dual MA Trend', 'SMA Stoch Pullback',
    'BB Stoch Bounce', 'SMAT3 Trend'
)
ON CONFLICT (logic_id, security_id) DO NOTHING;

-- SL/TP как у демо
-- Стопы seed: insert only if empty

INSERT INTO logic_stops (logic_id, rule_kind, scope_type, value, value_unit, display_order, is_active)
SELECT l.id, v.rule_kind, v.scope_type, v.value, v.value_unit, v.display_order, TRUE
FROM logics l
CROSS JOIN (VALUES
    ('stop_loss',   'security_resume', 1.0, 'percent', 0),
    ('take_profit', 'portfolio_ltp_renew', 5.0, 'percent', 1)
) AS v(rule_kind, scope_type, value, value_unit, display_order)
WHERE l.name IN (
    'RSI Mean Reversion', 'Bollinger Bounce', 'Bollinger Breakout', 'MACD Zero Line',
    'Stochastic Levels', 'EMA Price Cross', 'Dual MA Trend', 'SMA Stoch Pullback',
    'BB Stoch Bounce', 'SMAT3 Trend'
)
  AND NOT EXISTS (SELECT 1 FROM logic_stops z WHERE z.logic_id = l.id);

-- =====================================================================
-- v43: L1–L4 из MultiLogicTradeA (FINRESP) — AND-сигналы, без Strict/Regime/OnFlip
-- Адаптация: SMA100, LINREG±2σ, ATR GROWTH5≥3, ADX TrOk/WkOk, CCI, MACD HISTOGRAM
-- =====================================================================

INSERT INTO logics (name, account_id, is_enabled)
SELECT v.name, a.id, FALSE
FROM accounts a
JOIN brokers b ON b.id = a.broker_id
CROSS JOIN (VALUES
    ('L1 — лонг, тренд'),
    ('L2 — лонг, боковик'),
    ('L3 — шорт, тренд'),
    ('L4 — шорт, боковик')
) AS v(name)
WHERE b.code = 'T-BANK' AND a.account_code = 'FAKE-EFF-001'
ON CONFLICT (name) DO NOTHING;

INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
SELECT l.id, v.param_key, v.param_value, v.value_type
FROM logics l
CROSS JOIN (VALUES
    ('timeframe', 'M15', 'text'),
    ('position_size_pct', '10', 'number'),
    ('max_open_positions', '3', 'integer'),
    ('initial_balance', '1000000', 'money'),
    ('current_balance', '1000000', 'money'),
    ('commission_pct', '0.03', 'number'),
    ('cost_method', 'FIFO', 'text'),
    ('stop_loss_timeframe', 'M5', 'text'),
    ('base_annual_rate_pct', '20', 'number'),
    ('rating_lookback_days', '7', 'integer')
) AS v(param_key, param_value, value_type)
WHERE l.name IN (
    'L1 — лонг, тренд', 'L2 — лонг, боковик', 'L3 — шорт, тренд', 'L4 — шорт, боковик'
)
ON CONFLICT (logic_id, param_key) DO NOTHING;

INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
SELECT l.id, d.param_key, d.default_value, d.value_type
FROM logics l
CROSS JOIN logic_param_defs d
WHERE l.name IN (
    'L1 — лонг, тренд', 'L2 — лонг, боковик', 'L3 — шорт, тренд', 'L4 — шорт, боковик'
)
ON CONFLICT (logic_id, param_key) DO NOTHING;

-- Сигналы seed: insert only if empty (см. AND NOT EXISTS ниже)

-- L1 long trend: Op SMA Ab + LinReg AbUp + ATR GrOk + ADX TrOk + CCI>=100 + MACD>Sig
INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('SMA',    'open',  'long', 'trend',   '@SMA(period=100,series=VALUE) pp > VALUE', 0),
    ('LINREG', 'open',  'long', 'trend',   '@LINREG(period=20,std_dev=2,series=UPPER) pp > VALUE', 1),
    ('ATR',    'open',  'long', 'trend',   '@ATR(period=14,series=GROWTH5) VALUE >= 3', 2),
    ('ADX',    'open',  'long', 'trend',   '@ADX(period=14,series=ADX) VALUE >= 25', 3),
    ('CCI',    'open',  'long', 'trend',   '@CCI(period=20,series=VALUE) VALUE >= 100', 4),
    ('MACD',   'open',  'long', 'trend',   '@MACD(fast_period=12,slow_period=26,signal_period=9,series=HISTOGRAM) VALUE > 0', 5),
    ('SMA',    'close', 'long', 'counter', '@SMA(period=100,series=VALUE) pp < VALUE', 6),
    ('LINREG', 'close', 'long', 'counter', '@LINREG(period=20,std_dev=2,series=LOWER) pp < VALUE', 7),
    ('CCI',    'close', 'long', 'counter', '@CCI(period=20,series=VALUE) VALUE <= -100', 8),
    ('MACD',   'close', 'long', 'counter', '@MACD(fast_period=12,slow_period=26,signal_period=9,series=HISTOGRAM) VALUE < 0', 9)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'L1 — лонг, тренд'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

-- L2 long flat: Stoch oversold + ADX weak + ATR growth + SMA Ab + MACD
INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('SMA',   'open',  'long', 'trend',   '@SMA(period=100,series=VALUE) pp > VALUE', 0),
    ('STOCH', 'open',  'long', 'counter', '@STOCH(k_period=14,d_period=3,smooth=3,series=K) VALUE <= 10', 1),
    ('ATR',   'open',  'long', 'trend',   '@ATR(period=14,series=GROWTH5) VALUE >= 3', 2),
    ('ADX',   'open',  'long', 'counter', '@ADX(period=14,series=ADX) VALUE < 25', 3),
    ('MACD',  'open',  'long', 'trend',   '@MACD(fast_period=12,slow_period=26,signal_period=9,series=HISTOGRAM) VALUE > 0', 4),
    ('SMA',   'close', 'long', 'counter', '@SMA(period=100,series=VALUE) pp < VALUE', 5),
    ('STOCH', 'close', 'long', 'trend',   '@STOCH(k_period=14,d_period=3,smooth=3,series=K) VALUE >= 90', 6),
    ('MACD',  'close', 'long', 'counter', '@MACD(fast_period=12,slow_period=26,signal_period=9,series=HISTOGRAM) VALUE < 0', 7)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'L2 — лонг, боковик'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

-- L3 short trend
INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('SMA',    'open',  'short', 'trend',   '@SMA(period=100,series=VALUE) pp < VALUE', 0),
    ('LINREG', 'open',  'short', 'trend',   '@LINREG(period=20,std_dev=2,series=LOWER) pp < VALUE', 1),
    ('ATR',    'open',  'short', 'trend',   '@ATR(period=14,series=GROWTH5) VALUE >= 3', 2),
    ('ADX',    'open',  'short', 'trend',   '@ADX(period=14,series=ADX) VALUE >= 25', 3),
    ('CCI',    'open',  'short', 'trend',   '@CCI(period=20,series=VALUE) VALUE <= -100', 4),
    ('MACD',   'open',  'short', 'trend',   '@MACD(fast_period=12,slow_period=26,signal_period=9,series=HISTOGRAM) VALUE < 0', 5),
    ('SMA',    'close', 'short', 'counter', '@SMA(period=100,series=VALUE) pp > VALUE', 6),
    ('LINREG', 'close', 'short', 'counter', '@LINREG(period=20,std_dev=2,series=UPPER) pp > VALUE', 7),
    ('CCI',    'close', 'short', 'counter', '@CCI(period=20,series=VALUE) VALUE >= 100', 8),
    ('MACD',   'close', 'short', 'counter', '@MACD(fast_period=12,slow_period=26,signal_period=9,series=HISTOGRAM) VALUE > 0', 9)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'L3 — шорт, тренд'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

-- L4 short flat
INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('SMA',   'open',  'short', 'trend',   '@SMA(period=100,series=VALUE) pp < VALUE', 0),
    ('STOCH', 'open',  'short', 'counter', '@STOCH(k_period=14,d_period=3,smooth=3,series=K) VALUE >= 90', 1),
    ('ATR',   'open',  'short', 'trend',   '@ATR(period=14,series=GROWTH5) VALUE >= 3', 2),
    ('ADX',   'open',  'short', 'counter', '@ADX(period=14,series=ADX) VALUE < 25', 3),
    ('MACD',  'open',  'short', 'trend',   '@MACD(fast_period=12,slow_period=26,signal_period=9,series=HISTOGRAM) VALUE < 0', 4),
    ('SMA',   'close', 'short', 'counter', '@SMA(period=100,series=VALUE) pp > VALUE', 5),
    ('STOCH', 'close', 'short', 'trend',   '@STOCH(k_period=14,d_period=3,smooth=3,series=K) VALUE <= 10', 6),
    ('MACD',  'close', 'short', 'counter', '@MACD(fast_period=12,slow_period=26,signal_period=9,series=HISTOGRAM) VALUE > 0', 7)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'L4 — шорт, боковик'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

INSERT INTO logic_securities (logic_id, security_id, display_order)
SELECT l.id, q.security_id, ROW_NUMBER() OVER (PARTITION BY l.id ORDER BY q.sort_key) - 1
FROM logics l
CROSS JOIN LATERAL (
    SELECT DISTINCT ON (s.id)
        s.id AS security_id,
        COALESCE(sp.prefix, s.name) AS sort_key
    FROM securities s
    JOIN security_prefixes sp ON sp.security_id = s.id AND sp.instrument_market = 'stock'
    ORDER BY s.id, sp.prefix
) q
WHERE l.name IN (
    'L1 — лонг, тренд', 'L2 — лонг, боковик', 'L3 — шорт, тренд', 'L4 — шорт, боковик'
)
ON CONFLICT (logic_id, security_id) DO NOTHING;

-- Стопы seed: insert only if empty

INSERT INTO logic_stops (logic_id, rule_kind, scope_type, value, value_unit, display_order, is_active)
SELECT l.id, v.rule_kind, v.scope_type, v.value, v.value_unit, v.display_order, TRUE
FROM logics l
CROSS JOIN (VALUES
    ('stop_loss',   'security_resume', 1.0, 'percent', 0),
    ('take_profit', 'portfolio_ltp_renew', 5.0, 'percent', 1)
) AS v(rule_kind, scope_type, value, value_unit, display_order)
WHERE l.name IN (
    'L1 — лонг, тренд', 'L2 — лонг, боковик', 'L3 — шорт, тренд', 'L4 — шорт, боковик'
)
  AND NOT EXISTS (SELECT 1 FROM logic_stops z WHERE z.logic_id = l.id);

-- =====================================================================
-- v44: ещё 5 контртрендовых стратегий (OsEngine-style)
-- FAKE, выключены, все акции, SL 1% security_resume / TP 5% portfolio_ltp_renew.
-- =====================================================================

INSERT INTO logics (name, account_id, is_enabled, note)
SELECT v.name, a.id, FALSE, v.note
FROM accounts a
JOIN brokers b ON b.id = a.broker_id
CROSS JOIN (VALUES
    (
        'CCI Countertrade',
        'Контртрендовая. По мотивам OsEngine CciTrade: long при CCI ≤ −100, short при CCI ≥ +100; выход к нулевой зоне.'
    ),
    (
        'LinReg Fade',
        'Контртрендовая. OsEngine-style fade по каналу LinReg: отскок от нижней/верхней границы к середине канала.'
    ),
    (
        'Square Fade',
        'Контртрендовая. Как LinReg Fade, но канал SQUARE (квадратичная регрессия b+a·x+c·x²): отскок от границ к середине.'
    ),
    (
        'ADX Range RSI',
        'Контртрендовая (боковик). Слабый тренд ADX < 25 + перепроданность/перекупленность RSI — OsEngine range-trading.'
    ),
    (
        'MACD Hist Fade',
        'Контртрендовая. OsEngine MacdRevers (упрощ.): вход против импульса гистограммы MACD, выход при смене знака HISTOGRAM.'
    ),
    (
        'ATR Spike Reversal',
        'Контртрендовая. Всплеск волатильности ATR GROWTH5 ≥ 3 + экстремум RSI — откат после импульса (OsEngine-style fade).'
    )
) AS v(name, note)
WHERE b.code = 'T-BANK' AND a.account_code = 'FAKE-EFF-001'
ON CONFLICT (name) DO NOTHING;

INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
SELECT l.id, v.param_key, v.param_value, v.value_type
FROM logics l
CROSS JOIN (VALUES
    ('timeframe', 'M15', 'text'),
    ('position_size_pct', '10', 'number'),
    ('max_open_positions', '3', 'integer'),
    ('initial_balance', '1000000', 'money'),
    ('current_balance', '1000000', 'money'),
    ('commission_pct', '0.03', 'number'),
    ('cost_method', 'FIFO', 'text'),
    ('stop_loss_timeframe', 'M5', 'text'),
    ('base_annual_rate_pct', '20', 'number'),
    ('rating_lookback_days', '7', 'integer')
) AS v(param_key, param_value, value_type)
WHERE l.name IN (
    'CCI Countertrade', 'LinReg Fade', 'Square Fade', 'ADX Range RSI', 'MACD Hist Fade', 'ATR Spike Reversal'
)
ON CONFLICT (logic_id, param_key) DO NOTHING;

INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
SELECT l.id, d.param_key, d.default_value, d.value_type
FROM logics l
CROSS JOIN logic_param_defs d
WHERE l.name IN (
    'CCI Countertrade', 'LinReg Fade', 'Square Fade', 'ADX Range RSI', 'MACD Hist Fade', 'ATR Spike Reversal'
)
ON CONFLICT (logic_id, param_key) DO NOTHING;

-- Сигналы seed: insert only if empty (см. AND NOT EXISTS ниже)

INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('CCI', 'open',  'long',  'counter', '@CCI(period=20,series=VALUE) VALUE <= -100', 0),
    ('CCI', 'close', 'long',  'trend',   '@CCI(period=20,series=VALUE) VALUE >= 0', 1),
    ('CCI', 'open',  'short', 'counter', '@CCI(period=20,series=VALUE) VALUE >= 100', 2),
    ('CCI', 'close', 'short', 'trend',   '@CCI(period=20,series=VALUE) VALUE <= 0', 3)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'CCI Countertrade'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('LINREG', 'open',  'long',  'counter', '@LINREG(period=20,std_dev=2,series=LOWER) pp <= VALUE', 0),
    ('LINREG', 'close', 'long',  'trend',   '@LINREG(period=20,std_dev=2,series=MIDDLE) pp >= VALUE', 1),
    ('LINREG', 'open',  'short', 'counter', '@LINREG(period=20,std_dev=2,series=UPPER) pp >= VALUE', 2),
    ('LINREG', 'close', 'short', 'trend',   '@LINREG(period=20,std_dev=2,series=MIDDLE) pp <= VALUE', 3)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'LinReg Fade'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

-- LinReg Fade Optimized: same fade, std_dev wrapped in OPT(...,10%)
-- Счёт: FAKE-EFF-001, иначе любой fake T-BANK (install-on-top / чужой репозиторий).
INSERT INTO logics (name, account_id, is_enabled, note)
SELECT
    'LinReg Fade Optimized',
    a.id,
    FALSE,
    'Как LinReg Fade, но std_dev оптимизируется на лету: OPT(std_dev,10) — чемпион + ветки ±10%, окно opt_eval_candles.'
FROM (
    SELECT acc.id
    FROM accounts acc
    JOIN brokers br ON br.id = acc.broker_id
    WHERE br.code = 'T-BANK'
      AND (acc.account_code = 'FAKE-EFF-001' OR lower(acc.account_type::text) = 'fake')
    ORDER BY CASE WHEN acc.account_code = 'FAKE-EFF-001' THEN 0 ELSE 1 END, acc.id
    LIMIT 1
) a
ON CONFLICT (name) DO NOTHING;

INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
SELECT l.id, d.param_key, d.default_value, d.value_type
FROM logics l
CROSS JOIN logic_param_defs d
WHERE l.name = 'LinReg Fade Optimized'
ON CONFLICT (logic_id, param_key) DO NOTHING;

INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
SELECT l.id, v.param_key, v.param_value, v.value_type
FROM logics l
CROSS JOIN (VALUES
    ('timeframe', 'M15', 'text'),
    ('position_size_pct', '10', 'number'),
    ('max_open_positions', '3', 'integer'),
    ('initial_balance', '1000000', 'money'),
    ('current_balance', '1000000', 'money'),
    ('commission_pct', '0.03', 'number'),
    ('cost_method', 'FIFO', 'text'),
    ('opt_eval_candles', '20', 'integer')
) AS v(param_key, param_value, value_type)
WHERE l.name = 'LinReg Fade Optimized'
  AND EXISTS (SELECT 1 FROM logic_param_defs d WHERE d.param_key = v.param_key)
ON CONFLICT (logic_id, param_key) DO UPDATE SET
    param_value = EXCLUDED.param_value,
    value_type = EXCLUDED.value_type;

-- Upgrade: empty initial_balance on Optimized / copies → backtest cash=0 → zero opens
UPDATE logic_params lp
SET param_value = '1000000',
    value_type = 'money',
    updated_at = CURRENT_TIMESTAMP
FROM logics l
WHERE l.id = lp.logic_id
  AND l.name ILIKE 'LinReg Fade Optimized%'
  AND lp.param_key IN ('initial_balance', 'current_balance')
  AND btrim(COALESCE(lp.param_value, '')) = '';

INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('LINREG', 'open',  'long',  'counter', '@LINREG(period=20,std_dev=2,series=LOWER,OPT(std_dev,10)) pp <= VALUE', 0),
    ('LINREG', 'close', 'long',  'trend',   '@LINREG(period=20,std_dev=2,series=MIDDLE,OPT(std_dev,10)) pp >= VALUE', 1),
    ('LINREG', 'open',  'short', 'counter', '@LINREG(period=20,std_dev=2,series=UPPER,OPT(std_dev,10)) pp >= VALUE', 2),
    ('LINREG', 'close', 'short', 'trend',   '@LINREG(period=20,std_dev=2,series=MIDDLE,OPT(std_dev,10)) pp <= VALUE', 3)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'LinReg Fade Optimized'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

-- Бумаги Optimized — после назначения LinReg Fade (ниже); здесь только сигналы.

INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('SQUARE', 'open',  'long',  'counter', '@SQUARE(period=20,std_dev=2,series=LOWER) pp <= VALUE', 0),
    ('SQUARE', 'close', 'long',  'trend',   '@SQUARE(period=20,std_dev=2,series=MIDDLE) pp >= VALUE', 1),
    ('SQUARE', 'open',  'short', 'counter', '@SQUARE(period=20,std_dev=2,series=UPPER) pp >= VALUE', 2),
    ('SQUARE', 'close', 'short', 'trend',   '@SQUARE(period=20,std_dev=2,series=MIDDLE) pp <= VALUE', 3)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'Square Fade'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

-- Upgrade: убрать неудачный LINREGV / LinRegV Fade (если ставили раньше).
-- Tables logic_trades / logic_trade_lots are created later in this script — guard with to_regclass.
DO $$
BEGIN
    IF to_regclass('public.logic_trade_lots') IS NOT NULL THEN
        DELETE FROM logic_trade_lots
        WHERE logic_id IN (SELECT id FROM logics WHERE name = 'LinRegV Fade');
    END IF;
    IF to_regclass('public.logic_trades') IS NOT NULL THEN
        DELETE FROM logic_trades
        WHERE logic_id IN (SELECT id FROM logics WHERE name = 'LinRegV Fade');
    END IF;
    DELETE FROM logics WHERE name = 'LinRegV Fade';
    IF to_regclass('public.logic_indicator_signals') IS NOT NULL THEN
        DELETE FROM logic_indicator_signals
        WHERE indicator_id IN (SELECT id FROM indicators WHERE code = 'LINREGV');
    END IF;
    DELETE FROM indicators WHERE code = 'LINREGV';
END $$;

INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('ADX', 'open',  'long',  'counter', '@ADX(period=14,series=ADX) VALUE < 25', 0),
    ('RSI', 'open',  'long',  'counter', '@RSI(period=14,series=VALUE) VALUE < 30', 1),
    ('RSI', 'close', 'long',  'trend',   '@RSI(period=14,series=VALUE) VALUE > 50', 2),
    ('ADX', 'open',  'short', 'counter', '@ADX(period=14,series=ADX) VALUE < 25', 3),
    ('RSI', 'open',  'short', 'counter', '@RSI(period=14,series=VALUE) VALUE > 70', 4),
    ('RSI', 'close', 'short', 'trend',   '@RSI(period=14,series=VALUE) VALUE < 50', 5)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'ADX Range RSI'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('MACD', 'open',  'long',  'counter', '@MACD(fast_period=12,slow_period=26,signal_period=9,series=HISTOGRAM) VALUE < 0', 0),
    ('MACD', 'close', 'long',  'trend',   '@MACD(fast_period=12,slow_period=26,signal_period=9,series=HISTOGRAM) VALUE > 0', 1),
    ('MACD', 'open',  'short', 'counter', '@MACD(fast_period=12,slow_period=26,signal_period=9,series=HISTOGRAM) VALUE > 0', 2),
    ('MACD', 'close', 'short', 'trend',   '@MACD(fast_period=12,slow_period=26,signal_period=9,series=HISTOGRAM) VALUE < 0', 3)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'MACD Hist Fade'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('ATR', 'open',  'long',  'counter', '@ATR(period=14,series=GROWTH5) VALUE >= 3', 0),
    ('RSI', 'open',  'long',  'counter', '@RSI(period=14,series=VALUE) VALUE < 35', 1),
    ('RSI', 'close', 'long',  'trend',   '@RSI(period=14,series=VALUE) VALUE > 55', 2),
    ('ATR', 'open',  'short', 'counter', '@ATR(period=14,series=GROWTH5) VALUE >= 3', 3),
    ('RSI', 'open',  'short', 'counter', '@RSI(period=14,series=VALUE) VALUE > 65', 4),
    ('RSI', 'close', 'short', 'trend',   '@RSI(period=14,series=VALUE) VALUE < 45', 5)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'ATR Spike Reversal'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

INSERT INTO logic_securities (logic_id, security_id, display_order)
SELECT l.id, q.security_id, ROW_NUMBER() OVER (PARTITION BY l.id ORDER BY q.sort_key) - 1
FROM logics l
CROSS JOIN LATERAL (
    SELECT DISTINCT ON (s.id)
        s.id AS security_id,
        COALESCE(sp.prefix, s.name) AS sort_key
    FROM securities s
    JOIN security_prefixes sp ON sp.security_id = s.id AND sp.instrument_market = 'stock'
    ORDER BY s.id, sp.prefix
) q
WHERE l.name IN (
    'CCI Countertrade', 'LinReg Fade', 'LinReg Fade Optimized',
    'Square Fade', 'ADX Range RSI', 'MACD Hist Fade', 'ATR Spike Reversal'
)
ON CONFLICT (logic_id, security_id) DO NOTHING;

-- Optimized: предпочтительно те же бумаги, что у LinReg Fade (если уже есть)
INSERT INTO logic_securities (logic_id, security_id, display_order, is_active)
SELECT dst.id, ls.security_id, ls.display_order, ls.is_active
FROM logics src
JOIN logic_securities ls ON ls.logic_id = src.id
JOIN logics dst ON dst.name = 'LinReg Fade Optimized'
WHERE src.name = 'LinReg Fade'
ON CONFLICT (logic_id, security_id) DO UPDATE SET
    is_active = EXCLUDED.is_active,
    display_order = EXCLUDED.display_order;

-- Стопы seed: insert only if empty

INSERT INTO logic_stops (logic_id, rule_kind, scope_type, value, value_unit, display_order, is_active)
SELECT l.id, v.rule_kind, v.scope_type, v.value, v.value_unit, v.display_order, TRUE
FROM logics l
CROSS JOIN (VALUES
    ('stop_loss',   'security_resume', 1.0, 'percent', 0),
    ('take_profit', 'portfolio_ltp_renew', 5.0, 'percent', 1)
) AS v(rule_kind, scope_type, value, value_unit, display_order)
WHERE l.name IN (
    'CCI Countertrade', 'LinReg Fade', 'LinReg Fade Optimized',
    'Square Fade', 'ADX Range RSI', 'MACD Hist Fade', 'ATR Spike Reversal'
)
  AND NOT EXISTS (SELECT 1 FROM logic_stops z WHERE z.logic_id = l.id);

-- =====================================================================
-- v45: +5 трендовых и +10 контртрендовых (OsEngine-style), ещё не в seed
-- FAKE, выключены, все акции, SL 1% security_resume / TP 5% portfolio_ltp_renew.
-- Только INSERT IF NOT EXISTS — копии пользователя и правки не затираются.
-- =====================================================================

INSERT INTO logics (name, account_id, is_enabled, note)
SELECT v.name, a.id, FALSE, v.note
FROM accounts a
JOIN brokers b ON b.id = a.broker_id
CROSS JOIN (VALUES
    -- 5 trend
    ('MACD Signal Cross', 'Трендовая. OsEngine MacdLine: long при HISTOGRAM>0 (MACD выше Signal), short при HISTOGRAM<0.'),
    ('ADX DI Trend', 'Трендовая. OsEngine AdxTrade: ADX>25 и направление +DI/−DI; выход при ослаблении ADX.'),
    ('SMA100 Trend', 'Трендовая. OsEngine SmaTrendSample (долгая SMA): long выше SMA(100), short ниже.'),
    ('LinReg Slope Trend', 'Трендовая. Следование наклону LinReg: long при SLOPE>0 и цене выше mid, short зеркально.'),
    ('PACC Momentum Trend', 'Трендовая. OsEngine-style по ускорению цены PACC: long при PACC>0, short при PACC<0.'),
    -- 10 counter-trend
    ('RSI Extreme 20/80', 'Контртрендовая. OsEngine RsiTrade (жёсткие уровни): long RSI<20, short RSI>80.'),
    ('Stoch D Fade', 'Контртрендовая. OsEngine Stochastic по %D: long %D<20, short %D>80.'),
    ('CCI Extreme 200', 'Контртрендовая. OsEngine CciTrade (экстремум ±200): вход на перегибе, выход к нулю.'),
    ('MACD Signal Fade', 'Контртрендовая. Fade против гистограммы MACD (зеркало MacdLine): long при HISTOGRAM<0.'),
    ('ADX Exhaustion Fade', 'Контртрендовая. Сильный ADX>40 + RSI-экстремум — усталость тренда (OsEngine exhaustion).'),
    ('ATR Quiet RSI', 'Контртрендовая. Низкая волатильность ATR GROWTH5<1 + RSI fade — боковик.'),
    ('SMA Stretch Fade', 'Контртрендовая. Сильный отрыв цены от SMA(20) + RSI — возврат к средней (OsEngine stretch).'),
    ('Stoch RSI Combo', 'Контртрендовая (комбо). OsEngine-style: одновременно Stoch и RSI в экстремуме.'),
    ('PACC Reversal', 'Контртрендовая. Разворот ускорения PACC против цены/RSI — fade после импульса.'),
    ('EMA RSI Fade', 'Контртрендовая. Цена у EMA + RSI перепродан/перекуп — откат к EMA (OsEngine pullback fade).')
) AS v(name, note)
WHERE b.code = 'T-BANK' AND a.account_code = 'FAKE-EFF-001'
ON CONFLICT (name) DO NOTHING;

INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
SELECT l.id, v.param_key, v.param_value, v.value_type
FROM logics l
CROSS JOIN (VALUES
    ('timeframe', 'M15', 'text'),
    ('position_size_pct', '10', 'number'),
    ('max_open_positions', '3', 'integer'),
    ('initial_balance', '1000000', 'money'),
    ('current_balance', '1000000', 'money'),
    ('commission_pct', '0.03', 'number'),
    ('cost_method', 'FIFO', 'text'),
    ('stop_loss_timeframe', 'M5', 'text'),
    ('base_annual_rate_pct', '20', 'number'),
    ('rating_lookback_days', '7', 'integer')
) AS v(param_key, param_value, value_type)
WHERE l.name IN (
    'MACD Signal Cross', 'ADX DI Trend', 'SMA100 Trend', 'LinReg Slope Trend', 'PACC Momentum Trend',
    'RSI Extreme 20/80', 'Stoch D Fade', 'CCI Extreme 200', 'MACD Signal Fade', 'ADX Exhaustion Fade',
    'ATR Quiet RSI', 'SMA Stretch Fade', 'Stoch RSI Combo', 'PACC Reversal', 'EMA RSI Fade'
)
ON CONFLICT (logic_id, param_key) DO NOTHING;

INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
SELECT l.id, d.param_key, d.default_value, d.value_type
FROM logics l
CROSS JOIN logic_param_defs d
WHERE l.name IN (
    'MACD Signal Cross', 'ADX DI Trend', 'SMA100 Trend', 'LinReg Slope Trend', 'PACC Momentum Trend',
    'RSI Extreme 20/80', 'Stoch D Fade', 'CCI Extreme 200', 'MACD Signal Fade', 'ADX Exhaustion Fade',
    'ATR Quiet RSI', 'SMA Stretch Fade', 'Stoch RSI Combo', 'PACC Reversal', 'EMA RSI Fade'
)
ON CONFLICT (logic_id, param_key) DO NOTHING;

-- --- trend signals ---
INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('MACD', 'open',  'long',  'trend',   '@MACD(fast_period=12,slow_period=26,signal_period=9,series=HISTOGRAM) VALUE > 0', 0),
    ('MACD', 'close', 'long',  'trend',   '@MACD(fast_period=12,slow_period=26,signal_period=9,series=HISTOGRAM) VALUE < 0', 1),
    ('MACD', 'open',  'short', 'trend',   '@MACD(fast_period=12,slow_period=26,signal_period=9,series=HISTOGRAM) VALUE < 0', 2),
    ('MACD', 'close', 'short', 'trend',   '@MACD(fast_period=12,slow_period=26,signal_period=9,series=HISTOGRAM) VALUE > 0', 3)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'MACD Signal Cross'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('ADX', 'open',  'long',  'trend',   '@ADX(period=14,series=ADX) VALUE > 25', 0),
    ('SMA', 'open',  'long',  'trend',   '@SMA(period=50,series=VALUE) pp > VALUE', 1),
    ('ADX', 'close', 'long',  'trend',   '@ADX(period=14,series=ADX) VALUE < 20', 2),
    ('ADX', 'open',  'short', 'trend',   '@ADX(period=14,series=ADX) VALUE > 25', 3),
    ('SMA', 'open',  'short', 'trend',   '@SMA(period=50,series=VALUE) pp < VALUE', 4),
    ('ADX', 'close', 'short', 'trend',   '@ADX(period=14,series=ADX) VALUE < 20', 5)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'ADX DI Trend'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('SMA', 'open',  'long',  'trend',   '@SMA(period=100,series=VALUE) pp > VALUE', 0),
    ('SMA', 'close', 'long',  'trend',   '@SMA(period=100,series=VALUE) pp < VALUE', 1),
    ('SMA', 'open',  'short', 'trend',   '@SMA(period=100,series=VALUE) pp < VALUE', 2),
    ('SMA', 'close', 'short', 'trend',   '@SMA(period=100,series=VALUE) pp > VALUE', 3)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'SMA100 Trend'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('LINREG', 'open',  'long',  'trend',   '@LINREG(period=20,std_dev=2,series=SLOPE) VALUE > 0', 0),
    ('SMA',    'open',  'long',  'trend',   '@SMA(period=20,series=VALUE) pp > VALUE', 1),
    ('LINREG', 'close', 'long',  'trend',   '@LINREG(period=20,std_dev=2,series=SLOPE) VALUE < 0', 2),
    ('LINREG', 'open',  'short', 'trend',   '@LINREG(period=20,std_dev=2,series=SLOPE) VALUE < 0', 3),
    ('SMA',    'open',  'short', 'trend',   '@SMA(period=20,series=VALUE) pp < VALUE', 4),
    ('LINREG', 'close', 'short', 'trend',   '@LINREG(period=20,std_dev=2,series=SLOPE) VALUE > 0', 5)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'LinReg Slope Trend'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('PACC', 'open',  'long',  'trend',   '@PACC(series=VALUE) VALUE > 0', 0),
    ('PACC', 'close', 'long',  'trend',   '@PACC(series=VALUE) VALUE < 0', 1),
    ('PACC', 'open',  'short', 'trend',   '@PACC(series=VALUE) VALUE < 0', 2),
    ('PACC', 'close', 'short', 'trend',   '@PACC(series=VALUE) VALUE > 0', 3)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'PACC Momentum Trend'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

-- --- counter-trend signals ---
INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('RSI', 'open',  'long',  'counter', '@RSI(period=14,series=VALUE) VALUE < 20', 0),
    ('RSI', 'close', 'long',  'trend',   '@RSI(period=14,series=VALUE) VALUE > 50', 1),
    ('RSI', 'open',  'short', 'counter', '@RSI(period=14,series=VALUE) VALUE > 80', 2),
    ('RSI', 'close', 'short', 'trend',   '@RSI(period=14,series=VALUE) VALUE < 50', 3)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'RSI Extreme 20/80'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('STOCH', 'open',  'long',  'counter', '@STOCH(series=D) VALUE < 20', 0),
    ('STOCH', 'close', 'long',  'trend',   '@STOCH(series=D) VALUE > 50', 1),
    ('STOCH', 'open',  'short', 'counter', '@STOCH(series=D) VALUE > 80', 2),
    ('STOCH', 'close', 'short', 'trend',   '@STOCH(series=D) VALUE < 50', 3)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'Stoch D Fade'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('CCI', 'open',  'long',  'counter', '@CCI(period=20,series=VALUE) VALUE <= -200', 0),
    ('CCI', 'close', 'long',  'trend',   '@CCI(period=20,series=VALUE) VALUE >= 0', 1),
    ('CCI', 'open',  'short', 'counter', '@CCI(period=20,series=VALUE) VALUE >= 200', 2),
    ('CCI', 'close', 'short', 'trend',   '@CCI(period=20,series=VALUE) VALUE <= 0', 3)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'CCI Extreme 200'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('MACD', 'open',  'long',  'counter', '@MACD(fast_period=12,slow_period=26,signal_period=9,series=HISTOGRAM) VALUE < 0', 0),
    ('MACD', 'close', 'long',  'trend',   '@MACD(fast_period=12,slow_period=26,signal_period=9,series=HISTOGRAM) VALUE > 0', 1),
    ('MACD', 'open',  'short', 'counter', '@MACD(fast_period=12,slow_period=26,signal_period=9,series=HISTOGRAM) VALUE > 0', 2),
    ('MACD', 'close', 'short', 'trend',   '@MACD(fast_period=12,slow_period=26,signal_period=9,series=HISTOGRAM) VALUE < 0', 3)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'MACD Signal Fade'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('ADX', 'open',  'long',  'counter', '@ADX(period=14,series=ADX) VALUE > 40', 0),
    ('RSI', 'open',  'long',  'counter', '@RSI(period=14,series=VALUE) VALUE < 30', 1),
    ('RSI', 'close', 'long',  'trend',   '@RSI(period=14,series=VALUE) VALUE > 50', 2),
    ('ADX', 'open',  'short', 'counter', '@ADX(period=14,series=ADX) VALUE > 40', 3),
    ('RSI', 'open',  'short', 'counter', '@RSI(period=14,series=VALUE) VALUE > 70', 4),
    ('RSI', 'close', 'short', 'trend',   '@RSI(period=14,series=VALUE) VALUE < 50', 5)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'ADX Exhaustion Fade'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('ATR', 'open',  'long',  'counter', '@ATR(period=14,series=GROWTH5) VALUE < 1', 0),
    ('RSI', 'open',  'long',  'counter', '@RSI(period=14,series=VALUE) VALUE < 35', 1),
    ('RSI', 'close', 'long',  'trend',   '@RSI(period=14,series=VALUE) VALUE > 55', 2),
    ('ATR', 'open',  'short', 'counter', '@ATR(period=14,series=GROWTH5) VALUE < 1', 3),
    ('RSI', 'open',  'short', 'counter', '@RSI(period=14,series=VALUE) VALUE > 65', 4),
    ('RSI', 'close', 'short', 'trend',   '@RSI(period=14,series=VALUE) VALUE < 45', 5)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'ATR Quiet RSI'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('SMA', 'open',  'long',  'counter', '@SMA(period=20,series=VALUE) pp < VALUE', 0),
    ('RSI', 'open',  'long',  'counter', '@RSI(period=14,series=VALUE) VALUE < 30', 1),
    ('SMA', 'close', 'long',  'trend',   '@SMA(period=20,series=VALUE) pp >= VALUE', 2),
    ('SMA', 'open',  'short', 'counter', '@SMA(period=20,series=VALUE) pp > VALUE', 3),
    ('RSI', 'open',  'short', 'counter', '@RSI(period=14,series=VALUE) VALUE > 70', 4),
    ('SMA', 'close', 'short', 'trend',   '@SMA(period=20,series=VALUE) pp <= VALUE', 5)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'SMA Stretch Fade'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('STOCH', 'open',  'long',  'counter', '@STOCH(series=K) VALUE < 20', 0),
    ('RSI',   'open',  'long',  'counter', '@RSI(period=14,series=VALUE) VALUE < 30', 1),
    ('RSI',   'close', 'long',  'trend',   '@RSI(period=14,series=VALUE) VALUE > 50', 2),
    ('STOCH', 'open',  'short', 'counter', '@STOCH(series=K) VALUE > 80', 3),
    ('RSI',   'open',  'short', 'counter', '@RSI(period=14,series=VALUE) VALUE > 70', 4),
    ('RSI',   'close', 'short', 'trend',   '@RSI(period=14,series=VALUE) VALUE < 50', 5)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'Stoch RSI Combo'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('PACC', 'open',  'long',  'counter', '@PACC(series=VALUE) VALUE < 0', 0),
    ('RSI',  'open',  'long',  'counter', '@RSI(period=14,series=VALUE) VALUE < 35', 1),
    ('PACC', 'close', 'long',  'trend',   '@PACC(series=VALUE) VALUE > 0', 2),
    ('PACC', 'open',  'short', 'counter', '@PACC(series=VALUE) VALUE > 0', 3),
    ('RSI',  'open',  'short', 'counter', '@RSI(period=14,series=VALUE) VALUE > 65', 4),
    ('PACC', 'close', 'short', 'trend',   '@PACC(series=VALUE) VALUE < 0', 5)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'PACC Reversal'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('EMA', 'open',  'long',  'counter', '@EMA(period=20,series=VALUE) pp <= VALUE', 0),
    ('RSI', 'open',  'long',  'counter', '@RSI(period=14,series=VALUE) VALUE < 35', 1),
    ('EMA', 'close', 'long',  'trend',   '@EMA(period=20,series=VALUE) pp > VALUE', 2),
    ('EMA', 'open',  'short', 'counter', '@EMA(period=20,series=VALUE) pp >= VALUE', 3),
    ('RSI', 'open',  'short', 'counter', '@RSI(period=14,series=VALUE) VALUE > 65', 4),
    ('EMA', 'close', 'short', 'trend',   '@EMA(period=20,series=VALUE) pp < VALUE', 5)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'EMA RSI Fade'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

INSERT INTO logic_securities (logic_id, security_id, display_order)
SELECT l.id, q.security_id, ROW_NUMBER() OVER (PARTITION BY l.id ORDER BY q.sort_key) - 1
FROM logics l
CROSS JOIN LATERAL (
    SELECT DISTINCT ON (s.id)
        s.id AS security_id,
        COALESCE(sp.prefix, s.name) AS sort_key
    FROM securities s
    JOIN security_prefixes sp ON sp.security_id = s.id AND sp.instrument_market = 'stock'
    ORDER BY s.id, sp.prefix
) q
WHERE l.name IN (
    'MACD Signal Cross', 'ADX DI Trend', 'SMA100 Trend', 'LinReg Slope Trend', 'PACC Momentum Trend',
    'RSI Extreme 20/80', 'Stoch D Fade', 'CCI Extreme 200', 'MACD Signal Fade', 'ADX Exhaustion Fade',
    'ATR Quiet RSI', 'SMA Stretch Fade', 'Stoch RSI Combo', 'PACC Reversal', 'EMA RSI Fade'
)
ON CONFLICT (logic_id, security_id) DO NOTHING;

INSERT INTO logic_stops (logic_id, rule_kind, scope_type, value, value_unit, display_order, is_active)
SELECT l.id, v.rule_kind, v.scope_type, v.value, v.value_unit, v.display_order, TRUE
FROM logics l
CROSS JOIN (VALUES
    ('stop_loss',   'security_resume', 1.0, 'percent', 0),
    ('take_profit', 'portfolio_ltp_renew', 5.0, 'percent', 1)
) AS v(rule_kind, scope_type, value, value_unit, display_order)
WHERE l.name IN (
    'MACD Signal Cross', 'ADX DI Trend', 'SMA100 Trend', 'LinReg Slope Trend', 'PACC Momentum Trend',
    'RSI Extreme 20/80', 'Stoch D Fade', 'CCI Extreme 200', 'MACD Signal Fade', 'ADX Exhaustion Fade',
    'ATR Quiet RSI', 'SMA Stretch Fade', 'Stoch RSI Combo', 'PACC Reversal', 'EMA RSI Fade'
)
  AND NOT EXISTS (SELECT 1 FROM logic_stops z WHERE z.logic_id = l.id);

-- =====================================================================
-- v47: +8 контртрендовых OsEngine Custom Robots (ещё не в seed)
-- Прокси на индикаторы с calc в PG (NRTR/RAVI/SuperTrend/FI/MI/Aroon/CMO/StdDev нет).
-- FAKE, выключены, все акции, SL 1% security_resume / TP 5% portfolio_ltp_renew.
-- Только INSERT IF NOT EXISTS — копии пользователя и правки не затираются.
-- =====================================================================

INSERT INTO logics (name, account_id, is_enabled, note)
SELECT v.name, a.id, FALSE, v.note
FROM accounts a
JOIN brokers b ON b.id = a.broker_id
CROSS JOIN (VALUES
    (
        'NRTR ROC Fade',
        'Контртрендовая. OsEngine ContrTrendNrtrAndROC; прокси: SMA(24)≈NRTR, RSI≈ROC — long ниже SMA+RSI<30, short выше SMA+RSI>70.'
    ),
    (
        'RAVI BB Fade',
        'Контртрендовая. OsEngine ContrtrendRaviAndBollinger; прокси: ADX<25≈слабый RAVI + отскок BB к середине.'
    ),
    (
        'Stoch Aroon Fade',
        'Контртрендовая. OsEngine ContrtrendStochAndAroon; прокси: ADX≈Aroon strength + Stoch %K экстремум.'
    ),
    (
        'MI SMA Reversal',
        'Контртрендовая. OsEngine ContrtrendStrategyMiAndSma; прокси: ATR GROWTH5≈Mass Index bulge + направление SMA(20).'
    ),
    (
        'SuperTrend CMO Fade',
        'Контртрендовая. OsEngine ContrtrendSuperTrendAndCMO; прокси: EMA(10)≈SuperTrend, RSI≈CMO ±50.'
    ),
    (
        'Force Index Fade',
        'Контртрендовая. OsEngine CounterTrendFI; прокси: MACD HISTOGRAM (знак силы) + RSI.'
    ),
    (
        'BB StdDev Fade',
        'Контртрендовая. OsEngine CountertrendBollingerAndStdDev; прокси: BB + ATR GROWTH5>1 как фильтр StdDev.'
    ),
    (
        'BB Volume Fade',
        'Контртрендовая. OsEngine CountertrendBollingerAndVolumes; прокси: BB + ADX<30 как объёмный/режимный фильтр.'
    )
) AS v(name, note)
WHERE b.code = 'T-BANK' AND a.account_code = 'FAKE-EFF-001'
ON CONFLICT (name) DO NOTHING;

INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
SELECT l.id, v.param_key, v.param_value, v.value_type
FROM logics l
CROSS JOIN (VALUES
    ('timeframe', 'M15', 'text'),
    ('position_size_pct', '10', 'number'),
    ('max_open_positions', '3', 'integer'),
    ('initial_balance', '1000000', 'money'),
    ('current_balance', '1000000', 'money'),
    ('commission_pct', '0.03', 'number'),
    ('cost_method', 'FIFO', 'text'),
    ('stop_loss_timeframe', 'M5', 'text'),
    ('base_annual_rate_pct', '20', 'number'),
    ('rating_lookback_days', '7', 'integer')
) AS v(param_key, param_value, value_type)
WHERE l.name IN (
    'NRTR ROC Fade', 'RAVI BB Fade', 'Stoch Aroon Fade', 'MI SMA Reversal',
    'SuperTrend CMO Fade', 'Force Index Fade', 'BB StdDev Fade', 'BB Volume Fade'
)
ON CONFLICT (logic_id, param_key) DO NOTHING;

INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
SELECT l.id, d.param_key, d.default_value, d.value_type
FROM logics l
CROSS JOIN logic_param_defs d
WHERE l.name IN (
    'NRTR ROC Fade', 'RAVI BB Fade', 'Stoch Aroon Fade', 'MI SMA Reversal',
    'SuperTrend CMO Fade', 'Force Index Fade', 'BB StdDev Fade', 'BB Volume Fade'
)
ON CONFLICT (logic_id, param_key) DO NOTHING;

-- NRTR ROC Fade (ContrTrendNrtrAndROC)
INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('SMA', 'open',  'long',  'counter', '@SMA(period=24,series=VALUE) pp < VALUE', 0),
    ('RSI', 'open',  'long',  'counter', '@RSI(period=14,series=VALUE) VALUE < 30', 1),
    ('SMA', 'close', 'long',  'trend',   '@SMA(period=24,series=VALUE) pp > VALUE', 2),
    ('SMA', 'open',  'short', 'counter', '@SMA(period=24,series=VALUE) pp > VALUE', 3),
    ('RSI', 'open',  'short', 'counter', '@RSI(period=14,series=VALUE) VALUE > 70', 4),
    ('SMA', 'close', 'short', 'trend',   '@SMA(period=24,series=VALUE) pp < VALUE', 5)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'NRTR ROC Fade'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

-- RAVI BB Fade (ContrtrendRaviAndBollinger)
INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('ADX', 'open',  'long',  'counter', '@ADX(period=14,series=ADX) VALUE < 25', 0),
    ('BB',  'open',  'long',  'counter', '@BB(period=21,std_dev=1,series=LOWER) pp < VALUE', 1),
    ('BB',  'close', 'long',  'trend',   '@BB(period=21,std_dev=1,series=MIDDLE) pp > VALUE', 2),
    ('ADX', 'open',  'short', 'counter', '@ADX(period=14,series=ADX) VALUE < 25', 3),
    ('BB',  'open',  'short', 'counter', '@BB(period=21,std_dev=1,series=UPPER) pp > VALUE', 4),
    ('BB',  'close', 'short', 'trend',   '@BB(period=21,std_dev=1,series=MIDDLE) pp < VALUE', 5)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'RAVI BB Fade'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

-- Stoch Aroon Fade (ContrtrendStochAndAroon)
INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('ADX',   'open',  'long',  'counter', '@ADX(period=14,series=ADX) VALUE > 25', 0),
    ('STOCH', 'open',  'long',  'counter', '@STOCH(k_period=9,d_period=5,smooth=3,series=K) VALUE < 30', 1),
    ('ADX',   'close', 'long',  'trend',   '@ADX(period=14,series=ADX) VALUE < 20', 2),
    ('ADX',   'open',  'short', 'counter', '@ADX(period=14,series=ADX) VALUE > 25', 3),
    ('STOCH', 'open',  'short', 'counter', '@STOCH(k_period=9,d_period=5,smooth=3,series=K) VALUE > 80', 4),
    ('ADX',   'close', 'short', 'trend',   '@ADX(period=14,series=ADX) VALUE < 20', 5)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'Stoch Aroon Fade'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

-- MI SMA Reversal (ContrtrendStrategyMiAndSma)
INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('ATR', 'open',  'long',  'counter', '@ATR(period=14,series=GROWTH5) VALUE >= 2', 0),
    ('SMA', 'open',  'long',  'counter', '@SMA(period=20,series=VALUE) pp < VALUE', 1),
    ('SMA', 'close', 'long',  'trend',   '@SMA(period=20,series=VALUE) pp > VALUE', 2),
    ('ATR', 'open',  'short', 'counter', '@ATR(period=14,series=GROWTH5) VALUE >= 2', 3),
    ('SMA', 'open',  'short', 'counter', '@SMA(period=20,series=VALUE) pp > VALUE', 4),
    ('SMA', 'close', 'short', 'trend',   '@SMA(period=20,series=VALUE) pp < VALUE', 5)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'MI SMA Reversal'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

-- SuperTrend CMO Fade (ContrtrendSuperTrendAndCMO)
INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('EMA', 'open',  'long',  'counter', '@EMA(period=10,series=VALUE) pp > VALUE', 0),
    ('RSI', 'open',  'long',  'counter', '@RSI(period=14,series=VALUE) VALUE < 30', 1),
    ('EMA', 'close', 'long',  'trend',   '@EMA(period=10,series=VALUE) pp < VALUE', 2),
    ('EMA', 'open',  'short', 'counter', '@EMA(period=10,series=VALUE) pp < VALUE', 3),
    ('RSI', 'open',  'short', 'counter', '@RSI(period=14,series=VALUE) VALUE > 70', 4),
    ('EMA', 'close', 'short', 'trend',   '@EMA(period=10,series=VALUE) pp > VALUE', 5)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'SuperTrend CMO Fade'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

-- Force Index Fade (CounterTrendFI)
INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('MACD', 'open',  'long',  'counter', '@MACD(fast_period=12,slow_period=26,signal_period=9,series=HISTOGRAM) VALUE < 0', 0),
    ('RSI',  'open',  'long',  'counter', '@RSI(period=14,series=VALUE) VALUE < 40', 1),
    ('RSI',  'close', 'long',  'trend',   '@RSI(period=14,series=VALUE) VALUE > 50', 2),
    ('MACD', 'open',  'short', 'counter', '@MACD(fast_period=12,slow_period=26,signal_period=9,series=HISTOGRAM) VALUE > 0', 3),
    ('RSI',  'open',  'short', 'counter', '@RSI(period=14,series=VALUE) VALUE > 60', 4),
    ('RSI',  'close', 'short', 'trend',   '@RSI(period=14,series=VALUE) VALUE < 50', 5)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'Force Index Fade'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

-- BB StdDev Fade (CountertrendBollingerAndStdDev)
INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('BB',  'open',  'long',  'counter', '@BB(period=21,std_dev=1,series=LOWER) pp <= VALUE', 0),
    ('ATR', 'open',  'long',  'counter', '@ATR(period=14,series=GROWTH5) VALUE > 1', 1),
    ('BB',  'close', 'long',  'trend',   '@BB(period=21,std_dev=1,series=MIDDLE) pp > VALUE', 2),
    ('BB',  'open',  'short', 'counter', '@BB(period=21,std_dev=1,series=UPPER) pp >= VALUE', 3),
    ('ATR', 'open',  'short', 'counter', '@ATR(period=14,series=GROWTH5) VALUE > 1', 4),
    ('BB',  'close', 'short', 'trend',   '@BB(period=21,std_dev=1,series=MIDDLE) pp < VALUE', 5)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'BB StdDev Fade'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

-- BB Volume Fade (CountertrendBollingerAndVolumes)
INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('BB',  'open',  'long',  'counter', '@BB(period=21,std_dev=1,series=LOWER) pp < VALUE', 0),
    ('ADX', 'open',  'long',  'counter', '@ADX(period=14,series=ADX) VALUE < 30', 1),
    ('BB',  'close', 'long',  'trend',   '@BB(period=21,std_dev=1,series=MIDDLE) pp > VALUE', 2),
    ('BB',  'open',  'short', 'counter', '@BB(period=21,std_dev=1,series=UPPER) pp > VALUE', 3),
    ('ADX', 'open',  'short', 'counter', '@ADX(period=14,series=ADX) VALUE < 30', 4),
    ('BB',  'close', 'short', 'trend',   '@BB(period=21,std_dev=1,series=MIDDLE) pp < VALUE', 5)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'BB Volume Fade'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

INSERT INTO logic_securities (logic_id, security_id, display_order)
SELECT l.id, q.security_id, ROW_NUMBER() OVER (PARTITION BY l.id ORDER BY q.sort_key) - 1
FROM logics l
CROSS JOIN LATERAL (
    SELECT DISTINCT ON (s.id)
        s.id AS security_id,
        COALESCE(sp.prefix, s.name) AS sort_key
    FROM securities s
    JOIN security_prefixes sp ON sp.security_id = s.id AND sp.instrument_market = 'stock'
    ORDER BY s.id, sp.prefix
) q
WHERE l.name IN (
    'NRTR ROC Fade', 'RAVI BB Fade', 'Stoch Aroon Fade', 'MI SMA Reversal',
    'SuperTrend CMO Fade', 'Force Index Fade', 'BB StdDev Fade', 'BB Volume Fade'
)
ON CONFLICT (logic_id, security_id) DO NOTHING;

INSERT INTO logic_stops (logic_id, rule_kind, scope_type, value, value_unit, display_order, is_active)
SELECT l.id, v.rule_kind, v.scope_type, v.value, v.value_unit, v.display_order, TRUE
FROM logics l
CROSS JOIN (VALUES
    ('stop_loss',   'security_resume', 1.0, 'percent', 0),
    ('take_profit', 'portfolio_ltp_renew', 5.0, 'percent', 1)
) AS v(rule_kind, scope_type, value, value_unit, display_order)
WHERE l.name IN (
    'NRTR ROC Fade', 'RAVI BB Fade', 'Stoch Aroon Fade', 'MI SMA Reversal',
    'SuperTrend CMO Fade', 'Force Index Fade', 'BB StdDev Fade', 'BB Volume Fade'
)
  AND NOT EXISTS (SELECT 1 FROM logic_stops z WHERE z.logic_id = l.id);

-- =====================================================================
-- v54: install-on-top ensure — все default seed-логики, если отсутствуют.
-- Не затирает копии/правки пользователя (только INSERT … ON CONFLICT DO NOTHING).
-- =====================================================================
INSERT INTO logics (name, account_id, is_enabled, note)
SELECT v.name, a.id, FALSE, v.note
FROM (
    SELECT acc.id
    FROM accounts acc
    JOIN brokers br ON br.id = acc.broker_id
    WHERE br.code = 'T-BANK'
      AND (acc.account_code = 'FAKE-EFF-001' OR lower(acc.account_type::text) = 'fake')
    ORDER BY CASE WHEN acc.account_code = 'FAKE-EFF-001' THEN 0 ELSE 1 END, acc.id
    LIMIT 1
) a
CROSS JOIN (VALUES
    ('SMA Price Cross Demo', 'Демо: пересечение цены и SMA.'),
    ('RSI Mean Reversion', NULL),
    ('Bollinger Bounce', NULL),
    ('Bollinger Breakout', NULL),
    ('MACD Zero Line', NULL),
    ('Stochastic Levels', NULL),
    ('EMA Price Cross', NULL),
    ('Dual MA Trend', NULL),
    ('SMA Stoch Pullback', NULL),
    ('BB Stoch Bounce', NULL),
    ('SMAT3 Trend', NULL),
    ('L1 — лонг, тренд', NULL),
    ('L2 — лонг, боковик', NULL),
    ('L3 — шорт, тренд', NULL),
    ('L4 — шорт, боковик', NULL),
    ('CCI Countertrade', 'Контртрендовая. OsEngine-style CCI fade.'),
    ('LinReg Fade', 'Контртрендовая. Fade по каналу LinReg.'),
    ('LinReg Fade Optimized', 'Как LinReg Fade + OPT(std_dev,10).'),
    ('Square Fade', 'Контртрендовая. Fade по каналу SQUARE.'),
    ('ADX Range RSI', NULL),
    ('MACD Hist Fade', NULL),
    ('ATR Spike Reversal', NULL),
    ('MACD Signal Cross', NULL),
    ('ADX DI Trend', NULL),
    ('SMA100 Trend', NULL),
    ('LinReg Slope Trend', NULL),
    ('PACC Momentum Trend', NULL),
    ('RSI Extreme 20/80', NULL),
    ('Stoch D Fade', NULL),
    ('CCI Extreme 200', NULL),
    ('MACD Signal Fade', NULL),
    ('ADX Exhaustion Fade', NULL),
    ('ATR Quiet RSI', NULL),
    ('SMA Stretch Fade', NULL),
    ('Stoch RSI Combo', NULL),
    ('PACC Reversal', NULL),
    ('EMA RSI Fade', NULL),
    ('NRTR ROC Fade', NULL),
    ('RAVI BB Fade', NULL),
    ('Stoch Aroon Fade', NULL),
    ('MI SMA Reversal', NULL),
    ('SuperTrend CMO Fade', NULL),
    ('Force Index Fade', NULL),
    ('BB StdDev Fade', NULL),
    ('BB Volume Fade', NULL)
) AS v(name, note)
ON CONFLICT (name) DO NOTHING;

-- Базовые params для любых seed без ключей (не перезаписывает уже заданные)
INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
SELECT l.id, v.param_key, v.param_value, v.value_type
FROM logics l
CROSS JOIN (VALUES
    ('timeframe', 'M15', 'text'),
    ('position_size_pct', '10', 'number'),
    ('max_open_positions', '3', 'integer'),
    ('initial_balance', '1000000', 'money'),
    ('current_balance', '1000000', 'money'),
    ('commission_pct', '0.03', 'number'),
    ('cost_method', 'FIFO', 'text')
) AS v(param_key, param_value, value_type)
WHERE l.name IN (
    'SMA Price Cross Demo',
    'RSI Mean Reversion', 'Bollinger Bounce', 'Bollinger Breakout', 'MACD Zero Line',
    'Stochastic Levels', 'EMA Price Cross', 'Dual MA Trend', 'SMA Stoch Pullback',
    'BB Stoch Bounce', 'SMAT3 Trend',
    'L1 — лонг, тренд', 'L2 — лонг, боковик', 'L3 — шорт, тренд', 'L4 — шорт, боковик',
    'CCI Countertrade', 'LinReg Fade', 'LinReg Fade Optimized', 'Square Fade',
    'ADX Range RSI', 'MACD Hist Fade', 'ATR Spike Reversal',
    'MACD Signal Cross', 'ADX DI Trend', 'SMA100 Trend', 'LinReg Slope Trend', 'PACC Momentum Trend',
    'RSI Extreme 20/80', 'Stoch D Fade', 'CCI Extreme 200', 'MACD Signal Fade', 'ADX Exhaustion Fade',
    'ATR Quiet RSI', 'SMA Stretch Fade', 'Stoch RSI Combo', 'PACC Reversal', 'EMA RSI Fade',
    'NRTR ROC Fade', 'RAVI BB Fade', 'Stoch Aroon Fade', 'MI SMA Reversal',
    'SuperTrend CMO Fade', 'Force Index Fade', 'BB StdDev Fade', 'BB Volume Fade'
)
  AND EXISTS (SELECT 1 FROM logic_param_defs d WHERE d.param_key = v.param_key)
ON CONFLICT (logic_id, param_key) DO NOTHING;

INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
SELECT l.id, 'opt_eval_candles', '20', 'integer'
FROM logics l
WHERE l.name = 'LinReg Fade Optimized'
  AND EXISTS (SELECT 1 FROM logic_param_defs d WHERE d.param_key = 'opt_eval_candles')
ON CONFLICT (logic_id, param_key) DO NOTHING;

-- Сигналы Optimized, если логику только что создали ensure-блоком
INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('LINREG', 'open',  'long',  'counter', '@LINREG(period=20,std_dev=2,series=LOWER,OPT(std_dev,10)) pp <= VALUE', 0),
    ('LINREG', 'close', 'long',  'trend',   '@LINREG(period=20,std_dev=2,series=MIDDLE,OPT(std_dev,10)) pp >= VALUE', 1),
    ('LINREG', 'open',  'short', 'counter', '@LINREG(period=20,std_dev=2,series=UPPER,OPT(std_dev,10)) pp >= VALUE', 2),
    ('LINREG', 'close', 'short', 'trend',   '@LINREG(period=20,std_dev=2,series=MIDDLE,OPT(std_dev,10)) pp <= VALUE', 3)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'LinReg Fade Optimized'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

-- Бумаги: если у seed пусто — все акции; Optimized предпочитает состав LinReg Fade
INSERT INTO logic_securities (logic_id, security_id, display_order, is_active)
SELECT dst.id, ls.security_id, ls.display_order, ls.is_active
FROM logics src
JOIN logic_securities ls ON ls.logic_id = src.id
JOIN logics dst ON dst.name = 'LinReg Fade Optimized'
WHERE src.name = 'LinReg Fade'
  AND NOT EXISTS (SELECT 1 FROM logic_securities z WHERE z.logic_id = dst.id)
ON CONFLICT (logic_id, security_id) DO NOTHING;

INSERT INTO logic_securities (logic_id, security_id, display_order)
SELECT l.id, q.security_id, ROW_NUMBER() OVER (PARTITION BY l.id ORDER BY q.sort_key) - 1
FROM logics l
CROSS JOIN LATERAL (
    SELECT DISTINCT ON (s.id)
        s.id AS security_id,
        COALESCE(sp.prefix, s.name) AS sort_key
    FROM securities s
    JOIN security_prefixes sp ON sp.security_id = s.id AND sp.instrument_market = 'stock'
    ORDER BY s.id, sp.prefix
) q
WHERE l.name IN (
    'SMA Price Cross Demo',
    'RSI Mean Reversion', 'Bollinger Bounce', 'Bollinger Breakout', 'MACD Zero Line',
    'Stochastic Levels', 'EMA Price Cross', 'Dual MA Trend', 'SMA Stoch Pullback',
    'BB Stoch Bounce', 'SMAT3 Trend',
    'L1 — лонг, тренд', 'L2 — лонг, боковик', 'L3 — шорт, тренд', 'L4 — шорт, боковик',
    'CCI Countertrade', 'LinReg Fade', 'LinReg Fade Optimized', 'Square Fade',
    'ADX Range RSI', 'MACD Hist Fade', 'ATR Spike Reversal',
    'MACD Signal Cross', 'ADX DI Trend', 'SMA100 Trend', 'LinReg Slope Trend', 'PACC Momentum Trend',
    'RSI Extreme 20/80', 'Stoch D Fade', 'CCI Extreme 200', 'MACD Signal Fade', 'ADX Exhaustion Fade',
    'ATR Quiet RSI', 'SMA Stretch Fade', 'Stoch RSI Combo', 'PACC Reversal', 'EMA RSI Fade',
    'NRTR ROC Fade', 'RAVI BB Fade', 'Stoch Aroon Fade', 'MI SMA Reversal',
    'SuperTrend CMO Fade', 'Force Index Fade', 'BB StdDev Fade', 'BB Volume Fade'
)
  AND NOT EXISTS (SELECT 1 FROM logic_securities z WHERE z.logic_id = l.id)
ON CONFLICT (logic_id, security_id) DO NOTHING;

INSERT INTO logic_stops (logic_id, rule_kind, scope_type, value, value_unit, display_order, is_active)
SELECT l.id, v.rule_kind, v.scope_type, v.value, v.value_unit, v.display_order, TRUE
FROM logics l
CROSS JOIN (VALUES
    ('stop_loss',   'security_resume', 1.0, 'percent', 0),
    ('take_profit', 'portfolio_ltp_renew', 5.0, 'percent', 1)
) AS v(rule_kind, scope_type, value, value_unit, display_order)
WHERE l.name IN (
    'SMA Price Cross Demo',
    'RSI Mean Reversion', 'Bollinger Bounce', 'Bollinger Breakout', 'MACD Zero Line',
    'Stochastic Levels', 'EMA Price Cross', 'Dual MA Trend', 'SMA Stoch Pullback',
    'BB Stoch Bounce', 'SMAT3 Trend',
    'L1 — лонг, тренд', 'L2 — лонг, боковик', 'L3 — шорт, тренд', 'L4 — шорт, боковик',
    'CCI Countertrade', 'LinReg Fade', 'LinReg Fade Optimized', 'Square Fade',
    'ADX Range RSI', 'MACD Hist Fade', 'ATR Spike Reversal',
    'MACD Signal Cross', 'ADX DI Trend', 'SMA100 Trend', 'LinReg Slope Trend', 'PACC Momentum Trend',
    'RSI Extreme 20/80', 'Stoch D Fade', 'CCI Extreme 200', 'MACD Signal Fade', 'ADX Exhaustion Fade',
    'ATR Quiet RSI', 'SMA Stretch Fade', 'Stoch RSI Combo', 'PACC Reversal', 'EMA RSI Fade',
    'NRTR ROC Fade', 'RAVI BB Fade', 'Stoch Aroon Fade', 'MI SMA Reversal',
    'SuperTrend CMO Fade', 'Force Index Fade', 'BB StdDev Fade', 'BB Volume Fade'
)
  AND NOT EXISTS (SELECT 1 FROM logic_stops z WHERE z.logic_id = l.id);

-- Upgrade (01 re-run): дефолты стопов для всех логик
-- SL → security_resume (бумага×сторона, возобновление при сумме прерывания)
-- TP → portfolio_ltp_renew (линейный TP по портфелю с renew); 3% → 5%
UPDATE logic_stops
SET scope_type = 'security_resume'
WHERE rule_kind = 'stop_loss'
  AND scope_type IS DISTINCT FROM 'security_resume';

UPDATE logic_stops
SET scope_type = 'portfolio_ltp_renew'
WHERE rule_kind = 'take_profit'
  AND scope_type IS DISTINCT FROM 'portfolio_ltp_renew';

UPDATE logic_stops
SET value = 5.0
WHERE rule_kind = 'take_profit'
  AND value_unit = 'percent'
  AND value = 3.0;

-- Логики без стопов — вставить пару дефолтов
INSERT INTO logic_stops (logic_id, rule_kind, scope_type, value, value_unit, display_order, is_active)
SELECT l.id, v.rule_kind, v.scope_type, v.value, v.value_unit, v.display_order, TRUE
FROM logics l
CROSS JOIN (VALUES
    ('stop_loss',   'security_resume', 1.0, 'percent', 0),
    ('take_profit', 'portfolio_ltp_renew', 5.0, 'percent', 1)
) AS v(rule_kind, scope_type, value, value_unit, display_order)
WHERE NOT EXISTS (SELECT 1 FROM logic_stops z WHERE z.logic_id = l.id);

-- Примечания ко всем seed-логикам (тип стратегии + источник)
UPDATE logics l
SET note = v.note
FROM (VALUES
    (
        'SMA Price Cross Demo',
        'Демо-логика проекта. Трендовая по пересечению цены и SMA: long выше средней, short ниже. Для проверки UI и runner, не из OsEngine.'
    ),
    (
        'RSI Mean Reversion',
        'Контртрендовая (mean reversion). OsEngine RsiTrade: покупка в перепроданности RSI<30, продажа в перекупленности RSI>70.'
    ),
    (
        'Bollinger Bounce',
        'Контртрендовая. OsEngine StrategyBollinger: отскок от нижней/верхней полосы BB к середине канала.'
    ),
    (
        'Bollinger Breakout',
        'Трендовая. OsEngine BollingerRevers / пробой: вход по выходу за полосу, выход у середины BB.'
    ),
    (
        'MACD Zero Line',
        'Трендовая. OsEngine MacdTrend (упрощ.): long при MACD>0, short при MACD<0.'
    ),
    (
        'Stochastic Levels',
        'Контртрендовая. OsEngine Stochastic fade: long при %K<20, short при %K>80.'
    ),
    (
        'EMA Price Cross',
        'Трендовая. OsEngine SmaTrendSample на EMA: цена выше EMA — long, ниже — short.'
    ),
    (
        'Dual MA Trend',
        'Трендовая. OsEngine SmaWithAShift: цена выше SMA(20) и EMA(50) — long, ниже обеих — short.'
    ),
    (
        'SMA Stoch Pullback',
        'Смешанная: тренд + контртренд. OsEngine SmaStochastic — фильтр тренда по SMA, вход на откате Stoch.'
    ),
    (
        'BB Stoch Bounce',
        'Контртрендовая (комбо). OsEngine StrategyBollingerAndStochastic: экстремум одновременно по BB и Stoch.'
    ),
    (
        'SMAT3 Trend',
        'Трендовая. Сглаженное тройное SMA (SMAT3): long выше линии, short ниже — тренд по сглаженной средней.'
    ),
    (
        'L1 — лонг, тренд',
        'Трендовая комплексная. Адаптация MultiLogicTradeA FINRESP L1 (SMA, LinReg, ATR, ADX, CCI, MACD). Не OsEngine.'
    ),
    (
        'L2 — лонг, боковик',
        'Контртрендовая / боковик. FINRESP L2 — long в диапазоне, слабый ADX и откат к нижней границе LinReg.'
    ),
    (
        'L3 — шорт, тренд',
        'Трендовая шорт. FINRESP L3 — зеркало L1 для short по тем же фильтрам.'
    ),
    (
        'L4 — шорт, боковик',
        'Контртрендовая / боковик. FINRESP L4 — short в диапазоне.'
    ),
    ('MACD Signal Cross', 'Трендовая. OsEngine MacdLine: long при HISTOGRAM>0 (MACD выше Signal), short при HISTOGRAM<0.'),
    ('ADX DI Trend', 'Трендовая. OsEngine AdxTrade: ADX>25 + направление по SMA(50); выход при ADX<20.'),
    ('SMA100 Trend', 'Трендовая. OsEngine SmaTrendSample (долгая SMA): long выше SMA(100), short ниже.'),
    ('LinReg Slope Trend', 'Трендовая. Следование наклону LinReg + фильтр SMA(20).'),
    ('PACC Momentum Trend', 'Трендовая. Ускорение цены PACC: long при PACC>0, short при PACC<0.'),
    ('RSI Extreme 20/80', 'Контртрендовая. OsEngine RsiTrade (жёсткие уровни): long RSI<20, short RSI>80.'),
    ('Stoch D Fade', 'Контртрендовая. OsEngine Stochastic по %D: long %D<20, short %D>80.'),
    ('CCI Extreme 200', 'Контртрендовая. OsEngine CciTrade (экстремум ±200).'),
    ('MACD Signal Fade', 'Контртрендовая. Fade против гистограммы MACD (зеркало MacdLine).'),
    ('ADX Exhaustion Fade', 'Контртрендовая. ADX>40 + RSI-экстремум — усталость тренда.'),
    ('ATR Quiet RSI', 'Контртрендовая. Низкая волатильность ATR + RSI fade.'),
    ('SMA Stretch Fade', 'Контртрендовая. Отрыв от SMA(20) + RSI — возврат к средней.'),
    ('Stoch RSI Combo', 'Контртрендовая (комбо). Stoch и RSI одновременно в экстремуме.'),
    ('PACC Reversal', 'Контртрендовая. Разворот ускорения PACC + RSI.'),
    ('EMA RSI Fade', 'Контртрендовая. Цена у EMA + RSI — откат к EMA.'),
    ('NRTR ROC Fade', 'Контртрендовая. OsEngine ContrTrendNrtrAndROC; прокси SMA(24)≈NRTR, RSI≈ROC.'),
    ('RAVI BB Fade', 'Контртрендовая. OsEngine ContrtrendRaviAndBollinger; прокси ADX<25 + BB.'),
    ('Stoch Aroon Fade', 'Контртрендовая. OsEngine ContrtrendStochAndAroon; прокси ADX + Stoch %K.'),
    ('MI SMA Reversal', 'Контртрендовая. OsEngine ContrtrendStrategyMiAndSma; прокси ATR GROWTH5 + SMA.'),
    ('SuperTrend CMO Fade', 'Контртрендовая. OsEngine ContrtrendSuperTrendAndCMO; прокси EMA(10) + RSI.'),
    ('Force Index Fade', 'Контртрендовая. OsEngine CounterTrendFI; прокси MACD HISTOGRAM + RSI.'),
    ('BB StdDev Fade', 'Контртрендовая. OsEngine CountertrendBollingerAndStdDev; прокси BB + ATR GROWTH5.'),
    ('BB Volume Fade', 'Контртрендовая. OsEngine CountertrendBollingerAndVolumes; прокси BB + ADX<30.')
) AS v(name, note)
WHERE l.name = v.name
  AND (l.note IS NULL OR btrim(l.note) = '');

-- Сделки по торговой логике (исполнение по сигналам индикаторов)
CREATE TABLE IF NOT EXISTS logic_trades (
    id BIGSERIAL PRIMARY KEY,
    logic_id INTEGER NOT NULL REFERENCES logics(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    security_id INTEGER NOT NULL REFERENCES securities(id) ON DELETE RESTRICT,
    timeframe_id INTEGER NOT NULL REFERENCES timeframes(id) ON DELETE RESTRICT,
    side_id INTEGER NOT NULL REFERENCES sides(id) ON DELETE RESTRICT,
    action_id INTEGER NOT NULL REFERENCES actions(id) ON DELETE RESTRICT,
    position_event VARCHAR(10) NOT NULL DEFAULT 'open'
        CHECK (position_event IN ('open', 'close')),
    signal_kind VARCHAR(10) NOT NULL CHECK (signal_kind IN ('trend', 'counter', 'cash_fund', 'opt')),
    signal_formula TEXT NOT NULL,
    quantity NUMERIC(20, 6) NOT NULL DEFAULT 1 CHECK (quantity > 0),
    price NUMERIC(18, 6) NOT NULL CHECK (price > 0),
    bar_dt TIMESTAMP NOT NULL,
    executed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_simulated BOOLEAN NOT NULL DEFAULT FALSE,
    is_fictitious BOOLEAN NOT NULL DEFAULT FALSE,
    is_shadow BOOLEAN NOT NULL DEFAULT FALSE,
    is_test BOOLEAN NOT NULL DEFAULT FALSE,
    run_id BIGINT,
    broker_order_id VARCHAR(100),
    status VARCHAR(20) NOT NULL DEFAULT 'filled'
        CHECK (status IN ('pending', 'submitted', 'filled', 'rejected', 'cancelled')),
    commission NUMERIC(18, 6) NOT NULL DEFAULT 0,
    financial_result NUMERIC(20, 6),
    note TEXT,
    trade_reason TEXT,
    opt_lane TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE logic_trades ADD COLUMN IF NOT EXISTS logic_id INTEGER REFERENCES logics(id) ON DELETE CASCADE;
ALTER TABLE logic_trades ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES accounts(id) ON DELETE RESTRICT;
ALTER TABLE logic_trades ADD COLUMN IF NOT EXISTS security_id INTEGER REFERENCES securities(id) ON DELETE RESTRICT;
ALTER TABLE logic_trades ADD COLUMN IF NOT EXISTS timeframe_id INTEGER REFERENCES timeframes(id) ON DELETE RESTRICT;
ALTER TABLE logic_trades ADD COLUMN IF NOT EXISTS side_id INTEGER REFERENCES sides(id) ON DELETE RESTRICT;
ALTER TABLE logic_trades ADD COLUMN IF NOT EXISTS action_id INTEGER REFERENCES actions(id) ON DELETE RESTRICT;

-- Upgrade: удаление логики должно убирать её сделки (раньше RESTRICT → ошибка FK).
DO $$
BEGIN
    ALTER TABLE logic_trades DROP CONSTRAINT IF EXISTS logic_trades_logic_id_fkey;
    ALTER TABLE logic_trades
      ADD CONSTRAINT logic_trades_logic_id_fkey
      FOREIGN KEY (logic_id) REFERENCES logics(id) ON DELETE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE logic_trades ADD COLUMN IF NOT EXISTS position_event VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (position_event IN ('open', 'close'));
ALTER TABLE logic_trades ADD COLUMN IF NOT EXISTS signal_kind VARCHAR(10) CHECK (signal_kind IN ('trend', 'counter', 'cash_fund', 'opt'));
ALTER TABLE logic_trades ADD COLUMN IF NOT EXISTS signal_formula TEXT;
-- Upgrade: cash_fund (парк) + opt (OPT promote reset closes)
ALTER TABLE logic_trades DROP CONSTRAINT IF EXISTS logic_trades_signal_kind_check;
DO $$
BEGIN
    ALTER TABLE logic_trades ADD CONSTRAINT logic_trades_signal_kind_check
        CHECK (signal_kind IN ('trend', 'counter', 'cash_fund', 'opt'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE logic_trades ADD COLUMN IF NOT EXISTS quantity NUMERIC(20, 6) NOT NULL DEFAULT 1 CHECK (quantity > 0);
ALTER TABLE logic_trades ADD COLUMN IF NOT EXISTS price NUMERIC(18, 6) CHECK (price > 0);
ALTER TABLE logic_trades ADD COLUMN IF NOT EXISTS bar_dt TIMESTAMP;
ALTER TABLE logic_trades ADD COLUMN IF NOT EXISTS executed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE logic_trades ADD COLUMN IF NOT EXISTS is_simulated BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE logic_trades ADD COLUMN IF NOT EXISTS is_fictitious BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE logic_trades ADD COLUMN IF NOT EXISTS is_shadow BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE logic_trades ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE logic_trades ADD COLUMN IF NOT EXISTS run_id BIGINT;
ALTER TABLE logic_trades ADD COLUMN IF NOT EXISTS broker_order_id VARCHAR(100);
ALTER TABLE logic_trades ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'filled' CHECK (status IN ('pending', 'submitted', 'filled', 'rejected', 'cancelled'));
ALTER TABLE logic_trades ADD COLUMN IF NOT EXISTS commission NUMERIC(18, 6) NOT NULL DEFAULT 0;
ALTER TABLE logic_trades ADD COLUMN IF NOT EXISTS financial_result NUMERIC(20, 6);
ALTER TABLE logic_trades ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE logic_trades ADD COLUMN IF NOT EXISTS trade_reason TEXT;
ALTER TABLE logic_trades ADD COLUMN IF NOT EXISTS opt_lane TEXT NOT NULL DEFAULT '';
ALTER TABLE logic_trades ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.




CREATE INDEX IF NOT EXISTS idx_logic_trades_logic_id ON logic_trades(logic_id);
CREATE INDEX IF NOT EXISTS idx_logic_trades_executed_at ON logic_trades(executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_logic_trades_security_id ON logic_trades(security_id);

-- Прогон теста, породивший сделку (NULL = бой / старые записи до v43c)

DO $$
BEGIN
    ALTER TABLE logic_trades ADD CONSTRAINT logic_trades_position_event_check
        CHECK (position_event IN ('open', 'close'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Backfill: Close side → position_event=close
UPDATE logic_trades lt
SET position_event = 'close'
FROM sides s
WHERE s.id = lt.side_id AND s.name = 'Close' AND lt.position_event = 'open';

UPDATE logic_trades lt
SET position_event = 'open'
FROM sides s
WHERE s.id = lt.side_id AND s.name = 'Open' AND lt.position_event = 'close';

ALTER TABLE logic_trades DROP CONSTRAINT IF EXISTS logic_trades_logic_id_security_id_signal_kind_bar_dt_key;
DROP INDEX IF EXISTS logic_trades_logic_id_security_id_signal_kind_bar_dt_key;
-- v40: одна сделка на open/close × сторону (action) на баре — сигналы объединяются AND
DROP INDEX IF EXISTS idx_logic_trades_signal_bar_book;
CREATE UNIQUE INDEX IF NOT EXISTS idx_logic_trades_signal_bar_book
    ON logic_trades (logic_id, security_id, position_event, action_id, bar_dt, is_test, is_shadow, opt_lane);

CREATE INDEX IF NOT EXISTS idx_logic_trades_test ON logic_trades(logic_id) WHERE is_test;
CREATE INDEX IF NOT EXISTS idx_logic_trades_opt_lane ON logic_trades(logic_id, opt_lane)
    WHERE opt_lane <> '';

COMMENT ON TABLE logic_trades IS
'Сделки logics: исполнение по logic_indicator_signals; is_simulated — фейковый счёт; is_fictitious — резерв';
COMMENT ON COLUMN logic_trades.is_simulated IS 'TRUE — сделка на фейковом счёте (бумажная торговля)';
COMMENT ON COLUMN logic_trades.is_fictitious IS 'Фиктивная сделка (резерв, заполнение позже)';
COMMENT ON COLUMN logic_trades.is_shadow IS
'Теневая сделка: не влияет на реальный депозит; режим возобновления после стоп-лосса по бумаге';
COMMENT ON COLUMN logic_trades.is_test IS
'TRUE — сделка исторического тестирования (отдельная книга, не смешивается с боевыми и live-теневыми)';
COMMENT ON COLUMN logic_trades.opt_lane IS
'Ветка OPT: пусто = чемпион; иначе напр. std_dev:up или period:down|std_dev:up. Не смешивать с is_shadow/is_test';
COMMENT ON COLUMN logic_trades.trade_reason IS
'Причина сделки: сигнал индикатора, stop_loss/take_profit (тип), market:close_all и т.п.';
COMMENT ON COLUMN logic_trades.bar_dt IS 'Свеча, на которой сработал сигнал';
COMMENT ON COLUMN logic_trades.commission IS 'Комиссия по сделке (фейк/тест: commission_pct % от номинала; real: T-Bank executedCommission/initialCommission)';
COMMENT ON COLUMN logic_trades.financial_result IS 'Итог PnL закрывающей сделки (сумма пакетов); NULL для открытия';
COMMENT ON COLUMN logic_trades.run_id IS
'FK → logic_backtest_runs: прогон теста, породивший сделку; NULL для боевых и legacy';

CREATE TABLE IF NOT EXISTS logic_backtest_runs (
    id BIGSERIAL PRIMARY KEY,
    logic_id INTEGER NOT NULL REFERENCES logics(id) ON DELETE CASCADE,
    date_from DATE NOT NULL,
    date_to DATE NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'pending'
        CHECK (status IN (
            'pending', 'loading_prices', 'loading_indicators', 'running',
            'completed', 'cancelled', 'failed'
        )),
    progress_pct NUMERIC(5, 2) NOT NULL DEFAULT 0,
    phase_message TEXT,
    phase_detail TEXT,
    current_bar_dt TIMESTAMP,
    total_bars INTEGER NOT NULL DEFAULT 0,
    processed_bars INTEGER NOT NULL DEFAULT 0,
    trades_created INTEGER NOT NULL DEFAULT 0,
    test_balance NUMERIC(20, 6),
    financial_result NUMERIC(20, 6),
    cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
    error_message TEXT,
    started_at TIMESTAMP,
    finished_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE logic_backtest_runs ADD COLUMN IF NOT EXISTS logic_id INTEGER REFERENCES logics(id) ON DELETE CASCADE;
ALTER TABLE logic_backtest_runs ADD COLUMN IF NOT EXISTS date_from DATE;
ALTER TABLE logic_backtest_runs ADD COLUMN IF NOT EXISTS date_to DATE;
ALTER TABLE logic_backtest_runs ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (status IN ( 'pending', 'loading_prices', 'loading_indicators', 'running', 'completed', 'cancelled', 'failed' ));
ALTER TABLE logic_backtest_runs ADD COLUMN IF NOT EXISTS progress_pct NUMERIC(5, 2) NOT NULL DEFAULT 0;
ALTER TABLE logic_backtest_runs ADD COLUMN IF NOT EXISTS phase_message TEXT;
ALTER TABLE logic_backtest_runs ADD COLUMN IF NOT EXISTS phase_detail TEXT;
ALTER TABLE logic_backtest_runs ADD COLUMN IF NOT EXISTS current_bar_dt TIMESTAMP;
ALTER TABLE logic_backtest_runs ADD COLUMN IF NOT EXISTS total_bars INTEGER NOT NULL DEFAULT 0;
ALTER TABLE logic_backtest_runs ADD COLUMN IF NOT EXISTS processed_bars INTEGER NOT NULL DEFAULT 0;
ALTER TABLE logic_backtest_runs ADD COLUMN IF NOT EXISTS trades_created INTEGER NOT NULL DEFAULT 0;
ALTER TABLE logic_backtest_runs ADD COLUMN IF NOT EXISTS test_balance NUMERIC(20, 6);
ALTER TABLE logic_backtest_runs ADD COLUMN IF NOT EXISTS financial_result NUMERIC(20, 6);
ALTER TABLE logic_backtest_runs ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE logic_backtest_runs ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE logic_backtest_runs ADD COLUMN IF NOT EXISTS portfolio_trading_paused BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE logic_backtest_runs ADD COLUMN IF NOT EXISTS portfolio_equity_peak NUMERIC(20, 6);
ALTER TABLE logic_backtest_runs ADD COLUMN IF NOT EXISTS portfolio_stop_resume_equity NUMERIC(20, 6);
ALTER TABLE logic_backtest_runs ADD COLUMN IF NOT EXISTS portfolio_stop_resume_baseline NUMERIC(20, 6);
ALTER TABLE logic_backtest_runs ADD COLUMN IF NOT EXISTS portfolio_tp_latched BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE logic_backtest_runs ADD COLUMN IF NOT EXISTS portfolio_linear_tp_armed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE logic_backtest_runs ADD COLUMN IF NOT EXISTS portfolio_linear_tp_peak_equity NUMERIC(20, 6);
ALTER TABLE logic_backtest_runs ADD COLUMN IF NOT EXISTS portfolio_linear_tp_arm_bar_dt TIMESTAMP;
ALTER TABLE logic_backtest_runs ADD COLUMN IF NOT EXISTS portfolio_linear_tp_latched BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN logic_backtest_runs.portfolio_linear_tp_latched IS
'После LTP close: не взводить снова, пока track% < arm%';
ALTER TABLE logic_backtest_runs ADD COLUMN IF NOT EXISTS started_at TIMESTAMP;
ALTER TABLE logic_backtest_runs ADD COLUMN IF NOT EXISTS finished_at TIMESTAMP;
ALTER TABLE logic_backtest_runs ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE logic_backtest_runs ADD COLUMN IF NOT EXISTS last_opt_eval_bar_dt TIMESTAMP;
COMMENT ON COLUMN logic_backtest_runs.last_opt_eval_bar_dt IS
'Курсор окна OPT в прогоне теста (отдельно от live last_opt_eval_bar_dt в logic_params)';

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.




CREATE INDEX IF NOT EXISTS idx_logic_backtest_runs_logic ON logic_backtest_runs(logic_id, created_at DESC);

-- FK logic_trades.run_id после CREATE logic_backtest_runs (порядок таблиц)
DO $$
BEGIN
    ALTER TABLE logic_trades
        ADD CONSTRAINT logic_trades_run_id_fkey
        FOREIGN KEY (run_id) REFERENCES logic_backtest_runs(id) ON DELETE SET NULL;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_logic_trades_run_id
    ON logic_trades(run_id)
    WHERE run_id IS NOT NULL;

COMMENT ON TABLE logic_backtest_runs IS
'Историческое тестирование: прогресс, период, итог (сделки is_test=TRUE)';

-- v49: archived backtest HTML reports (one row per run_id; rewritten on snapshot/finish)
CREATE TABLE IF NOT EXISTS logic_backtest_reports (
    id BIGSERIAL PRIMARY KEY,
    run_id BIGINT NOT NULL UNIQUE REFERENCES logic_backtest_runs(id) ON DELETE CASCADE,
    logic_id INTEGER NOT NULL REFERENCES logics(id) ON DELETE CASCADE,
    logic_name TEXT NOT NULL DEFAULT '',
    date_from DATE,
    date_to DATE,
    timeframe TEXT,
    run_status VARCHAR(30),
    is_snapshot BOOLEAN NOT NULL DEFAULT FALSE,
    deal_count INTEGER NOT NULL DEFAULT 0,
    net_pnl NUMERIC(20, 6),
    net_pnl_pct NUMERIC(12, 4),
    profit_factor NUMERIC(12, 4),
    max_drawdown_pct NUMERIC(12, 4),
    download_name TEXT,
    summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    html_body TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE logic_backtest_reports ADD COLUMN IF NOT EXISTS run_id BIGINT REFERENCES logic_backtest_runs(id) ON DELETE CASCADE;
ALTER TABLE logic_backtest_reports ADD COLUMN IF NOT EXISTS logic_id INTEGER REFERENCES logics(id) ON DELETE CASCADE;
ALTER TABLE logic_backtest_reports ADD COLUMN IF NOT EXISTS logic_name TEXT NOT NULL DEFAULT '';
ALTER TABLE logic_backtest_reports ADD COLUMN IF NOT EXISTS date_from DATE;
ALTER TABLE logic_backtest_reports ADD COLUMN IF NOT EXISTS date_to DATE;
ALTER TABLE logic_backtest_reports ADD COLUMN IF NOT EXISTS timeframe TEXT;
ALTER TABLE logic_backtest_reports ADD COLUMN IF NOT EXISTS run_status VARCHAR(30);
ALTER TABLE logic_backtest_reports ADD COLUMN IF NOT EXISTS is_snapshot BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE logic_backtest_reports ADD COLUMN IF NOT EXISTS deal_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE logic_backtest_reports ADD COLUMN IF NOT EXISTS net_pnl NUMERIC(20, 6);
ALTER TABLE logic_backtest_reports ADD COLUMN IF NOT EXISTS net_pnl_pct NUMERIC(12, 4);
ALTER TABLE logic_backtest_reports ADD COLUMN IF NOT EXISTS profit_factor NUMERIC(12, 4);
ALTER TABLE logic_backtest_reports ADD COLUMN IF NOT EXISTS max_drawdown_pct NUMERIC(12, 4);
ALTER TABLE logic_backtest_reports ADD COLUMN IF NOT EXISTS download_name TEXT;
ALTER TABLE logic_backtest_reports ADD COLUMN IF NOT EXISTS summary JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE logic_backtest_reports ADD COLUMN IF NOT EXISTS html_body TEXT NOT NULL DEFAULT '';
ALTER TABLE logic_backtest_reports ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE logic_backtest_reports ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS uq_logic_backtest_reports_run
    ON logic_backtest_reports(run_id);
CREATE INDEX IF NOT EXISTS idx_logic_backtest_reports_logic_updated
    ON logic_backtest_reports(logic_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_logic_backtest_reports_updated
    ON logic_backtest_reports(updated_at DESC);

COMMENT ON TABLE logic_backtest_reports IS
'Сохранённые отчёты тестов (HTML+summary). Пишется API вне bar-loop (finish / редкий snapshot).';

-- v52: история баз OPT (снимок при старте теста / promote в бою)
CREATE TABLE IF NOT EXISTS logic_opt_param_history (
    id BIGSERIAL PRIMARY KEY,
    logic_id INTEGER NOT NULL REFERENCES logics(id) ON DELETE CASCADE,
    run_id BIGINT REFERENCES logic_backtest_runs(id) ON DELETE CASCADE,
    bar_dt TIMESTAMP,
    event_kind TEXT NOT NULL CHECK (event_kind IN ('snapshot', 'promote')),
    lane TEXT NOT NULL DEFAULT '',
    params JSONB NOT NULL DEFAULT '{}'::jsonb,
    params_prev JSONB,
    opt_specs JSONB NOT NULL DEFAULT '{}'::jsonb,
    formulas JSONB NOT NULL DEFAULT '[]'::jsonb,
    champion_finres NUMERIC(20, 6),
    winner_finres NUMERIC(20, 6),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE logic_opt_param_history ADD COLUMN IF NOT EXISTS logic_id INTEGER REFERENCES logics(id) ON DELETE CASCADE;
ALTER TABLE logic_opt_param_history ADD COLUMN IF NOT EXISTS run_id BIGINT REFERENCES logic_backtest_runs(id) ON DELETE CASCADE;
ALTER TABLE logic_opt_param_history ADD COLUMN IF NOT EXISTS bar_dt TIMESTAMP;
ALTER TABLE logic_opt_param_history ADD COLUMN IF NOT EXISTS event_kind TEXT;
ALTER TABLE logic_opt_param_history ADD COLUMN IF NOT EXISTS lane TEXT NOT NULL DEFAULT '';
ALTER TABLE logic_opt_param_history ADD COLUMN IF NOT EXISTS params JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE logic_opt_param_history ADD COLUMN IF NOT EXISTS params_prev JSONB;
ALTER TABLE logic_opt_param_history ADD COLUMN IF NOT EXISTS opt_specs JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE logic_opt_param_history ADD COLUMN IF NOT EXISTS formulas JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE logic_opt_param_history ADD COLUMN IF NOT EXISTS champion_finres NUMERIC(20, 6);
ALTER TABLE logic_opt_param_history ADD COLUMN IF NOT EXISTS winner_finres NUMERIC(20, 6);
ALTER TABLE logic_opt_param_history ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_logic_opt_param_history_logic_created
    ON logic_opt_param_history(logic_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logic_opt_param_history_run
    ON logic_opt_param_history(run_id, created_at ASC)
    WHERE run_id IS NOT NULL;

COMMENT ON TABLE logic_opt_param_history IS
'Снимки и promote баз OPT/формул: для отчёта теста (история или один снимок).';

CREATE TABLE IF NOT EXISTS logic_backtest_security_state (
    run_id BIGINT NOT NULL REFERENCES logic_backtest_runs(id) ON DELETE CASCADE,
    security_id INTEGER NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
    real_trading_paused BOOLEAN NOT NULL DEFAULT FALSE,
    real_trading_paused_long BOOLEAN NOT NULL DEFAULT FALSE,
    real_trading_paused_short BOOLEAN NOT NULL DEFAULT FALSE,
    real_trading_inverted BOOLEAN NOT NULL DEFAULT FALSE,
    stop_resume_equity NUMERIC(20, 6),
    stop_resume_baseline NUMERIC(20, 6),
    stop_resume_equity_long NUMERIC(20, 6),
    stop_resume_baseline_long NUMERIC(20, 6),
    stop_resume_equity_short NUMERIC(20, 6),
    stop_resume_baseline_short NUMERIC(20, 6),
    linear_tp_armed BOOLEAN NOT NULL DEFAULT FALSE,
    linear_tp_last_price NUMERIC(18, 6),
    linear_tp_arm_bar_dt TIMESTAMP,
    PRIMARY KEY (run_id, security_id)
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE logic_backtest_security_state ADD COLUMN IF NOT EXISTS run_id BIGINT REFERENCES logic_backtest_runs(id) ON DELETE CASCADE;
ALTER TABLE logic_backtest_security_state ADD COLUMN IF NOT EXISTS security_id INTEGER REFERENCES securities(id) ON DELETE CASCADE;
ALTER TABLE logic_backtest_security_state ADD COLUMN IF NOT EXISTS real_trading_paused BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE logic_backtest_security_state ADD COLUMN IF NOT EXISTS real_trading_paused_long BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE logic_backtest_security_state ADD COLUMN IF NOT EXISTS real_trading_paused_short BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE logic_backtest_security_state ADD COLUMN IF NOT EXISTS real_trading_inverted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE logic_backtest_security_state ADD COLUMN IF NOT EXISTS stop_resume_equity NUMERIC(20, 6);
ALTER TABLE logic_backtest_security_state ADD COLUMN IF NOT EXISTS stop_resume_baseline NUMERIC(20, 6);
ALTER TABLE logic_backtest_security_state ADD COLUMN IF NOT EXISTS stop_resume_equity_long NUMERIC(20, 6);
ALTER TABLE logic_backtest_security_state ADD COLUMN IF NOT EXISTS stop_resume_baseline_long NUMERIC(20, 6);
ALTER TABLE logic_backtest_security_state ADD COLUMN IF NOT EXISTS stop_resume_equity_short NUMERIC(20, 6);
ALTER TABLE logic_backtest_security_state ADD COLUMN IF NOT EXISTS stop_resume_baseline_short NUMERIC(20, 6);
ALTER TABLE logic_backtest_security_state ADD COLUMN IF NOT EXISTS linear_tp_armed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE logic_backtest_security_state ADD COLUMN IF NOT EXISTS linear_tp_last_price NUMERIC(18, 6);
ALTER TABLE logic_backtest_security_state ADD COLUMN IF NOT EXISTS linear_tp_arm_bar_dt TIMESTAMP;

-- v48: migrate paper-level backtest pause → both sides (once)
UPDATE logic_backtest_security_state
SET
    real_trading_paused_long = TRUE,
    real_trading_paused_short = TRUE,
    stop_resume_equity_long = COALESCE(stop_resume_equity_long, stop_resume_equity),
    stop_resume_baseline_long = COALESCE(stop_resume_baseline_long, stop_resume_baseline),
    stop_resume_equity_short = COALESCE(stop_resume_equity_short, stop_resume_equity),
    stop_resume_baseline_short = COALESCE(stop_resume_baseline_short, stop_resume_baseline)
WHERE COALESCE(real_trading_paused, FALSE)
  AND NOT COALESCE(real_trading_paused_long, FALSE)
  AND NOT COALESCE(real_trading_paused_short, FALSE);

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.




COMMENT ON TABLE logic_backtest_security_state IS
'Пауза security_resume по бумаге×стороне (long/short) и локальная инверсия security_inversion внутри backtest (не меняет live logic_securities)';
COMMENT ON COLUMN logic_backtest_security_state.real_trading_paused_long IS
'Теневой режим Long внутри backtest после security_resume';
COMMENT ON COLUMN logic_backtest_security_state.real_trading_paused_short IS
'Теневой режим Short внутри backtest после security_resume';


-- Пакеты закрытия (FIFO / средняя): связь продажи с покупками
CREATE TABLE IF NOT EXISTS logic_trade_lots (
    id BIGSERIAL PRIMARY KEY,
    logic_id INTEGER NOT NULL REFERENCES logics(id) ON DELETE CASCADE,
    close_trade_id BIGINT NOT NULL REFERENCES logic_trades(id) ON DELETE CASCADE,
    open_trade_id BIGINT REFERENCES logic_trades(id) ON DELETE SET NULL,
    action_id INTEGER NOT NULL REFERENCES actions(id) ON DELETE RESTRICT,
    cost_method VARCHAR(10) NOT NULL DEFAULT 'FIFO'
        CHECK (cost_method IN ('FIFO', 'AVERAGE')),
    quantity NUMERIC(20, 6) NOT NULL CHECK (quantity > 0),
    close_amount NUMERIC(20, 6) NOT NULL,
    open_amount NUMERIC(20, 6) NOT NULL,
    close_commission NUMERIC(18, 6) NOT NULL DEFAULT 0,
    open_commission NUMERIC(18, 6) NOT NULL DEFAULT 0,
    financial_result NUMERIC(20, 6) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE logic_trade_lots ADD COLUMN IF NOT EXISTS logic_id INTEGER REFERENCES logics(id) ON DELETE CASCADE;
ALTER TABLE logic_trade_lots ADD COLUMN IF NOT EXISTS close_trade_id BIGINT REFERENCES logic_trades(id) ON DELETE CASCADE;
ALTER TABLE logic_trade_lots ADD COLUMN IF NOT EXISTS open_trade_id BIGINT REFERENCES logic_trades(id) ON DELETE SET NULL;
ALTER TABLE logic_trade_lots ADD COLUMN IF NOT EXISTS action_id INTEGER REFERENCES actions(id) ON DELETE RESTRICT;
ALTER TABLE logic_trade_lots ADD COLUMN IF NOT EXISTS cost_method VARCHAR(10) NOT NULL DEFAULT 'FIFO' CHECK (cost_method IN ('FIFO', 'AVERAGE'));
ALTER TABLE logic_trade_lots ADD COLUMN IF NOT EXISTS quantity NUMERIC(20, 6) CHECK (quantity > 0);
ALTER TABLE logic_trade_lots ADD COLUMN IF NOT EXISTS close_amount NUMERIC(20, 6);
ALTER TABLE logic_trade_lots ADD COLUMN IF NOT EXISTS open_amount NUMERIC(20, 6);
ALTER TABLE logic_trade_lots ADD COLUMN IF NOT EXISTS close_commission NUMERIC(18, 6) NOT NULL DEFAULT 0;
ALTER TABLE logic_trade_lots ADD COLUMN IF NOT EXISTS open_commission NUMERIC(18, 6) NOT NULL DEFAULT 0;
ALTER TABLE logic_trade_lots ADD COLUMN IF NOT EXISTS financial_result NUMERIC(20, 6);
ALTER TABLE logic_trade_lots ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.




CREATE INDEX IF NOT EXISTS idx_logic_trade_lots_close ON logic_trade_lots(close_trade_id);
CREATE INDEX IF NOT EXISTS idx_logic_trade_lots_open ON logic_trade_lots(open_trade_id);
CREATE INDEX IF NOT EXISTS idx_logic_trade_lots_logic ON logic_trade_lots(logic_id);

COMMENT ON TABLE logic_trade_lots IS
'Пакеты по сделкам: закрытие → открытие; PnL = доход − расход − комиссии';
COMMENT ON COLUMN logic_trade_lots.open_trade_id IS 'NULL при методе AVERAGE (средняя цена)';

-- ============================================
-- Таблица: futures_expirations (контракты фьючерсов)
-- ============================================
CREATE TABLE IF NOT EXISTS futures_expirations (
    id SERIAL PRIMARY KEY,
    security_id INTEGER NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
    prefix VARCHAR(50) NOT NULL,
    moex_secid VARCHAR(20),
    expiration_date DATE NOT NULL,
    tbank_figi VARCHAR(50),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE futures_expirations ADD COLUMN IF NOT EXISTS security_id INTEGER REFERENCES securities(id) ON DELETE CASCADE;
ALTER TABLE futures_expirations ADD COLUMN IF NOT EXISTS prefix VARCHAR(50);
ALTER TABLE futures_expirations ADD COLUMN IF NOT EXISTS moex_secid VARCHAR(20);
ALTER TABLE futures_expirations ADD COLUMN IF NOT EXISTS expiration_date DATE;
ALTER TABLE futures_expirations ADD COLUMN IF NOT EXISTS tbank_figi VARCHAR(50);
ALTER TABLE futures_expirations ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE futures_expirations ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.




CREATE INDEX IF NOT EXISTS idx_futures_exp_security_id ON futures_expirations(security_id);
CREATE INDEX IF NOT EXISTS idx_futures_exp_prefix ON futures_expirations(prefix);
CREATE INDEX IF NOT EXISTS idx_futures_exp_date ON futures_expirations(expiration_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_futures_exp_security_prefix ON futures_expirations(security_id, prefix);


COMMENT ON TABLE futures_expirations IS 'Контракты фьючерсов; prefix — SHORTNAME MOEX (CNY-9.26), moex_secid — SECID (CRU6) для T-Bank/MOEX. Sync из MOEX ISS.';

-- Ручной INSERT контрактов не нужен — sync_futures_expirations_from_moex подтягивает список с MOEX.
-- ============================================
-- Таблица: price_load_log (лог загрузки цен)
-- ============================================
CREATE TABLE IF NOT EXISTS price_load_log (
    id BIGSERIAL PRIMARY KEY,
    security_id INTEGER NOT NULL REFERENCES securities(id),
    timeframe_id INTEGER NOT NULL REFERENCES timeframes(id),
    date_from DATE NOT NULL,
    date_to DATE NOT NULL,
    source VARCHAR(20) NOT NULL,
    records_loaded INTEGER DEFAULT 0,
    contract_prefix VARCHAR(50),
    error_message TEXT,
    loaded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE price_load_log ADD COLUMN IF NOT EXISTS security_id INTEGER REFERENCES securities(id);
ALTER TABLE price_load_log ADD COLUMN IF NOT EXISTS timeframe_id INTEGER REFERENCES timeframes(id);
ALTER TABLE price_load_log ADD COLUMN IF NOT EXISTS date_from DATE;
ALTER TABLE price_load_log ADD COLUMN IF NOT EXISTS date_to DATE;
ALTER TABLE price_load_log ADD COLUMN IF NOT EXISTS source VARCHAR(20);
ALTER TABLE price_load_log ADD COLUMN IF NOT EXISTS records_loaded INTEGER DEFAULT 0;
ALTER TABLE price_load_log ADD COLUMN IF NOT EXISTS contract_prefix VARCHAR(50);
ALTER TABLE price_load_log ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE price_load_log ADD COLUMN IF NOT EXISTS loaded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.





CREATE INDEX IF NOT EXISTS idx_price_load_log_security ON price_load_log(security_id, timeframe_id);
CREATE INDEX IF NOT EXISTS idx_price_load_log_loaded_at ON price_load_log(loaded_at);

-- ============================================
-- Таблица: app_tech_log (технический журнал UI/API)
-- ============================================
CREATE TABLE IF NOT EXISTS app_tech_log (
    id BIGSERIAL PRIMARY KEY,
    trace_id UUID NOT NULL DEFAULT gen_random_uuid(),
    span_id VARCHAR(64) NOT NULL,
    parent_span_id VARCHAR(64),
    thread_key VARCHAR(128) NOT NULL,
    source VARCHAR(32) NOT NULL DEFAULT 'web',
    operation VARCHAR(128) NOT NULL,
    phase VARCHAR(16) NOT NULL CHECK (phase IN ('start', 'end', 'event')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMPTZ,
    duration_ms INTEGER,
    security_id INTEGER REFERENCES securities(id) ON DELETE SET NULL,
    timeframe_id INTEGER REFERENCES timeframes(id) ON DELETE SET NULL,
    logic_id INTEGER REFERENCES logics(id) ON DELETE SET NULL,
    sync_gen INTEGER,
    message TEXT,
    payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.
ALTER TABLE app_tech_log ADD COLUMN IF NOT EXISTS trace_id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE app_tech_log ADD COLUMN IF NOT EXISTS span_id VARCHAR(64);
ALTER TABLE app_tech_log ADD COLUMN IF NOT EXISTS parent_span_id VARCHAR(64);
ALTER TABLE app_tech_log ADD COLUMN IF NOT EXISTS thread_key VARCHAR(128);
ALTER TABLE app_tech_log ADD COLUMN IF NOT EXISTS source VARCHAR(32) NOT NULL DEFAULT 'web';
ALTER TABLE app_tech_log ADD COLUMN IF NOT EXISTS operation VARCHAR(128);
ALTER TABLE app_tech_log ADD COLUMN IF NOT EXISTS phase VARCHAR(16) CHECK (phase IN ('start', 'end', 'event'));
ALTER TABLE app_tech_log ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE app_tech_log ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;
ALTER TABLE app_tech_log ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
ALTER TABLE app_tech_log ADD COLUMN IF NOT EXISTS security_id INTEGER REFERENCES securities(id) ON DELETE SET NULL;
ALTER TABLE app_tech_log ADD COLUMN IF NOT EXISTS timeframe_id INTEGER REFERENCES timeframes(id) ON DELETE SET NULL;
ALTER TABLE app_tech_log ADD COLUMN IF NOT EXISTS logic_id INTEGER REFERENCES logics(id) ON DELETE SET NULL;
ALTER TABLE app_tech_log ADD COLUMN IF NOT EXISTS sync_gen INTEGER;
ALTER TABLE app_tech_log ADD COLUMN IF NOT EXISTS message TEXT;
ALTER TABLE app_tech_log ADD COLUMN IF NOT EXISTS payload JSONB;
ALTER TABLE app_tech_log ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.





CREATE INDEX IF NOT EXISTS idx_app_tech_log_created_at ON app_tech_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_tech_log_trace_id ON app_tech_log(trace_id);
CREATE INDEX IF NOT EXISTS idx_app_tech_log_thread_key ON app_tech_log(thread_key);
CREATE INDEX IF NOT EXISTS idx_app_tech_log_security ON app_tech_log(security_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_tech_log_logic_id ON app_tech_log(logic_id, created_at DESC);

COMMENT ON TABLE app_tech_log IS
'Технический журнал проекта: sync графика, trade runner, сигналы, параметры логики (если APP_TECH_LOGGING=1)';
COMMENT ON COLUMN app_tech_log.trace_id IS 'Цепочка одного жеста пользователя (pan/zoom)';
COMMENT ON COLUMN app_tech_log.thread_key IS 'Поток: sec:29:gen:3, logic:1:trade, trade-runner и т.п.';
COMMENT ON COLUMN app_tech_log.logic_id IS 'Торговая логика (trade runner, параметры, enable/disable)';
COMMENT ON COLUMN app_tech_log.phase IS 'start | end | event';

-- ============================================
-- Дополнительные индексы
-- ============================================
CREATE INDEX IF NOT EXISTS idx_security_types_name ON security_types(name);
CREATE INDEX IF NOT EXISTS idx_exchanges_name ON exchanges(name);
CREATE INDEX IF NOT EXISTS idx_securities_type_id ON securities(security_type_id);
CREATE INDEX IF NOT EXISTS idx_security_prefixes_security_id ON security_prefixes(security_id);
CREATE INDEX IF NOT EXISTS idx_timeframes_tf ON timeframes(tf);
CREATE INDEX IF NOT EXISTS idx_brokers_code ON brokers(code);
CREATE INDEX IF NOT EXISTS idx_indicators_code ON indicators(code);

-- ============================================
-- Комментарии ко всем таблицам и полям (PostgreSQL COMMENT ON)
-- ============================================

-- security_types
COMMENT ON COLUMN security_types.id IS 'Surrogate PK';
COMMENT ON COLUMN security_types.name IS 'Код типа: Stock, Futures, Bond …';
-- exchanges
COMMENT ON COLUMN exchanges.id IS 'Surrogate PK';
COMMENT ON COLUMN exchanges.name IS 'Код площадки: MOEX, SPB';

-- securities
COMMENT ON COLUMN securities.id IS 'Surrogate PK';
COMMENT ON COLUMN securities.name IS 'Полное наименование инструмента (уникально)';
COMMENT ON COLUMN securities.security_type_id IS 'FK → security_types';

-- security_prefixes
COMMENT ON COLUMN security_prefixes.id IS 'Surrogate PK';
COMMENT ON COLUMN security_prefixes.security_id IS 'FK → securities';
COMMENT ON COLUMN security_prefixes.exchange_id IS 'FK → exchanges';
COMMENT ON COLUMN security_prefixes.prefix IS 'Тикер на бирже (SBER, VTBR, Si …)';
COMMENT ON COLUMN security_prefixes.note IS 'Произвольная заметка';

-- timeframes
COMMENT ON COLUMN timeframes.id IS 'Surrogate PK';
COMMENT ON COLUMN timeframes.tf IS 'Код TF: M15, H1, D1 …';
COMMENT ON COLUMN timeframes.full_name IS 'Человекочитаемое название';
COMMENT ON COLUMN timeframes.sec IS 'Длительность одной свечи в секундах';

-- brokers
COMMENT ON TABLE brokers IS 'Брокеры / провайдеры API (T-Bank и др.)';
COMMENT ON COLUMN brokers.id IS 'Surrogate PK';
COMMENT ON COLUMN brokers.code IS 'Уникальный код брокера (T-BANK)';
COMMENT ON COLUMN brokers.name IS 'Отображаемое имя';
COMMENT ON COLUMN brokers.api_url IS 'Базовый URL REST API';
COMMENT ON COLUMN brokers.is_active IS 'Брокер доступен для подключения счетов';

-- accounts
COMMENT ON TABLE accounts IS 'Торговые счета брокера (real / fake); логики привязаны к account_id';
COMMENT ON COLUMN accounts.id IS 'Surrogate PK';
COMMENT ON COLUMN accounts.broker_id IS 'FK → brokers';
COMMENT ON COLUMN accounts.account_code IS 'Код счёта у брокера (уникален в рамках broker_id)';
COMMENT ON COLUMN accounts.name IS 'Имя счёта в UI';
COMMENT ON COLUMN accounts.account_type IS 'real — боевой; fake — бумажная торговля';
COMMENT ON COLUMN accounts.is_efficient IS 'Эффективный (маржинальный) счёт T-Bank';
COMMENT ON COLUMN accounts.token_encrypted IS 'Зашифрованный токен счёта (если отличается от глобального)';
COMMENT ON COLUMN accounts.token_hash IS 'Хеш токена для проверки без расшифровки';
COMMENT ON COLUMN accounts.is_active IS 'Счёт активен';
COMMENT ON COLUMN accounts.updated_at IS 'Дата последнего изменения';

-- prices
COMMENT ON COLUMN prices.id IS 'Surrogate PK';
COMMENT ON COLUMN prices.security_id IS 'FK → securities';
COMMENT ON COLUMN prices.timeframe_id IS 'FK → timeframes';
COMMENT ON COLUMN prices.dt IS 'Open time свечи (UTC/локаль БД)';
COMMENT ON COLUMN prices.open_price IS 'Цена открытия';
COMMENT ON COLUMN prices.high_price IS 'Максимум';
COMMENT ON COLUMN prices.low_price IS 'Минимум';
COMMENT ON COLUMN prices.close_price IS 'Цена закрытия';
COMMENT ON COLUMN prices.volume IS 'Объём в лотах/штуках';
COMMENT ON COLUMN prices.value IS 'Оборот в деньгах (MOEX resample)';

-- parameter_types (глобальные настройки приложения, не per-logic)
COMMENT ON TABLE parameter_types IS 'Справочник типов глобальных параметров (RSI_PERIOD, TBANK_API_TOKEN …)';
COMMENT ON COLUMN parameter_types.id IS 'Surrogate PK';
COMMENT ON COLUMN parameter_types.name IS 'Полное имя параметра';
COMMENT ON COLUMN parameter_types.short_name IS 'Ключ в коде (RSI_PERIOD, TBANK_API_TOKEN)';
COMMENT ON COLUMN parameter_types.value_type IS 'integer | number | boolean | text | secret';
COMMENT ON COLUMN parameter_types.default_value IS 'Значение по умолчанию (текст)';

-- parameter_sets
COMMENT ON TABLE parameter_sets IS 'Наборы глобальных параметров (обычно Default)';
COMMENT ON COLUMN parameter_sets.id IS 'Surrogate PK';
COMMENT ON COLUMN parameter_sets.name IS 'Имя набора (уникально)';

-- parameter_values
COMMENT ON TABLE parameter_values IS 'Значения глобальных parameter_types внутри parameter_sets';
COMMENT ON COLUMN parameter_values.id IS 'Surrogate PK';
COMMENT ON COLUMN parameter_values.parameter_set_id IS 'FK → parameter_sets';
COMMENT ON COLUMN parameter_values.parameter_type_id IS 'FK → parameter_types';
COMMENT ON COLUMN parameter_values.value IS 'Текущее значение (текст)';

-- indicators
COMMENT ON TABLE indicators IS 'Справочник индикаторов: код (SMA, RSI), formula/script, описание';
COMMENT ON COLUMN indicators.id IS 'Surrogate PK';
COMMENT ON COLUMN indicators.code IS 'Короткий код (@SMA в формулах сигналов)';
COMMENT ON COLUMN indicators.name IS 'Полное английское название';
COMMENT ON COLUMN indicators.category IS 'Группа: trend, momentum, volatility …';
COMMENT ON COLUMN indicators.is_active IS 'Индикатор доступен в UI и расчётах';
COMMENT ON COLUMN indicators.created_at IS 'Дата создания';
COMMENT ON COLUMN indicators.sig_trend_def IS 'Шаблон follow (signal_kind=trend): по течению / пробой';
COMMENT ON COLUMN indicators.sig_ct_def IS 'Шаблон fade (signal_kind=counter): против / возврат от края';
COMMENT ON COLUMN indicators.sig_profile IS
'Профиль шаблонов: trend_line | oscillator | channel | zero_line | strength | volume';

-- indicator_value_types
COMMENT ON TABLE indicator_value_types IS 'Линии/серии индикатора: RSI, OVERBOUGHT, MACD, UPPER …';
COMMENT ON COLUMN indicator_value_types.id IS 'Surrogate PK';
COMMENT ON COLUMN indicator_value_types.indicator_id IS 'FK → indicators';
COMMENT ON COLUMN indicator_value_types.code IS 'Код серии в рамках индикатора';
COMMENT ON COLUMN indicator_value_types.name IS 'Отображаемое имя линии';
COMMENT ON COLUMN indicator_value_types.value_type IS 'Тип значения (float …)';
COMMENT ON COLUMN indicator_value_types.is_threshold IS 'TRUE — горизонтальный порог на графике';
COMMENT ON COLUMN indicator_value_types.threshold_value IS 'Значение порога (70 для RSI OVERBOUGHT)';
COMMENT ON COLUMN indicator_value_types.description IS 'Описание серии';
COMMENT ON COLUMN indicator_value_types.display_order IS 'Порядок на графике';
COMMENT ON COLUMN indicator_value_types.created_at IS 'Дата создания';

-- security_indicator_series
COMMENT ON COLUMN security_indicator_series.id IS 'Surrogate PK';
COMMENT ON COLUMN security_indicator_series.security_id IS 'FK → securities';
COMMENT ON COLUMN security_indicator_series.indicator_id IS 'FK → indicators';
COMMENT ON COLUMN security_indicator_series.series_code IS 'Код серии (VALUE, K, D …)';
COMMENT ON COLUMN security_indicator_series.invoke_formula IS 'Формула расчёта: calc_ind_*_array или многочлен pp * (1;-2;1)';
COMMENT ON COLUMN security_indicator_series.param_period IS 'period для SMA/RSI/BB …';
COMMENT ON COLUMN security_indicator_series.param_fast_period IS 'fast_period для MACD';
COMMENT ON COLUMN security_indicator_series.param_slow_period IS 'slow_period для MACD';
COMMENT ON COLUMN security_indicator_series.param_signal_period IS 'signal_period для MACD';
COMMENT ON COLUMN security_indicator_series.param_std_dev IS 'std_dev для Bollinger';
COMMENT ON COLUMN security_indicator_series.param_k_period IS '%K period для STOCH';
COMMENT ON COLUMN security_indicator_series.param_d_period IS '%D period для STOCH';
COMMENT ON COLUMN security_indicator_series.param_smooth IS 'Сглаживание STOCH';
COMMENT ON COLUMN security_indicator_series.point_count IS 'Число баров в массивном расчёте';
COMMENT ON COLUMN security_indicator_series.display_order IS 'Порядок линий на графике';
COMMENT ON COLUMN security_indicator_series.is_active IS 'Серия участвует в sync/calc';
COMMENT ON COLUMN security_indicator_series.created_at IS 'Дата создания';

-- indicator_values
COMMENT ON TABLE indicator_values IS 'Рассчитанные значения индикаторов по бумаге, TF и времени';
COMMENT ON COLUMN indicator_values.id IS 'Surrogate PK';
COMMENT ON COLUMN indicator_values.indicator_id IS 'FK → indicators';
COMMENT ON COLUMN indicator_values.indicator_value_type_id IS 'FK → indicator_value_types (какая линия)';
COMMENT ON COLUMN indicator_values.security_id IS 'FK → securities';
COMMENT ON COLUMN indicator_values.timeframe_id IS 'FK → timeframes';
COMMENT ON COLUMN indicator_values.dt IS 'Open time свечи значения';
COMMENT ON COLUMN indicator_values.value IS 'Числовое значение индикатора';

-- logics (дополнение)
COMMENT ON COLUMN logics.id IS 'Surrogate PK; все дочерние таблицы ссылаются logic_id → logics.id';
COMMENT ON COLUMN logics.note IS 'Примечание: тип стратегии, источник, комментарий в свободной форме';

-- logic_param_defs
COMMENT ON COLUMN logic_param_defs.param_key IS 'Уникальный ключ параметра логики (timeframe, commission_pct …)';
COMMENT ON COLUMN logic_param_defs.name_ru IS 'Подпись в UI';
COMMENT ON COLUMN logic_param_defs.value_type IS 'number | integer | money | boolean | text';
COMMENT ON COLUMN logic_param_defs.default_value IS 'Значение при создании новой логики';
COMMENT ON COLUMN logic_param_defs.description IS 'Подсказка в UI';
COMMENT ON COLUMN logic_param_defs.display_order IS 'Порядок полей в форме параметров';

-- logic_params
COMMENT ON COLUMN logic_params.id IS 'Surrogate PK';
COMMENT ON COLUMN logic_params.logic_id IS 'FK → logics: параметры изолированы по логике';
COMMENT ON COLUMN logic_params.updated_at IS 'Время последнего изменения значения';

-- sides / actions (справочники сделок)
COMMENT ON TABLE sides IS 'Сторона сделки: Open (открытие) | Close (закрытие)';
COMMENT ON COLUMN sides.id IS 'Surrogate PK';
COMMENT ON COLUMN sides.name IS 'Open | Close';

COMMENT ON TABLE actions IS 'Направление позиции: Long | Short';
COMMENT ON COLUMN actions.id IS 'Surrogate PK';
COMMENT ON COLUMN actions.name IS 'Long | Short';

-- logic_indicator_signals (дополнение)
COMMENT ON COLUMN logic_indicator_signals.id IS 'Surrogate PK';
COMMENT ON COLUMN logic_indicator_signals.logic_id IS 'FK → logics';
COMMENT ON COLUMN logic_indicator_signals.indicator_id IS 'FK → indicators';
COMMENT ON COLUMN logic_indicator_signals.display_order IS 'Приоритет проверки сигналов';
COMMENT ON COLUMN logic_indicator_signals.is_active IS 'Сигнал участвует в trade runner';
COMMENT ON COLUMN logic_indicator_signals.created_at IS 'Дата создания';

-- logic_stops (дополнение)
COMMENT ON COLUMN logic_stops.id IS 'Surrogate PK';
COMMENT ON COLUMN logic_stops.logic_id IS 'FK → logics';
COMMENT ON COLUMN logic_stops.value IS 'Величина SL/TP (% или множитель ATR)';
COMMENT ON COLUMN logic_stops.display_order IS 'Порядок применения правил';
COMMENT ON COLUMN logic_stops.is_active IS 'Правило включено';
COMMENT ON COLUMN logic_stops.created_at IS 'Дата создания';

-- logic_securities (дополнение)
COMMENT ON COLUMN logic_securities.id IS 'Surrogate PK';
COMMENT ON COLUMN logic_securities.logic_id IS 'FK → logics';
COMMENT ON COLUMN logic_securities.security_id IS 'FK → securities — бумага в портфеле логики';
COMMENT ON COLUMN logic_securities.is_active IS 'Бумага участвует в торговле/тесте';
COMMENT ON COLUMN logic_securities.real_trading_inverted IS 'Локальная инверсия сигналов по бумаге внутри логики';
COMMENT ON COLUMN logic_securities.stop_resume_triggered_at IS 'Когда сработал security_resume SL';
COMMENT ON COLUMN logic_securities.created_at IS 'Дата добавления в портфель';

-- logic_trades (дополнение)
COMMENT ON COLUMN logic_trades.id IS 'Surrogate PK сделки';
COMMENT ON COLUMN logic_trades.logic_id IS 'FK → logics — все сделки логики здесь';
COMMENT ON COLUMN logic_trades.account_id IS 'FK → accounts — счёт исполнения';
COMMENT ON COLUMN logic_trades.security_id IS 'FK → securities';
COMMENT ON COLUMN logic_trades.timeframe_id IS 'FK → timeframes — TF сигнала';
COMMENT ON COLUMN logic_trades.side_id IS 'FK → sides: Open | Close';
COMMENT ON COLUMN logic_trades.action_id IS 'FK → actions: Long | Short';
COMMENT ON COLUMN logic_trades.position_event IS 'open | close — действие сигнала (копия с logic_indicator_signals)';
COMMENT ON COLUMN logic_trades.signal_kind IS 'trend | counter | cash_fund | opt — сигнал, парк кэша или закрытие OPT promote';
COMMENT ON COLUMN logic_trades.signal_formula IS 'Копия формулы logic_indicator_signals на момент сделки';
COMMENT ON COLUMN logic_trades.quantity IS 'Объём в лотах/штуках';
COMMENT ON COLUMN logic_trades.price IS 'Цена исполнения';
COMMENT ON COLUMN logic_trades.executed_at IS 'Время записи/исполнения';
COMMENT ON COLUMN logic_trades.is_simulated IS 'Бумажная торговля (fake account)';
COMMENT ON COLUMN logic_trades.broker_order_id IS 'ID заявки у брокера (real)';
COMMENT ON COLUMN logic_trades.status IS 'pending | submitted | filled | rejected | cancelled';
COMMENT ON COLUMN logic_trades.note IS 'Произвольная заметка';
COMMENT ON COLUMN logic_trades.created_at IS 'Дата создания записи';

-- logic_backtest_runs
COMMENT ON COLUMN logic_backtest_runs.id IS 'Surrogate PK прогона теста';
COMMENT ON COLUMN logic_backtest_runs.logic_id IS 'FK → logics';
COMMENT ON COLUMN logic_backtest_runs.date_from IS 'Начало периода теста';
COMMENT ON COLUMN logic_backtest_runs.date_to IS 'Конец периода теста';
COMMENT ON COLUMN logic_backtest_runs.status IS 'pending | loading_prices | running | completed | …';
COMMENT ON COLUMN logic_backtest_runs.progress_pct IS 'Прогресс 0–100';
COMMENT ON COLUMN logic_backtest_runs.phase_message IS 'Текущая фаза для UI';
COMMENT ON COLUMN logic_backtest_runs.phase_detail IS 'Детали фазы (JSON-текст)';
COMMENT ON COLUMN logic_backtest_runs.current_bar_dt IS 'Обрабатываемая свеча';
COMMENT ON COLUMN logic_backtest_runs.total_bars IS 'Всего баров в прогоне';
COMMENT ON COLUMN logic_backtest_runs.processed_bars IS 'Обработано баров';
COMMENT ON COLUMN logic_backtest_runs.trades_created IS 'Создано test-сделок';
COMMENT ON COLUMN logic_backtest_runs.test_balance IS 'Итоговый баланс в тесте';
COMMENT ON COLUMN logic_backtest_runs.financial_result IS 'Суммарный PnL теста';
COMMENT ON COLUMN logic_backtest_runs.cancel_requested IS 'Запрошена отмена';
COMMENT ON COLUMN logic_backtest_runs.error_message IS 'Текст ошибки при failed';
COMMENT ON COLUMN logic_backtest_runs.started_at IS 'Старт прогона';
COMMENT ON COLUMN logic_backtest_runs.finished_at IS 'Завершение прогона';
COMMENT ON COLUMN logic_backtest_runs.created_at IS 'Создание записи прогона';

-- logic_backtest_security_state
COMMENT ON COLUMN logic_backtest_security_state.run_id IS 'FK → logic_backtest_runs';
COMMENT ON COLUMN logic_backtest_security_state.security_id IS 'FK → securities';
COMMENT ON COLUMN logic_backtest_security_state.real_trading_paused IS 'Теневой режим внутри backtest';
COMMENT ON COLUMN logic_backtest_security_state.real_trading_inverted IS 'Локальная инверсия сигналов по бумаге внутри backtest';
COMMENT ON COLUMN logic_backtest_security_state.stop_resume_equity IS 'Цель возобновления (копия logic_securities)';
COMMENT ON COLUMN logic_backtest_security_state.stop_resume_baseline IS 'База после SL в тесте';

-- logic_trade_lots
COMMENT ON COLUMN logic_trade_lots.id IS 'Surrogate PK пакета закрытия';
COMMENT ON COLUMN logic_trade_lots.logic_id IS 'FK → logics';
COMMENT ON COLUMN logic_trade_lots.close_trade_id IS 'FK → logic_trades (Close)';
COMMENT ON COLUMN logic_trade_lots.action_id IS 'Long | Short — сторона закрываемой позиции';
COMMENT ON COLUMN logic_trade_lots.cost_method IS 'FIFO | AVERAGE — из logic_params.cost_method';
COMMENT ON COLUMN logic_trade_lots.quantity IS 'Объём в пакете';
COMMENT ON COLUMN logic_trade_lots.close_amount IS 'Сумма по цене закрытия';
COMMENT ON COLUMN logic_trade_lots.open_amount IS 'Сумма по цене открытия (FIFO) или средней';
COMMENT ON COLUMN logic_trade_lots.close_commission IS 'Комиссия закрывающей сделки (доля)';
COMMENT ON COLUMN logic_trade_lots.open_commission IS 'Комиссия открывающей сделки (доля)';
COMMENT ON COLUMN logic_trade_lots.financial_result IS 'PnL пакета';
COMMENT ON COLUMN logic_trade_lots.created_at IS 'Дата создания';

-- futures_expirations
COMMENT ON COLUMN futures_expirations.id IS 'Surrogate PK контракта';
COMMENT ON COLUMN futures_expirations.security_id IS 'FK → securities (группа фьючерса)';
COMMENT ON COLUMN futures_expirations.prefix IS 'SHORTNAME MOEX (Si-6.26, CNY-9.26)';
COMMENT ON COLUMN futures_expirations.moex_secid IS 'SECID для API (CRU6, SiM6)';
COMMENT ON COLUMN futures_expirations.expiration_date IS 'Дата экспирации';
COMMENT ON COLUMN futures_expirations.tbank_figi IS 'FIGI контракта в T-Bank';
COMMENT ON COLUMN futures_expirations.is_active IS 'Контракт доступен для загрузки цен';
COMMENT ON COLUMN futures_expirations.created_at IS 'Дата синхронизации';

-- price_load_log
COMMENT ON TABLE price_load_log IS 'Журнал загрузок цен (T-Bank / MOEX): период, источник, результат';
COMMENT ON COLUMN price_load_log.id IS 'Surrogate PK';
COMMENT ON COLUMN price_load_log.security_id IS 'FK → securities';
COMMENT ON COLUMN price_load_log.timeframe_id IS 'FK → timeframes';
COMMENT ON COLUMN price_load_log.date_from IS 'Начало запрошенного периода';
COMMENT ON COLUMN price_load_log.date_to IS 'Конец запрошенного периода';
COMMENT ON COLUMN price_load_log.source IS 'T-BANK | MOEX | …';
COMMENT ON COLUMN price_load_log.records_loaded IS 'Число загруженных свечей';
COMMENT ON COLUMN price_load_log.contract_prefix IS 'Конкретный фьючерсный контракт (если есть)';
COMMENT ON COLUMN price_load_log.error_message IS 'Текст ошибки загрузки';
COMMENT ON COLUMN price_load_log.loaded_at IS 'Время завершения загрузки';

-- app_tech_log (дополнение)
COMMENT ON COLUMN app_tech_log.id IS 'Surrogate PK';
COMMENT ON COLUMN app_tech_log.span_id IS 'Идентификатор span в trace';
COMMENT ON COLUMN app_tech_log.parent_span_id IS 'Родительский span';
COMMENT ON COLUMN app_tech_log.source IS 'web | api | sql';
COMMENT ON COLUMN app_tech_log.operation IS 'Имя операции (run_trade_cycle, backtest.start …)';
COMMENT ON COLUMN app_tech_log.started_at IS 'Начало операции';
COMMENT ON COLUMN app_tech_log.finished_at IS 'Конец операции';
COMMENT ON COLUMN app_tech_log.duration_ms IS 'Длительность, мс';
COMMENT ON COLUMN app_tech_log.security_id IS 'FK → securities (если применимо)';
COMMENT ON COLUMN app_tech_log.timeframe_id IS 'FK → timeframes (если применимо)';
COMMENT ON COLUMN app_tech_log.sync_gen IS 'Поколение sync графика';
COMMENT ON COLUMN app_tech_log.message IS 'Краткое сообщение';
COMMENT ON COLUMN app_tech_log.payload IS 'JSON с деталями';
COMMENT ON COLUMN app_tech_log.created_at IS 'Время записи в журнал';

-- Неторговые периоды MOEX TQBR по умолчанию (если у логики ещё пусто)
INSERT INTO logic_non_trading_intervals (
    logic_id, day_of_week, time_from, time_to, note, display_order, is_active
)
SELECT
    l.id,
    v.day_of_week,
    v.time_from,
    v.time_to,
    v.note,
    v.ord,
    TRUE
FROM logics l
CROSS JOIN (
    VALUES
        (1::SMALLINT, TIME '00:00', TIME '09:59:59', 'Пн до открытия', 1),
        (1::SMALLINT, TIME '18:40', TIME '23:59:59', 'Пн после сессии', 2),
        (2::SMALLINT, TIME '00:00', TIME '09:59:59', 'Вт до открытия', 3),
        (2::SMALLINT, TIME '18:40', TIME '23:59:59', 'Вт после сессии', 4),
        (3::SMALLINT, TIME '00:00', TIME '09:59:59', 'Ср до открытия', 5),
        (3::SMALLINT, TIME '18:40', TIME '23:59:59', 'Ср после сессии', 6),
        (4::SMALLINT, TIME '00:00', TIME '09:59:59', 'Чт до открытия', 7),
        (4::SMALLINT, TIME '18:40', TIME '23:59:59', 'Чт после сессии', 8),
        (5::SMALLINT, TIME '00:00', TIME '09:59:59', 'Пт до открытия', 9),
        (5::SMALLINT, TIME '18:40', TIME '23:59:59', 'Пт после сессии', 10),
        (6::SMALLINT, TIME '00:00', TIME '23:59:59', 'Суббота', 11),
        (7::SMALLINT, TIME '00:00', TIME '23:59:59', 'Воскресенье', 12)
) AS v(day_of_week, time_from, time_to, note, ord)
WHERE NOT EXISTS (
    SELECT 1 FROM logic_non_trading_intervals x WHERE x.logic_id = l.id
);

-- ============================================
-- Готово: шаг 1 завершён
-- ============================================
