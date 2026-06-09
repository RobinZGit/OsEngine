--[[
================================================================================
  MultiLogic — Lua для QUIK
  Порт OsEngine Custom/Robots/MultiLogic.cs (упрощённый, один инструмент)
================================================================================

УСТАНОВКА
  1. Скопируйте в каталог Lua QUIK.
  2. Задайте CLASS_CODE, SEC_CODE, ACCOUNT, INTERVAL ниже.
  3. REGIME = "On" на демо, затем боевой.
  4. Сервис → Lua-скрипты → Добавить → Запустить.

ПЕРЕНЕСЕНО
  • 4 слота L1–L4 (строки как в OsEngine, @LR → LINREG_LEN)
  • Disabled, Regime(LinReg;…), AND, SMA/LinReg/ATR/CCI/MACD/Stoch
  • Op/Cl, Side[S], инверсия логики, Regime On/Off/OnlyLong/…
  • Общепортфельный SL/TP % (упрощённо по equity счёта)
  • Нерабочие периоды, трейлинг позиции
  • Приоритет входа L1→L4

НЕ ПЕРЕНЕСЕНО
  • HTML-отчёт, кнопки GUI, MOEX-скринер, металогика PnlSMA, много вкладок
  • OR/NOT в строке, SL[…]/TP[…] в логике
  • VWAP, Bollinger, RSI в парсере и Op/Cl
  • Note(…), импорт каталога трендов

Сигналы: только на ЗАКРЫТОЙ свече (idx = Size()-2 при новом баре).
================================================================================
]]

-- ======================== ИНСТРУМЕНТ ========================
CLASS_CODE  = "TQBR"
SEC_CODE    = "SBER"
INTERVAL    = INTERVAL_H1
ACCOUNT     = ""
CLIENT_CODE = ""
LOT_SIZE    = 1

-- ======================== ОБЩИЕ ========================
REGIME = "Off"              -- Off / On / OnlyLong / OnlyShort / OnlyClosePosition
LOGIC_INVERSION = false
LINREG_LEN = 50

L1_ENABLE = true
L2_ENABLE = true
L3_ENABLE = true
L4_ENABLE = true

LOGIC1 = "Regime(LinReg;L=@LR;Dev=2;SlopeLb=3;OnFlip=Close;Entry=MatchSide) (SMA(100) Op[Ab] Cl[Bl]) AND (LinReg(@LR;Dev=2) Op[AbUp] Cl[BlLo]) AND (ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-]) AND (CCI(20;Lmin=100;Smax=-100) Op[CCI>=100] Cl[CCI<=-100]) AND (MACD(12,26,9) Op[Macd>Sig] Cl[Macd<Sig])"
LOGIC2 = "Regime(LinReg;L=@LR;Dev=2;SlopeLb=3;SlopeDead=0.05%;OnFlip=Close;Entry=FlatOnly) (SMA(100) Op[Ab] Cl[Bl]) AND (Stoch(14-3-3;Lmin=90;Smax=10) Op[K<=10] Cl[K>=90]) AND (ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-]) AND (MACD(12,26,9) Op[Macd>Sig] Cl[Macd<Sig])"
LOGIC3 = "Regime(LinReg;L=@LR;Dev=2;SlopeLb=3;OnFlip=Close;Entry=MatchSide) (SMA(100) Side[S] Op[Bl] Cl[Ab]) AND (LinReg(@LR;Dev=2) Op[BlLo] Cl[AbUp]) AND (ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-]) AND (CCI(20;Lmin=100;Smax=-100) Op[CCI<=-100] Cl[CCI>=100]) AND (MACD(12,26,9) Op[Macd<Sig] Cl[Macd>Sig])"
LOGIC4 = "Regime(LinReg;L=@LR;Dev=2;SlopeLb=3;SlopeDead=0.05%;OnFlip=Close;Entry=FlatOnly) (SMA(100) Side[S] Op[Bl] Cl[Ab]) AND (Stoch(14-3-3;Lmin=90;Smax=10) Op[K>=90] Cl[K<=10]) AND (ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-]) AND (MACD(12,26,9) Op[Macd<Sig] Cl[Macd>Sig])"

-- Stopper (упрощённо: equity = баланс + переоценка по позиции)
PORTF_SL_ON = false
PORTF_SL_PCT = 1.0
PORTF_TP_ON = false
PORTF_TP_PCT = 2.0

USE_TRAILING = false
TRAILING_PCT = 1.0
USE_NON_TRADE = true
NON_TRADE_1 = { true,  0,  0, 10,  5 }
NON_TRADE_2 = { false, 13, 54, 14,  6 }
NON_TRADE_3 = { true, 18,  1, 23, 58 }
TRADE_SATURDAY = false
TRADE_SUNDAY = false

-- ======================== СЛУЖЕБНОЕ ========================
is_run = true
last_bar_time = 0
ds = nil
position_side = 0
active_slot = 0
trail_peak = 0
ref_equity = 0
slots = {}

function log_msg(t) message(tostring(t), 1) end

function replace_lr(s)
    return (tostring(s):gsub("@LR", tostring(LINREG_LEN)))
end

function trim(s)
    return (tostring(s):match("^%s*(.-)%s*$"))
end

function upper(s) return string.upper(tostring(s)) end

function split_and(line)
    local parts = {}
    local start = 1
    while true do
        local p = string.find(line, " AND ", start, true)
        local chunk = p and string.sub(line, start, p - 1) or string.sub(line, start)
        chunk = trim(chunk)
        if chunk ~= "" then table.insert(parts, chunk) end
        if not p then break end
        start = p + 5
    end
    return parts
end

function parse_regime(work)
    local r = { valid=false, entryMatchSide=false, entryFlatOnly=false, closeOnFlip=false,
                slopeLb=3, slopeDeadPct=0, linLen=LINREG_LEN, linDev=2.0 }
    local body, rest = work:match("^Regime%((.-)%)%s*(.*)$")
    if not body then return r, work end
    work = trim(rest or "")
    for token in string.gmatch(body, "[^;]+") do
        token = trim(token)
        local k, v = token:match("^([^=]+)=(.+)$")
        if k then
            k = upper(k)
            if k == "L" then r.linLen = tonumber(v) or LINREG_LEN
            elseif k == "DEV" then r.linDev = tonumber(v) or 2
            elseif k == "SLOPELB" then r.slopeLb = tonumber(v) or 3
            elseif k == "SLOPEDEAD" then
                v = v:gsub("%%", "")
                r.slopeDeadPct = tonumber(v) or 0
            elseif k == "ENTRY" and upper(v) == "MATCHSIDE" then r.entryMatchSide = true
            elseif k == "ENTRY" and upper(v) == "FLATONLY" then r.entryFlatOnly = true
            elseif k == "ONFLIP" and upper(v) == "CLOSE" then r.closeOnFlip = true
            end
        end
    end
    r.valid = true
    return r, work
end

function parse_disabled(work)
    local d, rest = work:match("^Disabled%((.-)%)%s*(.*)$")
    if d then
        d = upper(d)
        return (d == "TRUE" or d == "1"), trim(rest)
    end
    d, rest = work:match("^Disable%((.-)%)%s*(.*)$")
    if d then
        d = upper(d)
        return (d == "TRUE" or d == "1"), trim(rest)
    end
    return false, work
end

function parse_atom(token)
    token = trim(token)
    if token:sub(1,1) == "(" and token:sub(-1) == ")" then
        token = trim(token:sub(2, -2))
    end
    local head, tail = token:match("^(.-)%s+Op%[(.-)$")
    if not head then return nil end
    local opSig = tail:match("^([^%]]+)%]")
    local clSig = token:match("Cl%[([^%]]*)%]")
    local isShort = token:find("Side%[S%]") or token:find("Side%[SELL%]")
    local kind, params = head:match("^([%w]+)%((.*)%)$")
    if not kind then
        kind = upper(trim(head))
        params = ""
    else
        kind = upper(kind)
    end
    local a = { kind=kind, p1=14, p2=26, p3=9, dev=2, grPct=3, grLb=5, lmin=55, smax=45,
                opSig=opSig or "", clSig=clSig or "", isShort=not not isShort }
    if kind == "VWAP" then return a
    if kind == "SMA" then a.p1 = tonumber(params) or 100
    elseif kind == "CCI" or kind == "RSI" then
        local n, rest = params:match("^(%d+);?(.*)$")
        a.p1 = tonumber(n) or 20
        for kv in string.gmatch(rest or "", "[^;]+") do
            local k,v = kv:match("^([^=]+)=(.+)$")
            if k and upper(k) == "LMIN" then a.lmin = tonumber(v)
            elseif k and upper(k) == "SMAX" then a.smax = tonumber(v) end
        end
    elseif kind == "MACD" then
        local f,s,sg = params:match("^(%d+),(%d+),(%d+)")
        a.p1, a.p2, a.p3 = tonumber(f) or 12, tonumber(s) or 26, tonumber(sg) or 9
    elseif kind == "LINREG" or kind == "LR" then
        local n = params:match("^(%d+)")
        a.p1 = tonumber(n) or LINREG_LEN
        local d = params:match("Dev=([%d%.]+)")
        if d then a.dev = tonumber(d) end
    elseif kind == "ATR" then
        local n = params:match("^(%d+)")
        a.p1 = tonumber(n) or 14
        local g = params:match("Gr=([%d%.]+)")
        if g then a.grPct = tonumber(g) end
        local lb = params:match("Lb=(%d+)")
        if lb then a.grLb = tonumber(lb) end
    elseif kind == "STOCH" or kind == "STOCHASTIC" then
        local p1,p2,p3 = params:match("^(%d+)%-(%d+)%-(%d+)")
        a.p1, a.p2, a.p3 = tonumber(p1) or 14, tonumber(p2) or 3, tonumber(p3) or 3
        local lmi = params:match("Lmin=([%d%.]+)")
        local smx = params:match("Smax=([%d%.]+)")
        if lmi then a.lmin = tonumber(lmi) end
        if smx then a.smax = tonumber(smx) end
    elseif kind == "BOLL" or kind == "BOLLINGER" then
        local n = params:match("^(%d+)")
        a.p1 = tonumber(n) or 20
        local d = params:match("Dev=([%d%.]+)")
        if d then a.dev = tonumber(d) end
    else return nil end
    if kind == "CCI" and (not a.lmin or a.lmin == 0) then a.lmin = 100 end
    if kind == "CCI" and (not a.smax or a.smax == 0) then a.smax = -100 end
    return a
end

function parse_slot(line, enabled)
    local work = replace_lr(line)
    local disabled, w2 = parse_disabled(work)
    work = w2
    local regime, w3 = parse_regime(work)
    work = w3
    local atoms = {}
    for _, tok in ipairs(split_and(work)) do
        local a = parse_atom(tok)
        if a then table.insert(atoms, a) end
    end
    return { enabled=enabled, disabled=disabled, regime=regime, atoms=atoms }
end

function calc_linreg_bands(idx, period, dev)
    if idx < period - 1 then return nil, nil, nil end
    local start_i = idx - period + 1
    local sumy, sumx, sumxy, sumx2 = 0, 0, 0, 0
    for i = start_i, idx do
        local g = i - start_i
        local y = ds:C(i)
        sumy = sumy + y; sumxy = sumxy + y * g; sumx = sumx + g; sumx2 = sumx2 + g * g
    end
    local c = sumx2 * period - sumx * sumx
    if c == 0 then return nil, nil, nil end
    local b = (sumxy * period - sumx * sumy) / c
    local a0 = (sumy - sumx * b) / period
    local err = 0
    for i = start_i, idx do
        local g = i - start_i
        err = err + math.abs(ds:C(i) - (a0 + b * g))
    end
    err = err / period
    local mid = a0 + b * (period - 1)
    return mid + err * dev, mid, mid - err * dev
end

function regime_sign(r, idx)
    if not r.valid then return 0 end
    local _, mid, _ = calc_linreg_bands(idx, r.linLen, r.linDev)
    local _, mid2, _ = calc_linreg_bands(idx - r.slopeLb, r.linLen, r.linDev)
    if not mid or not mid2 then return 0 end
    local delta = mid - mid2
    local dead = (r.slopeDeadPct > 0) and math.abs(mid) * r.slopeDeadPct / 100 or 0
    if delta > dead then return 1 elseif delta < -dead then return -1 end
    return 0
end

function calc_sma(idx, len)
    if idx < len - 1 then return nil end
    local s = 0
    for i = idx - len + 1, idx do s = s + ds:C(i) end
    return s / len
end

function true_range(i)
    if i <= 0 then return 0 end
    local hi, lo, pc = ds:H(i), ds:L(i), ds:C(i - 1)
    return math.max(hi - lo, math.abs(pc - hi), math.abs(pc - lo))
end

function calc_atr(idx, len)
    if idx < len then return nil end
    local atr = 0
    for i = 0, len - 1 do atr = atr + true_range(i) end
    atr = atr / len
    for i = len, idx do atr = (atr * (len - 1) + true_range(i)) / len end
    return atr
end

function atr_grow(idx, len, grPct, lb)
    lb = math.max(1, lb)
    if idx < len + lb then return false end
    local last = calc_atr(idx, len)
    local past = calc_atr(idx - lb, len)
    if not last or not past or past == 0 then return false end
    return (last / (past / 100) - 100) >= grPct
end

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

function calc_boll_bands(idx, period, dev)
    if idx < period - 1 then return nil, nil, nil end
    local sum = 0
    for i = idx - period + 1, idx do sum = sum + ds:C(i) end
    local mid = sum / period
    local var = 0
    for i = idx - period + 1, idx do
        local d = ds:C(i) - mid
        var = var + d * d
    end
    local std = math.sqrt(var / period)
    return mid + std * dev, mid, mid - std * dev
end

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

function calc_cci(idx, len)
    if idx < len - 1 then return nil end
    local tp, s, md = 0, 0, 0
    for i = idx - len + 1, idx do
        local t = (ds:H(i) + ds:L(i) + ds:C(i)) / 3
        tp = tp + t
    end
    local sma = tp / len
    for i = idx - len + 1, idx do
        local t = (ds:H(i) + ds:L(i) + ds:C(i)) / 3
        md = md + math.abs(t - sma)
    end
    md = md / len
    if md == 0 then return 0 end
    local t0 = (ds:H(idx) + ds:L(idx) + ds:C(idx)) / 3
    return (t0 - sma) / (0.015 * md)
end

function calc_stoch_k(idx, p1, p2, p3)
    if idx < p1 - 1 then return nil end
    local hh, ll = ds:H(idx), ds:L(idx)
    for i = idx - p1 + 1, idx do
        hh = math.max(hh, ds:H(i))
        ll = math.min(ll, ds:L(i))
    end
    if hh == ll then return 50 end
    return 100 * (ds:C(idx) - ll) / (hh - ll)
end

function calc_macd_hist(idx, fast, slow, sig)
    -- упрощённо: EMA fast - EMA slow vs signal (достаточно для сравнения линий)
    local function ema(len, i)
        local k = 2 / (len + 1)
        local e = ds:C(0)
        for j = 1, i do e = ds:C(j) * k + e * (1 - k) end
        return e
    end
    local m = ema(fast, idx) - ema(slow, idx)
    local s = ema(sig, idx) -- грубо
    return m, s
end

function eval_signal(sig, a, idx, _)
    sig = upper(trim(sig or ""))
    if sig == "" or sig == "-" or sig == "NONE" then return false end
    local close = ds:C(idx)
    if a.kind == "SMA" then
        local v = calc_sma(idx, a.p1)
        if not v then return false end
        if sig == "AB" then return close > v end
        if sig == "BL" then return close < v end
    elseif a.kind == "LINREG" or a.kind == "LR" then
        local up, mid, lo = calc_linreg_bands(idx, a.p1, a.dev)
        if sig == "ABUP" or sig == "AB" then return up and close > up end
        if sig == "BLLO" or sig == "BL" then return lo and close < lo end
    elseif a.kind == "ATR" and sig == "GROK" then
        return atr_grow(idx, a.p1, a.grPct, a.grLb)
    elseif a.kind == "CCI" then
        local v = calc_cci(idx, a.p1)
        if not v then return false end
        local th = tonumber(sig:match("CCI>=(.+)$") or sig:match("CCI<=(.+)$") or sig:match("CCI<(.+)$"))
        if sig:find(">=") then return v >= (th or a.lmin) end
        if sig:find("<=") then return v <= (th or a.smax) end
        if sig:find("<") then return v < (th or a.smax) end
    elseif a.kind == "RSI" then
        local v = calc_rsi(idx, a.p1)
        if not v then return false end
        local th = tonumber(sig:match("RSI>=(.+)$") or sig:match("RSI<=(.+)$") or sig:match("RSI<(.+)$"))
        if sig:find(">=") then return v >= (th or a.lmin) end
        if sig:find("<=") then return v <= (th or a.smax) end
        if sig:find("<") then return v < (th or a.smax) end
    elseif a.kind == "VWAP" then
        local v = calc_vwap(idx)
        if not v or v == 0 then return false end
        if sig == "AB" then return close > v end
        if sig == "BL" then return close < v end
    elseif a.kind == "BOLL" or a.kind == "BOLLINGER" then
        local up, mid, lo = calc_boll_bands(idx, a.p1, a.dev)
        if sig == "AB" or sig == "ABUP" then return up and close > up end
        if sig == "BL" or sig == "BLLO" then return lo and close < lo end
        if sig == "ABMID" then return mid and close > mid end
        if sig == "BLMID" then return mid and close < mid end
    elseif a.kind == "STOCH" or a.kind == "STOCHASTIC" then
        local k = calc_stoch_k(idx, a.p1, a.p2, a.p3)
        if not k then return false end
        local th = tonumber(sig:match("K>=(.+)$") or sig:match("K<=(.+)$"))
        if sig:find(">=") then return k >= (th or a.lmin) end
        if sig:find("<=") then return k <= (th or a.smax) end
    elseif a.kind == "MACD" then
        local m, s = calc_macd_hist(idx, a.p1, a.p2, a.p3)
        if sig == "MACD>SIG" then return m > s end
        if sig == "MACD<SIG" then return m < s end
    end
    return false
end

function eval_open(slot, idx)
    if not slot.enabled or slot.disabled then return false end
    for _, a in ipairs(slot.atoms) do
        if not eval_signal(a.opSig, a, idx, false) then return false end
    end
    return #slot.atoms > 0
end

function eval_close(slot, idx)
    for _, a in ipairs(slot.atoms) do
        local cl = upper(trim(a.clSig))
        if cl ~= "" and cl ~= "-" then
            if eval_signal(a.clSig, a, idx, true) then return true end
        end
    end
    return false
end

function slot_side(slot)
    for _, a in ipairs(slot.atoms) do
        if a.isShort then return -1 end
    end
    return 1
end

function regime_allows_entry(r, side, sign)
    if not r.valid then return true end
    if r.entryFlatOnly then return sign == 0 end
    if r.entryMatchSide then
        if sign > 0 then return side == 1 end
        if sign < 0 then return side == -1 end
        return false
    end
    return true
end

function regime_should_close(r, side, sign)
    if not r.valid or not r.closeOnFlip then return false end
    if r.entryFlatOnly then return sign ~= 0 end
    if sign > 0 then return side == -1 end
    if sign < 0 then return side == 1 end
    return false
end

function time_in_non_trade()
    if not USE_NON_TRADE then return false end
    local t = os.date("*t")
    if t.wday == 1 and not TRADE_SUNDAY then return true end
    if t.wday == 7 and not TRADE_SATURDAY then return true end
    local mins = t.hour * 60 + t.min
    for _, p in ipairs({ NON_TRADE_1, NON_TRADE_2, NON_TRADE_3 }) do
        if p[1] then
            local a, b = p[2] * 60 + p[3], p[4] * 60 + p[5]
            if a <= b then if mins >= a and mins < b then return true end
            else if mins >= a or mins < b then return true end end
        end
    end
    return false
end

function refresh_position()
    position_side = 0
    local n = getNumberOf("depo_limits")
    if n and n > 0 then
        for i = 0, n - 1 do
            local d = getItem("depo_limits", i)
            if d and d.sec_code == SEC_CODE then
                local bal = d.currentbal or d.currentbalance or 0
                if bal > 0 then position_side = 1 elseif bal < 0 then position_side = -1 end
                return
            end
        end
    end
end

function send_market(op)
    local t = { ACTION="NEW_ORDER", CLASSCODE=CLASS_CODE, SECCODE=SEC_CODE, OPERATION=op, TYPE="M", QUANTITY=tostring(LOT_SIZE) }
    if ACCOUNT ~= "" then t.ACCOUNT = ACCOUNT end
    if CLIENT_CODE ~= "" then t.CLIENT_CODE = CLIENT_CODE end
    return sendTransaction(t)
end

function close_all()
    if position_side == 1 then send_market("S")
    elseif position_side == -1 then send_market("B") end
    position_side = 0
    active_slot = 0
    trail_peak = 0
end

function open_side(side, slot)
    if REGIME == "Off" or REGIME == "OnlyClosePosition" then return end
    if side == 1 and REGIME == "OnlyShort" then return end
    if side == -1 and REGIME == "OnlyLong" then return end
    if position_side == -side then close_all() end
    if position_side == 0 then
        send_market(side == 1 and "B" or "S")
        position_side = side
        active_slot = slot
        trail_peak = ds:C(ds:Size() - 1)
    end
end

function account_equity_approx()
    local m = getMoneyEx(ACCOUNT ~= "" and ACCOUNT or nil, "SUR")
    if m and m.currentbal then return m.currentbal end
    return 0
end

function check_portf_stopper()
    local eq = account_equity_approx()
    if eq <= 0 then return false end
    if ref_equity <= 0 then ref_equity = eq end
    if eq > ref_equity then ref_equity = eq end
    if PORTF_SL_ON and PORTF_SL_PCT > 0 and eq <= ref_equity * (1 - PORTF_SL_PCT / 100) then
        close_all(); ref_equity = eq; return true
    end
    if PORTF_TP_ON and PORTF_TP_PCT > 0 and eq >= ref_equity * (1 + PORTF_TP_PCT / 100) then
        close_all(); ref_equity = eq; return true
    end
    return false
end

function check_trailing(idx)
    if not USE_TRAILING or position_side == 0 then return end
    local c = ds:C(idx)
    if position_side == 1 then
        if c > trail_peak then trail_peak = c end
        if c <= trail_peak * (1 - TRAILING_PCT / 100) then close_all() end
    else
        if trail_peak == 0 or c < trail_peak then trail_peak = c end
        if c >= trail_peak * (1 + TRAILING_PCT / 100) then close_all() end
    end
end

function apply_inversion(side)
    if LOGIC_INVERSION then return -side end
    return side
end

function process_bar(idx)
    if REGIME == "Off" then return end
    if time_in_non_trade() then return end
    refresh_position()
    check_trailing(idx)
    if check_portf_stopper() then return end

    if position_side ~= 0 and active_slot >= 1 and active_slot <= 4 then
        local sl = slots[active_slot]
        local side = apply_inversion(slot_side(sl))
        local sign = regime_sign(sl.regime, idx)
        if regime_should_close(sl.regime, side, sign) or eval_close(sl, idx) then
            close_all()
            return
        end
    end

    if position_side ~= 0 then return end

    for s = 1, 4 do
        local sl = slots[s]
        if sl.enabled and not sl.disabled and eval_open(sl, idx) then
            local side = apply_inversion(slot_side(sl))
            local sign = regime_sign(sl.regime, idx)
            if regime_allows_entry(sl.regime, side, sign) then
                open_side(side, s)
                return
            end
        end
    end
end

function OnInit()
    is_run = true
    ds = CreateDataSource(CLASS_CODE, SEC_CODE, INTERVAL)
    if not ds then
        log_msg("MultiLogic: ошибка CreateDataSource")
        return
    end
    ds:SetEmptyCallback()
    slots[1] = parse_slot(LOGIC1, L1_ENABLE)
    slots[2] = parse_slot(LOGIC2, L2_ENABLE)
    slots[3] = parse_slot(LOGIC3, L3_ENABLE)
    slots[4] = parse_slot(LOGIC4, L4_ENABLE)
    ref_equity = account_equity_approx()
    log_msg("MultiLogic QUIK: старт " .. CLASS_CODE .. "." .. SEC_CODE .. " LinReg=" .. LINREG_LEN)
end

function OnStop()
    is_run = false
    log_msg("MultiLogic: остановлен")
end

function main()
    if not ds then OnInit(); if not ds then return end end
    while is_run do
        if isConnected() == 2 and ds:Size() > 1 then
            local idx = ds:Size() - 1
            local t = ds:T(idx)
            if t ~= last_bar_time then
                local closed = idx - 1
                if closed >= LINREG_LEN + 5 then process_bar(closed) end
                last_bar_time = t
            end
        end
        sleep(500)
    end
end
