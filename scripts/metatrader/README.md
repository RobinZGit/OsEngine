# MetaTrader 5 — порты роботов OsEngine

## MultiLogic.mq5

Порт **MultiLogic** (`Custom/Robots/MultiLogic.cs`) на **один символ** графика.

### Перенесено

- 4 слота логики L1–L4 (строки по умолчанию как в OsEngine)
- Токен `@LR` → вход `InpLinRegLen`
- `Disabled`, `Regime(LinReg;…)`, `Entry=MatchSide` / `FlatOnly`, `OnFlip=Close`
- Атомы: SMA, LinReg, ATR, CCI, MACD, Stochastic, **RSI**, **VWAP**, **Bollinger**; Op/Cl (`Ab`, `AbMid`, `BlMid`, `RSI>=`, …)
- Инверсия логики, Regime Off/On/OnlyLong/OnlyShort/OnlyClose
- Общепортфельный SL/TP (% от equity, high-water reference)
- Нерабочие периоды, трейлинг позиции
- Приоритет входа: L1 → L2 → L3 → L4

### Не перенесено

- HTML-отчёт, кнопки GUI, MOEX-скринер, много вкладок
- Металогика PnlSMA, shadow-позиции, SL/TP в строке логики
- OR/NOT в формуле, каталог трендов, оптимизатор OsEngine

### Установка

1. `MultiLogic.mq5` → `MetaTrader 5/MQL5/Experts/`
2. MetaEditor → Compile (F7)
3. На график → включить Algo Trading
4. `InpRegime = On` (сначала демо)

### TrendMultiIndicatorScreener.mq5

Предыдущий порт скринера (И-группы, один набор индикаторов). Оставлен для сравнения.
