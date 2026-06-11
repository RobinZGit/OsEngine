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
  • 4 слота L1–L4 (строки v2 Op/Cl как в OsEngine, @LR → LINREG_LEN, @Strict → STRICTNESS)
  • Op(Long/Short(Ind(параметры)(условие) …)) Cl(… OnFlip(Close|Flip|Open))
  • Regime Entry=MatchSide / FlatOnly; OnFlip в Cl приоритетнее Regime
  • Op/Cl сигналы, инверсия логики, Regime On/Off/OnlyLong/…
  • Общепортфельный SL/TP % (equity счёта; отрицательный equity допустим)
  • Просадка от пика (% от max equity — только закрытие; пик может быть < 0)
  • Инверсия: Buy↔Sell и Op↔Cl (как OsEngine / TMIS)
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
LINREG_LEN = 10
STRICTNESS = 3              -- 1…5 (3 — пороги в тексте без масштабирования; @Strict в строке)

L1_ENABLE = true
L2_ENABLE = true
L3_ENABLE = true
L4_ENABLE = true

LOGIC1 = "Strict(@Strict) Regime(LinReg;L=@LR;Dev=2;SlopeLb=3;OnFlip=Close;Entry=MatchSide) Op(Long(SMA(100)(Ab) AND LinReg(@LR;Dev=2)(AbUp) AND ATR(14;Gr=3%;Lb=5)(GrOk) AND CCI(20;Lmin=100;Smax=-100)(CCI>=100) AND MACD(12,26,9)(Macd>Sig))) Cl(Long(SMA(100)(Bl) AND LinReg(@LR;Dev=2)(BlLo) AND CCI(20;Lmin=100;Smax=-100)(CCI<=-100) AND MACD(12,26,9)(Macd<Sig)) OnFlip(Close)) Note(lon-trend)"
LOGIC2 = "Strict(@Strict) Regime(LinReg;L=@LR;Dev=2;SlopeLb=3;SlopeDead=0.05%;OnFlip=Close;Entry=FlatOnly) Op(Long(SMA(100)(Ab) AND Stoch(14-3-3;Lmin=90;Smax=10)(K<=10) AND ATR(14;Gr=3%;Lb=5)(GrOk) AND MACD(12,26,9)(Macd>Sig))) Cl(Long(SMA(100)(Bl) AND Stoch(14-3-3;Lmin=90;Smax=10)(K>=90) AND MACD(12,26,9)(Macd<Sig)) OnFlip(Close)) Note(lon-bokovik)"
LOGIC3 = "Strict(@Strict) Regime(LinReg;L=@LR;Dev=2;SlopeLb=3;OnFlip=Close;Entry=MatchSide) Op(Short(SMA(100)(Bl) AND LinReg(@LR;Dev=2)(BlLo) AND ATR(14;Gr=3%;Lb=5)(GrOk) AND CCI(20;Lmin=100;Smax=-100)(CCI<=-100) AND MACD(12,26,9)(Macd<Sig))) Cl(Short(SMA(100)(Ab) AND LinReg(@LR;Dev=2)(AbUp) AND CCI(20;Lmin=100;Smax=-100)(CCI>=100) AND MACD(12,26,9)(Macd>Sig)) OnFlip(Close)) Note(short-trend)"
LOGIC4 = "Strict(@Strict) Regime(LinReg;L=@LR;Dev=2;SlopeLb=3;SlopeDead=0.05%;OnFlip=Close;Entry=FlatOnly) Op(Short(SMA(100)(Bl) AND Stoch(14-3-3;Lmin=90;Smax=10)(K>=90) AND ATR(14;Gr=3%;Lb=5)(GrOk) AND MACD(12,26,9)(Macd<Sig))) Cl(Short(SMA(100)(Ab) AND Stoch(14-3-3;Lmin=90;Smax=10)(K<=10) AND MACD(12,26,9)(Macd>Sig)) OnFlip(Close)) Note(short-bokovik)"

-- Stopper (упрощённо: equity счёта; отрицательный equity — норма при плече, без «обнуления»)
PORTF_SL_ON = false
PORTF_SL_PCT = 1.0
PORTF_TP_ON = false
PORTF_TP_PCT = 2.0
PEAK_DRAWDOWN_ON = false
PEAK_DRAWDOWN_PCT = 1.0
SIG_PEAK_PAUSE_ON = false
SIG_PEAK_ANNUAL_PCT = 100.0
SIG_PEAK_WIDTH_MULT = 10.0

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
portfolio_peak = 0
sig_peak_pause_until = 0
sig_peak_last_peak_time = 0
eq_hist = {}
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
    local r = { valid=false, entryMatchSide=false, entryFlatOnly=false, closeOnFlip=false, flipOnRegime=false,
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
            elseif k == "ONFLIP" then
                local uv = upper(v)
                if uv == "FLIP" or uv == "REVERSE" or uv == "REV" then
                    r.flipOnRegime = true
                    r.closeOnFlip = false
                elseif uv == "CLOSE" or uv == "CLOSEONFLIP" or uv == "TRUE" then
                    r.closeOnFlip = true
                end
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

function clamp_strict(v)
    v = tonumber(v) or 3
    if v < 1 then return 1 end
    if v > 5 then return 5 end
    return math.floor(v + 0.5)
end

function resolve_strict_inner(inner)
    inner = trim(inner or "")
    if upper(inner) == "@STRICT" then return clamp_strict(STRICTNESS) end
    return clamp_strict(inner)
end

function parse_strict(work)
    local inner, rest = work:match("^Strict%((.-)%)%s*(.*)$")
    if not inner then return clamp_strict(STRICTNESS), work end
    return resolve_strict_inner(inner), trim(rest)
end

function scale_neutral(neutral, strict, step, invert, lo_r, hi_r)
    if strict == 3 or not neutral or neutral == 0 then return neutral end
    local off = strict - 3
    local factor = invert and (1 - off * step) or (1 + off * step)
    local scaled = neutral * factor
    local lo, hi = neutral * lo_r, neutral * hi_r
    if scaled < lo then return lo end
    if scaled > hi then return hi end
    return scaled
end

function scale_long_min(v, strict) return scale_neutral(v, strict, 0.10, false, 0.76, 1.24) end
function scale_short_pos(v, strict) return scale_neutral(v, strict, 0.10, true, 0.76, 1.24) end
function scale_short_signed(v, strict) return scale_neutral(v, strict, 0.10, false, 0.76, 1.24) end

function scale_sig_num(sig, prefix, strict, long_min)
    if strict == 3 or not sig:find("^" .. prefix) then return sig end
    local thr = tonumber(sig:sub(#prefix + 1))
    if not thr then return sig end
    local sc = long_min and scale_long_min(thr, strict)
        or (thr <= 0 and scale_short_signed(thr, strict) or scale_short_pos(thr, strict))
    return prefix .. tostring(sc)
end

function scale_op_cl(sig, strict)
    if strict == 3 or not sig or sig == "" or sig == "-" then return sig end
    local s = sig
    for _, p in ipairs({{"CCI>=", true}, {"CCI<=", false}, {"CCI<", false}, {"K>=", true}, {"K<=", false},
        {"RSI>=", true}, {"RSI<=", false}, {"MOM>=", true}, {"MOM<=", false}, {"MOM<", false}}) do
        s = scale_sig_num(s, p[1], strict, p[2])
    end
    return s
end

function apply_strict_atom(a, strict)
    if strict == 3 or not a then return end
    if a.lmin and a.lmin ~= 0 then a.lmin = scale_long_min(a.lmin, strict) end
    if a.smax and a.smax ~= 0 then
        a.smax = (a.smax < 0) and scale_short_signed(a.smax, strict) or scale_short_pos(a.smax, strict)
    end
    if a.grPct and a.grPct ~= 0 then a.grPct = scale_neutral(a.grPct, strict, 0.12, false, 0.65, 1.35) end
    if a.dev and a.dev ~= 0 then a.dev = scale_neutral(a.dev, strict, 0.08, true, 0.88, 1.12) end
    a.opSig = scale_op_cl(a.opSig, strict)
    a.clSig = scale_op_cl(a.clSig, strict)
end

function apply_strict_regime(r, strict)
    if strict == 3 or not r or not r.valid then return end
    if r.slopeDeadPct and r.slopeDeadPct ~= 0 then
        r.slopeDeadPct = scale_neutral(r.slopeDeadPct, strict, 0.10, true, 0.70, 1.30)
    end
    if r.linDev and r.linDev ~= 0 then
        r.linDev = scale_neutral(r.linDev, strict, 0.08, true, 0.88, 1.12)
    end
end

function split_top_level(text, sep)
    local parts = {}
    local depth = 0
    local start = 1
    local i = 1
    local len = #text
    local sep_len = #sep
    while i <= len do
        local c = text:sub(i, i)
        if c == "(" then depth = depth + 1
        elseif c == ")" then depth = depth - 1
        elseif depth == 0 and text:sub(i, i + sep_len - 1) == sep then
            local chunk = trim(text:sub(start, i - 1))
            if chunk ~= "" then table.insert(parts, chunk) end
            start = i + sep_len
            i = start - 1
        end
        i = i + 1
    end
    local last = trim(text:sub(start))
    if last ~= "" then table.insert(parts, last) end
    return parts
end

function extract_tagged_block(work, tag)
    local key = tag .. "("
    local p = work:find(key, 1, true)
    if not p then return nil, work end
    local depth = 0
    local start = p + #key
    for i = start - 1, #work do
        local c = work:sub(i, i)
        if c == "(" then depth = depth + 1
        elseif c == ")" then
            depth = depth - 1
            if depth == 0 then
                local inner = work:sub(start, i - 1)
                local before = work:sub(1, p - 1)
                local after = work:sub(i + 1)
                return inner, trim(before .. " " .. after)
            end
        end
    end
    return nil, work
end

function parse_indicator_header(head)
    head = trim(head)
    local kind, params = head:match("^([%w]+)%((.*)%)$")
    if not kind then
        kind = upper(trim(head))
        params = ""
    else
        kind = upper(kind)
    end
    local a = { kind=kind, p1=14, p2=26, p3=9, dev=2, grPct=3, grLb=5, lmin=55, smax=45, opSig="", clSig="" }
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

function parse_predicate(token)
    token = trim(token)
    if token:sub(1,1) == "(" and token:sub(-1) == ")" then
        token = trim(token:sub(2, -2))
    end
    local pc = token:find(")(", 1, true)
    if not pc then return nil end
    local head = token:sub(1, pc)
    local cond = token:sub(pc + 2)
    if cond:sub(1,1) == "(" and cond:sub(-1) == ")" then
        cond = trim(cond:sub(2, -2))
    end
    local a = parse_indicator_header(head)
    if not a then return nil end
    a.opSig = trim(cond)
    a.clSig = ""
    if a.opSig == "" then return nil end
    return a
end

function parse_predicate_list(inner, use_and, strict, atoms_out)
    local sep = use_and and " AND " or " OR "
    local parts = split_top_level(inner, sep)
    local list = {}
    for _, tok in ipairs(parts) do
        local a = parse_predicate(tok)
        if a then
            apply_strict_atom(a, strict)
            table.insert(list, a)
            table.insert(atoms_out, a)
        end
    end
    return list
end

function parse_onflip_from_tail(content)
    local p = content:find("OnFlip(", 1, true)
    if not p then return content, false, false, false end
    local tail = content:sub(p)
    content = trim(content:sub(1, p - 1))
    local mode = upper(trim(tail:match("^OnFlip%((.-)%)")))
    local closeOn, flipOn, openOn = false, false, false
    if mode == "FLIP" then flipOn = true
    elseif mode == "OPEN" then openOn = true
    else closeOn = true end
    return content, closeOn, flipOn, openOn
end

function parse_side_block(content, side_tag, use_and, strict, atoms_out)
    local key = side_tag .. "("
    local p = content:find(key, 1, true)
    if not p then return {}, content end
    local depth = 0
    local start = p + #key
    for i = start - 1, #content do
        local c = content:sub(i, i)
        if c == "(" then depth = depth + 1
        elseif c == ")" then
            depth = depth - 1
            if depth == 0 then
                local inner = content:sub(start, i - 1)
                local before = content:sub(1, p - 1)
                local after = content:sub(i + 1)
                return parse_predicate_list(inner, use_and, strict, atoms_out), trim(before .. " " .. after)
            end
        end
    end
    return {}, content
end

function parse_signal_block(content, is_op, strict, slot)
    local closeOn, flipOn, openOn
    content, closeOn, flipOn, openOn = parse_onflip_from_tail(content)
    if not is_op then
        if flipOn then slot.clOnFlipFlip = true; slot.clOnFlipClose = false
        elseif closeOn then slot.clOnFlipClose = true; slot.clOnFlipFlip = false end
    elseif openOn then slot.opOnFlipOpen = true end

    local use_and = true
    local shared = content
    if is_op then
        slot.longOp, shared = parse_side_block(shared, "Long", use_and, strict, slot.atoms)
        slot.shortOp, shared = parse_side_block(shared, "Short", use_and, strict, slot.atoms)
        slot.longOp, shared = parse_side_block(shared, "Buy", use_and, strict, slot.atoms)
        slot.shortOp, shared = parse_side_block(shared, "Sell", use_and, strict, slot.atoms)
        shared = trim(shared)
        if shared ~= "" then slot.sharedOp = parse_predicate_list(shared, true, strict, slot.atoms) end
    else
        slot.longCl, shared = parse_side_block(shared, "Long", use_and, strict, slot.atoms)
        slot.shortCl, shared = parse_side_block(shared, "Short", use_and, strict, slot.atoms)
        slot.longCl, shared = parse_side_block(shared, "Buy", use_and, strict, slot.atoms)
        slot.shortCl, shared = parse_side_block(shared, "Sell", use_and, strict, slot.atoms)
    end
end

function parse_slot(line, enabled)
    local work = replace_lr(line)
    local disabled, w2 = parse_disabled(work)
    work = w2
    local line_strict, w25 = parse_strict(work)
    work = w25
    local regime, w3 = parse_regime(work)
    work = trim(w3)
    local slot = {
        enabled=enabled, disabled=disabled, regime=regime, strictness=line_strict,
        atoms={}, sharedOp={}, longOp={}, shortOp={}, longCl={}, shortCl={},
        clOnFlipClose=false, clOnFlipFlip=false, opOnFlipOpen=false
    }
    local opBody, clBody
    opBody, work = extract_tagged_block(work, "Op")
    if not opBody then return slot end
    clBody, work = extract_tagged_block(work, "Cl")
    parse_signal_block(opBody, true, line_strict, slot)
    if clBody then parse_signal_block(clBody, false, line_strict, slot) end
    apply_strict_regime(regime, line_strict)
    return slot
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

function try_get_primary_value(a, idx)
    if a.kind == "SMA" then return calc_sma(idx, a.p1) end
    if a.kind == "CCI" then return calc_cci(idx, a.p1) end
    if a.kind == "RSI" then return calc_rsi(idx, a.p1) end
    if a.kind == "VWAP" then return calc_vwap(idx) end
    if a.kind == "STOCH" or a.kind == "STOCHASTIC" then return calc_stoch_k(idx, a.p1, a.p2, a.p3) end
    if a.kind == "MACD" then
        local m, _ = calc_macd_hist(idx, a.p1, a.p2, a.p3)
        return m
    end
    if a.kind == "LINREG" or a.kind == "LR" then
        local _, mid, _ = calc_linreg_bands(idx, a.p1, a.dev)
        return mid
    end
    if a.kind == "BOLL" or a.kind == "BOLLINGER" then
        local _, mid, _ = calc_boll_bands(idx, a.p1, a.dev)
        return mid
    end
    return nil
end

function eval_value_direction(sig, a, idx)
    sig = upper(trim(sig or ""))
    local require_up, streak = true, 1
    if sig == "RISE" or sig == "VALUP" then
    elseif sig == "FALL" or sig == "VALDN" then require_up = false
    elseif sig:match("^VALUP(%d+)$") then streak = tonumber(sig:match("^VALUP(%d+)$")) or 1
    elseif sig:match("^RISE(%d+)$") then streak = tonumber(sig:match("^RISE(%d+)$")) or 1
    elseif sig:match("^VALDN(%d+)$") then require_up = false; streak = tonumber(sig:match("^VALDN(%d+)$")) or 1
    elseif sig:match("^FALL(%d+)$") then require_up = false; streak = tonumber(sig:match("^FALL(%d+)$")) or 1
    else return nil end
    streak = math.max(1, streak)
    for i = 0, streak - 1 do
        local cur = try_get_primary_value(a, idx - i)
        local prev = try_get_primary_value(a, idx - i - 1)
        if not cur or not prev then return false end
        if require_up and not (cur > prev) then return false end
        if not require_up and not (cur < prev) then return false end
    end
    return true
end

function eval_value_change(sig, a, idx)
    sig = upper(trim(sig or ""))
    local lb, op, thr = sig:match("^CHG(%d*)([<>]=)(.+)$")
    if not op then return nil end
    lb = math.max(1, tonumber(lb) or 1)
    thr = tonumber((thr or "0"):gsub("%%", "")) or 0
    local cur = try_get_primary_value(a, idx)
    local past = try_get_primary_value(a, idx - lb)
    if not cur or not past or past == 0 then return false end
    local pct = (cur - past) / math.abs(past) * 100
    thr = math.abs(thr)
    if op == ">=" then return pct >= thr end
    return pct <= -thr
end

function eval_signal(sig, a, idx, _)
    sig = upper(trim(sig or ""))
    if sig == "" or sig == "-" or sig == "NONE" then return false end
    local dir = eval_value_direction(sig, a, idx)
    if dir ~= nil then return dir end
    local chg = eval_value_change(sig, a, idx)
    if chg ~= nil then return chg end
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

function eval_atoms_and(list, idx)
    if not list or #list == 0 then return true end
    for _, a in ipairs(list) do
        if not eval_signal(a.opSig, a, idx, false) then return false end
    end
    return true
end

function eval_atoms_or(list, idx)
    if not list or #list == 0 then return false end
    for _, a in ipairs(list) do
        if eval_signal(a.opSig, a, idx, false) then return true end
    end
    return false
end

function effective_regime(slot)
    local r = {}
    for k, v in pairs(slot.regime) do r[k] = v end
    if slot.clOnFlipFlip then r.flipOnRegime = true; r.closeOnFlip = false
    elseif slot.clOnFlipClose then r.closeOnFlip = true; r.flipOnRegime = false end
    return r
end

function try_pick_entry_side_normal(slot, idx)
    if not slot.enabled or slot.disabled then return false, 0 end
    local sharedOk = eval_atoms_and(slot.sharedOp, idx)
    if slot.sharedOp and #slot.sharedOp > 0 and not sharedOk then return false, 0 end
    if slot.longOp and #slot.longOp > 0 and sharedOk and eval_atoms_and(slot.longOp, idx) then
        return true, 1
    end
    if slot.shortOp and #slot.shortOp > 0 and sharedOk and eval_atoms_and(slot.shortOp, idx) then
        return true, -1
    end
    return false, 0
end

function eval_close_for_side(slot, idx, pos_side)
    if pos_side == 1 and slot.longCl and #slot.longCl > 0 then
        return eval_atoms_and(slot.longCl, idx)
    end
    if pos_side == -1 and slot.shortCl and #slot.shortCl > 0 then
        return eval_atoms_and(slot.shortCl, idx)
    end
    return false
end

function try_pick_entry_side(slot, idx)
    if LOGIC_INVERSION then
        if eval_close_for_side(slot, idx, 1) then return true, -1 end
        return false, 0
    end
    return try_pick_entry_side_normal(slot, idx)
end

function eval_exit_for_position(slot, idx, pos_side)
    if LOGIC_INVERSION then
        local ok, _ = try_pick_entry_side_normal(slot, idx)
        return ok
    end
    return eval_close_for_side(slot, idx, pos_side)
end

function eval_entry_signal(slot, idx)
    local ok, _ = try_pick_entry_side(slot, idx)
    return ok
end

function eval_exit_signal(slot, idx, pos_side)
    return eval_exit_for_position(slot, idx, pos_side)
end

function append_equity_snapshot(bar_time)
    local eq = account_equity_approx()
    local n = #eq_hist
    if n > 0 and eq_hist[n].time == bar_time then
        eq_hist[n].equity = eq
        return
    end
    table.insert(eq_hist, { time = bar_time, equity = eq })
    if #eq_hist > 128 then table.remove(eq_hist, 1) end
end

function try_compute_sig_peak_annual_pct(trough_eq, peak_eq, trough_time, peak_time)
    if trough_eq <= 0 or peak_eq <= trough_eq then return nil end
    local total_return = (peak_eq - trough_eq) / trough_eq
    if total_return <= -1 then return nil end
    local days = (peak_time - trough_time) / 86400
    if days < 1 / 24 then days = 1 / 24 end
    local exponent = 365 / days
    if exponent > 10000 then exponent = 10000 end
    local growth = (1 + total_return) ^ exponent
    if growth ~= growth or growth <= 0 then return nil end
    if growth >= 1e100 then return 1e12 end
    return (growth - 1) * 100
end

function update_sig_peak_pause(bar_time)
    if not SIG_PEAK_PAUSE_ON or #eq_hist < 3 then return end
    local peak_idx = #eq_hist - 1
    local peak_eq = eq_hist[peak_idx].equity
    local prev_eq = eq_hist[peak_idx - 1].equity
    local next_eq = eq_hist[peak_idx + 1].equity
    if not (peak_eq >= prev_eq and peak_eq > next_eq) then return end
    local peak_time = eq_hist[peak_idx].time
    if peak_time <= sig_peak_last_peak_time then return end
    sig_peak_last_peak_time = peak_time
    local trough_idx = peak_idx
    for j = peak_idx - 1, 1, -1 do
        if eq_hist[j].equity < eq_hist[trough_idx].equity then
            trough_idx = j
        elseif eq_hist[j].equity > eq_hist[trough_idx].equity then
            break
        end
    end
    local trough_eq = eq_hist[trough_idx].equity
    local trough_time = eq_hist[trough_idx].time
    local annual_pct = try_compute_sig_peak_annual_pct(trough_eq, peak_eq, trough_time, peak_time)
    if not annual_pct or annual_pct < SIG_PEAK_ANNUAL_PCT then return end
    local mult = SIG_PEAK_WIDTH_MULT
    if mult < 0.1 then mult = 0.1 end
    local pause_sec = (peak_time - trough_time) * mult
    if pause_sec <= 0 then pause_sec = 3600 end
    local pause_until = peak_time + pause_sec
    if pause_until > sig_peak_pause_until then sig_peak_pause_until = pause_until end
end

function is_sig_peak_entry_paused(bar_time)
    return SIG_PEAK_PAUSE_ON and sig_peak_pause_until > 0 and bar_time < sig_peak_pause_until
end

function check_peak_drawdown()
    if not PEAK_DRAWDOWN_ON or PEAK_DRAWDOWN_PCT <= 0 then return false end
    local eq = account_equity_approx()
    if portfolio_peak == 0 and eq == 0 then return false end
    if eq > portfolio_peak then portfolio_peak = eq end
    if portfolio_peak == 0 then return false end
    local floor = portfolio_peak * (1 - PEAK_DRAWDOWN_PCT / 100)
    if eq > floor then return false end
    close_all()
    portfolio_peak = eq
    return true
end

function slot_side(slot)
    if slot.shortOp and #slot.shortOp > 0 then return -1 end
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

function regime_should_act(r, side, sign)
    if not r.valid then return false end
    if not r.closeOnFlip and not r.flipOnRegime and not r.entryFlatOnly then return false end
    if r.entryFlatOnly then return sign ~= 0 end
    if not r.closeOnFlip and not r.flipOnRegime then return false end
    if sign > 0 then return side == -1 end
    if sign < 0 then return side == 1 end
    return false
end

function regime_flip_target_side(sign)
    if sign > 0 then return 1 end
    if sign < 0 then return -1 end
    return 0
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
    if ref_equity == 0 and eq == 0 then return false end
    if ref_equity == 0 then ref_equity = eq end
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
    local bar_time = ds:T(idx)
    append_equity_snapshot(bar_time)
    update_sig_peak_pause(bar_time)
    if check_peak_drawdown() then return end
    if check_portf_stopper() then return end

    if position_side ~= 0 and active_slot >= 1 and active_slot <= 4 then
        local sl = slots[active_slot]
        local pos_side = position_side
        local eff = effective_regime(sl)
        local sign = regime_sign(sl.regime, idx)
        if regime_should_act(eff, pos_side, sign) then
            if eff.flipOnRegime and sign ~= 0 then
                local flip_side = apply_inversion(regime_flip_target_side(sign))
                close_all()
                open_side(flip_side, active_slot)
                return
            end
            close_all()
            return
        end
        if eval_exit_signal(sl, idx, pos_side) then
            close_all()
            return
        end
    end

    if position_side ~= 0 then return end
    if is_sig_peak_entry_paused(bar_time) then return end

    for s = 1, 4 do
        local sl = slots[s]
        if sl.enabled and not sl.disabled then
            local ok, side = try_pick_entry_side(sl, idx)
            if ok and regime_allows_entry(sl.regime, side, regime_sign(sl.regime, idx)) then
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
    portfolio_peak = ref_equity
    log_msg("MultiLogic QUIK: старт " .. CLASS_CODE .. "." .. SEC_CODE .. " LinReg=" .. LINREG_LEN .. " Strict=" .. STRICTNESS)
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
