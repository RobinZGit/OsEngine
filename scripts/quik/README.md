# Скрипты QUIK для роботов OsEngine

## TrendMultiIndicatorScreener.lua

Порт логики робота **TrendMultiIndicatorScreener** на **один** инструмент в терминале QUIK.

### Что перенесено

- Индикаторы: SMA, VWAP (сброс по дню), ATR (рост %), LinReg-канал; опционально RSI, Stochastic, Momentum, Bollinger, Volume, MACD (флаги `USE_*`).
- И-группы: AND внутри `|№|`, OR между группами, отрицательный номер = NOT.
- Вход лонг/шорт, реверс при противоположном сигнале.
- Нерабочие периоды (3 окна), трейлинг позиции в %.
- Режимы `REGIME`, инверсия входа.

### Чего нет (только в OsEngine)

- Скринер и несколько бумаг одновременно.
- Самоиндикация, кластеры волатильности, MOEX reload.
- Страховка портфеля, рандомный сдвиг цен, расписание дата-время.

### Запуск

1. Скопируйте `TrendMultiIndicatorScreener.lua` в каталог Lua QUIK.
2. В начале файла укажите `CLASS_CODE`, `SEC_CODE`, `ACCOUNT`, `CLIENT_CODE`, `INTERVAL`.
3. Установите `REGIME = "On"` для торговли (сначала проверьте на демо).
4. В QUIK: **Сервис → Lua-скрипты → Добавить → Запустить**.

Сигналы считаются при появлении **новой** свечи (сравнение времени последнего бара).

### Соответствие параметров OsEngine

| OsEngine | QUIK-скрипт |
|----------|-------------|
| Use SMA / SMA length | `USE_SMA`, `SMA_LEN` |
| Use VWAP | `USE_VWAP` |
| Use ATR / grow % / lookback | `USE_ATR`, `ATR_*` |
| Use Linear Regression | `USE_LINREG`, `LINREG_*` |
| *: № И-группы | `*_GROUP` |
| Regime | `REGIME` |
| Инверсия логики | `INVERT_ENTRY_LOGIC` |
| Трейлинг позиции | `USE_POSITION_TRAILING` |
| Non trade periods | `USE_NON_TRADE_PERIODS`, `NON_TRADE_*` |
