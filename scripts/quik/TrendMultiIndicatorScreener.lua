--[[
================================================================================
  TrendMultiIndicatorScreener — скрипт для терминала QUIK
  Порт логики робота OsEngine: Custom/Robots/TrendMultiIndicatorScreener.cs
  Один инструмент (в OsEngine — скринер на много вкладок).
================================================================================

УСТАНОВКА И ЗАПУСК
  1. Скопируйте этот файл в каталог Lua QUIK (или укажите путь в «Скрипты Lua»).
  2. В блоке «НАСТРОЙКИ ИНСТРУМЕНТА» ниже задайте CLASS_CODE, SEC_CODE, ACCOUNT,
     CLIENT_CODE (для срочного рынка), INTERVAL.
  3. Для торговли установите REGIME = "On" (сначала проверьте на демо-счёте).
  4. QUIK: Сервис → Lua-скрипты → Добавить → Запустить.

СИГНАЛЫ (как в OsEngine)
  - Считаются на ЗАКРЫТОЙ свече: при появлении нового бара обрабатывается
    предыдущий (последний закрытый), не формирующийся.
  - И-группы («№ И-группы» в роботе): номера G и −G — одна группа |G|.
    Внутри группы условия связаны И (AND). Между разными |номерами| — ИЛИ (OR).
    Отрицательный номер (*_GROUP < 0) = NOT (инверсия условия индикатора).
    Номер 0 трактуется как 1.
  - По умолчанию включены: SMA(100), VWAP, ATR, LinReg(50, dev 2) — все в группе 1.
    Bull: close > SMA, close > VWAP, close > верх LinReg, ATR вырос на % за lookback.
    Bear: close < SMA, close < VWAP, close < низ LinReg, тот же фильтр ATR.

ВХОД / ВЫХОД
  - Нет позиции: лонг при bull, шорт при bear (с учётом REGIME и INVERT_ENTRY_LOGIC).
  - Есть позиция: при противоположном сигнале — закрыть и открыть в другую сторону (реверс).
  - INVERT_ENTRY_LOGIC = true: по bull открывается продажа, по bear — покупка.

ЧТО ПЕРЕНЕСЕНО В QUIK
  - SMA, VWAP (сброс накопления по календарному дню, typical = (H+L+C)/3),
    ATR Wilder (фильтр: рост на ATR_GROW_PERCENT % за ATR_GROW_LOOKBACK свечей),
    LinReg-канал (LinearRegressionChannelFast_Indicator),
    RSI (если USE_RSI = true); флаги USE_* для Stoch/Momentum/Bollinger/Volume/MACD.
  - Нерабочие периоды (3 окна, как Non trade periods в роботе).
  - Трейлинг позиции в % от пика цены (USE_POSITION_TRAILING).
  - REGIME: Off / On / OnlyLong / OnlyShort / OnlyClosePosition.

ЧЕГО НЕТ В QUIK (только в OsEngine)
  - Скринер и торговля сразу по многим бумагам / префиксам MOEX.
  - Самоиндикация, кластеры волатильности, кнопки «Обновить фьючерсы/акции».
  - Страховка портфеля (просадка equity), рандомный сдвиг цен.
  - Расписание «Дата-время начала/окончания работы».
  - DiscreteMidBestPair, RZIgreensMinusReds, Average Profit Percent Long.
  - Max positions (all tabs), проскальзывание лимиток (здесь рыночные заявки).

СООТВЕТСТВИЕ ПАРАМЕТРОВ OsEngine → этот скрипт
  Use SMA / SMA length              → USE_SMA, SMA_LEN, SMA_GROUP
  Use VWAP                          → USE_VWAP, VWAP_GROUP
  Use ATR / ATR min grow % / lookback → USE_ATR, ATR_GROW_PERCENT, ATR_GROW_LOOKBACK, ATR_GROUP
  Use Linear Regression / length / deviation → USE_LINREG, LINREG_LEN, LINREG_DEV, LINREG_GROUP
  Use RSI / RSI long min / short max → USE_RSI, RSI_*, RSI_GROUP
  Use Stochastic / Momentum / Bollinger / Volume / MACD → USE_*, *_GROUP (см. блок ниже)
  *: № И-группы                      → *_GROUP (отрицательное = NOT)
  Regime                            → REGIME
  Инверсия логики (покупка ↔ продажа) → INVERT_ENTRY_LOGIC
  Трейлинг позиции / %              → USE_POSITION_TRAILING, POSITION_TRAILING_PERCENT
  Non trade periods (3 окна)        → USE_NON_TRADE_PERIODS, NON_TRADE_1/2/3
  Trade in Saturday / Sunday        → TRADE_SATURDAY, TRADE_SUNDAY
  Volume / Slippage                 → LOT_SIZE (объём в лотах; SLIPPAGE_STEPS — задел)

ПРИМЕРЫ И-ГРУПП (как в комментарии к роботу)
  - SMA_GROUP=1, RSI_GROUP=1     → (SMA ∧ RSI) для входа в эту сторону.
  - SMA_GROUP=1, RSI_GROUP=-1    → (SMA ∧ ¬RSI) в одной группе |1|.
  - SMA_GROUP=2, RSI_GROUP=-2    → та же группа |2|; с VOLUME_GROUP=1 → (SMA₂∧¬RSI₂) ∨ (Volume₁).

================================================================================
]]

-- ======================== НАСТРОЙКИ ИНСТРУМЕНТА ========================
-- OsEngine: класс и тикер вкладки скринера. Здесь — один инструмент.
CLASS_CODE   = "SPBFUT"       -- SPBFUT (фьючерсы), TQBR (акции), …
SEC_CODE     = "SiM5"         -- код бумаги, как в QUIK
INTERVAL     = INTERVAL_M5    -- INTERVAL_M1, M5, M15, H1, D1, …
ACCOUNT      = ""             -- торговый счёт; пусто — из настроек терминала
CLIENT_CODE  = ""             -- для срочного рынка (SPBFUT), если требуется брокером
LOT_SIZE     = 1              -- объём одной сделки в лотах (OsEngine: Volume)

-- ======================== РЕЖИМ ========================
-- OsEngine: Regime — Off / On / OnlyLong / OnlyShort / OnlyClosePosition
REGIME = "Off"
-- OsEngine: «Инверсия логики (покупка ↔ продажа)»
INVERT_ENTRY_LOGIC = false    -- true: сигнал bull → продажа, bear → покупка

-- ======================== ИНДИКАТОРЫ ========================
-- Use* в роботе → USE_* ниже. По умолчанию как в OsEngine: SMA, VWAP, ATR, LinReg — вкл.
-- Полностью в расчёте сигнала: SMA, VWAP, ATR, LinReg, RSI (если USE_RSI).
-- Флаги USE_STOCH / USE_MOMENTUM / USE_BOLLINGER / USE_VOLUME_IND / USE_MACD —
-- заготовки под те же условия; для боевой торговли включайте после проверки логики.
USE_SMA  = true               -- OsEngine: Use SMA
SMA_LEN  = 100                -- SMA length; bull: close > SMA, bear: close < SMA
SMA_GROUP = 1                 -- OsEngine: SMA: № И-группы

USE_VWAP = true               -- OsEngine: Use VWAP; сброс VWAP в начале календарного дня
VWAP_GROUP = 1

USE_ATR  = true               -- OsEngine: Use ATR (фильтр роста волатильности, без направления)
ATR_LEN  = 14                 -- ATR length
ATR_GROW_PERCENT = 3.0        -- ATR min grow % vs lookback
ATR_GROW_LOOKBACK = 5         -- ATR grow lookback (candles)
ATR_GROUP = 1

USE_LINREG = true             -- OsEngine: Use Linear Regression
LINREG_LEN = 50               -- LinReg length
LINREG_DEV = 2.0              -- Up/Down channel deviation
LINREG_GROUP = 1              -- bull: close > верх канала; bear: close < низ канала

USE_RSI = false               -- OsEngine: Use RSI; bull: RSI >= long min, bear: RSI <= short max
RSI_LEN = 14
RSI_LONG_MIN = 55
RSI_SHORT_MAX = 45
RSI_GROUP = 1

USE_STOCH = false             -- OsEngine: Use Stochastic (в is_bull/bear пока не подключён)
STOCH_P1, STOCH_P2, STOCH_P3 = 5, 3, 3
STOCH_LONG_MIN, STOCH_SHORT_MAX = 55, 45
STOCH_GROUP = 1

USE_MOMENTUM = false          -- OsEngine: Use Momentum
MOM_LEN = 15
MOM_LONG_MIN, MOM_SHORT_MAX = 100, 100
MOM_GROUP = 1

USE_BOLLINGER = false         -- OsEngine: Use Bollinger; bull/bear: close vs середина полос
BOLL_LEN = 100
BOLL_DEV = 2.0
BOLL_GROUP = 1

USE_VOLUME_IND = false        -- OsEngine: Use Volume indicator; рост объёма vs пред. свеча, %
VOLUME_MIN_GROW_PERCENT = 5.0
VOLUME_GROUP = 1

USE_MACD = false              -- OsEngine: Use MACD; bull: MACD > signal, bear: MACD < signal
MACD_FAST, MACD_SLOW, MACD_SIGNAL = 12, 26, 9
MACD_GROUP = 1

-- ======================== СТОПЫ / ФИЛЬТРЫ ========================
-- OsEngine: вкладка «Стопы» — трейлинг позиции (CloseAtTrailingStopMarket / свеча в тестере)
USE_POSITION_TRAILING = true
POSITION_TRAILING_PERCENT = 1.0   -- % отката от пика цены для закрытия

-- OsEngine: Non trade periods (кнопка в роботе) — локальное время QUIK
USE_NON_TRADE_PERIODS = true
-- { включён, час_нач, мин_нач, час_кон, мин_кон }
NON_TRADE_1 = { true,  0,  0, 10,  5 }   -- по умолчанию в роботе: 00:00–10:05
NON_TRADE_2 = { false, 13, 54, 14,  6 }
NON_TRADE_3 = { true, 18,  1, 23, 58 }   -- 18:01–23:58
TRADE_SATURDAY = false        -- OsEngine: TradeInSaturday
TRADE_SUNDAY   = false        -- OsEngine: TradeInSunday

SLIPPAGE_STEPS = 0            -- OsEngine: Slippage (steps); 0 = заявки TYPE "M" (рыночные)

-- ======================== СЛУЖЕБНОЕ (не менять без необходимости) ========================
is_run = true
last_bar_time = 0
ds = nil
position_side = 0             -- 0 нет, 1 long, -1 short
trail_peak = 0

-- ---------------------------------------------------------------------------
function log_msg(text)
    message(tostring(text), 1)
end

function round(x, n)
    local m = 10 ^ (n or 0)
    return math.floor(x * m + 0.5) / m
end

function get_security_step()
    local si = getSecurityInfo(CLASS_CODE, SEC_CODE)
    if si and si.min_price_step and si.min_price_step > 0 then
        return si.min_price_step
    end
    return 0.01
end

function time_in_non_trade_periods()
    if not USE_NON_TRADE_PERIODS then
        return false
    end
    local t = os.date("*t")
    local dow = t.wday -- 1=воскресенье в Lua
    if dow == 1 and not TRADE_SUNDAY then return true end
    if dow == 7 and not TRADE_SATURDAY then return true end
    local mins = t.hour * 60 + t.min
    local periods = { NON_TRADE_1, NON_TRADE_2, NON_TRADE_3 }
    for _, p in ipairs(periods) do
        if p[1] then
            local a = p[2] * 60 + p[3]
            local b = p[4] * 60 + p[5]
            if a <= b then
                if mins >= a and mins < b then return true end
            else
                if mins >= a or mins < b then return true end
            end
        end
    end
    return false
end

function normalize_group(raw)
    if raw == 0 then return 1 end
    return raw
end

function add_group_item(items, group_param, pass)
    if pass == nil then return end
    local raw = normalize_group(group_param)
    local key = math.abs(raw)
    local p = pass
    if raw < 0 then p = not pass end
    table.insert(items, { key = key, pass = p })
end

function combine_groups(items)
    if #items == 0 then return true end
    local groups = {}
    for _, it in ipairs(items) do
        groups[it.key] = groups[it.key] or {}
        table.insert(groups[it.key], it.pass)
    end
    for _, passes in pairs(groups) do
        local ok = true
        for _, v in ipairs(passes) do
            if not v then ok = false break end
        end
        if ok then return true end
    end
    return false
end

-- SMA -----------------------------------------------------------------------
function calc_sma(idx, len)
    if idx < len then return nil end
    local s = 0
    for i = idx - len + 1, idx do
        s = s + ds:C(i)
    end
    return s / len
end

function bull_sma(close, idx)
    if not USE_SMA then return nil end
    local v = calc_sma(idx, SMA_LEN)
    if not v or v == 0 then return false end
    return close > v
end

function bear_sma(close, idx)
    if not USE_SMA then return nil end
    local v = calc_sma(idx, SMA_LEN)
    if not v or v == 0 then return false end
    return close < v
end

-- VWAP (сброс по календарному дню, typical = (H+L+C)/3) --------------------
function calc_vwap(idx)
    local cum_tv, cum_v = 0, 0
    local session_day = nil
    for i = 0, idx do
        local t = ds:T(i)
        local day = os.date("%Y%m%d", t)
        if session_day ~= day then
            session_day = day
            cum_tv, cum_v = 0, 0
        end
        local h, l, c, v = ds:H(i), ds:L(i), ds:C(i), ds:V(i)
        local typical = (h + l + c) / 3
        if v and v > 0 then
            cum_tv = cum_tv + typical * v
            cum_v = cum_v + v
        end
    end
    if cum_v <= 0 then return nil end
    return cum_tv / cum_v
end

function bull_vwap(close, idx)
    if not USE_VWAP then return nil end
    local v = calc_vwap(idx)
    if not v or v == 0 then return false end
    return close > v
end

function bear_vwap(close, idx)
    if not USE_VWAP then return nil end
    local v = calc_vwap(idx)
    if not v or v == 0 then return false end
    return close < v
end

-- ATR (Wilder) ----------------------------------------------------------------
function true_range(i)
    if i <= 0 then return 0 end
    local hi, lo = ds:H(i), ds:L(i)
    local prev_c = ds:C(i - 1)
    return math.max(hi - lo, math.abs(prev_c - hi), math.abs(prev_c - lo))
end

function calc_atr(idx, len)
    if idx < len then return nil end
    local atr = 0
    for i = 0, len - 1 do
        atr = atr + true_range(i)
    end
    atr = atr / len
    for i = len, idx do
        atr = (atr * (len - 1) + true_range(i)) / len
    end
    return atr
end

function atr_filter_passes(idx)
    if not USE_ATR then return nil end
    local lb = math.max(1, ATR_GROW_LOOKBACK)
    if idx < ATR_LEN + lb then return false end
    local last = calc_atr(idx, ATR_LEN)
    local past = calc_atr(idx - lb, ATR_LEN)
    if not last or not past or past == 0 then return false end
    local grow = last / (past / 100) - 100
    return grow >= ATR_GROW_PERCENT
end

-- LinReg channel (LinearRegressionChannelFast_Indicator) --------------------
function calc_linreg_bands(idx, period, dev)
    if idx < period - 1 then return nil, nil, nil end
    local start_i = idx - period + 1
    local sumy, sumx, sumxy, sumx2 = 0, 0, 0, 0
    for i = start_i, idx do
        local g = i - start_i
        local y = ds:C(i)
        sumy = sumy + y
        sumxy = sumxy + y * g
        sumx = sumx + g
        sumx2 = sumx2 + g * g
    end
    local c = sumx2 * period - sumx * sumx
    if c == 0 then return nil, nil, nil end
    local b = (sumxy * period - sumx * sumy) / c
    local a = (sumy - sumx * b) / period
    local central = a + b * (period - 1)
    local err = 0
    for i = start_i, idx do
        local g = i - start_i
        local line = a + b * g
        err = err + math.abs(ds:C(i) - line)
    end
    err = err / period
    return central + err * dev, central, central - err * dev
end

function bull_linreg(close, idx)
    if not USE_LINREG then return nil end
    local up, _, _ = calc_linreg_bands(idx, LINREG_LEN, LINREG_DEV)
    if not up or up == 0 then return false end
    return close > up
end

function bear_linreg(close, idx)
    if not USE_LINREG then return nil end
    local _, _, down = calc_linreg_bands(idx, LINREG_LEN, LINREG_DEV)
    if not down or down == 0 then return false end
    return close < down
end

-- RSI -----------------------------------------------------------------------
function calc_rsi(idx, len)
    if idx < len then return nil end
    local gain, loss = 0, 0
    for i = idx - len + 1, idx do
        local d = ds:C(i) - ds:C(i - 1)
        if d > 0 then gain = gain + d else loss = loss - d end
    end
    if loss == 0 then return 100 end
    local rs = gain / loss
    return 100 - (100 / (1 + rs))
end

function bull_rsi(_, idx)
    if not USE_RSI then return nil end
    local v = calc_rsi(idx, RSI_LEN)
    return v and v >= RSI_LONG_MIN
end

function bear_rsi(_, idx)
    if not USE_RSI then return nil end
    local v = calc_rsi(idx, RSI_LEN)
    return v and v <= RSI_SHORT_MAX
end

-- Volume growth -------------------------------------------------------------
function volume_growth_ok(idx)
    if idx < 1 then return false end
    local v0, v1 = ds:V(idx), ds:V(idx - 1)
    if not v1 or v1 <= 0 then return false end
    return v0 >= v1 * (1 + VOLUME_MIN_GROW_PERCENT / 100)
end

function bull_volume(_, idx)
    if not USE_VOLUME_IND then return nil end
    return volume_growth_ok(idx)
end

-- Signals -------------------------------------------------------------------
function is_bull_signal(idx)
    local close = ds:C(idx)
    local items = {}
    add_group_item(items, SMA_GROUP, bull_sma(close, idx))
    add_group_item(items, VWAP_GROUP, bull_vwap(close, idx))
    add_group_item(items, ATR_GROUP, atr_filter_passes(idx))
    add_group_item(items, LINREG_GROUP, bull_linreg(close, idx))
    add_group_item(items, RSI_GROUP, bull_rsi(close, idx))
    add_group_item(items, VOLUME_GROUP, bull_volume(close, idx))
    return combine_groups(items)
end

function is_bear_signal(idx)
    local close = ds:C(idx)
    local items = {}
    add_group_item(items, SMA_GROUP, bear_sma(close, idx))
    add_group_item(items, VWAP_GROUP, bear_vwap(close, idx))
    add_group_item(items, ATR_GROUP, atr_filter_passes(idx))
    add_group_item(items, LINREG_GROUP, bear_linreg(close, idx))
    add_group_item(items, RSI_GROUP, bear_rsi(close, idx))
    add_group_item(items, VOLUME_GROUP, bear_volume(close, idx))
    return combine_groups(items)
end

function apply_invert(bull, bear)
    if INVERT_ENTRY_LOGIC then
        return bear, bull
    end
    return bull, bear
end

-- Position ------------------------------------------------------------------
function refresh_position_side()
    position_side = 0
    local n = getNumberOf("futures_client_holding")
    if n and n > 0 then
        for i = 0, n - 1 do
            local h = getItem("futures_client_holding", i)
            if h and h.sec_code == SEC_CODE and (h.trdaccid == ACCOUNT or ACCOUNT == "") then
                if h.totalnet and h.totalnet > 0 then position_side = 1
                elseif h.totalnet and h.totalnet < 0 then position_side = -1 end
                return
            end
        end
    end
    n = getNumberOf("depo_limits")
    if n and n > 0 then
        for i = 0, n - 1 do
            local d = getItem("depo_limits", i)
            if d and d.sec_code == SEC_CODE then
                local bal = d.currentbal or d.currentbalance or 0
                if bal > 0 then position_side = 1
                elseif bal < 0 then position_side = -1 end
                return
            end
        end
    end
end

function send_market(operation)
    local t = {
        ACTION = "NEW_ORDER",
        CLASSCODE = CLASS_CODE,
        SECCODE = SEC_CODE,
        OPERATION = operation,  -- "B" / "S"
        TYPE = "M",
        QUANTITY = tostring(LOT_SIZE),
    }
    if ACCOUNT ~= "" then t.ACCOUNT = ACCOUNT end
    if CLIENT_CODE ~= "" then t.CLIENT_CODE = CLIENT_CODE end
    local res = sendTransaction(t)
    log_msg("Заявка " .. operation .. " " .. SEC_CODE .. " qty=" .. LOT_SIZE .. " -> " .. tostring(res))
    return res
end

function close_position()
    if position_side == 1 then
        send_market("S")
    elseif position_side == -1 then
        send_market("B")
    end
    position_side = 0
    trail_peak = 0
end

function open_long()
    if REGIME == "OnlyShort" or REGIME == "OnlyClosePosition" or REGIME == "Off" then return end
    if position_side == -1 then close_position() end
    if position_side == 0 then
        send_market("B")
        position_side = 1
        trail_peak = ds:C(ds:Size() - 1)
    end
end

function open_short()
    if REGIME == "OnlyLong" or REGIME == "OnlyClosePosition" or REGIME == "Off" then return end
    if position_side == 1 then close_position() end
    if position_side == 0 then
        send_market("S")
        position_side = -1
        trail_peak = ds:C(ds:Size() - 1)
    end
end

function check_trailing(idx)
    if not USE_POSITION_TRAILING or position_side == 0 then return end
    local c = ds:C(idx)
    if position_side == 1 then
        if c > trail_peak then trail_peak = c end
        local stop = trail_peak * (1 - POSITION_TRAILING_PERCENT / 100)
        if c <= stop then
            log_msg("Трейлинг лонг: close " .. c .. " <= " .. stop)
            close_position()
        end
    else
        if trail_peak == 0 or c < trail_peak then trail_peak = c end
        local stop = trail_peak * (1 + POSITION_TRAILING_PERCENT / 100)
        if c >= stop then
            log_msg("Трейлинг шорт: close " .. c .. " >= " .. stop)
            close_position()
        end
    end
end

function process_bar(idx)
    if REGIME == "Off" then return end
    if time_in_non_trade_periods() then return end

    refresh_position_side()
    check_trailing(idx)

    local bull = is_bull_signal(idx)
    local bear = is_bear_signal(idx)
    bull, bear = apply_invert(bull, bear)

    if not bull and not bear then return end

    if position_side == 0 then
        if bull then open_long()
        elseif bear then open_short() end
        return
    end

    if position_side == 1 and bear then
        close_position()
        open_short()
    elseif position_side == -1 and bull then
        close_position()
        open_long()
    end
end

function min_bars_needed()
    local m = 3
    if USE_SMA then m = math.max(m, SMA_LEN + 2) end
    if USE_LINREG then m = math.max(m, LINREG_LEN + 2) end
    if USE_ATR then m = math.max(m, ATR_LEN + ATR_GROW_LOOKBACK + 2) end
    if USE_RSI then m = math.max(m, RSI_LEN + 2) end
    return m
end

function OnInit()
    is_run = true
    ds = CreateDataSource(CLASS_CODE, SEC_CODE, INTERVAL)
    if ds == nil then
        log_msg("Ошибка CreateDataSource для " .. CLASS_CODE .. "." .. SEC_CODE)
        return
    end
    ds:SetEmptyCallback()
    last_bar_time = 0
    log_msg("TrendMultiIndicatorScreener: старт " .. CLASS_CODE .. "." .. SEC_CODE .. " Regime=" .. REGIME)
end

function OnStop()
    is_run = false
    log_msg("TrendMultiIndicatorScreener: остановлен")
end

function main()
    if ds == nil then
        OnInit()
        if ds == nil then return end
    end

    while is_run do
        if isConnected() == 2 and ds:Size() > 1 then
            local idx = ds:Size() - 1
            local t = ds:T(idx)
            if t ~= last_bar_time then
                -- См. заголовок файла: сигнал только по закрытой свече (idx-1), не по текущей
                local closed_idx = idx - 1
                if closed_idx >= min_bars_needed() - 1 then
                    process_bar(closed_idx)
                end
                last_bar_time = t
            end
        end
        sleep(500)
    end
end
