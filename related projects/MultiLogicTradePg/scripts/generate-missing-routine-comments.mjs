/**
 * Generates sql/routine_comments_missing.sql for CREATE FUNCTION/PROCEDURE
 * in 02 that lack COMMENT ON (shown in UI «Структура БД»).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql02 = fs.readFileSync(path.join(root, '02_multilogictrade_functions_and_procedures.sql'), 'utf8');

const creates = [...sql02.matchAll(/CREATE\s+OR\s+REPLACE\s+(FUNCTION|PROCEDURE)\s+([a-zA-Z0-9_]+)/gi)].map(
  (m) => ({ kind: m[1].toUpperCase(), name: m[2] }),
);
const byName = new Map();
for (const x of creates) byName.set(x.name.toLowerCase(), x);
const comments = new Set(
  [...sql02.matchAll(/COMMENT\s+ON\s+(FUNCTION|PROCEDURE)\s+([a-zA-Z0-9_]+)/gi)].map((m) =>
    m[2].toLowerCase(),
  ),
);

const desc = {
  calc_ind_atr: 'Расчёт ATR (Average True Range) для бумаги/таймфрейма; пишет серии индикатора.',
  calc_ind_atr_array: 'ATR массивом по барам (TABLE dt,value) для sync серий.',
  calc_ind_bb: 'Расчёт Bollinger Bands (UPPER/MIDDLE/LOWER).',
  calc_ind_bb_array: 'Bollinger Bands массивом по барам.',
  calc_ind_ema: 'Расчёт EMA (Exponential Moving Average).',
  calc_ind_ema_array: 'EMA массивом по барам.',
  calc_ind_macd: 'Расчёт MACD / SIGNAL / HISTOGRAM.',
  calc_ind_macd_array: 'MACD массивом по барам.',
  calc_ind_rsi: 'Расчёт RSI.',
  calc_ind_rsi_array: 'RSI массивом по барам.',
  calc_ind_sma: 'Расчёт SMA.',
  calc_ind_sma_array: 'SMA массивом по барам.',
  calc_ind_stoch: 'Расчёт Stochastic (K/D).',
  calc_ind_stoch_array: 'Stochastic массивом по барам.',
  calc_indicator_series_array: 'Универсальный расчёт серии индикатора (calc_ind_* или poly-формула).',
  default_invoke_formula: 'Формула вызова индикатора по умолчанию из справочника.',
  ensure_security_indicator_series: 'Создаёт строки security_indicator_series для индикатора на бумаге.',
  evaluate_signal_condition: 'Проверяет условие сигнала (@CODE …) на закрытом баре.',
  get_logic_param_numeric: 'Числовой параметр логики из logic_params (EAV).',
  get_logic_param_text: 'Текстовый параметр логики из logic_params (EAV).',
  ind_resolve_end_dt: 'Конечная дата/время окна расчёта индикатора.',
  ind_warmup_bars: 'Число баров прогрева для индикатора/формулы.',
  is_perpetual_future_group: 'Признак вечного фьючерса (CNYRUBF и т.п.) по группе префикса.',
  logic_backtest_cancel_requested: 'Проверка: пользователь запросил остановку бэктеста.',
  logic_backtest_close_security: 'Закрытие позиции по бумаге в бэктесте.',
  logic_backtest_count_open_positions: 'Число открытых позиций в прогоне бэктеста.',
  logic_backtest_diagnose: 'Диагностика состояния бэктеста (отладка).',
  logic_backtest_insert_trade: 'Вставка тестовой сделки (logic_trades, is_test=1, run_id).',
  logic_backtest_price_at: 'Цена бумаги на баре бэктеста.',
  logic_backtest_process_risk: 'Стопы/риск в бэктесте на баре.',
  logic_backtest_process_signals: 'Сигналы open/close в бэктесте на баре.',
  logic_backtest_request_cancel: 'Помечает прогон бэктеста к отмене (UI Стоп).',
  logic_backtest_sec_inverted: 'Локальная инверсия бумаги в бэктесте (security_inversion).',
  logic_backtest_sec_shadow: 'Теневой режим бумаги в бэктесте (пауза/resume).',
  logic_backtest_security_drawdown_pct: 'Просадка по бумаге в бэктесте, %.',
  logic_backtest_security_gain_pct: 'Прирост по бумаге в бэктесте, %.',
  logic_backtest_update_run: 'Обновление статуса/прогресса logic_backtest_runs.',
  logic_check_security_resume: 'Проверка условий security_resume для возобновления торговли.',
  logic_close_security_positions_market: 'Закрытие боевых позиций по бумаге по рынку.',
  logic_count_open_positions: 'Число открытых боевых позиций логики.',
  logic_ensure_balance: 'Инициализация/проверка current_balance фейк-счёта.',
  logic_long_position_qty: 'Объём открытого лонга по бумаге.',
  logic_portfolio_drawdown_pct: 'Просадка портфеля логики, %.',
  logic_portfolio_equity: 'Эквити портфеля логики (баланс ± позиции).',
  logic_security_drawdown_pct: 'Просадка по бумаге в боевом режиме, %.',
  logic_security_position_cost: 'Себестоимость позиции по бумаге.',
  logic_security_position_market: 'Рыночная оценка позиции по бумаге.',
  logic_security_track_value: 'Учётная стоимость позиции для стопов.',
  logic_short_position_qty: 'Объём открытого шорта по бумаге.',
  logic_signal_evaluate_at: 'Оценка сигнала логики на заданном баре.',
  logic_signal_record_fire: 'Фиксация срабатывания сигнала (pending рейтинга и т.п.).',
  logic_upsert_param: 'UPSERT параметра в logic_params.',
  parse_signal_formula: 'Разбор формулы сигнала @CODE(…) condition.',
  parse_signal_param_num: 'Числовой параметр из текста формулы сигнала.',
  parse_signal_series: 'Код серии (VALUE/UPPER/…) из формулы сигнала.',
  poly_add: 'Сложение рядов в poly-парсере.',
  poly_align2: 'Выравнивание двух рядов по длине.',
  poly_build_ema_kernel: 'Ядро EMA для свёртки.',
  poly_build_sma_kernel: 'Ядро SMA для свёртки.',
  poly_comp_div: 'Покомпонентное деление рядов.',
  poly_comp_mul: 'Покомпонентное умножение рядов.',
  poly_ctx_period: 'Период из контекста poly-формулы.',
  poly_delta_kernel: 'Ядро дельты (производной) для свёртки.',
  poly_eval_node: 'Вычисление узла AST poly-формулы.',
  poly_extend: 'Дополнение ряда до нужной длины.',
  poly_fn_empty_args: 'Проверка пустых аргументов функции sma/ema/…',
  poly_fn_resolve_period: 'Период из аргументов sma(period=…).',
  poly_fn_resolve_series: 'Серия из аргументов sma(…, series=…).',
  poly_fn_validate_args: 'Валидация аргументов встроенных poly-функций.',
  poly_formula_conv_depth: 'Глубина свёрток формулы (для warmup).',
  poly_formula_warmup_bars: 'Бары прогрева для poly-формулы.',
  poly_is_formula: 'Признак, что invoke — многочленная формула.',
  poly_len: 'Длина числового ряда.',
  poly_load_indicator_array: 'Загрузка ряда индикатора @CODE в poly-контекст.',
  poly_load_market_array: 'Загрузка OHLC/V ряда (pp/oo/…) в poly-контекст.',
  poly_load_market_dts: 'Метки времени баров рынка для poly.',
  poly_neg: 'Унарный минус ряда.',
  poly_parse: 'Разбор текста poly-формулы в AST.',
  poly_parse_add: 'Разбор сложения/вычитания.',
  poly_parse_atom: 'Разбор атома (число, ряд, скобки).',
  poly_parse_comp: 'Разбор покомпонентных операций.',
  poly_parse_conv: 'Разбор свёртки (*).',
  poly_parse_fn_args: 'Разбор аргументов sma(…)/ema(…).',
  poly_parse_unary: 'Разбор унарных операций.',
  poly_peek_token: 'Просмотр текущего токена без потребления.',
  poly_pp_from_ctx: 'Ряд Close (pp) из контекста.',
  poly_sub: 'Вычитание рядов.',
  poly_tokenize: 'Лексер poly-формулы.',
  resolve_indicator_params: 'Параметры индикатора (period и др.) для расчёта.',
  sync_security_indicator_series: 'Синхронизация (пересчёт) серий индикатора на бумаге.',
  sync_security_indicator_series_all: 'Синхронизация всех серий индикаторов на бумаге.',
};

const missing = [...byName.keys()].filter((n) => !comments.has(n)).sort();
const lines = [
  '-- @include sql/routine_comments_missing.sql',
  '-- Комментарии к функциям/процедурам без COMMENT ON (для UI «Структура БД» / obj_description).',
  '-- Файл генерируется: node scripts/generate-missing-routine-comments.mjs',
  '',
];

for (const key of missing) {
  const { kind, name } = byName.get(key);
  const d = desc[key] || `Служебная ${kind.toLowerCase()} ${name} (см. исходник в 02).`;
  lines.push(`COMMENT ON ${kind} ${name} IS`);
  lines.push(`  '${d.replace(/'/g, "''")}';`);
  lines.push('');
}

const outPath = path.join(root, 'sql', 'routine_comments_missing.sql');
fs.writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
console.log(`Wrote ${missing.length} COMMENT ON → ${outPath}`);
