# MetaTrader 5 — порты роботов OsEngine

## MultiLogic.mq5

Порт **MultiLogic** (`Custom/Robots/MultiLogic.cs`) на **один символ** графика.

### Перенесено

- 4 слота логики L1–L4 (строки v2 по умолчанию как в OsEngine)
- Токены `@LR` → `InpLinRegLen`, `@Strict` → `InpStrictness` (1…5)
- Формат v2: `Op(Long/Short(Ind(парам)(условие) …))` `Cl(… OnFlip(Close|Flip|Open))`
- `Disabled`, `Strict(@Strict|4)`, `Regime(LinReg;…)`, `Entry=MatchSide` / `FlatOnly`; OnFlip в Cl приоритетнее Regime
- Масштабирование порогов Lmin/Smax/Gr/Dev/SlopeDead и Op/Cl при разборе (strict≠3)
- Атомы: SMA, LinReg, ATR, CCI, MACD, Stochastic, **RSI**, **VWAP**, **Bollinger**; Op/Cl (`Ab`, `AbMid`, `BlMid`, `RSI>=`, …)
- Инверсия логики, Regime Off/On/OnlyLong/OnlyShort/OnlyClose
- Общепортфельный SL/TP (% от equity, high-water reference; **отрицательный equity допустим** — как в OsEngine при плече)
- **Просадка от пика** (% от max equity — закрыть всё; пик обновляется только вверх, может быть &lt; 0)
- **Пауза после значительного пика** (годовая доходность впадина→пик ≥ порога; блок новых входов)
- Инверсия: Buy↔Sell **и Op↔Cl** (как OsEngine / TMIS)
- Нерабочие периоды, трейлинг позиции
- Приоритет входа: L1 → L2 → L3 → L4

### Не перенесено

- HTML-отчёт, кнопки GUI (Strict ±1, Volume/Max positions ±5), MOEX-скринер, много вкладок
- Металогика PnlSMA, shadow-позиции, фейк-торговля Stopper, EOD flat
- Equity L1…L10 (в MT5 — equity счёта), HTML-маркеры, Regime после SL/TP
- OR/NOT в формуле, каталог трендов, оптимизатор OsEngine

### Установка

1. `MultiLogic.mq5` → `MetaTrader 5/MQL5/Experts/`
2. MetaEditor → Compile (F7)
3. На график → включить Algo Trading
4. `InpRegime = On` (сначала демо)

### TrendMultiIndicatorScreener.mq5

Предыдущий порт скринера (И-группы, один набор индикаторов). Оставлен для сравнения.
