-- Тренажёр: идемпотентная миграция для уже установленных БД.
-- Создаёт таблицы результатов тренажёра (trainer_sessions / trainer_trades),
-- если их нет. Вызывается установщиками в upgrade-ветке до применения 01/02.
-- Безопасна на любом состоянии БД: все объекты создаются IF NOT EXISTS.
-- Держать в синхронизации с блоком trainer_* в 01_multilogictrade_tables_and_data.sql.

CREATE TABLE IF NOT EXISTS trainer_sessions (
    id BIGSERIAL PRIMARY KEY,
    session_key UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    security_id INTEGER REFERENCES securities(id) ON DELETE SET NULL,
    timeframe_id INTEGER REFERENCES timeframes(id) ON DELETE SET NULL,
    security_name TEXT,
    timeframe_tf VARCHAR(16),
    started_at TIMESTAMP,
    ended_at TIMESTAMP,
    trading_ms BIGINT,
    commission_pct NUMERIC(8, 4) NOT NULL DEFAULT 0,
    exec_delay_sec INTEGER NOT NULL DEFAULT 0,
    finished BOOLEAN NOT NULL DEFAULT FALSE,
    trades_count INTEGER NOT NULL DEFAULT 0,
    wins_count INTEGER NOT NULL DEFAULT 0,
    losses_count INTEGER NOT NULL DEFAULT 0,
    total_pnl NUMERIC(18, 6) NOT NULL DEFAULT 0,
    unrealized_pnl NUMERIC(18, 6) NOT NULL DEFAULT 0,
    total_pnl_with_unrealized NUMERIC(18, 6) NOT NULL DEFAULT 0,
    annual_pct NUMERIC(14, 4),
    avg_holding_ms BIGINT,
    avg_exec_delay_sec NUMERIC(12, 3),
    CONSTRAINT uq_trainer_sessions_key UNIQUE (session_key)
);
ALTER TABLE trainer_sessions ADD COLUMN IF NOT EXISTS session_key UUID;
ALTER TABLE trainer_sessions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE trainer_sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE trainer_sessions ADD COLUMN IF NOT EXISTS security_id INTEGER REFERENCES securities(id) ON DELETE SET NULL;
ALTER TABLE trainer_sessions ADD COLUMN IF NOT EXISTS timeframe_id INTEGER REFERENCES timeframes(id) ON DELETE SET NULL;
ALTER TABLE trainer_sessions ADD COLUMN IF NOT EXISTS security_name TEXT;
ALTER TABLE trainer_sessions ADD COLUMN IF NOT EXISTS timeframe_tf VARCHAR(16);
ALTER TABLE trainer_sessions ADD COLUMN IF NOT EXISTS started_at TIMESTAMP;
ALTER TABLE trainer_sessions ADD COLUMN IF NOT EXISTS ended_at TIMESTAMP;
ALTER TABLE trainer_sessions ADD COLUMN IF NOT EXISTS trading_ms BIGINT;
ALTER TABLE trainer_sessions ADD COLUMN IF NOT EXISTS commission_pct NUMERIC(8, 4) NOT NULL DEFAULT 0;
ALTER TABLE trainer_sessions ADD COLUMN IF NOT EXISTS exec_delay_sec INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trainer_sessions ADD COLUMN IF NOT EXISTS finished BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE trainer_sessions ADD COLUMN IF NOT EXISTS trades_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trainer_sessions ADD COLUMN IF NOT EXISTS wins_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trainer_sessions ADD COLUMN IF NOT EXISTS losses_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trainer_sessions ADD COLUMN IF NOT EXISTS total_pnl NUMERIC(18, 6) NOT NULL DEFAULT 0;
ALTER TABLE trainer_sessions ADD COLUMN IF NOT EXISTS unrealized_pnl NUMERIC(18, 6) NOT NULL DEFAULT 0;
ALTER TABLE trainer_sessions ADD COLUMN IF NOT EXISTS total_pnl_with_unrealized NUMERIC(18, 6) NOT NULL DEFAULT 0;
ALTER TABLE trainer_sessions ADD COLUMN IF NOT EXISTS annual_pct NUMERIC(14, 4);
ALTER TABLE trainer_sessions ADD COLUMN IF NOT EXISTS avg_holding_ms BIGINT;
ALTER TABLE trainer_sessions ADD COLUMN IF NOT EXISTS avg_exec_delay_sec NUMERIC(12, 3);

-- UNIQUE(session_key) мог отсутствовать в старых БД — добавляем идемпотентно.
DO $upgrade_trainer_sessions_key$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_trainer_sessions_key'
    ) THEN
        ALTER TABLE trainer_sessions ADD CONSTRAINT uq_trainer_sessions_key UNIQUE (session_key);
    END IF;
END
$upgrade_trainer_sessions_key$;

CREATE INDEX IF NOT EXISTS idx_trainer_sessions_security ON trainer_sessions(security_id);
CREATE INDEX IF NOT EXISTS idx_trainer_sessions_timeframe ON trainer_sessions(timeframe_id);
CREATE INDEX IF NOT EXISTS idx_trainer_sessions_created_at ON trainer_sessions(created_at DESC);

COMMENT ON TABLE trainer_sessions IS
'Сессии вкладки «Тренажёр»: интерактивная посвечная торговля пользователя. Upsert по session_key при завершении/перезапуске; питает статистический отчёт по бумагам/таймфреймам.';

CREATE TABLE IF NOT EXISTS trainer_trades (
    id BIGSERIAL PRIMARY KEY,
    session_id BIGINT NOT NULL REFERENCES trainer_sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    side VARCHAR(5) NOT NULL CHECK (side IN ('long', 'short')),
    open_dt TIMESTAMP NOT NULL,
    open_price NUMERIC(18, 6) NOT NULL,
    close_dt TIMESTAMP,
    close_price NUMERIC(18, 6),
    commission NUMERIC(18, 6) NOT NULL DEFAULT 0,
    pnl NUMERIC(18, 6),
    pnl_pct NUMERIC(14, 4),
    annual_pct NUMERIC(14, 4),
    holding_ms BIGINT,
    is_open BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT uq_trainer_trades_session_seq UNIQUE (session_id, seq)
);
ALTER TABLE trainer_trades ADD COLUMN IF NOT EXISTS session_id BIGINT REFERENCES trainer_sessions(id) ON DELETE CASCADE;
ALTER TABLE trainer_trades ADD COLUMN IF NOT EXISTS seq INTEGER;
ALTER TABLE trainer_trades ADD COLUMN IF NOT EXISTS side VARCHAR(5);
ALTER TABLE trainer_trades ADD COLUMN IF NOT EXISTS open_dt TIMESTAMP;
ALTER TABLE trainer_trades ADD COLUMN IF NOT EXISTS open_price NUMERIC(18, 6);
ALTER TABLE trainer_trades ADD COLUMN IF NOT EXISTS close_dt TIMESTAMP;
ALTER TABLE trainer_trades ADD COLUMN IF NOT EXISTS close_price NUMERIC(18, 6);
ALTER TABLE trainer_trades ADD COLUMN IF NOT EXISTS commission NUMERIC(18, 6) NOT NULL DEFAULT 0;
ALTER TABLE trainer_trades ADD COLUMN IF NOT EXISTS pnl NUMERIC(18, 6);
ALTER TABLE trainer_trades ADD COLUMN IF NOT EXISTS pnl_pct NUMERIC(14, 4);
ALTER TABLE trainer_trades ADD COLUMN IF NOT EXISTS annual_pct NUMERIC(14, 4);
ALTER TABLE trainer_trades ADD COLUMN IF NOT EXISTS holding_ms BIGINT;
ALTER TABLE trainer_trades ADD COLUMN IF NOT EXISTS is_open BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_trainer_trades_session ON trainer_trades(session_id);

COMMENT ON TABLE trainer_trades IS
'Сделки пользователя в сессии тренажёра (1 юнит). is_open=TRUE — mark-to-market строка ещё открытой позиции на момент сохранения.';
