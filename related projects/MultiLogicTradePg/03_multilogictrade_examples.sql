-- ============================================
-- MultiLogicTrade — шаг 3: примеры запросов
-- ============================================
-- Необязательный файл. Только SELECT/CALL для обучения и отладки.
-- Не создаёт объектов БД. Можно выполнять выборочно.
--
-- ================================================================
-- ПЕРЕД ЗАПУСКОМ
-- ================================================================
--
-- 1. Выполнены 00 → 01 → 02 (таблицы, функции, процедуры).
-- 2. Подключение: multilogictrade.
-- 3. Для примеров с load_prices_http / http_get:
--      расширение pgsql-http установлено (см. комментарии в 02).
-- 4. Для загрузки цен из T-Bank: токен в accounts.token_encrypted.
--
-- psql:
--   psql -U postgres -d multilogictrade -f 03_multilogictrade_examples.sql
-- ================================================================
-- ============================================

-- ПРИМЕРЫ ЗАПРОСОВ (SQL EXAMPLES)
-- ============================================

-- ============================================
-- 1. ЦЕНЫ (prices)
-- ============================================

-- 1.1 Получить все свечи Сбербанка (SBER, id=1) на M5 (id=4) за неделю
SELECT 
    p.dt,
    p.open_price,
    p.high_price,
    p.low_price,
    p.close_price,
    p.volume
FROM prices p
WHERE p.security_id = 1
  AND p.timeframe_id = 4
  AND p.dt BETWEEN '2026-06-17' AND '2026-06-24'
ORDER BY p.dt;

-- 1.2 Получить последнюю свечу по каждой бумаге на D1
SELECT DISTINCT ON (p.security_id)
    s.name AS security_name,
    sp.prefix,
    p.dt,
    p.close_price,
    p.volume
FROM prices p
JOIN securities s ON p.security_id = s.id
JOIN security_prefixes sp ON s.id = sp.security_id AND sp.exchange_id = 1
WHERE p.timeframe_id = 15  -- D1
ORDER BY p.security_id, p.dt DESC;

-- 1.3 Получить диапазон цен (мин/макс) за период
SELECT 
    s.name AS security_name,
    MIN(p.low_price) AS min_price,
    MAX(p.high_price) AS max_price,
    AVG(p.close_price) AS avg_close,
    SUM(p.volume) AS total_volume
FROM prices p
JOIN securities s ON p.security_id = s.id
WHERE p.security_id = 3   -- GAZP
  AND p.timeframe_id = 15 -- D1
  AND p.dt BETWEEN '2026-06-01' AND '2026-06-24'
GROUP BY s.name;

-- 1.4 Сравнение цен акции и фьючерса на неё
SELECT 
    p_stock.dt,
    p_stock.close_price AS stock_price,
    p_fut.close_price AS futures_price,
    p_fut.close_price - p_stock.close_price AS basis
FROM prices p_stock
JOIN prices p_fut ON p_stock.dt = p_fut.dt AND p_stock.timeframe_id = p_fut.timeframe_id
WHERE p_stock.security_id = 1   -- SBER акция
  AND p_fut.security_id = 46    -- SBRF фьючерс
  AND p_stock.timeframe_id = 4  -- M5
  AND p_stock.dt >= '2026-06-24'
ORDER BY p_stock.dt;

-- ============================================
-- 2. ИНДИКАТОРЫ (indicators + indicator_values)
-- ============================================

-- 2.1 Получить все линии RSI для Сбербанка на M5 за сегодня
SELECT 
    i.code AS indicator,
    ivt.code AS line_code,
    ivt.name AS line_name,
    iv.dt,
    iv.value
FROM indicator_values iv
JOIN indicators i ON iv.indicator_id = i.id
JOIN indicator_value_types ivt ON iv.indicator_value_type_id = ivt.id
WHERE i.code = 'RSI'
  AND iv.security_id = 1      -- SBER
  AND iv.timeframe_id = 4     -- M5
  AND iv.dt >= '2026-06-24'
ORDER BY iv.dt, ivt.display_order;

-- 2.2 Получить только основные линии (без порогов) MACD
SELECT 
    s.name AS security,
    tf.tf AS timeframe,
    iv.dt,
    MAX(CASE WHEN ivt.code = 'MACD' THEN iv.value END) AS macd_line,
    MAX(CASE WHEN ivt.code = 'SIGNAL' THEN iv.value END) AS signal_line,
    MAX(CASE WHEN ivt.code = 'HISTOGRAM' THEN iv.value END) AS histogram
FROM indicator_values iv
JOIN indicator_value_types ivt ON iv.indicator_value_type_id = ivt.id
JOIN securities s ON iv.security_id = s.id
JOIN timeframes tf ON iv.timeframe_id = tf.id
WHERE iv.indicator_id = 5       -- MACD
  AND iv.security_id = 1        -- SBER
  AND iv.timeframe_id = 4     -- M5
  AND iv.dt >= '2026-06-24'
GROUP BY s.name, tf.tf, iv.dt
ORDER BY iv.dt;

-- 2.3 Сигналы перекупленности/перепроданности (Stochastic)
SELECT 
    s.name AS security,
    iv.dt,
    MAX(CASE WHEN ivt.code = 'K' THEN iv.value END) AS k_line,
    MAX(CASE WHEN ivt.code = 'D' THEN iv.value END) AS d_line,
    CASE 
        WHEN MAX(CASE WHEN ivt.code = 'K' THEN iv.value END) > 80 THEN 'OVERBOUGHT'
        WHEN MAX(CASE WHEN ivt.code = 'K' THEN iv.value END) < 20 THEN 'OVERSOLD'
        ELSE 'NEUTRAL'
    END AS signal
FROM indicator_values iv
JOIN indicator_value_types ivt ON iv.indicator_value_type_id = ivt.id
JOIN securities s ON iv.security_id = s.id
WHERE iv.indicator_id = 6       -- STOCH
  AND iv.security_id = 1        -- SBER
  AND iv.timeframe_id = 4       -- M5
  AND iv.dt >= '2026-06-24'
GROUP BY s.name, iv.dt
HAVING MAX(CASE WHEN ivt.code = 'K' THEN iv.value END) IS NOT NULL
ORDER BY iv.dt;

-- 2.4 Все значения Bollinger Bands для Газпрома
SELECT 
    iv.dt,
    MAX(CASE WHEN ivt.code = 'UPPER' THEN iv.value END) AS upper_band,
    MAX(CASE WHEN ivt.code = 'MIDDLE' THEN iv.value END) AS middle_band,
    MAX(CASE WHEN ivt.code = 'LOWER' THEN iv.value END) AS lower_band,
    MAX(CASE WHEN ivt.code = 'BANDWIDTH' THEN iv.value END) AS bandwidth
FROM indicator_values iv
JOIN indicator_value_types ivt ON iv.indicator_value_type_id = ivt.id
WHERE iv.indicator_id = 7       -- BB
  AND iv.security_id = 3        -- GAZP
  AND iv.timeframe_id = 15    -- D1
  AND iv.dt >= '2026-06-01'
GROUP BY iv.dt
ORDER BY iv.dt;

-- 2.5 Сравнение двух индикаторов (RSI + MACD) — поиск дивергенций
WITH rsi_vals AS (
    SELECT iv.dt, iv.value AS rsi
    FROM indicator_values iv
    JOIN indicator_value_types ivt ON iv.indicator_value_type_id = ivt.id
    WHERE iv.indicator_id = 4 AND ivt.code = 'RSI'
      AND iv.security_id = 1 AND iv.timeframe_id = 15
),
macd_vals AS (
    SELECT iv.dt, iv.value AS macd
    FROM indicator_values iv
    JOIN indicator_value_types ivt ON iv.indicator_value_type_id = ivt.id
    WHERE iv.indicator_id = 5 AND ivt.code = 'MACD'
      AND iv.security_id = 1 AND iv.timeframe_id = 15
)
SELECT 
    r.dt,
    r.rsi,
    m.macd,
    p.close_price,
    CASE 
        WHEN r.rsi > 70 AND m.macd < 0 THEN 'BEARISH_DIVERGENCE'
        WHEN r.rsi < 30 AND m.macd > 0 THEN 'BULLISH_DIVERGENCE'
        ELSE 'NO_DIVERGENCE'
    END AS divergence_signal
FROM rsi_vals r
JOIN macd_vals m ON r.dt = m.dt
JOIN prices p ON p.security_id = 1 AND p.timeframe_id = 15 AND p.dt = r.dt
WHERE r.dt >= '2026-06-01'
ORDER BY r.dt;

-- ============================================
-- 3. БУМАГИ И ПРЕФИКСЫ (securities + security_prefixes)
-- ============================================

-- 3.1 Все акции с их тикерами на ММВБ
SELECT 
    s.id,
    s.name,
    st.name AS type_name,
    st.note AS type_ru,
    sp.prefix AS ticker_moex
FROM securities s
JOIN security_types st ON s.security_type_id = st.id
LEFT JOIN security_prefixes sp ON s.id = sp.security_id AND sp.exchange_id = 1
WHERE st.name = 'Stock'
ORDER BY s.name;

-- 3.2 Все фьючерсы с тикерами
SELECT 
    s.id,
    s.name,
    sp.prefix AS base_ticker,
    st.note AS type_ru
FROM securities s
JOIN security_types st ON s.security_type_id = st.id
LEFT JOIN security_prefixes sp ON s.id = sp.security_id AND sp.exchange_id = 1
WHERE st.name = 'Futures'
ORDER BY s.name;

-- 3.3 Найти бумагу по тикеру
SELECT 
    s.id,
    s.name,
    sp.prefix,
    e.name AS exchange
FROM securities s
JOIN security_prefixes sp ON s.id = sp.security_id
JOIN exchanges e ON sp.exchange_id = e.id
WHERE sp.prefix = 'SBER';

-- ============================================
-- 4. ПАРАМЕТРЫ (parameter_types + parameter_sets + parameter_values)
-- ============================================

-- 4.1 Все типы параметров
SELECT 
    pt.id,
    pt.name,
    pt.short_name,
    pt.value_type,
    pt.default_value
FROM parameter_types pt
ORDER BY pt.name;

-- 4.2 Значения параметров в конкретном сете
SELECT 
    ps.name AS set_name,
    pt.name AS param_name,
    pt.short_name,
    pv.value
FROM parameter_values pv
JOIN parameter_sets ps ON pv.parameter_set_id = ps.id
JOIN parameter_types pt ON pv.parameter_type_id = pt.id
WHERE ps.name = 'Default'
ORDER BY pt.name;

-- ============================================
-- 5. БРОКЕРЫ И СЧЕТА (brokers + accounts)
-- ============================================

-- 5.1 Все брокеры и их счета
SELECT 
    b.code AS broker_code,
    b.name AS broker_name,
    a.account_code,
    a.name AS account_name,
    a.account_type,
    a.is_efficient,
    CASE WHEN a.token_encrypted IS NOT NULL THEN 'YES' ELSE 'NO' END AS has_token
FROM brokers b
LEFT JOIN accounts a ON b.id = a.broker_id
ORDER BY b.code, a.account_code;

-- 5.2 Только активные счета с токенами
SELECT 
    b.name AS broker,
    a.account_code,
    a.name,
    a.is_efficient,
    a.created_at
FROM accounts a
JOIN brokers b ON a.broker_id = b.id
WHERE a.is_active = TRUE
  AND a.token_encrypted IS NOT NULL;

-- ============================================
-- 6. ЛОГИКИ (logics + logic_indicator_signals + logic_params)
-- ============================================

-- 6.1 Все логики с сигналами
SELECT 
    l.name AS logic_name,
    lis.position_event,
    lis.position_side,
    lis.signal_kind,
    lis.formula,
    i.code AS indicator
FROM logics l
JOIN logic_indicator_signals lis ON lis.logic_id = l.id
JOIN indicators i ON i.id = lis.indicator_id
ORDER BY l.name, lis.display_order;

-- 6.2 Сигналы на открытие лонга
SELECT 
    l.name,
    lis.formula,
    i.code AS indicator
FROM logics l
JOIN logic_indicator_signals lis ON lis.logic_id = l.id
JOIN indicators i ON i.id = lis.indicator_id
WHERE lis.position_event = 'open' AND lis.position_side = 'long';

-- 6.3 Демо-логика SMA (бумажная торговля) — параметры из logic_params
SELECT
    l.name,
    l.is_enabled,
    MAX(CASE WHEN lp.param_key = 'position_size_pct' THEN lp.param_value END) AS position_size_pct,
    MAX(CASE WHEN lp.param_key = 'max_open_positions' THEN lp.param_value END) AS max_open_positions,
    MAX(CASE WHEN lp.param_key = 'initial_balance' THEN lp.param_value END) AS initial_balance,
    MAX(CASE WHEN lp.param_key = 'current_balance' THEN lp.param_value END) AS current_balance,
    a.account_code,
    a.account_type
FROM logics l
JOIN accounts a ON a.id = l.account_id
LEFT JOIN logic_params lp ON lp.logic_id = l.id
WHERE l.name = 'SMA Price Cross Demo'
GROUP BY l.name, l.is_enabled, a.account_code, a.account_type;

-- 6.4 Сигналы и бумаги демо-логики
SELECT l.name, lis.position_side, lis.signal_kind, lis.formula, i.code AS indicator
FROM logics l
JOIN logic_indicator_signals lis ON lis.logic_id = l.id
JOIN indicators i ON i.id = lis.indicator_id
WHERE l.name = 'SMA Price Cross Demo'
ORDER BY lis.display_order;

SELECT l.name, sp.prefix, s.name AS security_name
FROM logics l
JOIN logic_securities ls ON ls.logic_id = l.id
JOIN securities s ON s.id = ls.security_id
LEFT JOIN security_prefixes sp ON sp.security_id = s.id AND sp.exchange_id = 1
WHERE l.name = 'SMA Price Cross Demo';

-- ============================================
-- 7. КОМПЛЕКСНЫЕ ЗАПРОСЫ
-- ============================================

-- 7.1 Полная картина: цена + индикаторы для одной бумаги
WITH price_data AS (
    SELECT dt, close_price, volume
    FROM prices
    WHERE security_id = 1 AND timeframe_id = 4
      AND dt >= '2026-06-24'
),
rsi_data AS (
    SELECT iv.dt, iv.value AS rsi
    FROM indicator_values iv
    JOIN indicator_value_types ivt ON iv.indicator_value_type_id = ivt.id
    WHERE iv.indicator_id = 4 AND ivt.code = 'RSI'
      AND iv.security_id = 1 AND iv.timeframe_id = 4
),
macd_data AS (
    SELECT iv.dt, iv.value AS macd
    FROM indicator_values iv
    JOIN indicator_value_types ivt ON iv.indicator_value_type_id = ivt.id
    WHERE iv.indicator_id = 5 AND ivt.code = 'MACD'
      AND iv.security_id = 1 AND iv.timeframe_id = 4
)
SELECT 
    p.dt,
    p.close_price,
    p.volume,
    r.rsi,
    m.macd,
    CASE 
        WHEN r.rsi < 30 AND m.macd > 0 THEN 'STRONG_BUY'
        WHEN r.rsi > 70 AND m.macd < 0 THEN 'STRONG_SELL'
        WHEN r.rsi < 30 THEN 'BUY'
        WHEN r.rsi > 70 THEN 'SELL'
        ELSE 'HOLD'
    END AS signal
FROM price_data p
LEFT JOIN rsi_data r ON p.dt = r.dt
LEFT JOIN macd_data m ON p.dt = m.dt
ORDER BY p.dt;

-- 7.2 Скринер: найти все бумаги где RSI < 30 (перепроданность)
SELECT 
    s.name AS security,
    sp.prefix AS ticker,
    tf.tf AS timeframe,
    iv.dt,
    iv.value AS rsi_value
FROM indicator_values iv
JOIN indicator_value_types ivt ON iv.indicator_value_type_id = ivt.id
JOIN securities s ON iv.security_id = s.id
JOIN security_prefixes sp ON s.id = sp.security_id AND sp.exchange_id = 1
JOIN timeframes tf ON iv.timeframe_id = tf.id
WHERE iv.indicator_id = 4
  AND ivt.code = 'RSI'
  AND iv.value < 30
  AND iv.dt = (SELECT MAX(dt) FROM indicator_values WHERE indicator_id = 4 AND indicator_value_type_id = ivt.id)
ORDER BY iv.value ASC;

-- 7.3 Сравнение таймфреймов: цена на M5 vs H1 vs D1
SELECT 
    tf.tf,
    p.dt,
    p.open_price,
    p.high_price,
    p.low_price,
    p.close_price,
    p.volume
FROM prices p
JOIN timeframes tf ON p.timeframe_id = tf.id
WHERE p.security_id = 1  -- SBER
  AND p.dt >= '2026-06-24'
  AND tf.tf IN ('M5', 'H1', 'D1')
ORDER BY p.dt, tf.sec;

-- 7.4 Объемный анализ: аномальные объемы (более 2σ от среднего)
WITH volume_stats AS (
    SELECT 
        security_id,
        timeframe_id,
        AVG(volume) AS avg_vol,
        STDDEV(volume) AS stddev_vol
    FROM prices
    WHERE dt >= '2026-06-01'
    GROUP BY security_id, timeframe_id
)
SELECT 
    s.name,
    p.dt,
    p.volume,
    vs.avg_vol,
    (p.volume - vs.avg_vol) / NULLIF(vs.stddev_vol, 0) AS z_score
FROM prices p
JOIN volume_stats vs ON p.security_id = vs.security_id AND p.timeframe_id = vs.timeframe_id
JOIN securities s ON p.security_id = s.id
WHERE p.timeframe_id = 4  -- M5
  AND p.dt >= '2026-06-24'
  AND p.volume > vs.avg_vol + 2 * vs.stddev_vol
ORDER BY z_score DESC
LIMIT 20;

-- ============================================
-- 8. АДМИНИСТРАТИВНЫЕ ЗАПРОСЫ
-- ============================================

-- 8.1 Статистика загрузки цен
SELECT 
    source,
    COUNT(*) AS load_count,
    SUM(records_loaded) AS total_records,
    MIN(loaded_at) AS first_load,
    MAX(loaded_at) AS last_load
FROM price_load_log
GROUP BY source
ORDER BY source;

-- 8.2 Последние ошибки загрузки
SELECT 
    s.name AS security,
    pll.date_from,
    pll.date_to,
    pll.source,
    pll.error_message,
    pll.loaded_at
FROM price_load_log pll
JOIN securities s ON pll.security_id = s.id
WHERE pll.error_message IS NOT NULL
ORDER BY pll.loaded_at DESC
LIMIT 10;

-- 8.3 Количество свечей по бумагам и таймфреймам
SELECT 
    s.name,
    tf.tf AS timeframe,
    COUNT(*) AS candle_count,
    MIN(p.dt) AS first_candle,
    MAX(p.dt) AS last_candle
FROM prices p
JOIN securities s ON p.security_id = s.id
JOIN timeframes tf ON p.timeframe_id = tf.id
GROUP BY s.name, tf.tf
ORDER BY s.name, tf.sec;

-- 8.4 Проверка целостности: дубли свечей (должно быть 0)
SELECT 
    security_id,
    timeframe_id,
    dt,
    COUNT(*) AS duplicate_count
FROM prices
GROUP BY security_id, timeframe_id, dt
HAVING COUNT(*) > 1;

-- 8.5 Размер таблиц
SELECT 
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;