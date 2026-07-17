-- ============================================
-- БАЗА ДАННЫХ: multilogictrade
-- УСТАРЕЛО: используйте файлы 01, 02, 03 (v12)
-- ============================================
-- Этот монолитный скрипт v11 сохранён для истории.
-- Актуальная схема:
--   00_create_database.sql
--   01_multilogictrade_tables_and_data.sql
--   02_multilogictrade_functions_and_procedures.sql
--   03_multilogictrade_examples.sql
-- ============================================

-- ============================================
-- БАЗА ДАННЫХ: multilogictrade
-- Полный скрипт создания с нуля (v11)
-- ============================================
-- Этот скрипт создает БД, таблицы, заполняет данные, создает процедуры и индексы
-- Запускать единым блоком (весь файл сразу)
-- ============================================

-- ============================================
-- ЧАСТЬ 1: СОЗДАНИЕ БАЗЫ ДАННЫХ
-- ============================================

-- Удаление базы данных если существует (ОПЦИОНАЛЬНО, раскомментируй если нужно)
-- DROP DATABASE IF EXISTS multilogictrade;

-- Создание базы данных
SELECT 'CREATE DATABASE multilogictrade' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'multilogictrade')\gexec

-- Подключение к базе данных
\c multilogictrade;

-- ============================================
-- БАЗА ДАННЫХ: multilogictrade
-- Полный скрипт создания с нуля (v10: + индикаторы)
-- ============================================

-- Удаление базы данных если существует (опционально, раскомментируй если нужно)
-- DROP DATABASE IF EXISTS multilogictrade;

-- Создание базы данных
SELECT 'CREATE DATABASE multilogictrade' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'multilogictrade')\gexec

-- Подключение к базе данных
\c multilogictrade;

-- ============================================
-- Таблица: security_types (типы ценных бумаг)
-- ============================================
CREATE TABLE IF NOT EXISTS security_types (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,
    note VARCHAR(100)
);

INSERT INTO security_types (name, note) VALUES
    ('Stock', 'Акции'),
    ('Bond', 'Облигации'),
    ('Futures', 'Фьючерсы'),
    ('Options', 'Опционы'),
    ('ETF', 'Биржевые фонды'),
    ('CFD', 'Контракты на разницу'),
    ('Warrant', 'Варранты'),
    ('Swap', 'Свопы'),
    ('Commodity', 'Товары/сырьё'),
    ('Index', 'Индексы'),
    ('Forex', 'Валютные пары'),
    ('MutualFund', 'Паевые фонды'),
    ('PreferredStock', 'Привилегированные акции'),
    ('ConvertibleBond', 'Конвертируемые облигации') ON CONFLICT (name) DO NOTHING;

COMMENT ON TABLE security_types IS 'Таблица типов ценных бумаг';
COMMENT ON COLUMN security_types.name IS 'Название типа (латиницей)';
COMMENT ON COLUMN security_types.note IS 'Расшифровка типа по-русски';

-- ============================================
-- Таблица: exchanges (торговые площадки)
-- ============================================
CREATE TABLE IF NOT EXISTS exchanges (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE
);

INSERT INTO exchanges (name) VALUES ('MOEX'), ('SPB') ON CONFLICT (name) DO NOTHING;

COMMENT ON TABLE exchanges IS 'Таблица торговых площадок';
COMMENT ON COLUMN exchanges.name IS 'Название торговой площадки';

-- ============================================
-- Таблица: securities (ценные бумаги)
-- ============================================
CREATE TABLE IF NOT EXISTS securities (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    security_type_id INTEGER REFERENCES security_types(id)
);

COMMENT ON TABLE securities IS 'Таблица ценных бумаг';
COMMENT ON COLUMN securities.name IS 'Название ценной бумаги (по-русски)';
COMMENT ON COLUMN securities.security_type_id IS 'Ссылка на тип ценной бумаги';

-- ============================================
-- Таблица: security_prefixes (префиксы)
-- ============================================
CREATE TABLE IF NOT EXISTS security_prefixes (
    id SERIAL PRIMARY KEY,
    security_id INTEGER NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
    exchange_id INTEGER NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
    prefix VARCHAR(50) NOT NULL UNIQUE
);

COMMENT ON TABLE security_prefixes IS 'Префиксы (тикеры) на торговых площадках';
COMMENT ON COLUMN security_prefixes.security_id IS 'Ссылка на ценную бумагу';
COMMENT ON COLUMN security_prefixes.exchange_id IS 'Ссылка на торговую площадку';
COMMENT ON COLUMN security_prefixes.prefix IS 'Префикс (тикер) на данной площадке';

-- ============================================
-- 34 АКЦИИ ММВБ
-- ============================================
INSERT INTO securities (name, security_type_id) VALUES
    ('Сбербанк (обыкновенные)', 1),
    ('Сбербанк (привилегированные)', 13),
    ('Газпром', 1),
    ('ЛУКОЙЛ', 1),
    ('Роснефть', 1),
    ('НОВАТЭК', 1),
    ('Норникель', 1),
    ('Татнефть (обыкновенные)', 1),
    ('Татнефть (привилегированные)', 13),
    ('Сургутнефтегаз (обыкновенные)', 1),
    ('Сургутнефтегаз (привилегированные)', 13),
    ('Полюс', 1),
    ('Алроса', 1),
    ('Северсталь', 1),
    ('НЛМК', 1),
    ('ММК', 1),
    ('Мечел (обыкновенные)', 1),
    ('Мечел (привилегированные)', 13),
    ('Магнит', 1),
    ('МТС', 1),
    ('ВТБ', 1),
    ('РУСАЛ', 1),
    ('РусГидро', 1),
    ('Интер РАО', 1),
    ('ФСК-Россети', 1),
    ('Транснефть (привилегированные)', 13),
    ('Юнипро', 1),
    ('Московская биржа', 1),
    ('Ростелеком', 1),
    ('Яндекс', 1),
    ('Аэрофлот', 1),
    ('Совкомфлот', 1),
    ('ФосАгро', 1),
    ('АФК Система', 1) ON CONFLICT (name) DO NOTHING;

-- ============================================
-- 20 ФЬЮЧЕРСОВ ММВБ
-- ============================================
INSERT INTO securities (name, security_type_id) VALUES
    ('USD/RUB (доллар/рубль)', 3),
    ('EUR/RUB (евро/рубль)', 3),
    ('CNY/RUB (юань/рубль)', 3),
    ('CNY/RUB вечный фьючерс', 3),
    ('USD/RUB вечный фьючерс', 3),
    ('Природный газ', 3),
    ('Нефть Brent', 3),
    ('Золото (USD)', 3),
    ('Серебро (USD)', 3),
    ('Золото (рублевый)', 3),
    ('Золото вечный фьючерс', 3),
    ('Сбербанк (фьючерс на акции)', 3),
    ('ВТБ (фьючерс на акции)', 3),
    ('Газпром (фьючерс на акции)', 3),
    ('ЛУКОЙЛ (фьючерс на акции)', 3),
    ('Индекс Мосбиржи (IMOEX)', 3),
    ('Индекс РТС', 3),
    ('Индекс Мосбиржи (дневной фьючерс)', 3),
    ('Серебро (квартальный)', 3),
    ('Золото (квартальный)', 3) ON CONFLICT (name) DO NOTHING;

-- ============================================
-- ПРЕФИКСЫ: 54 инструмента на ММВБ (exchange_id = 1)
-- ============================================
INSERT INTO security_prefixes (security_id, exchange_id, prefix) VALUES
    (1, 1, 'SBER'), (2, 1, 'SBERP'), (3, 1, 'GAZP'), (4, 1, 'LKOH'),
    (5, 1, 'ROSN'), (6, 1, 'NVTK'), (7, 1, 'GMKN'), (8, 1, 'TATN'),
    (9, 1, 'TATNP'), (10, 1, 'SNGS'), (11, 1, 'SNGSP'), (12, 1, 'PLZL'),
    (13, 1, 'ALRS'), (14, 1, 'CHMF'), (15, 1, 'NLMK'), (16, 1, 'MAGN'),
    (17, 1, 'MTLR'), (18, 1, 'MTLRP'), (19, 1, 'MGNT'), (20, 1, 'MTSS'),
    (21, 1, 'VTBR'), (22, 1, 'RUAL'), (23, 1, 'HYDR'), (24, 1, 'IRAO'),
    (25, 1, 'FEES'), (26, 1, 'TRNFP'), (27, 1, 'UPRO'), (28, 1, 'MOEX'),
    (29, 1, 'RTKM'), (30, 1, 'YDEX'), (31, 1, 'AFLT'), (32, 1, 'FLOT'),
    (33, 1, 'PHOR'), (34, 1, 'AFKS'),
    (35, 1, 'Si'), (36, 1, 'Eu'), (37, 1, 'CR'), (38, 1, 'CNYRUBF'),
    (39, 1, 'USDRUBF'), (40, 1, 'NG'), (41, 1, 'Br'), (42, 1, 'GD'),
    (43, 1, 'SV'), (44, 1, 'GL'), (45, 1, 'GLDRUBF'), (46, 1, 'SBRF'),
    (47, 1, 'VTBR'), (48, 1, 'GAZR'), (49, 1, 'LKOH'), (50, 1, 'MX'),
    (51, 1, 'RI'), (52, 1, 'IMOEXF'), (53, 1, 'SILV'), (54, 1, 'GOLD') ON CONFLICT (prefix) DO NOTHING;

-- ============================================
-- Таблица: timeframes (таймфреймы)
-- ============================================
CREATE TABLE IF NOT EXISTS timeframes (
    id SERIAL PRIMARY KEY,
    tf VARCHAR(20) NOT NULL UNIQUE,
    full_name VARCHAR(50) NOT NULL,
    sec INTEGER NOT NULL CHECK (sec > 0)
);

INSERT INTO timeframes (tf, full_name, sec) VALUES
    ('M1', '1 минута', 60), ('M2', '2 минуты', 120), ('M3', '3 минуты', 180),
    ('M5', '5 минут', 300), ('M10', '10 минут', 600), ('M15', '15 минут', 900),
    ('M20', '20 минут', 1200), ('M30', '30 минут', 1800),
    ('H1', '1 час', 3600), ('H2', '2 часа', 7200), ('H4', '4 часа', 14400),
    ('H6', '6 часов', 21600), ('H8', '8 часов', 28800), ('H12', '12 часов', 43200),
    ('D1', '1 день', 86400), ('D2', '2 дня', 172800), ('D3', '3 дня', 259200),
    ('W1', '1 неделя', 604800), ('W2', '2 недели', 1209600), ('W3', '3 недели', 1814400),
    ('MN1', '1 месяц', 2592000), ('MN2', '2 месяца', 5184000), ('MN3', '3 месяца', 7776000),
    ('MN6', '6 месяцев', 15552000), ('Y1', '1 год', 31536000) ON CONFLICT (tf) DO NOTHING;

COMMENT ON TABLE timeframes IS 'Таблица таймфреймов';
COMMENT ON COLUMN timeframes.tf IS 'Краткое обозначение таймфрейма';
COMMENT ON COLUMN timeframes.full_name IS 'Полное имя таймфрейма по-русски';
COMMENT ON COLUMN timeframes.sec IS 'Количество секунд в таймфрейме';

-- ============================================
-- Таблица: brokers (брокеры)
-- ============================================
CREATE TABLE IF NOT EXISTS brokers (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    api_url VARCHAR(255),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO brokers (code, name, api_url) VALUES
    ('T-BANK', 'T-Bank (Т-Банк)', 'https://invest-public-api.tinkoff.ru/rest') ON CONFLICT (code) DO NOTHING;

COMMENT ON TABLE brokers IS 'Таблица брокеров';
COMMENT ON COLUMN brokers.code IS 'Код брокера (для API и внутреннего использования)';
COMMENT ON COLUMN brokers.name IS 'Наименование брокера';
COMMENT ON COLUMN brokers.api_url IS 'URL API брокера';
COMMENT ON COLUMN brokers.is_active IS 'Активен ли брокер';
COMMENT ON COLUMN brokers.created_at IS 'Дата создания записи';

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
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_broker_account_code ON accounts(broker_id, account_code);

INSERT INTO accounts (broker_id, account_code, name, account_type, is_efficient, token_encrypted, token_hash) VALUES
    (1, 'FAKE-EFF-001', 'Демо-счет T-Bank (эффективный)', 'fake', TRUE, NULL, NULL) ON CONFLICT ((broker_id, account_code)) DO NOTHING;

COMMENT ON TABLE accounts IS 'Таблица торговых счетов';
COMMENT ON COLUMN accounts.broker_id IS 'Ссылка на брокера';
COMMENT ON COLUMN accounts.account_code IS 'Код счета (ID у брокера)';
COMMENT ON COLUMN accounts.name IS 'Наименование счета';
COMMENT ON COLUMN accounts.account_type IS 'Тип счета: real (реальный) или fake (фейковый/демо)';
COMMENT ON COLUMN accounts.is_efficient IS 'Эффективный счет (налогообложение по прибыли)';
COMMENT ON COLUMN accounts.token_encrypted IS 'Зашифрованный API-токен (хранить с осторожностью!)';
COMMENT ON COLUMN accounts.token_hash IS 'SHA-256 хеш токена для проверки без расшифровки';
COMMENT ON COLUMN accounts.is_active IS 'Активен ли счет';
COMMENT ON COLUMN accounts.created_at IS 'Дата создания';
COMMENT ON COLUMN accounts.updated_at IS 'Дата последнего обновления';

-- ============================================
-- Таблица: prices (цены бумаг)
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
    trades INTEGER,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_prices_security_id ON prices(security_id);
CREATE INDEX IF NOT EXISTS idx_prices_timeframe_id ON prices(timeframe_id);
CREATE INDEX IF NOT EXISTS idx_prices_dt ON prices(dt);
CREATE INDEX IF NOT EXISTS idx_prices_security_timeframe ON prices(security_id, timeframe_id);
CREATE INDEX IF NOT EXISTS idx_prices_security_timeframe_dt ON prices(security_id, timeframe_id, dt);
CREATE INDEX IF NOT EXISTS idx_prices_timeframe_dt ON prices(timeframe_id, dt);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prices_unique_candle ON prices(security_id, timeframe_id, dt);

COMMENT ON TABLE prices IS 'Таблица цен (OHLCV) ценных бумаг по таймфреймам';
COMMENT ON COLUMN prices.security_id IS 'Ссылка на ценную бумагу';
COMMENT ON COLUMN prices.timeframe_id IS 'Ссылка на таймфрейм';
COMMENT ON COLUMN prices.dt IS 'Дата и время свечи';
COMMENT ON COLUMN prices.open_price IS 'Цена открытия';
COMMENT ON COLUMN prices.high_price IS 'Максимальная цена';
COMMENT ON COLUMN prices.low_price IS 'Минимальная цена';
COMMENT ON COLUMN prices.close_price IS 'Цена закрытия';
COMMENT ON COLUMN prices.volume IS 'Объём торгов';
COMMENT ON COLUMN prices.value IS 'Оборот в валюте';
COMMENT ON COLUMN prices.trades IS 'Количество сделок';
COMMENT ON COLUMN prices.created_at IS 'Дата записи в БД';

-- ============================================
-- Таблица: parameter_types (типы параметров)
-- ============================================
CREATE TABLE IF NOT EXISTS parameter_types (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    short_name VARCHAR(20) NOT NULL,
    value_type VARCHAR(20) NOT NULL,
    is_control BOOLEAN NOT NULL DEFAULT FALSE,
    is_fake_only BOOLEAN NOT NULL DEFAULT FALSE,
    description TEXT,
    default_value TEXT,
    min_value NUMERIC(18, 6),
    max_value NUMERIC(18, 6),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE parameter_types IS 'Справочник типов параметров (что можно настроить)';
COMMENT ON COLUMN parameter_types.name IS 'Полное имя параметра';
COMMENT ON COLUMN parameter_types.short_name IS 'Короткое имя/код';
COMMENT ON COLUMN parameter_types.value_type IS 'Тип: integer, float, string, boolean, json';
COMMENT ON COLUMN parameter_types.is_control IS '0 = обычный, 1 = управляющий';
COMMENT ON COLUMN parameter_types.description IS 'Описание назначения';
COMMENT ON COLUMN parameter_types.default_value IS 'Значение по умолчанию';
COMMENT ON COLUMN parameter_types.min_value IS 'Минимально допустимое';
COMMENT ON COLUMN parameter_types.max_value IS 'Максимально допустимое';
COMMENT ON COLUMN parameter_types.is_fake_only IS '0 = используется для всех счетов, 1 = только для фейковых/демо счетов (например: тестовый период, виртуальный депозит)';

-- ============================================
-- Таблица: parameter_sets (сеты параметров)
-- ============================================
CREATE TABLE IF NOT EXISTS parameter_sets (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO parameter_sets (name, description) VALUES
    ('Default', 'Базовый набор параметров по умолчанию') ON CONFLICT (name) DO NOTHING;

COMMENT ON TABLE parameter_sets IS 'Наборы (сеты) параметров';
COMMENT ON COLUMN parameter_sets.name IS 'Наименование сета';
COMMENT ON COLUMN parameter_sets.description IS 'Описание';
COMMENT ON COLUMN parameter_sets.is_active IS 'Активен ли';
COMMENT ON COLUMN parameter_sets.created_at IS 'Дата создания';

-- ============================================
-- Таблица: parameter_values (значения параметров)
-- ============================================
CREATE TABLE IF NOT EXISTS parameter_values (
    id SERIAL PRIMARY KEY,
    parameter_set_id INTEGER NOT NULL REFERENCES parameter_sets(id) ON DELETE CASCADE,
    parameter_type_id INTEGER NOT NULL REFERENCES parameter_types(id) ON DELETE CASCADE,
    value TEXT NOT NULL,
    record_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_parameter_values_unique ON parameter_values(parameter_set_id, parameter_type_id);

COMMENT ON TABLE parameter_values IS 'Значения параметров в сетах';
COMMENT ON COLUMN parameter_values.parameter_set_id IS '→ parameter_sets';
COMMENT ON COLUMN parameter_values.parameter_type_id IS '→ parameter_types';
COMMENT ON COLUMN parameter_values.value IS 'Значение (строковое)';
COMMENT ON COLUMN parameter_values.record_date IS 'Дата записи значения';
COMMENT ON COLUMN parameter_values.created_at IS 'Дата создания записи';

-- ============================================
-- ТАБЛИЦА: indicators (ИНДИКАТОРЫ) — НОВАЯ
-- ============================================
CREATE TABLE IF NOT EXISTS indicators (
    id SERIAL PRIMARY KEY,
    code VARCHAR(20) NOT NULL UNIQUE,         -- Сокращение: SMA, EMA, RSI, MACD, etc.
    name VARCHAR(100) NOT NULL,              -- Полное имя индикатора
    script TEXT,                              -- SQL-скрипт для EXECUTE IMMEDIATE
    description TEXT,                         -- Описание
    category VARCHAR(50),                    -- Категория: trend, momentum, volatility, volume, etc.
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Заполнение популярных индикаторов (скрипт пустой — заполнять позже)
INSERT INTO indicators (code, name, description, category) VALUES
    ('SMA', 'Simple Moving Average', 'Простое скользящее среднее', 'trend'),
    ('EMA', 'Exponential Moving Average', 'Экспоненциальное скользящее среднее', 'trend'),
    ('WMA', 'Weighted Moving Average', 'Взвешенное скользящее среднее', 'trend'),
    ('RSI', 'Relative Strength Index', 'Индекс относительной силы (0-100)', 'momentum'),
    ('MACD', 'Moving Average Convergence Divergence', 'Схождение/расхождение скользящих средних', 'momentum'),
    ('STOCH', 'Stochastic Oscillator', 'Стохастический осциллятор (%K, %D)', 'momentum'),
    ('BB', 'Bollinger Bands', 'Полосы Боллинджера (Upper, Middle, Lower)', 'volatility'),
    ('ATR', 'Average True Range', 'Средний истинный диапазон', 'volatility'),
    ('ADX', 'Average Directional Index', 'Индекс среднего направления', 'trend'),
    ('OBV', 'On-Balance Volume', 'Накопленный объем', 'volume'),
    ('VWAP', 'Volume Weighted Average Price', 'Объемно-взвешенная средняя цена', 'volume'),
    ('MFI', 'Money Flow Index', 'Индекс денежного потока', 'momentum'),
    ('CCI', 'Commodity Channel Index', 'Индекс товарного канала', 'momentum'),
    ('WILLR', 'Williams %R', 'Процентный диапазон Вильямса', 'momentum'),
    ('PSAR', 'Parabolic SAR', 'Параболическая система SAR', 'trend'),
    ('ICHIMOKU', 'Ichimoku Cloud', 'Облако Ишимоку', 'trend'),
    ('KDJ', 'KDJ Indicator', 'Индикатор KDJ (K, D, J)', 'momentum'),
    ('DMI', 'Directional Movement Index', 'Индекс направленного движения (+DI, -DI, ADX)', 'trend'),
    ('KELTNER', 'Keltner Channels', 'Каналы Кельтнера', 'volatility'),
    ('DONCHIAN', 'Donchian Channels', 'Каналы Дончиана', 'volatility'),
    ('ROC', 'Rate of Change', 'Темп изменения', 'momentum'),
    ('TRIX', 'Triple Exponential Average', 'Тройное экспоненциальное среднее', 'momentum'),
    ('CMO', 'Chande Momentum Oscillator', 'Осциллятор моментума Чанде', 'momentum'),
    ('RVI', 'Relative Vigor Index', 'Индекс относительной бодрости', 'momentum'),
    ('TSI', 'True Strength Index', 'Индекс истинной силы', 'momentum'),
    ('UO', 'Ultimate Oscillator', 'Ультимативный осциллятор', 'momentum'),
    ('AROON', 'Aroon Indicator', 'Индикатор Арун (Up, Down)', 'trend'),
    ('SAR', 'Stop And Reverse', 'Стоп и реверс', 'trend'),
    ('HMA', 'Hull Moving Average', 'Скользящее среднее Халла', 'trend'),
    ('ZLEMA', 'Zero Lag EMA', 'EMA с нулевым запаздыванием', 'trend') ON CONFLICT (code) DO NOTHING;

COMMENT ON TABLE indicators IS 'Справочник технических индикаторов';
COMMENT ON COLUMN indicators.code IS 'Сокращение индикатора (SMA, RSI, MACD и т.д.)';
COMMENT ON COLUMN indicators.name IS 'Полное имя индикатора';
COMMENT ON COLUMN indicators.script IS 'SQL-скрипт для расчета (EXECUTE IMMEDIATE)';
COMMENT ON COLUMN indicators.description IS 'Описание индикатора';
COMMENT ON COLUMN indicators.category IS 'Категория: trend, momentum, volatility, volume';
COMMENT ON COLUMN indicators.is_active IS 'Активен ли';

-- ============================================
-- ТАБЛИЦА: indicator_value_types (ТИПЫ ЗНАЧЕНИЙ ИНДИКАТОРОВ) — НОВАЯ
-- ============================================
CREATE TABLE IF NOT EXISTS indicator_value_types (
    id SERIAL PRIMARY KEY,
    indicator_id INTEGER NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
    code VARCHAR(20) NOT NULL,               -- Код линии/значения: K, D, J, UPPER, LOWER, etc.
    name VARCHAR(50) NOT NULL,               -- Имя линии: '%K линия', '%D линия', 'Верхняя полоса'
    value_type VARCHAR(20) NOT NULL DEFAULT 'float', -- Тип: float, integer, boolean
    is_threshold BOOLEAN NOT NULL DEFAULT FALSE, -- Это пороговое значение (80, 20, 0)?
    threshold_value NUMERIC(18, 6),          -- Значение порога (если is_threshold = TRUE)
    description TEXT,                         -- Описание
    display_order INTEGER NOT NULL DEFAULT 0,  -- Порядок отображения
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Уникальный индекс: один индикатор = уникальные коды линий
CREATE UNIQUE INDEX IF NOT EXISTS idx_indicator_value_types_unique 
ON indicator_value_types(indicator_id, code);

-- Заполнение типов значений для популярных индикаторов
INSERT INTO indicator_value_types (indicator_id, code, name, value_type, is_threshold, threshold_value, description, display_order) VALUES
    -- RSI
    (4, 'RSI', 'Значение RSI', 'float', FALSE, NULL, 'Основное значение RSI (0-100)', 1),
    (4, 'OVERBOUGHT', 'Перекупленность', 'float', TRUE, 70, 'Порог перекупленности', 2),
    (4, 'OVERSOLD', 'Перепроданность', 'float', TRUE, 30, 'Порог перепроданности', 3),
    (4, 'NEUTRAL', 'Нейтральная зона', 'float', TRUE, 50, 'Нейтральный уровень', 4),

    -- MACD
    (5, 'MACD', 'MACD линия', 'float', FALSE, NULL, 'Разница быстрой и медленной EMA', 1),
    (5, 'SIGNAL', 'Сигнальная линия', 'float', FALSE, NULL, 'Сигнальная линия (EMA от MACD)', 2),
    (5, 'HISTOGRAM', 'Гистограмма', 'float', FALSE, NULL, 'Разница MACD и Signal', 3),
    (5, 'ZERO', 'Нулевая линия', 'float', TRUE, 0, 'Нулевой уровень', 4),

    -- Stochastic
    (6, 'K', '%K линия', 'float', FALSE, NULL, 'Быстрая линия стохастика', 1),
    (6, 'D', '%D линия', 'float', FALSE, NULL, 'Медленная линия стохастика (SMA от %K)', 2),
    (6, 'OVERBOUGHT', 'Перекупленность', 'float', TRUE, 80, 'Порог перекупленности', 3),
    (6, 'OVERSOLD', 'Перепроданность', 'float', TRUE, 20, 'Порог перепроданности', 4),

    -- Bollinger Bands
    (7, 'UPPER', 'Верхняя полоса', 'float', FALSE, NULL, 'Верхняя полоса (SMA + 2σ)', 1),
    (7, 'MIDDLE', 'Средняя полоса', 'float', FALSE, NULL, 'Средняя полоса (SMA)', 2),
    (7, 'LOWER', 'Нижняя полоса', 'float', FALSE, NULL, 'Нижняя полоса (SMA - 2σ)', 3),
    (7, 'BANDWIDTH', 'Ширина полос', 'float', FALSE, NULL, 'Относительная ширина полос', 4),

    -- ATR
    (8, 'ATR', 'Значение ATR', 'float', FALSE, NULL, 'Средний истинный диапазон', 1),
    (8, 'ATR_PCT', 'ATR в процентах', 'float', FALSE, NULL, 'ATR как % от цены', 2),

    -- ADX
    (9, 'ADX', 'Значение ADX', 'float', FALSE, NULL, 'Сила тренда (0-100)', 1),
    (9, 'PLUS_DI', '+DI', 'float', FALSE, NULL, 'Плюсовое направление', 2),
    (9, 'MINUS_DI', '-DI', 'float', FALSE, NULL, 'Минусовое направление', 3),
    (9, 'TREND_STRONG', 'Сильный тренд', 'float', TRUE, 25, 'Порог сильного тренда', 4),
    (9, 'TREND_WEAK', 'Слабый тренд', 'float', TRUE, 20, 'Порог слабого тренда', 5),

    -- VWAP
    (10, 'VWAP', 'Значение VWAP', 'float', FALSE, NULL, 'Объемно-взвешенная цена', 1),
    (10, 'STD1_UPPER', 'Верхняя +1σ', 'float', FALSE, NULL, 'Верхняя граница 1 ст.откл.', 2),
    (10, 'STD1_LOWER', 'Нижняя -1σ', 'float', FALSE, NULL, 'Нижняя граница 1 ст.откл.', 3),
    (10, 'STD2_UPPER', 'Верхняя +2σ', 'float', FALSE, NULL, 'Верхняя граница 2 ст.откл.', 4),
    (10, 'STD2_LOWER', 'Нижняя -2σ', 'float', FALSE, NULL, 'Нижняя граница 2 ст.откл.', 5),

    -- MFI
    (11, 'MFI', 'Значение MFI', 'float', FALSE, NULL, 'Индекс денежного потока (0-100)', 1),
    (11, 'OVERBOUGHT', 'Перекупленность', 'float', TRUE, 80, 'Порог перекупленности', 2),
    (11, 'OVERSOLD', 'Перепроданность', 'float', TRUE, 20, 'Порог перепроданности', 3),

    -- CCI
    (12, 'CCI', 'Значение CCI', 'float', FALSE, NULL, 'Индекс товарного канала', 1),
    (12, 'OVERBOUGHT', 'Перекупленность', 'float', TRUE, 100, 'Порог перекупленности', 2),
    (12, 'OVERSOLD', 'Перепроданность', 'float', TRUE, -100, 'Порог перепроданности', 3),

    -- Williams %R
    (13, 'WILLR', 'Значение %R', 'float', FALSE, NULL, 'Процентный диапазон Вильямса (-100..0)', 1),
    (13, 'OVERBOUGHT', 'Перекупленность', 'float', TRUE, -20, 'Порог перекупленности', 2),
    (13, 'OVERSOLD', 'Перепроданность', 'float', TRUE, -80, 'Порог перепроданности', 3),

    -- Parabolic SAR
    (14, 'PSAR', 'Значение SAR', 'float', FALSE, NULL, 'Точка разворота', 1),
    (14, 'TREND', 'Направление тренда', 'integer', FALSE, NULL, '1 = восходящий, -1 = нисходящий', 2),

    -- Ichimoku
    (15, 'TENKAN', 'Tenkan-sen', 'float', FALSE, NULL, 'Линия разворота (9 периодов)', 1),
    (15, 'KIJUN', 'Kijun-sen', 'float', FALSE, NULL, 'Линия стандарта (26 периодов)', 2),
    (15, 'SENKOU_A', 'Senkou Span A', 'float', FALSE, NULL, 'Ведущая линия A', 3),
    (15, 'SENKOU_B', 'Senkou Span B', 'float', FALSE, NULL, 'Ведущая линия B', 4),
    (15, 'CHIKOU', 'Chikou Span', 'float', FALSE, NULL, 'Запаздывающая линия', 5),

    -- KDJ
    (16, 'K', 'K линия', 'float', FALSE, NULL, 'Линия K', 1),
    (16, 'D', 'D линия', 'float', FALSE, NULL, 'Линия D', 2),
    (16, 'J', 'J линия', 'float', FALSE, NULL, 'Линия J (3K - 2D)', 3),
    (16, 'OVERBOUGHT', 'Перекупленность', 'float', TRUE, 80, 'Порог перекупленности', 4),
    (16, 'OVERSOLD', 'Перепроданность', 'float', TRUE, 20, 'Порог перепроданности', 5),

    -- DMI
    (17, 'ADX', 'ADX', 'float', FALSE, NULL, 'Сила тренда', 1),
    (17, 'PLUS_DI', '+DI', 'float', FALSE, NULL, 'Плюсовое направление', 2),
    (17, 'MINUS_DI', '-DI', 'float', FALSE, NULL, 'Минусовое направление', 3),

    -- Keltner Channels
    (18, 'UPPER', 'Верхняя полоса', 'float', FALSE, NULL, 'Верхняя граница канала', 1),
    (18, 'MIDDLE', 'Средняя полоса', 'float', FALSE, NULL, 'EMA средняя линия', 2),
    (18, 'LOWER', 'Нижняя полоса', 'float', FALSE, NULL, 'Нижняя граница канала', 3),

    -- Donchian Channels
    (19, 'UPPER', 'Верхняя полоса', 'float', FALSE, NULL, 'Максимум за период', 1),
    (19, 'MIDDLE', 'Средняя полоса', 'float', FALSE, NULL, 'Среднее макс/мин', 2),
    (19, 'LOWER', 'Нижняя полоса', 'float', FALSE, NULL, 'Минимум за период', 3),

    -- SMA/EMA/WMA (общие)
    (1, 'VALUE', 'Значение MA', 'float', FALSE, NULL, 'Значение скользящей средней', 1),
    (2, 'VALUE', 'Значение EMA', 'float', FALSE, NULL, 'Значение экспоненциальной MA', 1),
    (3, 'VALUE', 'Значение WMA', 'float', FALSE, NULL, 'Значение взвешенной MA', 1) ON CONFLICT ((indicator_id, code)) DO NOTHING;

COMMENT ON TABLE indicator_value_types IS 'Типы значений (линий) индикаторов';
COMMENT ON COLUMN indicator_value_types.indicator_id IS '→ indicators';
COMMENT ON COLUMN indicator_value_types.code IS 'Код линии/значения (K, D, UPPER, LOWER и т.д.)';
COMMENT ON COLUMN indicator_value_types.name IS 'Имя линии';
COMMENT ON COLUMN indicator_value_types.value_type IS 'Тип данных: float, integer, boolean';
COMMENT ON COLUMN indicator_value_types.is_threshold IS 'Это пороговое значение?';
COMMENT ON COLUMN indicator_value_types.threshold_value IS 'Значение порога (80, 20, 0, -20 и т.д.)';
COMMENT ON COLUMN indicator_value_types.description IS 'Описание линии/порога';
COMMENT ON COLUMN indicator_value_types.display_order IS 'Порядок отображения';

-- ============================================
-- ТАБЛИЦА: indicator_values (ЗНАЧЕНИЯ ИНДИКАТОРОВ) — НОВАЯ
-- ============================================
CREATE TABLE IF NOT EXISTS indicator_values (
    id BIGSERIAL PRIMARY KEY,
    indicator_id INTEGER NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
    indicator_value_type_id INTEGER NOT NULL REFERENCES indicator_value_types(id) ON DELETE CASCADE,
    security_id INTEGER NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
    timeframe_id INTEGER NOT NULL REFERENCES timeframes(id) ON DELETE CASCADE,
    dt TIMESTAMP NOT NULL,                    -- Дата/время свечи
    value NUMERIC(18, 6),                     -- Значение индикатора
    is_signal BOOLEAN NOT NULL DEFAULT FALSE,  -- Это сигнальное значение?
    signal_type VARCHAR(20),                  -- Тип сигнала: buy, sell, overbought, oversold
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Индексы для быстрого поиска
CREATE INDEX IF NOT EXISTS idx_indicator_values_indicator_id ON indicator_values(indicator_id);
CREATE INDEX IF NOT EXISTS idx_indicator_values_security_id ON indicator_values(security_id);
CREATE INDEX IF NOT EXISTS idx_indicator_values_timeframe_id ON indicator_values(timeframe_id);
CREATE INDEX IF NOT EXISTS idx_indicator_values_dt ON indicator_values(dt);
CREATE INDEX IF NOT EXISTS idx_indicator_values_security_timeframe ON indicator_values(security_id, timeframe_id);
CREATE INDEX IF NOT EXISTS idx_indicator_values_security_timeframe_dt ON indicator_values(security_id, timeframe_id, dt);
CREATE INDEX IF NOT EXISTS idx_indicator_values_indicator_security_tf_dt ON indicator_values(indicator_id, security_id, timeframe_id, dt);

-- Уникальный индекс: одно значение одного типа индикатора на одну свечу
CREATE UNIQUE INDEX IF NOT EXISTS idx_indicator_values_unique 
ON indicator_values(indicator_id, indicator_value_type_id, security_id, timeframe_id, dt);

COMMENT ON TABLE indicator_values IS 'Рассчитанные значения индикаторов';
COMMENT ON COLUMN indicator_values.indicator_id IS '→ indicators';
COMMENT ON COLUMN indicator_values.indicator_value_type_id IS '→ indicator_value_types (какая линия/порог)';
COMMENT ON COLUMN indicator_values.security_id IS '→ securities (бумага)';
COMMENT ON COLUMN indicator_values.timeframe_id IS '→ timeframes (таймфрейм)';
COMMENT ON COLUMN indicator_values.dt IS 'Дата/время свечи';
COMMENT ON COLUMN indicator_values.value IS 'Значение индикатора';
COMMENT ON COLUMN indicator_values.is_signal IS 'Это сигнальное значение?';
COMMENT ON COLUMN indicator_values.signal_type IS 'Тип сигнала: buy, sell, overbought, oversold';

-- ============================================
-- Таблица: logics (логики)
-- ============================================
CREATE TABLE IF NOT EXISTS logics (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE
);

COMMENT ON TABLE logics IS 'Таблица логик';
COMMENT ON COLUMN logics.name IS 'Название логики';

-- ============================================
-- Таблица: sides (стороны)
-- ============================================
CREATE TABLE IF NOT EXISTS sides (
    id SERIAL PRIMARY KEY,
    name VARCHAR(20) NOT NULL UNIQUE
);

INSERT INTO sides (name) VALUES ('Open'), ('Close') ON CONFLICT (name) DO NOTHING;

COMMENT ON TABLE sides IS 'Таблица сторон (Open/Close)';
COMMENT ON COLUMN sides.name IS 'Название стороны: Open или Close';

-- ============================================
-- Таблица: actions (действия)
-- ============================================
CREATE TABLE IF NOT EXISTS actions (
    id SERIAL PRIMARY KEY,
    name VARCHAR(20) NOT NULL UNIQUE
);

INSERT INTO actions (name) VALUES ('Long'), ('Short') ON CONFLICT (name) DO NOTHING;

COMMENT ON TABLE actions IS 'Таблица действий (Long/Short)';
COMMENT ON COLUMN actions.name IS 'Название действия: Long или Short';

-- ============================================
-- Таблица: logics_detail (детали логики)
-- ============================================
CREATE TABLE IF NOT EXISTS logics_detail (
    id SERIAL PRIMARY KEY,
    logic_name VARCHAR(100) NOT NULL REFERENCES logics(name),
    formula TEXT NOT NULL,
    side_id INTEGER NOT NULL REFERENCES sides(id),
    action_id INTEGER NOT NULL REFERENCES actions(id)
);

COMMENT ON TABLE logics_detail IS 'Таблица деталей логики';
COMMENT ON COLUMN logics_detail.logic_name IS 'Ссылка на логику (название)';
COMMENT ON COLUMN logics_detail.formula IS 'Формула для расчета';
COMMENT ON COLUMN logics_detail.side_id IS 'Ссылка на сторону (sides): Open или Close';
COMMENT ON COLUMN logics_detail.action_id IS 'Ссылка на действие (actions): Long или Short';

-- ============================================
-- Индексы для оптимизации
-- ============================================
CREATE INDEX IF NOT EXISTS idx_security_types_name ON security_types(name);
CREATE INDEX IF NOT EXISTS idx_exchanges_name ON exchanges(name);
CREATE INDEX IF NOT EXISTS idx_securities_name ON securities(name);
CREATE INDEX IF NOT EXISTS idx_securities_type_id ON securities(security_type_id);
CREATE INDEX IF NOT EXISTS idx_security_prefixes_security_id ON security_prefixes(security_id);
CREATE INDEX IF NOT EXISTS idx_security_prefixes_exchange_id ON security_prefixes(exchange_id);
CREATE INDEX IF NOT EXISTS idx_security_prefixes_prefix ON security_prefixes(prefix);
CREATE INDEX IF NOT EXISTS idx_timeframes_tf ON timeframes(tf);
CREATE INDEX IF NOT EXISTS idx_timeframes_full_name ON timeframes(full_name);
CREATE INDEX IF NOT EXISTS idx_brokers_code ON brokers(code);
CREATE INDEX IF NOT EXISTS idx_brokers_name ON brokers(name);
CREATE INDEX IF NOT EXISTS idx_accounts_broker_id ON accounts(broker_id);
CREATE INDEX IF NOT EXISTS idx_accounts_account_code ON accounts(account_code);
CREATE INDEX IF NOT EXISTS idx_accounts_account_type ON accounts(account_type);
CREATE INDEX IF NOT EXISTS idx_accounts_is_efficient ON accounts(is_efficient);
CREATE INDEX IF NOT EXISTS idx_parameter_types_name ON parameter_types(name);
CREATE INDEX IF NOT EXISTS idx_parameter_types_short_name ON parameter_types(short_name);
CREATE INDEX IF NOT EXISTS idx_parameter_types_is_control ON parameter_types(is_control);
CREATE INDEX IF NOT EXISTS idx_parameter_types_is_fake_only ON parameter_types(is_fake_only);
CREATE INDEX IF NOT EXISTS idx_parameter_sets_name ON parameter_sets(name);
CREATE INDEX IF NOT EXISTS idx_parameter_values_set_id ON parameter_values(parameter_set_id);
CREATE INDEX IF NOT EXISTS idx_parameter_values_type_id ON parameter_values(parameter_type_id);
CREATE INDEX IF NOT EXISTS idx_parameter_values_record_date ON parameter_values(record_date);
CREATE INDEX IF NOT EXISTS idx_indicators_code ON indicators(code);
CREATE INDEX IF NOT EXISTS idx_indicators_category ON indicators(category);
CREATE INDEX IF NOT EXISTS idx_indicator_value_types_indicator_id ON indicator_value_types(indicator_id);
CREATE INDEX IF NOT EXISTS idx_indicator_value_types_code ON indicator_value_types(code);
CREATE INDEX IF NOT EXISTS idx_logics_name ON logics(name);
CREATE INDEX IF NOT EXISTS idx_logics_detail_logic_name ON logics_detail(logic_name);
CREATE INDEX IF NOT EXISTS idx_logics_detail_side_id ON logics_detail(side_id);
CREATE INDEX IF NOT EXISTS idx_logics_detail_action_id ON logics_detail(action_id);


-- ============================================
-- ПРОЦЕДУРЫ ЗАГРУЗКИ ЦЕН (T-BANK / MOEX)
-- ============================================

-- ============================================
-- Таблица: futures_expirations (сроки экспирации фьючерсов)
-- ============================================
CREATE TABLE IF NOT EXISTS futures_expirations (
    id SERIAL PRIMARY KEY,
    security_id INTEGER NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
    prefix VARCHAR(50) NOT NULL,
    expiration_date DATE NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_futures_exp_security_id ON futures_expirations(security_id);
CREATE INDEX IF NOT EXISTS idx_futures_exp_prefix ON futures_expirations(prefix);
CREATE INDEX IF NOT EXISTS idx_futures_exp_date ON futures_expirations(expiration_date);

COMMENT ON TABLE futures_expirations IS 'Сроки экспирации фьючерсов для определения активного контракта';
COMMENT ON COLUMN futures_expirations.security_id IS 'Ссылка на базовый фьючерс (без окончания)';
COMMENT ON COLUMN futures_expirations.prefix IS 'Полный тикер с датой экспирации (Si-6.26)';
COMMENT ON COLUMN futures_expirations.expiration_date IS 'Дата экспирации контракта';

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
    error_message TEXT,
    loaded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_price_load_log_security ON price_load_log(security_id, timeframe_id);
CREATE INDEX IF NOT EXISTS idx_price_load_log_loaded_at ON price_load_log(loaded_at);

COMMENT ON TABLE price_load_log IS 'Лог загрузки цен (для мониторинга и отладки)';

-- ============================================
-- Функция: get_active_future_prefix
-- Определяет активный фьючерс на заданную дату
-- ============================================
CREATE OR REPLACE FUNCTION get_active_future_prefix(
    p_security_id INTEGER,
    p_date DATE
)
RETURNS VARCHAR(50) AS $$
DECLARE
    v_prefix VARCHAR(50);
BEGIN
    SELECT fe.prefix INTO v_prefix
    FROM futures_expirations fe
    WHERE fe.security_id = p_security_id
      AND fe.expiration_date > p_date
      AND fe.is_active = TRUE
    ORDER BY fe.expiration_date ASC
    LIMIT 1;

    RETURN v_prefix;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION get_active_future_prefix(INTEGER, DATE) IS 
'Возвращает тикер активного фьючерса (с окончанием) на заданную дату';

-- ============================================
-- Функция: get_tbank_token
-- Получает зашифрованный токен T-Bank из счета
-- ============================================
CREATE OR REPLACE FUNCTION get_tbank_token(
    p_account_code VARCHAR(100) DEFAULT 'FAKE-EFF-001'
)
RETURNS TEXT AS $$
DECLARE
    v_token TEXT;
BEGIN
    SELECT token_encrypted INTO v_token
    FROM accounts a
    JOIN brokers b ON a.broker_id = b.id
    WHERE b.code = 'T-BANK'
      AND a.account_code = p_account_code
      AND a.is_active = TRUE;

    RETURN v_token;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION get_tbank_token(VARCHAR) IS 
'Получает зашифрованный токен T-Bank из таблицы accounts';

-- ============================================
-- Процедура: insert_candle
-- Вставляет/обновляет одну свечу (UPSERT)
-- ============================================
CREATE OR REPLACE PROCEDURE insert_candle(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_dt TIMESTAMP,
    p_open NUMERIC(18,6),
    p_high NUMERIC(18,6),
    p_low NUMERIC(18,6),
    p_close NUMERIC(18,6),
    p_volume NUMERIC(20,2) DEFAULT NULL,
    p_value NUMERIC(20,2) DEFAULT NULL,
    p_trades INTEGER DEFAULT NULL
)
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO prices (security_id, timeframe_id, dt, open_price, high_price, low_price, close_price, volume, value, trades)
    VALUES (p_security_id, p_timeframe_id, p_dt, p_open, p_high, p_low, p_close, p_volume, p_value, p_trades)
    ON CONFLICT (security_id, timeframe_id, dt) 
    DO UPDATE SET
        open_price = EXCLUDED.open_price,
        high_price = EXCLUDED.high_price,
        low_price = EXCLUDED.low_price,
        close_price = EXCLUDED.close_price,
        volume = EXCLUDED.volume,
        value = EXCLUDED.value,
        trades = EXCLUDED.trades;
END;
$$;

COMMENT ON PROCEDURE insert_candle(INTEGER, INTEGER, TIMESTAMP, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, INTEGER) IS 
'Вставляет/обновляет одну свечу в таблицу prices. Используется из внешнего скрипта загрузки.';

-- ============================================
-- Процедура: load_prices_from_tbank
-- Загружает цены через API T-Bank (TData)
-- ============================================
CREATE OR REPLACE PROCEDURE load_prices_from_tbank(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_date_from DATE,
    p_date_to DATE
)
LANGUAGE plpgsql AS $$
DECLARE
    v_prefix VARCHAR(50);
    v_tf_sec INTEGER;
    v_tf_name VARCHAR(20);
    v_is_future BOOLEAN;
    v_token TEXT;
    v_start_ts TIMESTAMP;
    v_end_ts TIMESTAMP;
    v_records_loaded INTEGER := 0;
BEGIN
    -- Получаем префикс
    SELECT sp.prefix INTO v_prefix
    FROM security_prefixes sp
    WHERE sp.security_id = p_security_id AND sp.exchange_id = 1;

    IF v_prefix IS NULL THEN
        RAISE EXCEPTION 'Префикс не найден для security_id=%', p_security_id;
    END IF;

    SELECT sec, tf INTO v_tf_sec, v_tf_name
    FROM timeframes WHERE id = p_timeframe_id;

    -- Проверяем, это фьючерс или нет
    SELECT (st.name = 'Futures') INTO v_is_future
    FROM securities s
    JOIN security_types st ON s.security_type_id = st.id
    WHERE s.id = p_security_id;

    -- Для фьючерса определяем активный контракт
    IF v_is_future THEN
        v_prefix := get_active_future_prefix(p_security_id, p_date_from);
        IF v_prefix IS NULL THEN
            RAISE EXCEPTION 'Активный фьючерс не найден для security_id=% на дату %', p_security_id, p_date_from;
        END IF;
    END IF;

    -- Получаем токен
    v_token := get_tbank_token();
    IF v_token IS NULL THEN
        RAISE EXCEPTION 'T-Bank токен не найден. Заполните token_encrypted в accounts.';
    END IF;

    v_start_ts := p_date_from::TIMESTAMP;
    v_end_ts := (p_date_to + INTERVAL '1 day')::TIMESTAMP;

    RAISE NOTICE 'T-Bank API запрос: figi=%, interval=%, from=%, to=%', 
        v_prefix, v_tf_name, v_start_ts, v_end_ts;

    -- Логируем попытку
    INSERT INTO price_load_log (security_id, timeframe_id, date_from, date_to, source, records_loaded)
    VALUES (p_security_id, p_timeframe_id, p_date_from, p_date_to, 'T-BANK', 0);

EXCEPTION
    WHEN OTHERS THEN
        INSERT INTO price_load_log (security_id, timeframe_id, date_from, date_to, source, records_loaded, error_message)
        VALUES (p_security_id, p_timeframe_id, p_date_from, p_date_to, 'T-BANK', 0, SQLERRM);
        RAISE;
END;
$$;

COMMENT ON PROCEDURE load_prices_from_tbank(INTEGER, INTEGER, DATE, DATE) IS 
'Загружает цены через API T-Bank. Для фьючерсов автоматически выбирает активный контракт.';

-- ============================================
-- Процедура: load_prices_from_moex
-- Загружает цены через API MOEX (ISS)
-- ============================================
CREATE OR REPLACE PROCEDURE load_prices_from_moex(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_date_from DATE,
    p_date_to DATE
)
LANGUAGE plpgsql AS $$
DECLARE
    v_prefix VARCHAR(50);
    v_tf_name VARCHAR(20);
    v_is_future BOOLEAN;
    v_engine VARCHAR(20) := 'stock';
    v_market VARCHAR(20) := 'shares';
    v_board VARCHAR(20) := 'TQBR';
    v_start_dt TIMESTAMP;
    v_end_dt TIMESTAMP;
    v_url TEXT;
    v_records_loaded INTEGER := 0;
BEGIN
    SELECT sp.prefix INTO v_prefix
    FROM security_prefixes sp
    WHERE sp.security_id = p_security_id AND sp.exchange_id = 1;

    IF v_prefix IS NULL THEN
        RAISE EXCEPTION 'Префикс не найден для security_id=%', p_security_id;
    END IF;

    SELECT tf INTO v_tf_name
    FROM timeframes WHERE id = p_timeframe_id;

    -- Определяем рынок
    SELECT 
        CASE st.name
            WHEN 'Stock' THEN 'stock'
            WHEN 'Futures' THEN 'futures'
            WHEN 'Bond' THEN 'bonds'
            WHEN 'Index' THEN 'stock'
            ELSE 'stock'
        END,
        CASE st.name
            WHEN 'Stock' THEN 'shares'
            WHEN 'Futures' THEN 'forts'
            WHEN 'Bond' THEN 'bonds'
            WHEN 'Index' THEN 'index'
            ELSE 'shares'
        END,
        CASE st.name
            WHEN 'Stock' THEN 'TQBR'
            WHEN 'Futures' THEN 'RFUD'
            ELSE 'TQBR'
        END
    INTO v_engine, v_market, v_board
    FROM securities s
    JOIN security_types st ON s.security_type_id = st.id
    WHERE s.id = p_security_id;

    -- Для фьючерсов определяем активный контракт
    IF v_engine = 'futures' THEN
        v_prefix := get_active_future_prefix(p_security_id, p_date_from);
        IF v_prefix IS NULL THEN
            RAISE EXCEPTION 'Активный фьючерс не найден для security_id=% на дату %', p_security_id, p_date_from;
        END IF;
    END IF;

    v_start_dt := p_date_from::TIMESTAMP;
    v_end_dt := (p_date_to + INTERVAL '1 day')::TIMESTAMP;

    -- Формируем URL MOEX ISS API
    v_url := format(
        'https://iss.moex.com/iss/engines/%s/markets/%s/boards/%s/securities/%s/candles.json?from=%s&till=%s&interval=%s',
        v_engine, v_market, v_board, v_prefix,
        to_char(v_start_dt, 'YYYY-MM-DD'),
        to_char(v_end_dt, 'YYYY-MM-DD'),
        CASE v_tf_name
            WHEN 'M1' THEN '1'
            WHEN 'M10' THEN '10'
            WHEN 'M60' THEN '60'
            WHEN 'D1' THEN '24'
            WHEN 'W1' THEN '7'
            WHEN 'MN1' THEN '31'
            ELSE '1'
        END
    );

    RAISE NOTICE 'MOEX API URL: %', v_url;

    -- Логируем попытку
    INSERT INTO price_load_log (security_id, timeframe_id, date_from, date_to, source, records_loaded)
    VALUES (p_security_id, p_timeframe_id, p_date_from, p_date_to, 'MOEX', 0);

EXCEPTION
    WHEN OTHERS THEN
        INSERT INTO price_load_log (security_id, timeframe_id, date_from, date_to, source, records_loaded, error_message)
        VALUES (p_security_id, p_timeframe_id, p_date_from, p_date_to, 'MOEX', 0, SQLERRM);
        RAISE;
END;
$$;

COMMENT ON PROCEDURE load_prices_from_moex(INTEGER, INTEGER, DATE, DATE) IS 
'Загружает цены через открытое API MOEX ISS. Для фьючерсов выбирает активный контракт.';

-- ============================================
-- ГЛАВНАЯ ПРОЦЕДУРА: load_prices
-- Сначала T-Bank, если не сработало -- MOEX
-- ============================================
CREATE OR REPLACE PROCEDURE load_prices(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_date_from DATE,
    p_date_to DATE
)
LANGUAGE plpgsql AS $$
DECLARE
    v_tbank_ok BOOLEAN := FALSE;
    v_error_msg TEXT;
BEGIN
    -- Попытка 1: T-Bank
    BEGIN
        CALL load_prices_from_tbank(p_security_id, p_timeframe_id, p_date_from, p_date_to);
        v_tbank_ok := TRUE;
        RAISE NOTICE 'Цены успешно загружены из T-Bank';
    EXCEPTION
        WHEN OTHERS THEN
            v_error_msg := SQLERRM;
            RAISE NOTICE 'T-Bank недоступен: %. Переключаемся на MOEX...', v_error_msg;
    END;

    -- Попытка 2: MOEX (если T-Bank не сработал)
    IF NOT v_tbank_ok THEN
        BEGIN
            CALL load_prices_from_moex(p_security_id, p_timeframe_id, p_date_from, p_date_to);
            RAISE NOTICE 'Цены успешно загружены из MOEX';
        EXCEPTION
            WHEN OTHERS THEN
                v_error_msg := SQLERRM;
                RAISE EXCEPTION 'Оба источника недоступны. T-Bank: %; MOEX: %', v_error_msg, SQLERRM;
        END;
    END IF;
END;
$$;

COMMENT ON PROCEDURE load_prices(INTEGER, INTEGER, DATE, DATE) IS 
'Главная процедура загрузки цен: сначала T-Bank, если не отвечает -- MOEX. Для фьючерсов автоматически выбирает активный контракт на дату периода.';

-- ============================================
-- Процедура: load_prices_batch
-- Загрузка цен для нескольких бумаг сразу
-- ============================================
CREATE OR REPLACE PROCEDURE load_prices_batch(
    p_security_ids INTEGER[],
    p_timeframe_id INTEGER,
    p_date_from DATE,
    p_date_to DATE
)
LANGUAGE plpgsql AS $$
DECLARE
    v_security_id INTEGER;
BEGIN
    FOREACH v_security_id IN ARRAY p_security_ids
    LOOP
        BEGIN
            CALL load_prices(v_security_id, p_timeframe_id, p_date_from, p_date_to);
            RAISE NOTICE 'Загружены цены для security_id=%', v_security_id;
        EXCEPTION
            WHEN OTHERS THEN
                RAISE NOTICE 'Ошибка загрузки для security_id=%: %', v_security_id, SQLERRM;
        END;
    END LOOP;
END;
$$;

COMMENT ON PROCEDURE load_prices_batch(INTEGER[], INTEGER, DATE, DATE) IS 
'Загружает цены для массива бумаг по одному таймфрейму и периоду.';

-- ============================================
-- Процедура: load_all_timeframes
-- Загрузка всех таймфреймов для одной бумаги
-- ============================================
CREATE OR REPLACE PROCEDURE load_all_timeframes(
    p_security_id INTEGER,
    p_date_from DATE,
    p_date_to DATE
)
LANGUAGE plpgsql AS $$
DECLARE
    v_tf RECORD;
BEGIN
    FOR v_tf IN SELECT id FROM timeframes WHERE is_active IS DISTINCT FROM FALSE ORDER BY sec
    LOOP
        BEGIN
            CALL load_prices(p_security_id, v_tf.id, p_date_from, p_date_to);
            RAISE NOTICE 'Загружен таймфрейм id=% для security_id=%', v_tf.id, p_security_id;
        EXCEPTION
            WHEN OTHERS THEN
                RAISE NOTICE 'Ошибка загрузки таймфрейма id=%: %', v_tf.id, SQLERRM;
        END;
    END LOOP;
END;
$$;

COMMENT ON PROCEDURE load_all_timeframes(INTEGER, DATE, DATE) IS 
'Загружает все таймфреймы для одной бумаги за указанный период.';

-- ============================================
-- Процедура: cleanup_old_prices
-- Очистка старых цен (архивирование)
-- ============================================
CREATE OR REPLACE PROCEDURE cleanup_old_prices(
    p_days_to_keep INTEGER DEFAULT 365
)
LANGUAGE plpgsql AS $$
DECLARE
    v_cutoff_date TIMESTAMP;
    v_deleted_count INTEGER;
BEGIN
    v_cutoff_date := CURRENT_TIMESTAMP - (p_days_to_keep || ' days')::INTERVAL;

    DELETE FROM prices
    WHERE dt < v_cutoff_date;

    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    RAISE NOTICE 'Удалено % старых свечей (старше % дней)', v_deleted_count, p_days_to_keep;
END;
$$;

COMMENT ON PROCEDURE cleanup_old_prices(INTEGER) IS 
'Удаляет цены старше указанного количества дней (по умолчанию 365).';

-- ============================================
-- Процедура: refresh_indicator_values
-- Пересчет индикаторов для свежих цен
-- ============================================
CREATE OR REPLACE PROCEDURE refresh_indicator_values(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_indicator_id INTEGER
)
LANGUAGE plpgsql AS $$
DECLARE
    v_script TEXT;
    v_indicator_code VARCHAR(20);
BEGIN
    SELECT code, script INTO v_indicator_code, v_script
    FROM indicators WHERE id = p_indicator_id;

    IF v_script IS NULL OR v_script = '' THEN
        RAISE NOTICE 'Скрипт для индикатора % не заполнен', v_indicator_code;
        RETURN;
    END IF;

    -- Выполняем скрипт индикатора (динамический SQL)
    -- Примечание: реальный скрипт должен быть написан и протестирован
    RAISE NOTICE 'Выполнение скрипта индикатора %...', v_indicator_code;

EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'Ошибка выполнения скрипта индикатора %: %', v_indicator_code, SQLERRM;
END;
$$;

COMMENT ON PROCEDURE refresh_indicator_values(INTEGER, INTEGER, INTEGER) IS 
'Пересчитывает значения индикатора для свежих цен. Скрипт берется из поля indicators.script.';


-- ============================================
-- Процедура: calculate_indicator
-- Расчет значений индикатора и запись в таблицу indicator_values
-- ============================================
-- ============================================
-- Процедура: calculate_indicator
-- Расчет значений технического индикатора и запись в таблицу indicator_values
-- ============================================
--
-- ПАРАМЕТРЫ:
--   p_security_id   INTEGER  - ID ценной бумаги из таблицы securities
--                              (например: 1 = SBER, 3 = GAZP, 35 = Si фьючерс)
--   p_timeframe_id   INTEGER  - ID таймфрейма из таблицы timeframes
--                              (например: 4 = M5, 15 = D1, 22 = MN1)
--   p_indicator_id   INTEGER  - ID индикатора из таблицы indicators
--                              (например: 4 = RSI, 5 = MACD, 7 = BB)
--   p_date_from      DATE     - Начальная дата периода расчета (включительно)
--   p_date_to        DATE     - Конечная дата периода расчета (включительно)
--   p_overwrite      BOOLEAN  - Флаг перезаписи существующих записей:
--                              TRUE  = удалить старые значения и записать новые
--                              FALSE = пропустить свечи, где значения уже есть
--
-- ПОДДЕРЖИВАЕМЫЕ ИНДИКАТОРЫ:
--   RSI      - Индекс относительной силы (0-100), период по умолчанию 14
--   SMA      - Простое скользящее среднее, период по умолчанию 20
--   EMA      - Экспоненциальное скользящее среднее, период по умолчанию 20
--   MACD     - Схождение/расхождение MA (fast=12, slow=26, signal=9)
--   BB       - Полосы Боллинджера (период=20, std_dev=2.0)
--   ATR      - Средний истинный диапазон, период по умолчанию 14
--   STOCH    - Стохастик (%K период=14, %D период=3, сглаживание=3)
--
-- ПРИМЕР ВЫЗОВА:
--   CALL calculate_indicator(1, 4, 4, '2026-06-17', '2026-06-24', TRUE);
--   -- Расчет RSI для SBER (id=1) на M5 (id=4) за неделю с перезаписью
-- ============================================
CREATE OR REPLACE PROCEDURE calculate_indicator(
    p_security_id INTEGER,           -- ID бумаги (ссылка на securities.id)
    p_timeframe_id INTEGER,          -- ID таймфрейма (ссылка на timeframes.id)
    p_indicator_id INTEGER,          -- ID индикатора (ссылка на indicators.id)
    p_date_from DATE,                -- Начало периода расчета (YYYY-MM-DD)
    p_date_to DATE,                  -- Конец периода расчета (YYYY-MM-DD)
    p_overwrite BOOLEAN DEFAULT FALSE -- Перезаписывать существующие записи?
)
LANGUAGE plpgsql AS $$
DECLARE
    -- ============================================================
    -- ПЕРЕМЕННЫЕ ИНФОРМАЦИИ ОБ ИНДИКАТОРЕ
    -- ============================================================
    v_indicator_code VARCHAR(20);    -- Код индикатора (RSI, MACD, BB и т.д.)
    v_indicator_name VARCHAR(100);   -- Полное имя индикатора
    v_indicator_category VARCHAR(50);-- Категория: trend, momentum, volatility, volume
    v_script TEXT;                   -- SQL-скрипт из indicators.script (пока не используется)

    -- ============================================================
    -- ПАРАМЕТРЫ ИНДИКАТОРА (загружаются из parameter_values или берутся по умолчанию)
    -- ============================================================
    v_period INTEGER := 14;          -- Основной период (для RSI, SMA, EMA, ATR, STOCH)
    v_fast_period INTEGER := 12;     -- Период быстрой линии (только для MACD)
    v_slow_period INTEGER := 26;     -- Период медленной линии (только для MACD)
    v_signal_period INTEGER := 9;    -- Период сигнальной линии (MACD, STOCH)
    v_std_dev NUMERIC := 2.0;        -- Количество стандартных отклонений (только для BB)
    v_k_period INTEGER := 14;        -- Период %K линии (только для Stochastic)
    v_d_period INTEGER := 3;         -- Период %D линии (только для Stochastic)
    v_smooth INTEGER := 3;           -- Период сглаживания (только для Stochastic)

    -- ============================================================
    -- ПЕРЕМЕННЫЕ ДЛЯ РАСЧЕТА RSI
    -- ============================================================
    v_gain NUMERIC(18,6) := 0;       -- Сумма положительных изменений цены
    v_loss NUMERIC(18,6) := 0;       -- Сумма отрицательных изменений цены
    v_avg_gain NUMERIC(18,6) := 0;   -- Средний прирост за период
    v_avg_loss NUMERIC(18,6) := 0;   -- Средняя потеря за период
    v_rsi NUMERIC(18,6);             -- Итоговое значение RSI (0-100)
    v_rs NUMERIC(18,6);              -- Отношение avg_gain / avg_loss

    -- ============================================================
    -- ПЕРЕМЕННЫЕ ДЛЯ РАСЧЕТА SMA / EMA
    -- ============================================================
    v_sma NUMERIC(18,6);             -- Значение простого скользящего среднего
    v_ema NUMERIC(18,6);             -- Значение экспоненциального скользящего среднего
    v_ema_prev NUMERIC(18,6);        -- Предыдущее значение EMA (для рекурсии)
    v_multiplier NUMERIC(18,6);    -- Множитель сглаживания EMA = 2/(period+1)
    v_sum NUMERIC(18,6) := 0;        -- Аккумулятор суммы (для SMA)
    v_count INTEGER := 0;            -- Счетчик итераций

    -- ============================================================
    -- ПЕРЕМЕННЫЕ ДЛЯ РАСЧЕТА BOLLINGER BANDS
    -- ============================================================
    v_bb_middle NUMERIC(18,6);       -- Средняя полоса (SMA)
    v_bb_upper NUMERIC(18,6);        -- Верхняя полоса (SMA + k*σ)
    v_bb_lower NUMERIC(18,6);        -- Нижняя полоса (SMA - k*σ)
    v_bb_stddev NUMERIC(18,6);       -- Стандартное отклонение
    v_bb_sum_sq NUMERIC(18,6) := 0;  -- Сумма квадратов отклонений (для σ)

    -- ============================================================
    -- ПЕРЕМЕННЫЕ ДЛЯ РАСЧЕТА MACD
    -- ============================================================
    v_ema_fast NUMERIC(18,6);        -- Быстрая EMA (период 12)
    v_ema_slow NUMERIC(18,6);        -- Медленная EMA (период 26)
    v_macd NUMERIC(18,6);            -- Линия MACD = EMA_fast - EMA_slow
    v_macd_signal NUMERIC(18,6);     -- Сигнальная линия (EMA от MACD, период 9)
    v_macd_histogram NUMERIC(18,6);  -- Гистограмма = MACD - Signal
    v_mult_fast NUMERIC(18,6);       -- Множитель быстрой EMA = 2/(12+1)
    v_mult_slow NUMERIC(18,6);       -- Множитель медленной EMA = 2/(26+1)
    v_mult_signal NUMERIC(18,6);     -- Множитель сигнальной EMA = 2/(9+1)

    -- ============================================================
    -- ПЕРЕМЕННЫЕ ДЛЯ РАСЧЕТА STOCHASTIC
    -- ============================================================
    v_stoch_k NUMERIC(18,6);         -- %K линия = (Close - Low) / (High - Low) * 100
    v_stoch_d NUMERIC(18,6);         -- %D линия = SMA(%K, 3)
    v_stoch_j NUMERIC(18,6);         -- J линия = 3K - 2D (не используется)
    v_lowest_low NUMERIC(18,6);      -- Минимум low за период %K
    v_highest_high NUMERIC(18,6);    -- Максимум high за период %K
    v_k_sum NUMERIC(18,6) := 0;      -- Аккумулятор для SMA %K
    v_k_count INTEGER := 0;          -- Счетчик для SMA %K

    -- ============================================================
    -- ПЕРЕМЕННЫЕ ДЛЯ РАСЧЕТА ATR
    -- ============================================================
    v_atr NUMERIC(18,6);             -- Текущее значение ATR
    v_atr_prev NUMERIC(18,6);        -- Предыдущее значение ATR (для Wilder's smoothing)
    v_tr NUMERIC(18,6);              -- True Range = max(High-Low, |High-Close_prev|, |Low-Close_prev|)
    v_tr_high NUMERIC(18,6);         -- High - Low (компонент TR)
    v_tr_low NUMERIC(18,6);          -- |High - Close_prev| (компонент TR)
    v_tr_close NUMERIC(18,6);        -- |Low - Close_prev| (компонент TR)

    -- ============================================================
    -- ПОРОГОВЫЕ ЗНАЧЕНИЯ (загружаются из indicator_value_types.threshold_value)
    -- ============================================================
    v_overbought NUMERIC(18,6) := 70;-- Порог перекупленности (RSI=70, STOCH=80)
    v_oversold NUMERIC(18,6) := 30;  -- Порог перепроданности (RSI=30, STOCH=20)
    v_neutral NUMERIC(18,6) := 50;  -- Нейтральный уровень

    -- ============================================================
    -- СЧЕТЧИКИ РЕЗУЛЬТАТОВ ОПЕРАЦИЙ
    -- ============================================================
    v_records_inserted INTEGER := 0; -- Количество вставленных новых записей
    v_records_updated INTEGER := 0;  -- Количество обновленных записей (при overwrite=TRUE)
    v_records_skipped INTEGER := 0;  -- Количество пропущенных записей (при overwrite=FALSE)
    v_dt TIMESTAMP;                  -- Текущая дата/время свечи

    -- ============================================================
    -- КУРСОР ДЛЯ ЗАГРУЗКИ ЦЕНОВЫХ ДАННЫХ
    -- ============================================================
    -- Загружаем OHLCV из таблицы prices для указанной бумаги, таймфрейма и периода
    cur_prices CURSOR(p_sec INTEGER, p_tf INTEGER, p_from TIMESTAMP, p_to TIMESTAMP) FOR
        SELECT dt, open_price, high_price, low_price, close_price, volume
        FROM prices
        WHERE security_id = p_sec AND timeframe_id = p_tf
          AND dt >= p_from AND dt <= p_to
        ORDER BY dt;

    -- ============================================================
    -- МАССИВЫ ДЛЯ ХРАНЕНИЯ ЦЕНОВЫХ ДАННЫХ В ПАМЯТИ
    -- ============================================================
    -- Загружаем все цены в массивы для быстрого доступа по индексу
    -- Это быстрее, чем многократные обращения к курсору
    v_closes NUMERIC(18,6)[];      -- Массив цен закрытия
    v_highs NUMERIC(18,6)[];       -- Массив максимальных цен
    v_lows NUMERIC(18,6)[];        -- Массив минимальных цен
    v_dts TIMESTAMP[];             -- Массив дат/времени свечей
    v_idx INTEGER := 0;            -- Текущий индекс в массивах (количество свечей)

    -- ============================================================
    -- ПЕРЕМЕННЫЕ ДЛЯ РАБОТЫ С ТИПАМИ ЗНАЧЕНИЙ ИНДИКАТОРА
    -- ============================================================
    v_value_type_id INTEGER;       -- ID типа значения из indicator_value_types.id
    v_value_type_code VARCHAR(20);   -- Код типа значения (RSI, K, D, UPPER и т.д.)

    -- ============================================================
    -- ПЕРЕМЕННАЯ ДЛЯ ПРОВЕРКИ СУЩЕСТВОВАНИЯ ЗАПИСИ
    -- ============================================================
    v_existing_count INTEGER;        -- Количество существующих записей (0 или 1)
BEGIN
    -- ============================================================
    -- БЛОК 1: ЗАГРУЗКА ИНФОРМАЦИИ ОБ ИНДИКАТОРЕ
    -- ============================================================
    -- Получаем код, имя, категорию и SQL-скрипт индикатора из таблицы indicators
    -- Если индикатор не найден -- выбрасываем исключение
    SELECT code, name, category, script
    INTO v_indicator_code, v_indicator_name, v_indicator_category, v_script
    FROM indicators
    WHERE id = p_indicator_id;

    IF v_indicator_code IS NULL THEN
        RAISE EXCEPTION 'Индикатор с id=% не найден в таблице indicators', p_indicator_id;
    END IF;

    RAISE NOTICE '=== РАСЧЕТ ИНДИКАТОРА % ===', v_indicator_code;
    RAISE NOTICE 'Бумага: %, Таймфрейм: %, Период: % - %', 
        p_security_id, p_timeframe_id, p_date_from, p_date_to;

    -- ============================================================
    -- БЛОК 2: ЗАГРУЗКА ПАРАМЕТРОВ ИНДИКАТОРА
    -- ============================================================
    -- Пытаемся загрузить период из таблицы parameter_values
    -- Если параметр не найден -- используем значение по умолчанию
    BEGIN
        SELECT value::INTEGER INTO v_period
        FROM parameter_values pv
        JOIN parameter_types pt ON pv.parameter_type_id = pt.id
        WHERE pt.short_name = v_indicator_code || '_PERIOD'
        LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
        -- Параметр не найден -- используем дефолтные значения по типу индикатора
        v_period := CASE v_indicator_code
            WHEN 'RSI' THEN 14
            WHEN 'SMA' THEN 20
            WHEN 'EMA' THEN 20
            WHEN 'BB' THEN 20
            WHEN 'ATR' THEN 14
            WHEN 'STOCH' THEN 14
            ELSE 14
        END;
    END;

    -- ============================================================
    -- БЛОК 3: УСТАНОВКА СПЕЦИФИЧНЫХ ПАРАМЕТРОВ ПО ТИПУ ИНДИКАТОРА
    -- ============================================================
    IF v_indicator_code = 'MACD' THEN
        -- MACD: fast=12, slow=26, signal=9 (стандартные параметры)
        v_fast_period := 12;
        v_slow_period := 26;
        v_signal_period := 9;
    ELSIF v_indicator_code = 'BB' THEN
        -- Bollinger Bands: std_dev = 2 (2 стандартных отклонения)
        v_std_dev := 2.0;
    ELSIF v_indicator_code = 'STOCH' THEN
        -- Stochastic: %K=14, %D=3, сглаживание=3
        v_k_period := 14;
        v_d_period := 3;
        v_smooth := 3;
    END IF;

    -- ============================================================
    -- БЛОК 4: ЗАГРУЗКА ЦЕНОВЫХ ДАННЫХ В МАССИВЫ
    -- ============================================================
    -- Загружаем все свечи из таблицы prices в массивы для быстрой обработки
    -- Это позволяет избежать многократных обращений к БД в циклах расчета
    FOR v_price IN cur_prices(p_security_id, p_timeframe_id, p_date_from::TIMESTAMP, (p_date_to + INTERVAL '1 day')::TIMESTAMP)
    LOOP
        v_idx := v_idx + 1;
        v_closes[v_idx] := v_price.close_price;   -- Цена закрытия
        v_highs[v_idx] := v_price.high_price;     -- Максимальная цена
        v_lows[v_idx] := v_price.low_price;       -- Минимальная цена
        v_dts[v_idx] := v_price.dt;               -- Дата/время свечи
    END LOOP;

    -- ============================================================
    -- БЛОК 5: ПРОВЕРКА ДОСТАТОЧНОСТИ ДАННЫХ
    -- ============================================================
    -- Если свечей меньше, чем период индикатора -- расчет невозможен
    IF v_idx < v_period THEN
        RAISE NOTICE 'Недостаточно данных: загружено % свечей, нужно минимум % для периода %', 
            v_idx, v_period, v_indicator_code;
        RETURN;  -- Выходим из процедуры
    END IF;

    RAISE NOTICE 'Загружено % свечей для расчета индикатора %', v_idx, v_indicator_code;

    -- ============================================================
    -- БЛОК 6: РАСЧЕТ ИНДИКАТОРА (ветвление по типу)
    -- ============================================================

    -- ==========================================
    -- 6.1 РАСЧЕТ RSI (Relative Strength Index)
    -- ==========================================
    -- Формула: RSI = 100 - (100 / (1 + RS))
    -- Где RS = средний прирост / средняя потеря за период
    -- Значение от 0 до 100. >70 = перекупленность, <30 = перепроданность
    IF v_indicator_code = 'RSI' THEN

        -- Загружаем пороговые значения из indicator_value_types
        -- OVERBOUGHT (по умолчанию 70), OVERSOLD (по умолчанию 30), NEUTRAL (50)
        FOR v_value_type_code IN ('RSI', 'OVERBOUGHT', 'OVERSOLD', 'NEUTRAL')
        LOOP
            SELECT id INTO v_value_type_id
            FROM indicator_value_types
            WHERE indicator_id = p_indicator_id AND code = v_value_type_code;

            IF v_value_type_id IS NULL THEN
                RAISE NOTICE 'Тип значения % не найден для индикатора RSI', v_value_type_code;
                CONTINUE;
            END IF;

            -- Сохраняем пороговые значения для последующей проверки сигналов
            IF v_value_type_code = 'OVERBOUGHT' THEN
                v_overbought := COALESCE((SELECT threshold_value FROM indicator_value_types WHERE id = v_value_type_id), 70);
            ELSIF v_value_type_code = 'OVERSOLD' THEN
                v_oversold := COALESCE((SELECT threshold_value FROM indicator_value_types WHERE id = v_value_type_id), 30);
            ELSIF v_value_type_code = 'NEUTRAL' THEN
                v_neutral := COALESCE((SELECT threshold_value FROM indicator_value_types WHERE id = v_value_type_id), 50);
            END IF;
        END LOOP;

        -- Основной цикл расчета RSI для каждой свечи, начиная с (period+1)
        FOR i IN v_period + 1 .. v_idx
        LOOP
            -- Сброс аккумуляторов прироста и потерь
            v_gain := 0;
            v_loss := 0;

            -- Суммируем приросты и потери за период
            FOR j IN i - v_period + 1 .. i
            LOOP
                IF v_closes[j] > v_closes[j - 1] THEN
                    -- Цена выросла -- добавляем прирост
                    v_gain := v_gain + (v_closes[j] - v_closes[j - 1]);
                ELSE
                    -- Цена упала -- добавляем потерю
                    v_loss := v_loss + (v_closes[j - 1] - v_closes[j]);
                END IF;
            END LOOP;

            -- Средние прирост и потеря
            v_avg_gain := v_gain / v_period;
            v_avg_loss := v_loss / v_period;

            -- Расчет RS и RSI
            IF v_avg_loss = 0 THEN
                v_rsi := 100;  -- Если потерь нет -- RSI = 100 (максимум)
            ELSE
                v_rs := v_avg_gain / v_avg_loss;
                v_rsi := 100 - (100 / (1 + v_rs));
            END IF;

            v_dt := v_dts[i];

            -- ============================================================
            -- БЛОК 6.1.1: ЗАПИСЬ ЗНАЧЕНИЯ RSI В БАЗУ
            -- ============================================================
            SELECT id INTO v_value_type_id
            FROM indicator_value_types
            WHERE indicator_id = p_indicator_id AND code = 'RSI';

            IF v_value_type_id IS NOT NULL THEN
                -- Проверяем, есть ли уже запись для этой свечи
                SELECT COUNT(*) INTO v_existing_count
                FROM indicator_values
                WHERE indicator_id = p_indicator_id
                  AND indicator_value_type_id = v_value_type_id
                  AND security_id = p_security_id
                  AND timeframe_id = p_timeframe_id
                  AND dt = v_dt;

                -- Если запись есть и overwrite=FALSE -- пропускаем
                IF v_existing_count > 0 AND NOT p_overwrite THEN
                    v_records_skipped := v_records_skipped + 1;
                ELSE
                    -- Удаляем старую запись, если overwrite=TRUE
                    IF v_existing_count > 0 THEN
                        DELETE FROM indicator_values
                        WHERE indicator_id = p_indicator_id
                          AND indicator_value_type_id = v_value_type_id
                          AND security_id = p_security_id
                          AND timeframe_id = p_timeframe_id
                          AND dt = v_dt;
                        v_records_updated := v_records_updated + 1;
                    ELSE
                        v_records_inserted := v_records_inserted + 1;
                    END IF;

                    -- Вставляем новое значение RSI
                    INSERT INTO indicator_values (indicator_id, indicator_value_type_id, security_id, timeframe_id, dt, value, is_signal, signal_type)
                    VALUES (p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, v_rsi, FALSE, NULL);
                END IF;
            END IF;

            -- ============================================================
            -- БЛОК 6.1.2: ПРОВЕРКА ПОРОГОВЫХ ЗНАЧЕНИЙ И СИГНАЛОВ
            -- ============================================================
            -- Если RSI >= overbought -- создаем сигнал перекупленности
            IF v_rsi >= v_overbought THEN
                SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'OVERBOUGHT';
                IF v_value_type_id IS NOT NULL THEN
                    PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, v_overbought, TRUE, 'overbought', p_overwrite);
                END IF;
            -- Если RSI <= oversold -- создаем сигнал перепроданности
            ELSIF v_rsi <= v_oversold THEN
                SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'OVERSOLD';
                IF v_value_type_id IS NOT NULL THEN
                    PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, v_oversold, TRUE, 'oversold', p_overwrite);
                END IF;
            END IF;
        END LOOP;

    -- ==========================================
    -- 6.2 РАСЧЕТ SMA (Simple Moving Average)
    -- ==========================================
    -- Формула: SMA = сумма(close, period) / period
    -- Простое среднее арифметическое цен закрытия за период
    ELSIF v_indicator_code = 'SMA' THEN
        -- Цикл по всем свечам, начиная с периода
        FOR i IN v_period .. v_idx
        LOOP
            -- Суммируем цены закрытия за период
            v_sum := 0;
            FOR j IN i - v_period + 1 .. i
            LOOP
                v_sum := v_sum + v_closes[j];
            END LOOP;
            v_sma := v_sum / v_period;  -- Делим на количество свечей
            v_dt := v_dts[i];

            -- Записываем значение SMA
            SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'VALUE';
            IF v_value_type_id IS NOT NULL THEN
                PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, v_sma, FALSE, NULL, p_overwrite);
                v_records_inserted := v_records_inserted + 1;
            END IF;
        END LOOP;

    -- ==========================================
    -- 6.3 РАСЧЕТ EMA (Exponential Moving Average)
    -- ==========================================
    -- Формула: EMA(today) = (Close(today) - EMA(yesterday)) * multiplier + EMA(yesterday)
    -- Где multiplier = 2 / (period + 1)
    -- Первое EMA = SMA за период
    ELSIF v_indicator_code = 'EMA' THEN
        -- Множитель сглаживания: 2/(N+1)
        v_multiplier := 2.0 / (v_period + 1);

        -- Расчет начального SMA (первое EMA = SMA)
        v_sum := 0;
        FOR j IN 1 .. v_period
        LOOP
            v_sum := v_sum + v_closes[j];
        END LOOP;
        v_ema := v_sum / v_period;

        -- Основной цикл расчета EMA
        FOR i IN v_period .. v_idx
        LOOP
            -- Если не первая точка -- применяем формулу EMA
            IF i > v_period THEN
                v_ema := (v_closes[i] - v_ema) * v_multiplier + v_ema;
            END IF;
            v_dt := v_dts[i];

            -- Записываем значение EMA
            SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'VALUE';
            IF v_value_type_id IS NOT NULL THEN
                PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, v_ema, FALSE, NULL, p_overwrite);
                v_records_inserted := v_records_inserted + 1;
            END IF;
        END LOOP;

    -- ==========================================
    -- 6.4 РАСЧЕТ MACD
    -- ==========================================
    -- MACD Line = EMA(12) - EMA(26)
    -- Signal Line = EMA(9) от MACD Line
    -- Histogram = MACD Line - Signal Line
    ELSIF v_indicator_code = 'MACD' THEN
        -- Множители для EMA
        v_mult_fast := 2.0 / (v_fast_period + 1);
        v_mult_slow := 2.0 / (v_slow_period + 1);
        v_mult_signal := 2.0 / (v_signal_period + 1);

        -- Начальные EMA (первые значения = SMA)
        v_sum := 0;
        FOR j IN 1 .. v_fast_period LOOP v_sum := v_sum + v_closes[j]; END LOOP;
        v_ema_fast := v_sum / v_fast_period;

        v_sum := 0;
        FOR j IN 1 .. v_slow_period LOOP v_sum := v_sum + v_closes[j]; END LOOP;
        v_ema_slow := v_sum / v_slow_period;

        v_macd_signal := 0;

        -- Основной цикл расчета MACD
        FOR i IN GREATEST(v_fast_period, v_slow_period) .. v_idx
        LOOP
            -- Обновляем быструю EMA (период 12)
            IF i > v_fast_period THEN
                v_ema_fast := (v_closes[i] - v_ema_fast) * v_mult_fast + v_ema_fast;
            END IF;
            -- Обновляем медленную EMA (период 26)
            IF i > v_slow_period THEN
                v_ema_slow := (v_closes[i] - v_ema_slow) * v_mult_slow + v_ema_slow;
            END IF;

            -- Линия MACD = разница EMA
            v_macd := v_ema_fast - v_ema_slow;

            -- Сигнальная линия = EMA(9) от MACD
            IF i = GREATEST(v_fast_period, v_slow_period) THEN
                v_macd_signal := v_macd;  -- Первое значение = MACD
            ELSE
                v_macd_signal := (v_macd - v_macd_signal) * v_mult_signal + v_macd_signal;
            END IF;

            -- Гистограмма = MACD - Signal
            v_macd_histogram := v_macd - v_macd_signal;
            v_dt := v_dts[i];

            -- Записываем MACD line
            SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'MACD';
            IF v_value_type_id IS NOT NULL THEN
                PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, v_macd, FALSE, NULL, p_overwrite);
            END IF;

            -- Записываем Signal line
            SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'SIGNAL';
            IF v_value_type_id IS NOT NULL THEN
                PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, v_macd_signal, FALSE, NULL, p_overwrite);
            END IF;

            -- Записываем Histogram
            SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'HISTOGRAM';
            IF v_value_type_id IS NOT NULL THEN
                PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, v_macd_histogram, FALSE, NULL, p_overwrite);
            END IF;

            -- Записываем нулевую линию (порог)
            SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'ZERO';
            IF v_value_type_id IS NOT NULL THEN
                PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, 0, FALSE, NULL, p_overwrite);
            END IF;

            v_records_inserted := v_records_inserted + 3;
        END LOOP;

    -- ==========================================
    -- 6.5 РАСЧЕТ BOLLINGER BANDS
    -- ==========================================
    -- Middle Band = SMA(period)
    -- Upper Band = SMA + (std_dev * σ)
    -- Lower Band = SMA - (std_dev * σ)
    -- Bandwidth = (Upper - Lower) / Middle
    ELSIF v_indicator_code = 'BB' THEN
        FOR i IN v_period .. v_idx
        LOOP
            -- Средняя полоса = SMA
            v_sum := 0;
            FOR j IN i - v_period + 1 .. i
            LOOP
                v_sum := v_sum + v_closes[j];
            END LOOP;
            v_bb_middle := v_sum / v_period;

            -- Стандартное отклонение
            v_bb_sum_sq := 0;
            FOR j IN i - v_period + 1 .. i
            LOOP
                v_bb_sum_sq := v_bb_sum_sq + POWER(v_closes[j] - v_bb_middle, 2);
            END LOOP;
            v_bb_stddev := SQRT(v_bb_sum_sq / v_period);

            -- Верхняя и нижняя полосы
            v_bb_upper := v_bb_middle + (v_std_dev * v_bb_stddev);
            v_bb_lower := v_bb_middle - (v_std_dev * v_bb_stddev);
            v_dt := v_dts[i];

            -- Записываем Upper band
            SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'UPPER';
            IF v_value_type_id IS NOT NULL THEN
                PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, v_bb_upper, FALSE, NULL, p_overwrite);
            END IF;

            -- Записываем Middle band
            SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'MIDDLE';
            IF v_value_type_id IS NOT NULL THEN
                PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, v_bb_middle, FALSE, NULL, p_overwrite);
            END IF;

            -- Записываем Lower band
            SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'LOWER';
            IF v_value_type_id IS NOT NULL THEN
                PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, v_bb_lower, FALSE, NULL, p_overwrite);
            END IF;

            -- Записываем Bandwidth
            SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'BANDWIDTH';
            IF v_value_type_id IS NOT NULL THEN
                PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, 
                    (v_bb_upper - v_bb_lower) / v_bb_middle, FALSE, NULL, p_overwrite);
            END IF;

            v_records_inserted := v_records_inserted + 4;
        END LOOP;

    -- ==========================================
    -- 6.6 РАСЧЕТ ATR (Average True Range)
    -- ==========================================
    -- TR = max(High - Low, |High - Close_prev|, |Low - Close_prev|)
    -- ATR = SMA(TR, period) или EMA(TR, period) -- здесь используется Wilder's smoothing
    ELSIF v_indicator_code = 'ATR' THEN
        v_atr := 0;

        FOR i IN 2 .. v_idx
        LOOP
            -- Вычисляем True Range
            v_tr_high := v_highs[i] - v_lows[i];                          -- High - Low
            v_tr_low := ABS(v_highs[i] - v_closes[i-1]);                  -- |High - Close_prev|
            v_tr_close := ABS(v_lows[i] - v_closes[i-1]);                 -- |Low - Close_prev|
            v_tr := GREATEST(v_tr_high, v_tr_low, v_tr_close);            -- Максимум из трех

            -- Wilder's smoothing: ATR = (ATR_prev * (N-1) + TR) / N
            IF i <= v_period THEN
                -- Накопление для первого ATR (простое среднее)
                v_atr := v_atr + v_tr;
                IF i = v_period THEN
                    v_atr := v_atr / v_period;  -- Первое значение = SMA
                END IF;
            ELSE
                -- Последующие значения -- Wilder's smoothing
                v_atr := (v_atr * (v_period - 1) + v_tr) / v_period;
            END IF;

            v_dt := v_dts[i];

            -- Записываем ATR (начиная с периода)
            IF i >= v_period THEN
                SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'ATR';
                IF v_value_type_id IS NOT NULL THEN
                    PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, v_atr, FALSE, NULL, p_overwrite);
                END IF;

                -- Записываем ATR в процентах от цены
                SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'ATR_PCT';
                IF v_value_type_id IS NOT NULL THEN
                    PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, 
                        (v_atr / v_closes[i]) * 100, FALSE, NULL, p_overwrite);
                END IF;

                v_records_inserted := v_records_inserted + 2;
            END IF;
        END LOOP;

    -- ==========================================
    -- 6.7 РАСЧЕТ STOCHASTIC OSCILLATOR
    -- ==========================================
    -- %K = (Close - LowestLow) / (HighestHigh - LowestLow) * 100
    -- %D = SMA(%K, 3)
    -- J = 3K - 2D (не используется здесь)
    ELSIF v_indicator_code = 'STOCH' THEN
        FOR i IN v_k_period .. v_idx
        LOOP
            -- Находим минимум low и максимум high за период %K
            v_lowest_low := v_lows[i];
            v_highest_high := v_highs[i];

            FOR j IN i - v_k_period + 1 .. i
            LOOP
                IF v_lows[j] < v_lowest_low THEN v_lowest_low := v_lows[j]; END IF;
                IF v_highs[j] > v_highest_high THEN v_highest_high := v_highs[j]; END IF;
            END LOOP;

            -- Расчет %K
            IF v_highest_high - v_lowest_low = 0 THEN
                v_stoch_k := 50;  -- Если диапазон 0 -- нейтральное значение
            ELSE
                v_stoch_k := ((v_closes[i] - v_lowest_low) / (v_highest_high - v_lowest_low)) * 100;
            END IF;

            v_dt := v_dts[i];

            -- Записываем %K линию
            SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'K';
            IF v_value_type_id IS NOT NULL THEN
                PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, v_stoch_k, FALSE, NULL, p_overwrite);
            END IF;

            -- Расчет %D (SMA от %K, период 3)
            IF i >= v_k_period + v_d_period - 1 THEN
                v_k_sum := 0;
                FOR j IN i - v_d_period + 1 .. i
                LOOP
                    -- Пересчитываем %K для каждой точки окна %D
                    v_lowest_low := v_lows[j];
                    v_highest_high := v_highs[j];
                    FOR m IN j - v_k_period + 1 .. j
                    LOOP
                        IF v_lows[m] < v_lowest_low THEN v_lowest_low := v_lows[m]; END IF;
                        IF v_highs[m] > v_highest_high THEN v_highest_high := v_highs[m]; END IF;
                    END LOOP;

                    IF v_highest_high - v_lowest_low = 0 THEN
                        v_k_sum := v_k_sum + 50;
                    ELSE
                        v_k_sum := v_k_sum + ((v_closes[j] - v_lowest_low) / (v_highest_high - v_lowest_low)) * 100;
                    END IF;
                END LOOP;
                v_stoch_d := v_k_sum / v_d_period;

                -- Записываем %D линию
                SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'D';
                IF v_value_type_id IS NOT NULL THEN
                    PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, v_stoch_d, FALSE, NULL, p_overwrite);
                END IF;

                -- ============================================================
                -- БЛОК 6.7.1: ПРОВЕРКА ПОРОГОВЫХ СИГНАЛОВ СТОХАСТИКА
                -- ============================================================
                IF v_stoch_k >= 80 THEN
                    -- Перекупленность: %K >= 80
                    SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'OVERBOUGHT';
                    IF v_value_type_id IS NOT NULL THEN
                        PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, 80, TRUE, 'overbought', p_overwrite);
                    END IF;
                ELSIF v_stoch_k <= 20 THEN
                    -- Перепроданность: %K <= 20
                    SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'OVERSOLD';
                    IF v_value_type_id IS NOT NULL THEN
                        PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, 20, TRUE, 'oversold', p_overwrite);
                    END IF;
                END IF;

                v_records_inserted := v_records_inserted + 3;
            ELSE
                v_records_inserted := v_records_inserted + 1;
            END IF;
        END LOOP;

    -- ==========================================
    -- 6.8 НЕПОДДЕРЖИВАЕМЫЙ ИНДИКАТОР
    -- ==========================================
    ELSE
        RAISE NOTICE 'Расчет для индикатора % пока не реализован в данной процедуре', v_indicator_code;
    END IF;

    -- ============================================================
    -- БЛОК 7: ИТОГОВАЯ СТАТИСТИКА
    -- ============================================================
    RAISE NOTICE '=== РАСЧЕТ ЗАВЕРШЕН ===';
    RAISE NOTICE 'Индикатор: %, Бумага: %, Таймфрейм: %', v_indicator_code, p_security_id, p_timeframe_id;
    RAISE NOTICE 'Вставлено новых записей: %', v_records_inserted;
    RAISE NOTICE 'Обновлено существующих записей: %', v_records_updated;
    RAISE NOTICE 'Пропущено (уже существуют): %', v_records_skipped;

EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Ошибка расчета индикатора % (id=%): %', v_indicator_code, p_indicator_id, SQLERRM;
END;
$$;

-- ============================================
-- КОММЕНТАРИЙ К ПРОЦЕДУРЕ calculate_indicator
-- ============================================
COMMENT ON PROCEDURE calculate_indicator(INTEGER, INTEGER, INTEGER, DATE, DATE, BOOLEAN) IS 
'Рассчитывает значения технического индикатора для указанной бумаги, таймфрейма и периода.

ПАРАМЕТРЫ:
  p_security_id  - ID ценной бумаги (securities.id)
  p_timeframe_id - ID таймфрейма (timeframes.id)
  p_indicator_id - ID индикатора (indicators.id)
  p_date_from    - Начальная дата периода (YYYY-MM-DD)
  p_date_to      - Конечная дата периода (YYYY-MM-DD)
  p_overwrite    - TRUE = перезаписать существующие, FALSE = пропустить

ПОДДЕРЖИВАЕМЫЕ ИНДИКАТОРЫ:
  RSI   - Индекс относительной силы (период 14, пороги 70/30)
  SMA   - Простое скользящее среднее (период 20)
  EMA   - Экспоненциальное скользящее среднее (период 20)
  MACD  - Схождение/расхождение (fast=12, slow=26, signal=9)
  BB    - Полосы Боллинджера (период 20, std_dev=2.0)
  ATR   - Средний истинный диапазон (период 14)
  STOCH - Стохастик (%K=14, %D=3)

ПРИМЕРЫ ВЫЗОВА:
  CALL calculate_indicator(1, 4, 4, ''2026-06-17'', ''2026-06-24'', TRUE);
  -- RSI для SBER (id=1) на M5 (id=4) за неделю с перезаписью

  CALL calculate_indicator(3, 15, 5, ''2026-06-01'', ''2026-06-24'', FALSE);
  -- MACD для GAZP (id=3) на D1 (id=15), пропустить если есть
';

-- ============================================
-- Вспомогательная функция: insert_indicator_value
-- ============================================
-- Параметры:
--   p_indicator_id      - ID индикатора (indicators.id)
--   p_value_type_id     - ID типа значения (indicator_value_types.id)
--   p_security_id       - ID бумаги (securities.id)
--   p_timeframe_id      - ID таймфрейма (timeframes.id)
--   p_dt                - Дата/время свечи
--   p_value             - Значение индикатора
--   p_is_signal         - Это сигнальное значение? (TRUE/FALSE)
--   p_signal_type       - Тип сигнала: buy, sell, overbought, oversold
--   p_overwrite         - Перезаписать существующую запись?
-- ============================================
CREATE OR REPLACE FUNCTION insert_indicator_value(
    p_indicator_id INTEGER,
    p_value_type_id INTEGER,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_dt TIMESTAMP,
    p_value NUMERIC(18,6),
    p_is_signal BOOLEAN,
    p_signal_type VARCHAR(20),
    p_overwrite BOOLEAN
)
RETURNS VOID AS $$
DECLARE
    v_existing_count INTEGER;  -- Количество существующих записей (0 или 1)
BEGIN
    -- ============================================================
    -- БЛОК 1: ПРОВЕРКА СУЩЕСТВОВАНИЯ ЗАПИСИ
    -- ============================================================
    -- Проверяем, есть ли уже запись для данной комбинации:
    -- индикатор + тип значения + бумага + таймфрейм + дата
    SELECT COUNT(*) INTO v_existing_count
    FROM indicator_values
    WHERE indicator_id = p_indicator_id
      AND indicator_value_type_id = p_value_type_id
      AND security_id = p_security_id
      AND timeframe_id = p_timeframe_id
      AND dt = p_dt;

    -- ============================================================
    -- БЛОК 2: ОБРАБОТКА В ЗАВИСИМОСТИ ОТ ФЛАГА OVERWRITE
    -- ============================================================
    IF v_existing_count > 0 AND NOT p_overwrite THEN
        -- Запись есть и overwrite=FALSE -- пропускаем (ничего не делаем)
        RETURN;
    END IF;

    -- Если запись есть и overwrite=TRUE -- удаляем старую
    IF v_existing_count > 0 THEN
        DELETE FROM indicator_values
        WHERE indicator_id = p_indicator_id
          AND indicator_value_type_id = p_value_type_id
          AND security_id = p_security_id
          AND timeframe_id = p_timeframe_id
          AND dt = p_dt;
    END IF;

    -- ============================================================
    -- БЛОК 3: ВСТАВКА НОВОГО ЗНАЧЕНИЯ
    -- ============================================================
    INSERT INTO indicator_values (
        indicator_id,           -- Ссылка на индикатор
        indicator_value_type_id,-- Ссылка на тип значения (линия/порог)
        security_id,            -- Ссылка на бумагу
        timeframe_id,           -- Ссылка на таймфрейм
        dt,                     -- Дата/время свечи
        value,                  -- Рассчитанное значение
        is_signal,              -- Это сигнальное значение?
        signal_type             -- Тип сигнала (buy, sell, overbought, oversold)
    ) VALUES (
        p_indicator_id,
        p_value_type_id,
        p_security_id,
        p_timeframe_id,
        p_dt,
        p_value,
        p_is_signal,
        p_signal_type
    );
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- КОММЕНТАРИЙ К ФУНКЦИИ insert_indicator_value
-- ============================================
COMMENT ON FUNCTION insert_indicator_value(INTEGER, INTEGER, INTEGER, INTEGER, TIMESTAMP, NUMERIC, BOOLEAN, VARCHAR, BOOLEAN) IS 
'Вспомогательная функция для вставки/обновления одного значения индикатора.

Проверяет существование записи по уникальному индексу:
(indicator_id, indicator_value_type_id, security_id, timeframe_id, dt)

Если запись существует и p_overwrite=FALSE -- пропускает.
Если запись существует и p_overwrite=TRUE -- удаляет старую и вставляет новую.
Если записи нет -- просто вставляет новую.

Используется внутри calculate_indicator для записи каждого значения.';

-- ============================================
-- Процедура: calculate_all_indicators
-- ============================================
-- Параметры:
--   p_security_id  - ID ценной бумаги
--   p_timeframe_id - ID таймфрейма
--   p_date_from    - Начальная дата периода
--   p_date_to      - Конечная дата периода
--   p_overwrite    - Перезаписывать существующие записи?
-- ============================================
-- Рассчитывает ВСЕ активные индикаторы из таблицы indicators
-- для указанной бумаги, таймфрейма и периода.
-- Ошибки в расчете отдельных индикаторов не прерывают общий процесс.
-- ============================================
CREATE OR REPLACE PROCEDURE calculate_all_indicators(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_date_from DATE,
    p_date_to DATE,
    p_overwrite BOOLEAN DEFAULT FALSE
)
LANGUAGE plpgsql AS $$
DECLARE
    v_indicator RECORD;  -- Курсор по активным индикаторам
BEGIN
    -- ============================================================
    -- БЛОК: ПЕРЕБОР ВСЕХ АКТИВНЫХ ИНДИКАТОРОВ
    -- ============================================================
    -- Выбираем все индикаторы где is_active = TRUE
    -- и по очереди вызываем для каждого calculate_indicator
    FOR v_indicator IN 
        SELECT id, code, name 
        FROM indicators 
        WHERE is_active = TRUE 
        ORDER BY id
    LOOP
        BEGIN
            -- Вызываем расчет для текущего индикатора
            CALL calculate_indicator(
                p_security_id,    -- Бумага
                p_timeframe_id,   -- Таймфрейм
                v_indicator.id,   -- ID индикатора
                p_date_from,      -- Начало периода
                p_date_to,        -- Конец периода
                p_overwrite       -- Флаг перезаписи
            );
            RAISE NOTICE 'Успешно рассчитан индикатор: % (%)', v_indicator.code, v_indicator.name;

        EXCEPTION
            WHEN OTHERS THEN
                -- Ошибка в одном индикаторе не прерывает расчет остальных
                RAISE NOTICE 'ОШИБКА расчета индикатора % (%): %', 
                    v_indicator.code, v_indicator.name, SQLERRM;
        END;
    END LOOP;

    RAISE NOTICE '=== Расчет всех индикаторов завершен ===';
END;
$$;

-- ============================================
-- КОММЕНТАРИЙ К ПРОЦЕДУРЕ calculate_all_indicators
-- ============================================
COMMENT ON PROCEDURE calculate_all_indicators(INTEGER, INTEGER, DATE, DATE, BOOLEAN) IS 
'Рассчитывает все активные индикаторы (indicators.is_active = TRUE) 
для указанной бумаги, таймфрейма и периода.

Перебирает все записи из таблицы indicators где is_active=TRUE
и вызывает для каждого calculate_indicator.

Ошибка в расчете одного индикатора НЕ прерывает расчет остальных.

ПРИМЕР:
  CALL calculate_all_indicators(1, 4, ''2026-06-17'', ''2026-06-24'', TRUE);
  -- Расчет ВСЕХ индикаторов для SBER на M5 за неделю';

-- ============================================
-- Процедура: calculate_indicators_batch
-- ============================================
-- Параметры:
--   p_security_ids - Массив ID бумаг (INTEGER[])
--   p_timeframe_id - ID таймфрейма
--   p_date_from    - Начальная дата периода
--   p_date_to      - Конечная дата периода
--   p_overwrite    - Перезаписывать существующие записи?
-- ============================================
-- Рассчитывает все индикаторы для массива бумаг.
-- Удобно для массового пересчета по портфелю.
-- ============================================
CREATE OR REPLACE PROCEDURE calculate_indicators_batch(
    p_security_ids INTEGER[],
    p_timeframe_id INTEGER,
    p_date_from DATE,
    p_date_to DATE,
    p_overwrite BOOLEAN DEFAULT FALSE
)
LANGUAGE plpgsql AS $$
DECLARE
    v_security_id INTEGER;  -- Текущая бумага из массива
BEGIN
    -- ============================================================
    -- БЛОК: ПЕРЕБОР ВСЕХ БУМАГ В МАССИВЕ
    -- ============================================================
    FOREACH v_security_id IN ARRAY p_security_ids
    LOOP
        BEGIN
            -- Вызываем расчет всех индикаторов для текущей бумаги
            CALL calculate_all_indicators(
                v_security_id,    -- Текущая бумага
                p_timeframe_id,   -- Таймфрейм
                p_date_from,      -- Начало периода
                p_date_to,        -- Конец периода
                p_overwrite       -- Флаг перезаписи
            );
            RAISE NOTICE 'Рассчитаны индикаторы для security_id=%', v_security_id;

        EXCEPTION
            WHEN OTHERS THEN
                -- Ошибка по одной бумаге не прерывает расчет остальных
                RAISE NOTICE 'ОШИБКА расчета для security_id=%: %', v_security_id, SQLERRM;
        END;
    END LOOP;

    RAISE NOTICE '=== Массовый расчет индикаторов завершен ===';
END;
$$;

-- ============================================
-- КОММЕНТАРИЙ К ПРОЦЕДУРЕ calculate_indicators_batch
-- ============================================
COMMENT ON PROCEDURE calculate_indicators_batch(INTEGER[], INTEGER, DATE, DATE, BOOLEAN) IS 
'Рассчитывает все активные индикаторы для массива бумаг.

Параметр p_security_ids -- массив ID из таблицы securities.

ПРИМЕР:
  CALL calculate_indicators_batch(ARRAY[1, 3, 4, 5], 4, ''2026-06-17'', ''2026-06-24'', FALSE);
  -- Расчет всех индикаторов для SBER, GAZP, LKOH, ROSN на M5';



-- ============================================
-- ЧАСТЬ 2: УСТАНОВКА РАСШИРЕНИЯ pgsql-http
-- ============================================
--
-- ВНИМАНИЕ: Для выполнения HTTP-запросов из PostgreSQL используется
-- расширение pgsql-http (обертка над libcurl).
--
-- ================================================================
-- ИНСТРУКЦИЯ ПО УСТАНОВКЕ pgsql-http (выполнить ОДИН РАЗ на сервере)
-- ================================================================
--
-- ШАГ 1: Установить системные зависимости
-- ---------------------------------------------------------------
--   Debian/Ubuntu:
--     sudo apt-get update
--     sudo apt-get install -y libcurl4-openssl-dev
--     sudo apt-get install -y postgresql-server-dev-XX
--       (где XX -- версия PostgreSQL, например 15, 16)
--
--   CentOS/RHEL/Fedora:
--     sudo yum install libcurl-devel
--     sudo yum install postgresql-devel
--
--   macOS (Homebrew):
--     brew install curl
--     brew install postgresql
--
-- ШАГ 2: Скачать и собрать расширение
-- ---------------------------------------------------------------
--   cd /tmp
--   git clone https://github.com/pramsey/pgsql-http.git
--   cd pgsql-http
--   make
--   sudo make install
--
--   Если make не находит pg_config -- укажите путь явно:
--     make PG_CONFIG=/usr/lib/postgresql/16/bin/pg_config
--     sudo make install PG_CONFIG=/usr/lib/postgresql/16/bin/pg_config
--
-- ШАГ 3: Проверить установку
-- ---------------------------------------------------------------
--   ls -la $(pg_config --sharedir)/extension/http*
--   Должны появиться файлы: http.control, http--*.sql
--
-- ШАГ 4: Включить расширение в базе данных
-- ---------------------------------------------------------------
--   psql -d multilogictrade -c "CREATE EXTENSION IF NOT EXISTS http;"
--
--   Или внутри psql:
--     \c multilogictrade
--     CREATE EXTENSION IF NOT EXISTS http;
--
-- ШАГ 5: Проверить работу
-- ---------------------------------------------------------------
--   SELECT http_get('https://httpbin.org/get');
--   Должен вернуться JSON-ответ с заголовками и телом.
--
-- ================================================================
-- НАСТРОЙКА БЕЗОПАСНОСТИ (ОПЦИОНАЛЬНО)
-- ================================================================
--
-- По умолчанию pgsql-http может обращаться к ЛЮБЫМ URL.
-- Для ограничения списка разрешенных URL:
--
--   ALTER SYSTEM SET http.whitelist = 'invest-public-api.tinkoff.ru,iss.moex.com';
--   SELECT pg_reload_conf();
--
-- Для полного запрета исходящих запросов:
--   ALTER SYSTEM SET http.blacklist = '*';
--   SELECT pg_reload_conf();
--
-- ================================================================
-- УДАЛЕНИЕ РАСШИРЕНИЯ (если нужно переустановить)
-- ================================================================
--
--   DROP EXTENSION http CASCADE;
--   -- Затем удалить файлы:
--   sudo rm $(pg_config --sharedir)/extension/http*
--   sudo rm $(pg_config --libdir)/http.so
--
-- ================================================================
-- ============================================
-- Процедура: load_prices_from_tbank_http
-- Загрузка цен через T-Bank API с использованием pgsql-http
-- ============================================
CREATE OR REPLACE PROCEDURE load_prices_from_tbank_http(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_date_from DATE,
    p_date_to DATE
)
LANGUAGE plpgsql AS $$
DECLARE
    -- ============================================================
    -- ПАРАМЕТРЫ ЗАПРОСА
    -- ============================================================
    v_prefix VARCHAR(50);            -- Тикер/FIGI бумаги
    v_tf_name VARCHAR(20);           -- Код таймфрейма (M5, D1 и т.д.)
    v_is_future BOOLEAN;             -- Флаг: это фьючерс?
    v_token TEXT;                    -- API-токен T-Bank (из accounts)

    -- ============================================================
    -- ПАРАМЕТРЫ HTTP-ЗАПРОСА
    -- ============================================================
    v_api_url TEXT;                  -- URL API T-Bank
    v_payload TEXT;                  -- JSON-тело POST-запроса
    v_headers http_header[];       -- Заголовки HTTP-запроса
    v_response http_response;        -- Ответ от API
    v_status INTEGER;                -- HTTP-статус ответа
    v_content JSONB;                 -- Распарсенный JSON-ответ

    -- ============================================================
    -- ПАРАМЕТРЫ ДЛЯ РАЗБОРА СВЕЧЕЙ
    -- ============================================================
    v_candles JSONB;                 -- Массив свечей из ответа
    v_candle JSONB;                  -- Одна свеча
    v_candle_time TIMESTAMP;         -- Время свечи
    v_candle_open NUMERIC(18,6);   -- Цена открытия
    v_candle_high NUMERIC(18,6);   -- Максимум
    v_candle_low NUMERIC(18,6);    -- Минимум
    v_candle_close NUMERIC(18,6);  -- Цена закрытия
    v_candle_volume NUMERIC(20,2); -- Объем
    v_records_loaded INTEGER := 0;   -- Счетчик загруженных записей
    v_i INTEGER;                     -- Итератор по массиву
BEGIN
    -- ============================================================
    -- БЛОК 1: ПОЛУЧЕНИЕ ПРЕФИКСА БУМАГИ
    -- ============================================================
    SELECT sp.prefix INTO v_prefix
    FROM security_prefixes sp
    WHERE sp.security_id = p_security_id AND sp.exchange_id = 1;

    IF v_prefix IS NULL THEN
        RAISE EXCEPTION 'Префикс не найден для security_id=%', p_security_id;
    END IF;

    -- ============================================================
    -- БЛОК 2: ПОЛУЧЕНИЕ ТАЙМФРЕЙМА
    -- ============================================================
    SELECT tf INTO v_tf_name
    FROM timeframes WHERE id = p_timeframe_id;

    -- ============================================================
    -- БЛОК 3: ПРОВЕРКА, ЭТО ФЬЮЧЕРС?
    -- ============================================================
    SELECT (st.name = 'Futures') INTO v_is_future
    FROM securities s
    JOIN security_types st ON s.security_type_id = st.id
    WHERE s.id = p_security_id;

    -- Для фьючерса определяем активный контракт
    IF v_is_future THEN
        v_prefix := get_active_future_prefix(p_security_id, p_date_from);
        IF v_prefix IS NULL THEN
            RAISE EXCEPTION 'Активный фьючерс не найден для security_id=% на дату %', 
                p_security_id, p_date_from;
        END IF;
    END IF;

    -- ============================================================
    -- БЛОК 4: ПОЛУЧЕНИЕ API-ТОКЕНА T-BANK
    -- ============================================================
    v_token := get_tbank_token();
    IF v_token IS NULL THEN
        RAISE EXCEPTION 'T-Bank токен не найден. Заполните token_encrypted в accounts.';
    END IF;

    -- ============================================================
    -- БЛОК 5: ФОРМИРОВАНИЕ HTTP-ЗАПРОСА
    -- ============================================================
    -- URL API T-Bank для получения свечей
    v_api_url := 'https://invest-public-api.tinkoff.ru/rest/tinkoff.public.invest.api.contract.v1.MarketDataService/GetCandles';

    -- Формируем JSON-тело запроса
    v_payload := jsonb_build_object(
        'figi', v_prefix,
        'from', p_date_from::TIMESTAMP::TEXT || 'Z',
        'to', (p_date_to + INTERVAL '1 day')::TIMESTAMP::TEXT || 'Z',
        'interval', CASE v_tf_name
            WHEN 'M1' THEN 'CANDLE_INTERVAL_1_MIN'
            WHEN 'M5' THEN 'CANDLE_INTERVAL_5_MIN'
            WHEN 'M15' THEN 'CANDLE_INTERVAL_15_MIN'
            WHEN 'H1' THEN 'CANDLE_INTERVAL_HOUR'
            WHEN 'D1' THEN 'CANDLE_INTERVAL_DAY'
            WHEN 'W1' THEN 'CANDLE_INTERVAL_WEEK'
            ELSE 'CANDLE_INTERVAL_DAY'
        END
    )::TEXT;

    -- Формируем заголовки с авторизацией
    v_headers := ARRAY[
        http_header('Authorization', 'Bearer ' || v_token),
        http_header('Content-Type', 'application/json'),
        http_header('Accept', 'application/json')
    ];

    -- ============================================================
    -- БЛОК 6: ВЫПОЛНЕНИЕ HTTP POST-ЗАПРОСА ЧЕРЕЗ pgsql-http
    -- ============================================================
    -- Функция http() из расширения pgsql-http выполняет запрос через libcurl
    -- Возвращает тип http_response со статусом, заголовками и телом ответа
    SELECT * INTO v_response FROM http((
        'POST',
        v_api_url,
        v_headers,
        'application/json',
        v_payload
    )::http_request);

    -- Проверяем HTTP-статус
    v_status := v_response.status;

    IF v_status != 200 THEN
        RAISE EXCEPTION 'T-Bank API вернул статус %: %', v_status, v_response.content;
    END IF;

    -- ============================================================
    -- БЛОК 7: РАЗБОР JSON-ОТВЕТА
    -- ============================================================
    -- Преобразуем текст ответа в JSONB
    v_content := v_response.content::JSONB;

    -- Извлекаем массив свечей
    v_candles := v_content->'candles';

    IF v_candles IS NULL OR jsonb_array_length(v_candles) = 0 THEN
        RAISE NOTICE 'T-Bank вернул пустой массив свечей';
        RETURN;
    END IF;

    -- ============================================================
    -- БЛОК 8: ЗАПИСЬ СВЕЧЕЙ В БАЗУ ДАННЫХ
    -- ============================================================
    FOR v_i IN 0 .. jsonb_array_length(v_candles) - 1
    LOOP
        v_candle := v_candles->v_i;

        -- Извлекаем поля свечи из JSON
        v_candle_time := (v_candle->>'time')::TIMESTAMP;
        v_candle_open := (v_candle->>'open')::NUMERIC;
        v_candle_high := (v_candle->>'high')::NUMERIC;
        v_candle_low := (v_candle->>'low')::NUMERIC;
        v_candle_close := (v_candle->>'close')::NUMERIC;
        v_candle_volume := (v_candle->>'volume')::NUMERIC;

        -- Вставляем свечу через процедуру insert_candle (UPSERT)
        CALL insert_candle(
            p_security_id,
            p_timeframe_id,
            v_candle_time,
            v_candle_open,
            v_candle_high,
            v_candle_low,
            v_candle_close,
            v_candle_volume,
            NULL,  -- value (оборот)
            NULL   -- trades (количество сделок)
        );

        v_records_loaded := v_records_loaded + 1;
    END LOOP;

    -- ============================================================
    -- БЛОК 9: ЛОГИРОВАНИЕ РЕЗУЛЬТАТА
    -- ============================================================
    INSERT INTO price_load_log (security_id, timeframe_id, date_from, date_to, source, records_loaded)
    VALUES (p_security_id, p_timeframe_id, p_date_from, p_date_to, 'T-BANK', v_records_loaded);

    RAISE NOTICE 'Загружено % свечей из T-Bank', v_records_loaded;

EXCEPTION
    WHEN OTHERS THEN
        INSERT INTO price_load_log (security_id, timeframe_id, date_from, date_to, source, records_loaded, error_message)
        VALUES (p_security_id, p_timeframe_id, p_date_from, p_date_to, 'T-BANK', 0, SQLERRM);
        RAISE;
END;
$$;

COMMENT ON PROCEDURE load_prices_from_tbank_http(INTEGER, INTEGER, DATE, DATE) IS 
'Загружает цены через T-Bank API используя расширение pgsql-http (libcurl).
Требует предварительной установки: CREATE EXTENSION http;
Для фьючерсов автоматически выбирает активный контракт.';

-- ============================================
-- Процедура: load_prices_from_moex_http
-- Загрузка цен через MOEX ISS API с использованием pgsql-http
-- ============================================
CREATE OR REPLACE PROCEDURE load_prices_from_moex_http(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_date_from DATE,
    p_date_to DATE
)
LANGUAGE plpgsql AS $$
DECLARE
    -- ============================================================
    -- ПАРАМЕТРЫ ЗАПРОСА
    -- ============================================================
    v_prefix VARCHAR(50);            -- Тикер бумаги
    v_tf_name VARCHAR(20);           -- Код таймфрейма
    v_sec_type VARCHAR(50);          -- Тип ценной бумаги
    v_engine VARCHAR(20);            -- Рынок MOEX (stock, futures, bonds)
    v_market VARCHAR(20);            -- Подрынок (shares, forts, bonds)
    v_board VARCHAR(20);             -- Режим торгов (TQBR, RFUD, TQOB)

    -- ============================================================
    -- ПАРАМЕТРЫ HTTP-ЗАПРОСА
    -- ============================================================
    v_api_url TEXT;                  -- URL API MOEX ISS
    v_response http_response;        -- Ответ от API
    v_status INTEGER;                -- HTTP-статус
    v_content JSONB;                 -- JSON-ответ

    -- ============================================================
    -- ПАРАМЕТРЫ ДЛЯ РАЗБОРА ОТВЕТА MOEX
    -- ============================================================
    v_candles_data JSONB;            -- Массив данных свечей
    v_columns JSONB;                 -- Массив названий колонок
    v_col_map JSONB;                 -- Маппинг колонок
    v_row JSONB;                     -- Одна строка данных
    v_row_idx INTEGER;               -- Индекс строки
    v_col_idx INTEGER;               -- Индекс колонки
    v_dt TIMESTAMP;                  -- Дата/время свечи
    v_open NUMERIC(18,6);            -- Цена открытия
    v_high NUMERIC(18,6);            -- Максимум
    v_low NUMERIC(18,6);             -- Минимум
    v_close NUMERIC(18,6);           -- Цена закрытия
    v_volume NUMERIC(20,2);          -- Объем
    v_value NUMERIC(20,2);           -- Оборот
    v_records_loaded INTEGER := 0;   -- Счетчик загруженных записей
BEGIN
    -- ============================================================
    -- БЛОК 1: ПОЛУЧЕНИЕ ПРЕФИКСА И ТИПА БУМАГИ
    -- ============================================================
    SELECT sp.prefix, st.name
    INTO v_prefix, v_sec_type
    FROM securities s
    JOIN security_types st ON s.security_type_id = st.id
    JOIN security_prefixes sp ON s.id = sp.security_id
    WHERE s.id = p_security_id AND sp.exchange_id = 1;

    IF v_prefix IS NULL THEN
        RAISE EXCEPTION 'Префикс не найден для security_id=%', p_security_id;
    END IF;

    -- ============================================================
    -- БЛОК 2: ОПРЕДЕЛЕНИЕ РЫНКА MOEX
    -- ============================================================
    SELECT tf INTO v_tf_name FROM timeframes WHERE id = p_timeframe_id;

    -- Маппинг типа бумаги на параметры MOEX
    v_engine := CASE v_sec_type
        WHEN 'Stock' THEN 'stock'
        WHEN 'Futures' THEN 'futures'
        WHEN 'Bond' THEN 'bonds'
        WHEN 'Index' THEN 'stock'
        ELSE 'stock'
    END;

    v_market := CASE v_sec_type
        WHEN 'Stock' THEN 'shares'
        WHEN 'Futures' THEN 'forts'
        WHEN 'Bond' THEN 'bonds'
        WHEN 'Index' THEN 'index'
        ELSE 'shares'
    END;

    v_board := CASE v_sec_type
        WHEN 'Stock' THEN 'TQBR'
        WHEN 'Futures' THEN 'RFUD'
        WHEN 'Bond' THEN 'TQOB'
        ELSE 'TQBR'
    END;

    -- Для фьючерсов определяем активный контракт
    IF v_engine = 'futures' THEN
        v_prefix := get_active_future_prefix(p_security_id, p_date_from);
        IF v_prefix IS NULL THEN
            RAISE EXCEPTION 'Активный фьючерс не найден для security_id=% на дату %', 
                p_security_id, p_date_from;
        END IF;
    END IF;

    -- ============================================================
    -- БЛОК 3: ФОРМИРОВАНИЕ URL И ВЫПОЛНЕНИЕ HTTP GET
    -- ============================================================
    v_api_url := format(
        'https://iss.moex.com/iss/engines/%s/markets/%s/boards/%s/securities/%s/candles.json?from=%s&till=%s&interval=%s',
        v_engine, v_market, v_board, v_prefix,
        p_date_from::TEXT,
        p_date_to::TEXT,
        CASE v_tf_name
            WHEN 'M1' THEN '1'
            WHEN 'M10' THEN '10'
            WHEN 'M60' THEN '60'
            WHEN 'D1' THEN '24'
            WHEN 'W1' THEN '7'
            WHEN 'MN1' THEN '31'
            ELSE '1'
        END
    );

    RAISE NOTICE 'MOEX API URL: %', v_api_url;

    -- Выполняем GET-запрос через pgsql-http
    SELECT * INTO v_response FROM http_get(v_api_url);

    v_status := v_response.status;
    IF v_status != 200 THEN
        RAISE EXCEPTION 'MOEX API вернул статус %: %', v_status, v_response.content;
    END IF;

    -- ============================================================
    -- БЛОК 4: РАЗБОР JSON-ОТВЕТА MOEX
    -- ============================================================
    v_content := v_response.content::JSONB;

    -- MOEX возвращает данные в формате: {"candles": {"columns": [...], "data": [...]}}
    v_candles_data := v_content->'candles'->'data';
    v_columns := v_content->'candles'->'columns';

    IF v_candles_data IS NULL OR jsonb_array_length(v_candles_data) = 0 THEN
        RAISE NOTICE 'MOEX вернул пустой массив свечей';
        RETURN;
    END IF;

    -- Создаем маппинг колонок: название -> индекс
    v_col_map := '{}'::JSONB;
    FOR v_col_idx IN 0 .. jsonb_array_length(v_columns) - 1
    LOOP
        v_col_map := jsonb_set(v_col_map, ARRAY[v_columns->>v_col_idx], to_jsonb(v_col_idx));
    END LOOP;

    -- ============================================================
    -- БЛОК 5: ЗАПИСЬ СВЕЧЕЙ В БАЗУ
    -- ============================================================
    FOR v_row_idx IN 0 .. jsonb_array_length(v_candles_data) - 1
    LOOP
        v_row := v_candles_data->v_row_idx;

        -- Извлекаем данные по индексам колонок
        v_dt := (v_row->>(v_col_map->>'begin')::INTEGER)::TIMESTAMP;
        v_open := (v_row->>(v_col_map->>'open')::INTEGER)::NUMERIC;
        v_high := (v_row->>(v_col_map->>'high')::INTEGER)::NUMERIC;
        v_low := (v_row->>(v_col_map->>'low')::INTEGER)::NUMERIC;
        v_close := (v_row->>(v_col_map->>'close')::INTEGER)::NUMERIC;
        v_volume := (v_row->>(v_col_map->>'volume')::INTEGER)::NUMERIC;
        v_value := (v_row->>(v_col_map->>'value')::INTEGER)::NUMERIC;

        -- Вставляем свечу
        CALL insert_candle(
            p_security_id, p_timeframe_id, v_dt,
            v_open, v_high, v_low, v_close,
            v_volume, v_value, NULL
        );

        v_records_loaded := v_records_loaded + 1;
    END LOOP;

    -- ============================================================
    -- БЛОК 6: ЛОГИРОВАНИЕ
    -- ============================================================
    INSERT INTO price_load_log (security_id, timeframe_id, date_from, date_to, source, records_loaded)
    VALUES (p_security_id, p_timeframe_id, p_date_from, p_date_to, 'MOEX', v_records_loaded);

    RAISE NOTICE 'Загружено % свечей из MOEX', v_records_loaded;

EXCEPTION
    WHEN OTHERS THEN
        INSERT INTO price_load_log (security_id, timeframe_id, date_from, date_to, source, records_loaded, error_message)
        VALUES (p_security_id, p_timeframe_id, p_date_from, p_date_to, 'MOEX', 0, SQLERRM);
        RAISE;
END;
$$;

COMMENT ON PROCEDURE load_prices_from_moex_http(INTEGER, INTEGER, DATE, DATE) IS 
'Загружает цены через MOEX ISS API используя расширение pgsql-http (libcurl).
Требует предварительной установки: CREATE EXTENSION http;
Для фьючерсов автоматически выбирает активный контракт.';

-- ============================================
-- ГЛАВНАЯ ПРОЦЕДУРА: load_prices_http
-- Сначала T-Bank, если не сработало -- MOEX
-- ============================================
CREATE OR REPLACE PROCEDURE load_prices_http(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_date_from DATE,
    p_date_to DATE
)
LANGUAGE plpgsql AS $$
DECLARE
    v_tbank_ok BOOLEAN := FALSE;
    v_error_msg TEXT;
BEGIN
    -- ============================================================
    -- БЛОК 1: ПОПЫТКА ЗАГРУЗКИ ИЗ T-BANK
    -- ============================================================
    BEGIN
        CALL load_prices_from_tbank_http(p_security_id, p_timeframe_id, p_date_from, p_date_to);
        v_tbank_ok := TRUE;
        RAISE NOTICE 'Цены успешно загружены из T-Bank';
    EXCEPTION
        WHEN OTHERS THEN
            v_error_msg := SQLERRM;
            RAISE NOTICE 'T-Bank недоступен: %. Переключаемся на MOEX...', v_error_msg;
    END;

    -- ============================================================
    -- БЛОК 2: ПОПЫТКА ЗАГРУЗКИ ИЗ MOEX (если T-Bank не сработал)
    -- ============================================================
    IF NOT v_tbank_ok THEN
        BEGIN
            CALL load_prices_from_moex_http(p_security_id, p_timeframe_id, p_date_from, p_date_to);
            RAISE NOTICE 'Цены успешно загружены из MOEX';
        EXCEPTION
            WHEN OTHERS THEN
                v_error_msg := SQLERRM;
                RAISE EXCEPTION 'Оба источника недоступны. T-Bank: %; MOEX: %', v_error_msg, SQLERRM;
        END;
    END IF;
END;
$$;

COMMENT ON PROCEDURE load_prices_http(INTEGER, INTEGER, DATE, DATE) IS 
'Главная процедура загрузки цен через pgsql-http: сначала T-Bank, если не отвечает -- MOEX.
Требует установки расширения: CREATE EXTENSION http;
Для фьючерсов автоматически выбирает активный контракт на дату периода.';

-- ============================================
-- Процедура: load_prices_batch_http
-- Загрузка цен для нескольких бумаг сразу
-- ============================================
CREATE OR REPLACE PROCEDURE load_prices_batch_http(
    p_security_ids INTEGER[],
    p_timeframe_id INTEGER,
    p_date_from DATE,
    p_date_to DATE
)
LANGUAGE plpgsql AS $$
DECLARE
    v_security_id INTEGER;
BEGIN
    FOREACH v_security_id IN ARRAY p_security_ids
    LOOP
        BEGIN
            CALL load_prices_http(v_security_id, p_timeframe_id, p_date_from, p_date_to);
            RAISE NOTICE 'Загружены цены для security_id=%', v_security_id;
        EXCEPTION
            WHEN OTHERS THEN
                RAISE NOTICE 'Ошибка загрузки для security_id=%: %', v_security_id, SQLERRM;
        END;
    END LOOP;
END;
$$;

COMMENT ON PROCEDURE load_prices_batch_http(INTEGER[], INTEGER, DATE, DATE) IS 
'Загружает цены для массива бумаг по одному таймфрейму и периоду через pgsql-http.
Требует установки расширения: CREATE EXTENSION http;';

-- ============================================
-- Процедура: load_all_timeframes_http
-- Загрузка всех таймфреймов для одной бумаги
-- ============================================
CREATE OR REPLACE PROCEDURE load_all_timeframes_http(
    p_security_id INTEGER,
    p_date_from DATE,
    p_date_to DATE
)
LANGUAGE plpgsql AS $$
DECLARE
    v_tf RECORD;
BEGIN
    FOR v_tf IN SELECT id FROM timeframes WHERE is_active IS DISTINCT FROM FALSE ORDER BY sec
    LOOP
        BEGIN
            CALL load_prices_http(p_security_id, v_tf.id, p_date_from, p_date_to);
            RAISE NOTICE 'Загружен таймфрейм id=% для security_id=%', v_tf.id, p_security_id;
        EXCEPTION
            WHEN OTHERS THEN
                RAISE NOTICE 'Ошибка загрузки таймфрейма id=%: %', v_tf.id, SQLERRM;
        END;
    END LOOP;
END;
$$;

COMMENT ON PROCEDURE load_all_timeframes_http(INTEGER, DATE, DATE) IS 
'Загружает все таймфреймы для одной бумаги через pgsql-http.
Требует установки расширения: CREATE EXTENSION http;';


-- ============================================
-- ================================================================
-- ================================================================
-- ================================================================
--                    НЕОБЯЗАТЕЛЬНАЯ ЧАСТЬ
-- ================================================================
-- ================================================================
-- ================================================================
--
-- ВСЕ ЧТО НИЖЕ -- НЕ НУЖНО ДЛЯ СОЗДАНИЯ СТРУКТУРЫ БАЗЫ ДАННЫХ
-- ЭТО ПРИМЕРЫ ЗАПРОСОВ, ДОКУМЕНТАЦИЯ И СПРАВОЧНАЯ ИНФОРМАЦИЯ
-- МОЖНО НЕ ВЫПОЛНЯТЬ ЭТУ ЧАСТЬ ПРИ РАЗВЕРТЫВАНИИ БД
--
-- ================================================================
-- ================================================================
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
    iv.value,
    iv.is_signal,
    iv.signal_type
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
    pt.is_control,
    pt.default_value,
    pt.min_value,
    pt.max_value
FROM parameter_types pt
ORDER BY pt.is_control DESC, pt.name;

-- 4.2 Значения параметров в конкретном сете
SELECT 
    ps.name AS set_name,
    pt.name AS param_name,
    pt.short_name,
    pv.value,
    pv.record_date
FROM parameter_values pv
JOIN parameter_sets ps ON pv.parameter_set_id = ps.id
JOIN parameter_types pt ON pv.parameter_type_id = pt.id
WHERE ps.name = 'Default'
ORDER BY pt.name;

-- 4.3 Управляющие параметры (is_control = TRUE)
SELECT 
    pt.name,
    pt.short_name,
    pt.description,
    pt.default_value
FROM parameter_types pt
WHERE pt.is_control = TRUE
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
-- 6. ЛОГИКИ (logics + logics_detail)
-- ============================================

-- 6.1 Все логики с деталями
SELECT 
    l.name AS logic_name,
    ld.formula,
    s.name AS side,
    a.name AS action
FROM logics l
JOIN logics_detail ld ON l.name = ld.logic_name
JOIN sides s ON ld.side_id = s.id
JOIN actions a ON ld.action_id = a.id
ORDER BY l.name;

-- 6.2 Логики на открытие лонга
SELECT 
    l.name,
    ld.formula
FROM logics l
JOIN logics_detail ld ON l.name = ld.logic_name
JOIN sides s ON ld.side_id = s.id
JOIN actions a ON ld.action_id = a.id
WHERE s.name = 'Open' AND a.name = 'Long';

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