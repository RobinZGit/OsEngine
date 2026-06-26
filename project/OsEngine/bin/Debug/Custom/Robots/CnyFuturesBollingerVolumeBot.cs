/*
 * Your rights to use code governed by this license https://github.com/AlexWan/OsEngine/blob/master/LICENSE
 * Ваши права на использование кода регулируются данной лицензией http://o-s-a.net/doc/license_simple_engine.pdf
 *
 * ==========================================================================================
 * КОНТРТРЕНДОВЫЙ РОБОТ ДЛЯ ЭКСПИРИРУЕМОГО ФЬЮЧЕРСА USD/CNY (UCNY)
 * ==========================================================================================
 *
 * Стратегия: Отскок от полос Боллинджера с подтверждением RSI и аномальным объёмом
 *
 * ОПИСАНИЕ СТРАТЕГИИ:
 * -------------------
 * Контртрендовая стратегия, использующая полосы Боллинджера (Bollinger Bands) 
 * для определения зон перекупленности/перепроданности. Робот входит в позицию 
 * при подходе цены к границам канала с ожиданием отскока.
 * 
 * Для фильтрации используются:
 * - RSI — подтверждение перекупленности/перепроданности
 * - Объём — аномальный всплеск объёма как сигнал разворота
 * 
 * ЛОГИКА ВХОДА В ПОЗИЦИЮ:
 * ------------------------
 * ЛОНГ (покупка от нижней полосы):
 *   1. Цена закрытия коснулась или пробила нижнюю полосу Боллинджера
 *   2. RSI ниже уровня перепроданности (по умолчанию 30)
 *   3. Объём текущей свечи выше среднего объёма (подтверждение интереса)
 * 
 * ШОРТ (продажа от верхней полосы):
 *   1. Цена закрытия коснулась или пробила верхнюю полосу Боллинджера
 *   2. RSI выше уровня перекупленности (по умолчанию 70)
 *   3. Объём текущей свечи выше среднего объёма (подтверждение интереса)
 * 
 * ЛОГИКА ВЫХОДА ИЗ ПОЗИЦИИ:
 * --------------------------
 * 1. Take-profit: при достижении средней линии Боллинджера (скользящей средней)
 * 2. Stop-loss: за пределами противоположной полосы Боллинджера
 * 3. Трейлинг-стоп: подтягивается при движении цены в направлении прибыли
 * 4. Защита перед экспирацией: закрытие за N дней до экспирации
 * 
 * ПОЧЕМУ ЭТА СТРАТЕГИЯ ПОДХОДИТ ДЛЯ USD/CNY:
 * --------------------------------------------
 * - Валютная пара USD/CNY часто торгуется в диапазоне (range-bound) из-за 
 *   интервенций Народного банка Китая
 * - В периоды бокового движения контртрендовые стратегии показывают лучшие результаты
 * - Полосы Боллинджера хорошо определяют границы торгового диапазона
 * - Аномальный объём часто предшествует развороту на валютном рынке
 * 
 * РЕКОМЕНДАЦИИ ПО НАСТРОЙКЕ (UCNY, ТФ 15-30 мин):
 * ------------------------------------------------
 * - Период Bollinger Bands: 20
 * - Отклонение BB: 2.0
 * - RSI период: 14
 * - RSI уровни: 30/70
 * - Множитель объёма: 1.5 (текущий объём > 1.5 * средний)
 * - Stop-loss: за границей противоположной полосы
 * - Take-profit: на средней линии BB
 */

using System;
using System.Collections.Generic;
using System.Linq;
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
    /// Контртрендовый робот для экспирируемого фьючерса USD/CNY
    /// Стратегия: отскок от Bollinger Bands + RSI + подтверждение объёмом
    /// </summary>
    [Bot("CnyFuturesBollingerVolumeBot")]
    public class CnyFuturesBollingerVolumeBot : BotPanel
    {
        // ---------------------------------------------------------------
        // ПОЛЯ КЛАССА
        // ---------------------------------------------------------------

        // Основная торговая вкладка
        private BotTabSimple _tab;

        // ============ ПАРАМЕТРЫ СТРАТЕГИИ ============

        // Базовые настройки
        private StrategyParameterString _regime;
        private StrategyParameterDecimal _slippage;
        private StrategyParameterString _orderType;

        // Настройки объёма
        private StrategyParameterString _volumeType;
        private StrategyParameterDecimal _volume;
        private StrategyParameterString _tradeAssetInPortfolio;

        // Настройки Bollinger Bands
        private StrategyParameterInt _bbPeriod;
        private StrategyParameterDecimal _bbDeviation;

        // Настройки RSI
        private StrategyParameterInt _rsiPeriod;
        private StrategyParameterInt _rsiOversold;
        private StrategyParameterInt _rsiOverbought;

        // Настройки объёма (фильтр)
        private StrategyParameterInt _volumeMaPeriod;      // Период скользящей средней объёма
        private StrategyParameterDecimal _volumeMultiplier; // Множитель объёма для сигнала

        // Настройки выхода
        private StrategyParameterDecimal _stopLossPercent; // Стоп-лосс в процентах от цены входа
        private StrategyParameterDecimal _takeProfitPercent; // Тейк-профит в процентах от цены входа
        private StrategyParameterBool _useTrailingStop;    // Использовать ли трейлинг-стоп
        private StrategyParameterDecimal _trailingStopPercent; // Размер трейлинг-стопа в процентах

        // Настройки экспирации
        private StrategyParameterInt _daysBeforeExpiration;

        // ============ ИНДИКАТОРЫ ============
        private Aindicator _bollinger;
        private Aindicator _rsi;
        private Aindicator _volumeMa;

        // ============ ЗНАЧЕНИЯ ИНДИКАТОРОВ ============
        private decimal _lastBbUpper;       // Верхняя полоса
        private decimal _lastBbLower;       // Нижняя полоса
        private decimal _lastBbMiddle;      // Средняя линия
        private decimal _lastRsi;           // RSI
        private decimal _lastVolumeMa;      // Средний объём

        // ============ ДАННЫЕ ПОЗИЦИИ ============
        private decimal _entryPrice;        // Цена входа (для расчёта стопа/профита)

        // ---------------------------------------------------------------
        // КОНСТРУКТОР
        // ---------------------------------------------------------------
        public CnyFuturesBollingerVolumeBot(string name, StartProgram startProgram) : base(name, startProgram)
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

            // --- Настройки Bollinger Bands ---
            _bbPeriod = CreateParameter("BB Period", 20, 10, 50, 1, "Bollinger");
            _bbDeviation = CreateParameter("BB Deviation", 2.0m, 1.0m, 4.0m, 0.5m, "Bollinger");

            // --- Настройки RSI ---
            _rsiPeriod = CreateParameter("RSI Period", 14, 7, 30, 1, "RSI");
            _rsiOversold = CreateParameter("RSI Oversold Level", 30, 10, 40, 5, "RSI");
            _rsiOverbought = CreateParameter("RSI Overbought Level", 70, 60, 90, 5, "RSI");

            // --- Настройки фильтра объёма ---
            _volumeMaPeriod = CreateParameter("Volume MA Period", 20, 10, 50, 1, "Volume");
            _volumeMultiplier = CreateParameter("Volume Multiplier", 1.5m, 1.0m, 3.0m, 0.5m, "Volume");

            // --- Настройки выхода ---
            _stopLossPercent = CreateParameter("Stop Loss %", 1.0m, 0.5m, 5.0m, 0.5m, "Exit");
            _takeProfitPercent = CreateParameter("Take Profit %", 1.5m, 0.5m, 5.0m, 0.5m, "Exit");
            _useTrailingStop = CreateParameter("Use Trailing Stop", true, "Exit");
            _trailingStopPercent = CreateParameter("Trailing Stop %", 1.0m, 0.3m, 3.0m, 0.1m, "Exit");

            // --- Настройки экспирации ---
            _daysBeforeExpiration = CreateParameter("Days Before Expiration to Close", 1, 0, 5, 1, "Expiration");

            // ============ СОЗДАНИЕ ИНДИКАТОРОВ ============

            // --- Bollinger Bands ---
            _bollinger = IndicatorsFactory.CreateIndicatorByName("Bollinger", name + "BB", false);
            _bollinger = (Aindicator)_tab.CreateCandleIndicator(_bollinger, "Prime");
            ((IndicatorParameterInt)_bollinger.Parameters[0]).ValueInt = _bbPeriod.ValueInt;
            ((IndicatorParameterDecimal)_bollinger.Parameters[1]).ValueDecimal = _bbDeviation.ValueDecimal;
            _bollinger.Save();

            // --- RSI ---
            _rsi = IndicatorsFactory.CreateIndicatorByName("RSI", name + "RSI", false);
            _rsi = (Aindicator)_tab.CreateCandleIndicator(_rsi, "NewArea");
            ((IndicatorParameterInt)_rsi.Parameters[0]).ValueInt = _rsiPeriod.ValueInt;
            _rsi.Save();

            // --- Volume MA ---
            _volumeMa = IndicatorsFactory.CreateIndicatorByName("VolumeMa", name + "VolMA", false);
            _volumeMa = (Aindicator)_tab.CreateCandleIndicator(_volumeMa, "NewArea0");
            ((IndicatorParameterInt)_volumeMa.Parameters[0]).ValueInt = _volumeMaPeriod.ValueInt;
            _volumeMa.Save();

            // ============ ПОДПИСКА НА СОБЫТИЯ ============

            ParametrsChangeByUser += CnyFuturesBollingerVolumeBot_ParametrsChangeByUser;
            _tab.CandleFinishedEvent += _tab_CandleFinishedEvent;

            Description = "Контртрендовый робот для фьючерса USD/CNY. " +
                         "Стратегия: отскок от Bollinger Bands + RSI + подтверждение объёмом. " +
                         "Автозакрытие перед экспирацией.";
        }

        // ---------------------------------------------------------------
        // ОБРАБОТЧИК ИЗМЕНЕНИЯ ПАРАМЕТРОВ
        // ---------------------------------------------------------------
        private void CnyFuturesBollingerVolumeBot_ParametrsChangeByUser()
        {
            // Bollinger Bands
            ((IndicatorParameterInt)_bollinger.Parameters[0]).ValueInt = _bbPeriod.ValueInt;
            ((IndicatorParameterDecimal)_bollinger.Parameters[1]).ValueDecimal = _bbDeviation.ValueDecimal;
            _bollinger.Save();
            _bollinger.Reload();

            // RSI
            ((IndicatorParameterInt)_rsi.Parameters[0]).ValueInt = _rsiPeriod.ValueInt;
            _rsi.Save();
            _rsi.Reload();

            // Volume MA
            ((IndicatorParameterInt)_volumeMa.Parameters[0]).ValueInt = _volumeMaPeriod.ValueInt;
            _volumeMa.Save();
            _volumeMa.Reload();
        }

        // ---------------------------------------------------------------
        // ИМЯ СТРАТЕГИИ
        // ---------------------------------------------------------------
        public override string GetNameStrategyType()
        {
            return "CnyFuturesBollingerVolumeBot";
        }

        public override void ShowIndividualSettingsDialog()
        {
        }

        // ---------------------------------------------------------------
        // ОСНОВНОЙ ОБРАБОТЧИК СВЕЧИ
        // ---------------------------------------------------------------
        private void _tab_CandleFinishedEvent(List<Candle> candles)
        {
            if (_regime.ValueString == "Off")
            {
                return;
            }

            // Проверяем, достаточно ли свечей
            int minPeriod = Math.Max(
                Math.Max(_bbPeriod.ValueInt, _rsiPeriod.ValueInt),
                _volumeMaPeriod.ValueInt
            );

            if (candles.Count <= minPeriod + 5)
            {
                return;
            }

            // Обновляем значения индикаторов
            UpdateIndicatorValues(candles);

            // Получаем открытые позиции
            List<Position> openPositions = _tab.PositionsOpenAll;

            // === ЗАКРЫТИЕ ПОЗИЦИЙ ===
            if (openPositions != null && openPositions.Count > 0)
            {
                LogicClosePosition(candles, openPositions);
                return;
            }

            // Если режим только закрытия
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
        private void UpdateIndicatorValues(List<Candle> candles)
        {
            // Bollinger Bands: [0] - верхняя, [1] - нижняя, [2] - средняя
            _lastBbUpper = _bollinger.DataSeries[0].Last;
            _lastBbLower = _bollinger.DataSeries[1].Last;
            _lastBbMiddle = _bollinger.DataSeries[2].Last;

            // RSI
            _lastRsi = _rsi.DataSeries[0].Last;

            // Volume MA
            _lastVolumeMa = _volumeMa.DataSeries[0].Last;
        }

        // ---------------------------------------------------------------
        // ЛОГИКА ОТКРЫТИЯ ПОЗИЦИИ
        // ---------------------------------------------------------------
        private void LogicOpenPosition(List<Candle> candles)
        {
            Candle lastCandle = candles[candles.Count - 1];
            decimal lastPrice = lastCandle.Close;
            decimal lastVolume = lastCandle.Volume;

            // Расчёт проскальзывания
            decimal slippage = _slippage.ValueDecimal * _tab.Security.PriceStep;

            // Проверяем валидность значений индикаторов
            if (_lastBbUpper == 0 || _lastBbLower == 0 || _lastVolumeMa == 0)
            {
                return;
            }

            // ============ ЛОНГ (покупка от нижней полосы) ============
            if (_regime.ValueString != "OnlyShort")
            {
                // Условия входа в лонг:
                // 1. Цена коснулась или пробила нижнюю полосу Боллинджера
                // 2. RSI в зоне перепроданности
                // 3. Объём выше среднего (подтверждение)
                bool priceAtLowerBand = lastPrice <= _lastBbLower * 1.001m; // Небольшой допуск
                bool rsiOversold = _lastRsi < _rsiOversold.ValueInt;
                bool volumeConfirmed = lastVolume > _lastVolumeMa * _volumeMultiplier.ValueDecimal;

                if (priceAtLowerBand && rsiOversold && volumeConfirmed)
                {
                    _entryPrice = lastPrice;

                    SendNewLogMessage(
                        $"=== СИГНАЛ ЛОНГ (отскок от BB) === | " +
                        $"Цена: {lastPrice} | " +
                        $"BB Lower: {_lastBbLower:F4} | " +
                        $"RSI: {_lastRsi:F2} | " +
                        $"Объём: {lastVolume:F0} > MA{_volumeMaPeriod.ValueInt}: {_lastVolumeMa:F0}",
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

            // ============ ШОРТ (продажа от верхней полосы) ============
            if (_regime.ValueString != "OnlyLong")
            {
                // Условия входа в шорт:
                // 1. Цена коснулась или пробила верхнюю полосу Боллинджера
                // 2. RSI в зоне перекупленности
                // 3. Объём выше среднего (подтверждение)
                bool priceAtUpperBand = lastPrice >= _lastBbUpper * 0.999m; // Небольшой допуск
                bool rsiOverbought = _lastRsi > _rsiOverbought.ValueInt;
                bool volumeConfirmed = lastVolume > _lastVolumeMa * _volumeMultiplier.ValueDecimal;

                if (priceAtUpperBand && rsiOverbought && volumeConfirmed)
                {
                    _entryPrice = lastPrice;

                    SendNewLogMessage(
                        $"=== СИГНАЛ ШОРТ (отскок от BB) === | " +
                        $"Цена: {lastPrice} | " +
                        $"BB Upper: {_lastBbUpper:F4} | " +
                        $"RSI: {_lastRsi:F2} | " +
                        $"Объём: {lastVolume:F0} > MA{_volumeMaPeriod.ValueInt}: {_lastVolumeMa:F0}",
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
            decimal lastPrice = lastCandle.Close;

            foreach (Position pos in openPositions)
            {
                if (pos.State != PositionStateType.Open)
                {
                    continue;
                }

                // 1. Защита перед экспирацией
                if (IsNearExpiration(candles))
                {
                    SendNewLogMessage(
                        $"Закрытие позиции {pos.Number} перед экспирацией!",
                        Logging.LogMessageType.System);
                    ClosePosition(pos);
                    continue;
                }

                // Рассчитываем цены стопа и профита
                decimal stopPrice, profitPrice;

                if (pos.Direction == Side.Buy)
                {
                    // Для лонга:
                    // Take-profit: средняя линия BB или фиксированный %
                    profitPrice = Math.Max(_lastBbMiddle, pos.EntryPrice * (1 + _takeProfitPercent.ValueDecimal / 100));
                    // Stop-loss: ниже нижней полосы или фиксированный %
                    stopPrice = Math.Min(_lastBbLower, pos.EntryPrice * (1 - _stopLossPercent.ValueDecimal / 100));

                    // Проверяем достижение тейк-профита
                    if (lastPrice >= profitPrice)
                    {
                        SendNewLogMessage(
                            $"Закрытие ЛОНГ {pos.Number} — достигнут take-profit: {lastPrice:F4}",
                            Logging.LogMessageType.System);
                        ClosePosition(pos);
                        continue;
                    }

                    // Выставляем стоп и трейлинг
                    if (_useTrailingStop.ValueBool)
                    {
                        decimal trailPrice = lastPrice * (1 - _trailingStopPercent.ValueDecimal / 100);
                        // Трейлинг-стоп не должен быть ниже обычного стопа
                        trailPrice = Math.Max(trailPrice, stopPrice);

                        if (_orderType.ValueString == "Limit")
                        {
                            _tab.CloseAtTrailingStop(pos, trailPrice, trailPrice);
                        }
                        else
                        {
                            _tab.CloseAtTrailingStopMarket(pos, trailPrice);
                        }
                    }
                    else
                    {
                        if (_orderType.ValueString == "Limit")
                        {
                            _tab.CloseAtStop(pos, stopPrice, stopPrice);
                        }
                        else
                        {
                            _tab.CloseAtStopMarket(pos, stopPrice);//, stopPrice);
                        }
                    }
                }
                else // Side.Sell
                {
                    // Для шорта:
                    // Take-profit: средняя линия BB или фиксированный %
                    profitPrice = Math.Min(_lastBbMiddle, pos.EntryPrice * (1 - _takeProfitPercent.ValueDecimal / 100));
                    // Stop-loss: выше верхней полосы или фиксированный %
                    stopPrice = Math.Max(_lastBbUpper, pos.EntryPrice * (1 + _stopLossPercent.ValueDecimal / 100));

                    // Проверяем достижение тейк-профита
                    if (lastPrice <= profitPrice)
                    {
                        SendNewLogMessage(
                            $"Закрытие ШОРТ {pos.Number} — достигнут take-profit: {lastPrice:F4}",
                            Logging.LogMessageType.System);
                        ClosePosition(pos);
                        continue;
                    }

                    // Выставляем стоп и трейлинг
                    if (_useTrailingStop.ValueBool)
                    {
                        decimal trailPrice = lastPrice * (1 + _trailingStopPercent.ValueDecimal / 100);
                        // Трейлинг-стоп не должен быть выше обычного стопа
                        trailPrice = Math.Min(trailPrice, stopPrice);

                        if (_orderType.ValueString == "Limit")
                        {
                            _tab.CloseAtTrailingStop(pos, trailPrice, trailPrice);
                        }
                        else
                        {
                            _tab.CloseAtTrailingStopMarket(pos, trailPrice);
                        }
                    }
                    else
                    {
                        if (_orderType.ValueString == "Limit")
                        {
                            _tab.CloseAtStop(pos, stopPrice, stopPrice);
                        }
                        else
                        {
                            _tab.CloseAtStopMarket(pos, stopPrice);//, stopPrice);
                        }
                    }
                }
            }
        }

        // ---------------------------------------------------------------
        // ПРОВЕРКА ПРИБЛИЖЕНИЯ ЭКСПИРАЦИИ
        // ---------------------------------------------------------------
        private bool IsNearExpiration(List<Candle> candles)
        {
            if (_daysBeforeExpiration.ValueInt <= 0)
            {
                return false;
            }

            DateTime currentDate = candles[candles.Count - 1].TimeStart;
            DateTime expirationDate = GetApproximateExpirationDate(currentDate);
            int daysUntilExpiration = (expirationDate - currentDate).Days;

            return daysUntilExpiration <= _daysBeforeExpiration.ValueInt;
        }

        private DateTime GetApproximateExpirationDate(DateTime date)
        {
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
        // ЗАКРЫТИЕ ПОЗИЦИИ
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

            if (_volumeType.ValueString == "Contracts")
            {
                volume = _volume.ValueDecimal;
            }
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

                decimal moneyOnPosition = portfolioPrimeAsset * (_volume.ValueDecimal / 100);

                decimal qty = moneyOnPosition / tab.PriceBestAsk / tab.Security.Lot;

                if (tab.StartProgram == StartProgram.IsOsTrader)
                {
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
