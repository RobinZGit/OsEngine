/*
 * Your rights to use code governed by this license https://github.com/AlexWan/OsEngine/blob/master/LICENSE
 * Ваши права на использование кода регулируются данной лицензией http://o-s-a.net/doc/license_simple_engine.pdf
 *
 * ==========================================================================================
 * ТРЕНДОВЫЙ РОБОТ ДЛЯ ЭКСПИРИРУЕМОГО ФЬЮЧЕРСА USD/CNY (UCNY)
 * ==========================================================================================
 * 
 * Стратегия: Пересечение двух EMA с фильтром RSI и трейлинг-стопом по ATR
 * 
 * ОПИСАНИЕ СТРАТЕГИИ:
 * -------------------
 * Данная стратегия основана на классическом трендовом подходе — пересечении двух 
 * экспоненциальных скользящих средних (EMA). Быстрая EMA отслеживает краткосрочный 
 * тренд, медленная EMA — долгосрочный. Пересечение этих линий даёт сигнал о возможном 
 * начале нового тренда.
 * 
 * Для фильтрации ложных сигналов используется индикатор RSI (Relative Strength Index).
 * RSI помогает избежать входов в перекупленность/перепроданность рынка.
 * 
 * Для управления рисками используется трейлинг-стоп на основе ATR (Average True Range),
 * который адаптируется под текущую волатильность рынка.
 * 
 * ОСОБЕННОСТИ ДЛЯ ЭКСПИРИРУЕМОГО ФЬЮЧЕРСА:
 * -------------------------------------------
 * 1. Фьючерс USD/CNY (UCNY) на Мосбирже — квартальный, экспирируется в третий четверг
 *    месяца экспирации. Коды контрактов: UCH (март), UCM (июнь), UCU (сентябрь), UCZ (декабрь)
 * 2. Параметры контракта:
 *    - Лот: 1000 USD
 *    - Шаг цены: 0.001 CNY
 *    - Стоимость шага: 1 CNY (~12-13 руб.)
 *    - ГО: ~6 000-8 000 руб.
 * 3. Робот автоматически закрывает позицию за 1 торговый день до экспирации,
 *    чтобы избежать форс-мажорных ситуаций при клиринге.
 * 
 * ЛОГИКА ВХОДА В ПОЗИЦИЮ:
 * ------------------------
 * ЛОНГ (покупка):
 *   1. Быстрая EMA пересекает медленную EMA снизу вверх
 *   2. RSI > уровня перепроданности (не в зоне перепроданности)
 *   3. Текущая свеча закрылась выше быстрой EMA
 * 
 * ШОРТ (продажа):
 *   1. Быстрая EMA пересекает медленную EMA сверху вниз
 *   2. RSI < уровня перекупленности (не в зоне перекупленности)
 *   3. Текущая свеча закрылась ниже быстрой EMA
 * 
 * ЛОГИКА ВЫХОДА ИЗ ПОЗИЦИИ:
 * --------------------------
 * 1. Трейлинг-стоп на основе ATR: стоп подтягивается вслед за ценой на расстоянии
 *    N * ATR от экстремума (минимум для лонга, максимум для шорта)
 * 2. Обратное пересечение EMA (быстрая пересекает медленную в обратную сторону)
 * 3. Защита перед экспирацией: закрытие позиции за 1 день до экспирации фьючерса
 * 
 * УПРАВЛЕНИЕ КАПИТАЛОМ:
 * ---------------------
 * - Объём позиции рассчитывается как фиксированный процент от депозита
 * - Максимальный риск на сделку ограничен (через ATR-стоп)
 * 
 * ПАРАМЕТРЫ ОПТИМИЗАЦИИ (рекомендации для UCNY, ТФ 15-60 мин):
 * -------------------------------------------------------------
 * - Период быстрой EMA: 9-12
 * - Период медленной EMA: 21-26
 * - RSI период: 14
 * - RSI уровни: 30/70
 * - ATR период: 14
 * - ATR множитель для стопа: 2.0-3.0
 */

using System;
using System.Collections.Generic;
using OsEngine.Entity;
using OsEngine.Indicators;
using OsEngine.OsTrader.Panels;
using OsEngine.OsTrader.Panels.Attributes;
using OsEngine.OsTrader.Panels.Tab;
using OsEngine.Market.Servers;
using OsEngine.Market;
using OsEngine.Language;

namespace OsEngine.Robots
{
    /// <summary>
    /// Трендовый робот для экспирируемого фьючерса USD/CNY (UCNY)
    /// Стратегия: пересечение EMA + фильтр RSI + трейлинг-стоп по ATR
    /// </summary>
    [Bot("CnyFuturesEmaRsiBot")]
    public class CnyFuturesEmaRsiBot : BotPanel
    {
        // ---------------------------------------------------------------
        // ПОЛЯ КЛАССА
        // ---------------------------------------------------------------

        // Основная торговая вкладка
        private BotTabSimple _tab;

        // ============ ПАРАМЕТРЫ СТРАТЕГИИ ============

        // Базовые настройки
        private StrategyParameterString _regime;           // Режим работы (Off/On/OnlyLong/OnlyShort/OnlyClosePosition)
        private StrategyParameterDecimal _slippage;        // Проскальзывание в процентах от шага цены
        private StrategyParameterString _orderType;        // Тип ордера (Market/Limit)

        // Настройки объёма
        private StrategyParameterString _volumeType;       // Тип расчёта объёма
        private StrategyParameterDecimal _volume;          // Значение объёма
        private StrategyParameterString _tradeAssetInPortfolio; // Актив портфеля для расчёта объёма

        // Настройки EMA
        private StrategyParameterInt _fastEmaPeriod;       // Период быстрой EMA
        private StrategyParameterInt _slowEmaPeriod;       // Период медленной EMA

        // Настройки RSI
        private StrategyParameterInt _rsiPeriod;           // Период RSI
        private StrategyParameterInt _rsiOversold;         // Уровень перепроданности
        private StrategyParameterInt _rsiOverbought;       // Уровень перекупленности

        // Настройки ATR (для стопа)
        private StrategyParameterInt _atrPeriod;           // Период ATR
        private StrategyParameterDecimal _atrMultiplier;   // Множитель ATR для стопа

        // Настройки экспирации
        private StrategyParameterInt _daysBeforeExpiration; // За сколько дней до экспирации закрывать позицию

        // ============ ИНДИКАТОРЫ ============
        private Aindicator _emaFast;    // Быстрая EMA
        private Aindicator _emaSlow;    // Медленная EMA
        private Aindicator _rsi;        // RSI
        private Aindicator _atr;        // ATR для расчёта стопа

        // ============ ЗНАЧЕНИЯ ИНДИКАТОРОВ ============
        private decimal _lastEmaFast;       // Последнее значение быстрой EMA
        private decimal _lastEmaSlow;       // Последнее значение медленной EMA
        private decimal _prevEmaFast;       // Предыдущее значение быстрой EMA
        private decimal _prevEmaSlow;       // Предыдущее значение медленной EMA
        private decimal _lastRsi;           // Последнее значение RSI
        private decimal _lastAtr;           // Последнее значение ATR

        // Флаг для отслеживания пересечения (чтобы не входить повторно на одной свече)
        private bool _crossUpHappened;      // Было ли пересечение вверх
        private bool _crossDownHappened;    // Было ли пересечение вниз

        // ---------------------------------------------------------------
        // КОНСТРУКТОР
        // ---------------------------------------------------------------
        public CnyFuturesEmaRsiBot(string name, StartProgram startProgram) : base(name, startProgram)
        {
            // Создаём основную торговую вкладку
            TabCreate(BotTabType.Simple);
            _tab = TabsSimple[0];

            // ============ СОЗДАНИЕ ПАРАМЕТРОВ ============

            // --- Базовые настройки ---
            _regime = CreateParameter("Regime", "Off", 
                new[] { "Off", "On", "OnlyLong", "OnlyShort", "OnlyClosePosition" }, 
                "Base");
            _slippage = CreateParameter("Slippage %", 0m, 0, 20, 1, "Base");
            _orderType = CreateParameter("Order type", "Market", 
                new[] { "Market", "Limit" }, 
                "Base");

            // --- Настройки объёма ---
            _volumeType = CreateParameter("Volume type", "Deposit percent", 
                new[] { "Contracts", "Contract currency", "Deposit percent" }, 
                "Base");
            _volume = CreateParameter("Volume", 10m, 1.0m, 50, 1, "Base");
            _tradeAssetInPortfolio = CreateParameter("Asset in portfolio", "Prime", "Base");

            // --- Настройки EMA (оптимизированы для UCNY) ---
            _fastEmaPeriod = CreateParameter("Fast EMA Period", 12, 5, 50, 1, "EMA");
            _slowEmaPeriod = CreateParameter("Slow EMA Period", 26, 10, 100, 1, "EMA");

            // --- Настройки RSI ---
            _rsiPeriod = CreateParameter("RSI Period", 14, 7, 30, 1, "RSI");
            _rsiOversold = CreateParameter("RSI Oversold Level", 30, 10, 40, 5, "RSI");
            _rsiOverbought = CreateParameter("RSI Overbought Level", 70, 60, 90, 5, "RSI");

            // --- Настройки ATR для стопа ---
            _atrPeriod = CreateParameter("ATR Period", 14, 7, 30, 1, "ATR Stop");
            _atrMultiplier = CreateParameter("ATR Multiplier", 2.5m, 1.0m, 5.0m, 0.5m, "ATR Stop");

            // --- Настройки экспирации ---
            _daysBeforeExpiration = CreateParameter("Days Before Expiration to Close", 1, 0, 5, 1, "Expiration");

            // ============ СОЗДАНИЕ ИНДИКАТОРОВ ============

            // --- Быстрая EMA ---
            _emaFast = IndicatorsFactory.CreateIndicatorByName("Ema", name + "FastEMA", false);
            _emaFast = (Aindicator)_tab.CreateCandleIndicator(_emaFast, "Prime");
            ((IndicatorParameterInt)_emaFast.Parameters[0]).ValueInt = _fastEmaPeriod.ValueInt;
            _emaFast.Save();

            // --- Медленная EMA ---
            _emaSlow = IndicatorsFactory.CreateIndicatorByName("Ema", name + "SlowEMA", false);
            _emaSlow = (Aindicator)_tab.CreateCandleIndicator(_emaSlow, "Prime");
            ((IndicatorParameterInt)_emaSlow.Parameters[0]).ValueInt = _slowEmaPeriod.ValueInt;
            _emaSlow.Save();

            // --- RSI ---
            _rsi = IndicatorsFactory.CreateIndicatorByName("RSI", name + "RSI", false);
            _rsi = (Aindicator)_tab.CreateCandleIndicator(_rsi, "NewArea");
            ((IndicatorParameterInt)_rsi.Parameters[0]).ValueInt = _rsiPeriod.ValueInt;
            _rsi.Save();

            // --- ATR ---
            _atr = IndicatorsFactory.CreateIndicatorByName("ATR", name + "ATR", false);
            _atr = (Aindicator)_tab.CreateCandleIndicator(_atr, "NewArea0");
            ((IndicatorParameterInt)_atr.Parameters[0]).ValueInt = _atrPeriod.ValueInt;
            _atr.Save();

            // ============ ПОДПИСКА НА СОБЫТИЯ ============

            // Обновление параметров пользователем
            ParametrsChangeByUser += CnyFuturesEmaRsiBot_ParametrsChangeByUser;

            // Завершение формирования свечи
            _tab.CandleFinishedEvent += _tab_CandleFinishedEvent;

            Description = "Трендовый робот для фьючерса USD/CNY. " +
                         "Стратегия: пересечение EMA + RSI + трейлинг-стоп ATR. " +
                         "Автозакрытие перед экспирацией.";
        }

        // ---------------------------------------------------------------
        // ОБРАБОТЧИК ИЗМЕНЕНИЯ ПАРАМЕТРОВ
        // ---------------------------------------------------------------
        private void CnyFuturesEmaRsiBot_ParametrsChangeByUser()
        {
            // Обновляем период быстрой EMA
            ((IndicatorParameterInt)_emaFast.Parameters[0]).ValueInt = _fastEmaPeriod.ValueInt;
            _emaFast.Save();
            _emaFast.Reload();

            // Обновляем период медленной EMA
            ((IndicatorParameterInt)_emaSlow.Parameters[0]).ValueInt = _slowEmaPeriod.ValueInt;
            _emaSlow.Save();
            _emaSlow.Reload();

            // Обновляем период RSI
            ((IndicatorParameterInt)_rsi.Parameters[0]).ValueInt = _rsiPeriod.ValueInt;
            _rsi.Save();
            _rsi.Reload();

            // Обновляем период ATR
            ((IndicatorParameterInt)_atr.Parameters[0]).ValueInt = _atrPeriod.ValueInt;
            _atr.Save();
            _atr.Reload();
        }

        // ---------------------------------------------------------------
        // ИМЯ СТРАТЕГИИ
        // ---------------------------------------------------------------
        public override string GetNameStrategyType()
        {
            return "CnyFuturesEmaRsiBot";
        }

        public override void ShowIndividualSettingsDialog()
        {
        }

        // ---------------------------------------------------------------
        // ОСНОВНОЙ ОБРАБОТЧИК СВЕЧИ
        // ---------------------------------------------------------------
        private void _tab_CandleFinishedEvent(List<Candle> candles)
        {
            // Если робот выключен — выходим
            if (_regime.ValueString == "Off")
            {
                return;
            }

            // Проверяем, достаточно ли свечей для расчёта индикаторов
            int minPeriod = Math.Max(
                Math.Max(_fastEmaPeriod.ValueInt, _slowEmaPeriod.ValueInt),
                Math.Max(_rsiPeriod.ValueInt, _atrPeriod.ValueInt)
            );

            if (candles.Count <= minPeriod + 5)
            {
                return;
            }

            // Получаем текущие значения индикаторов
            UpdateIndicatorValues();

            // Получаем открытые позиции
            List<Position> openPositions = _tab.PositionsOpenAll;

            // === ЗАКРЫТИЕ ПОЗИЦИЙ ===
            if (openPositions != null && openPositions.Count > 0)
            {
                LogicClosePosition(candles, openPositions);
                return; // Если есть позиции, на вход не проверяем
            }

            // Если режим только закрытия — выходим
            if (_regime.ValueString == "OnlyClosePosition")
            {
                return;
            }

            // === ОТКРЫТИЕ ПОЗИЦИЙ ===
            if (openPositions == null || openPositions.Count == 0)
            {
                LogicOpenPosition(candles);
            }
        }

        // ---------------------------------------------------------------
        // ОБНОВЛЕНИЕ ЗНАЧЕНИЙ ИНДИКАТОРОВ
        // ---------------------------------------------------------------
        private void UpdateIndicatorValues()
        {
            // EMA
            _prevEmaFast = _emaFast.DataSeries[0].Values[_emaFast.DataSeries[0].Values.Count - 2];
            _prevEmaSlow = _emaSlow.DataSeries[0].Values[_emaSlow.DataSeries[0].Values.Count - 2];
            _lastEmaFast = _emaFast.DataSeries[0].Last;
            _lastEmaSlow = _emaSlow.DataSeries[0].Last;

            // RSI
            _lastRsi = _rsi.DataSeries[0].Last;

            // ATR
            _lastAtr = _atr.DataSeries[0].Last;

            // Определяем пересечения
            _crossUpHappened = _prevEmaFast < _prevEmaSlow && _lastEmaFast > _lastEmaSlow;
            _crossDownHappened = _prevEmaFast > _prevEmaSlow && _lastEmaFast < _lastEmaSlow;
        }

        // ---------------------------------------------------------------
        // ЛОГИКА ОТКРЫТИЯ ПОЗИЦИИ
        // ---------------------------------------------------------------
        private void LogicOpenPosition(List<Candle> candles)
        {
            Candle lastCandle = candles[candles.Count - 1];
            decimal lastPrice = lastCandle.Close;

            // Расчёт проскальзывания
            decimal slippage = _slippage.ValueDecimal * _tab.Security.PriceStep;

            // ============ ЛОНГ (ПОКУПКА) ============
            if (_regime.ValueString != "OnlyShort")
            {
                // Условия входа в лонг:
                // 1. Быстрая EMA пересекла медленную снизу вверх
                // 2. RSI не в зоне перекупленности (фильтр)
                // 3. Цена закрытия выше быстрой EMA (подтверждение)
                if (_crossUpHappened && 
                    _lastRsi > _rsiOversold.ValueInt &&
                    lastPrice > _lastEmaFast)
                {
                    SendNewLogMessage(
                        $"=== СИГНАЛ ЛОНГ === | " +
                        $"Цена: {lastPrice} | " +
                        $"EMA{_fastEmaPeriod.ValueInt}: {_lastEmaFast:F4} | " +
                        $"EMA{_slowEmaPeriod.ValueInt}: {_lastEmaSlow:F4} | " +
                        $"RSI: {_lastRsi:F2}", 
                        Logging.LogMessageType.System);

                    if (_orderType.ValueString == "Limit")
                    {
                        _tab.BuyAtLimit(GetVolume(_tab), _tab.PriceBestAsk + slippage);
                    }
                    else
                    {
                        _tab.BuyAtMarket(GetVolume(_tab));
                    }
                }
            }

            // ============ ШОРТ (ПРОДАЖА) ============
            if (_regime.ValueString != "OnlyLong")
            {
                // Условия входа в шорт:
                // 1. Быстрая EMA пересекла медленную сверху вниз
                // 2. RSI не в зоне перепроданности (фильтр)
                // 3. Цена закрытия ниже быстрой EMA (подтверждение)
                if (_crossDownHappened && 
                    _lastRsi < _rsiOverbought.ValueInt &&
                    lastPrice < _lastEmaFast)
                {
                    SendNewLogMessage(
                        $"=== СИГНАЛ ШОРТ === | " +
                        $"Цена: {lastPrice} | " +
                        $"EMA{_fastEmaPeriod.ValueInt}: {_lastEmaFast:F4} | " +
                        $"EMA{_slowEmaPeriod.ValueInt}: {_lastEmaSlow:F4} | " +
                        $"RSI: {_lastRsi:F2}", 
                        Logging.LogMessageType.System);

                    if (_orderType.ValueString == "Limit")
                    {
                        _tab.SellAtLimit(GetVolume(_tab), _tab.PriceBestBid - slippage);
                    }
                    else
                    {
                        _tab.SellAtMarket(GetVolume(_tab));
                    }
                }
            }
        }

        // ---------------------------------------------------------------
        // ЛОГИКА ЗАКРЫТИЯ ПОЗИЦИИ
        // ---------------------------------------------------------------
        private void LogicClosePosition(List<Candle> candles, List<Position> openPositions)
        {
            Candle lastCandle = candles[candles.Count - 1];

            foreach (Position pos in openPositions)
            {
                // Пропускаем позиции, которые ещё не открылись
                if (pos.State != PositionStateType.Open)
                {
                    continue;
                }

                // 1. Проверка защиты от экспирации
                if (IsNearExpiration(candles))
                {
                    SendNewLogMessage(
                        $"Закрытие позиции {pos.Number} перед экспирацией фьючерса!", 
                        Logging.LogMessageType.System);
                    
                    ClosePosition(pos);
                    continue;
                }

                // 2. Трейлинг-стоп на основе ATR
                decimal stopPrice;
                
                if (pos.Direction == Side.Buy)
                {
                    // Для лонга: стоп ниже минимума свечи на ATR * множитель
                    stopPrice = lastCandle.Low - (_lastAtr * _atrMultiplier.ValueDecimal);
                    
                    // Также закрываем при обратном пересечении EMA (быстрая ниже медленной)
                    if (_crossDownHappened)
                    {
                        SendNewLogMessage(
                            $"Закрытие ЛОНГ {pos.Number} — обратное пересечение EMA", 
                            Logging.LogMessageType.System);
                        ClosePosition(pos);
                        continue;
                    }

                    // Выставляем трейлинг-стоп
                    if (_orderType.ValueString == "Limit")
                    {
                        _tab.CloseAtTrailingStop(pos, stopPrice, stopPrice);
                    }
                    else
                    {
                        _tab.CloseAtTrailingStopMarket(pos, stopPrice);
                    }
                }
                else // Side.Sell
                {
                    // Для шорта: стоп выше максимума свечи на ATR * множитель
                    stopPrice = lastCandle.High + (_lastAtr * _atrMultiplier.ValueDecimal);
                    
                    // Также закрываем при обратном пересечении EMA (быстрая выше медленной)
                    if (_crossUpHappened)
                    {
                        SendNewLogMessage(
                            $"Закрытие ШОРТ {pos.Number} — обратное пересечение EMA", 
                            Logging.LogMessageType.System);
                        ClosePosition(pos);
                        continue;
                    }

                    // Выставляем трейлинг-стоп
                    if (_orderType.ValueString == "Limit")
                    {
                        _tab.CloseAtTrailingStop(pos, stopPrice, stopPrice);
                    }
                    else
                    {
                        _tab.CloseAtTrailingStopMarket(pos, stopPrice);
                    }
                }
            }
        }

        // ---------------------------------------------------------------
        // ПРОВЕРКА ПРИБЛИЖЕНИЯ ЭКСПИРАЦИИ
        // ---------------------------------------------------------------
        /// <summary>
        /// Проверяет, не приближается ли дата экспирации фьючерса.
        /// Для экспирируемых фьючерсов UCNY экспирация — в третий четверг месяца.
        /// </summary>
        private bool IsNearExpiration(List<Candle> candles)
        {
            if (_daysBeforeExpiration.ValueInt <= 0)
            {
                return false;
            }

            // Получаем текущую дату из последней свечи
            DateTime currentDate = candles[candles.Count - 1].TimeStart;

            // Определяем дату экспирации (третий четверг текущего месяца для квартальных фьючерсов)
            // В реальности дату экспирации лучше получать из свойств инструмента,
            // но здесь делаем приближённый расчёт
            DateTime expirationDate = GetApproximateExpirationDate(currentDate);

            // Проверяем, сколько дней осталось
            int daysUntilExpiration = (expirationDate - currentDate).Days;

            return daysUntilExpiration <= _daysBeforeExpiration.ValueInt;
        }

        /// <summary>
        /// Приближённый расчёт даты экспирации (третий четверг месяца).
        /// В реальной торговле рекомендуется получать точную дату из параметров инструмента.
        /// </summary>
        private DateTime GetApproximateExpirationDate(DateTime date)
        {
            // Находим третий четверг месяца
            DateTime firstDayOfMonth = new DateTime(date.Year, date.Month, 1);
            int thursdayCount = 0;
            DateTime result = firstDayOfMonth;

            for (int day = 1; day <= DateTime.DaysInMonth(date.Year, date.Month); day++)
            {
                DateTime currentDay = new DateTime(date.Year, date.Month, day);
                if (currentDay.DayOfWeek == DayOfWeek.Thursday)
                {
                    thursdayCount++;
                    if (thursdayCount == 3)
                    {
                        result = currentDay;
                        break;
                    }
                }
            }

            return result;
        }

        // ---------------------------------------------------------------
        // ЗАКРЫТИЕ ПОЗИЦИИ (вспомогательный метод)
        // ---------------------------------------------------------------
        private void ClosePosition(Position pos)
        {
            if (_orderType.ValueString == "Limit")
            {
                if (pos.Direction == Side.Buy)
                {
                    _tab.CloseAtLimit(pos, _tab.PriceBestBid - (_slippage.ValueDecimal * _tab.Security.PriceStep), 
                        pos.OpenVolume);
                }
                else
                {
                    _tab.CloseAtLimit(pos, _tab.PriceBestAsk + (_slippage.ValueDecimal * _tab.Security.PriceStep), 
                        pos.OpenVolume);
                }
            }
            else
            {
                _tab.CloseAtMarket(pos, pos.OpenVolume);
            }
        }

        // ---------------------------------------------------------------
        // РАСЧЁТ ОБЪЁМА ПОЗИЦИИ
        // ---------------------------------------------------------------
        private decimal GetVolume(BotTabSimple tab)
        {
            decimal volume = 0;

            // 1. Фиксированное количество контрактов
            if (_volumeType.ValueString == "Contracts")
            {
                volume = _volume.ValueDecimal;
            }
            // 2. В валюте контракта
            else if (_volumeType.ValueString == "Contract currency")
            {
                decimal contractPrice = tab.PriceBestAsk;
                volume = _volume.ValueDecimal / contractPrice;

                if (StartProgram == StartProgram.IsOsTrader)
                {
                    IServerPermission serverPermission = ServerMaster.GetServerPermission(tab.Connector.ServerType);

                    if (serverPermission != null &&
                        serverPermission.IsUseLotToCalculateProfit &&
                        tab.Security.Lot != 0 &&
                        tab.Security.Lot > 1)
                    {
                        volume = _volume.ValueDecimal / (contractPrice * tab.Security.Lot);
                    }

                    volume = Math.Round(volume, tab.Security.DecimalsVolume);
                }
                else
                {
                    volume = Math.Round(volume, 6);
                }
            }
            // 3. Процент от депозита (рекомендуется)
            else if (_volumeType.ValueString == "Deposit percent")
            {
                Portfolio myPortfolio = tab.Portfolio;

                if (myPortfolio == null)
                {
                    return 0;
                }

                decimal portfolioPrimeAsset = 0;

                if (_tradeAssetInPortfolio.ValueString == "Prime")
                {
                    portfolioPrimeAsset = myPortfolio.ValueCurrent;
                }
                else
                {
                    List<PositionOnBoard> positionOnBoard = myPortfolio.GetPositionOnBoard();

                    if (positionOnBoard == null)
                    {
                        return 0;
                    }

                    for (int i = 0; i < positionOnBoard.Count; i++)
                    {
                        if (positionOnBoard[i].SecurityNameCode == _tradeAssetInPortfolio.ValueString)
                        {
                            portfolioPrimeAsset = positionOnBoard[i].ValueCurrent;
                            break;
                        }
                    }
                }

                if (portfolioPrimeAsset == 0)
                {
                    SendNewLogMessage("Не найден портфель " + _tradeAssetInPortfolio.ValueString, 
                        Logging.LogMessageType.Error);
                    return 0;
                }

                // Расчёт суммы на позицию
                decimal moneyOnPosition = portfolioPrimeAsset * (_volume.ValueDecimal / 100);

                // Расчёт количества контрактов с учётом специфики фьючерсов Мосбиржи
                decimal qty = moneyOnPosition / tab.PriceBestAsk / tab.Security.Lot;

                if (tab.StartProgram == StartProgram.IsOsTrader)
                {
                    // Специальный расчёт для фьючерсов и опционов на Мосбирже
                    if (tab.Security.UsePriceStepCostToCalculateVolume == true
                       && tab.Security.PriceStep != tab.Security.PriceStepCost
                       && tab.PriceBestAsk != 0
                       && tab.Security.PriceStep != 0
                       && tab.Security.PriceStepCost != 0)
                    {
                        qty = moneyOnPosition / (tab.PriceBestAsk / tab.Security.PriceStep * tab.Security.PriceStepCost);
                    }
                    qty = Math.Round(qty, tab.Security.DecimalsVolume);
                }
                else
                {
                    qty = Math.Round(qty, 7);
                }

                return qty;
            }

            return volume;
        }
    }
}
