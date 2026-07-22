/*
 * Your rights to use code governed by this license https://github.com/AlexWan/OsEngine/blob/master/LICENSE
 * Ваши права на использование кода регулируются данной лицензией http://o-s-a.net/doc/license_simple_engine.pdf
 *
 * ==========================================================================================
 * СКРИНЕР ДЛЯ ЭКСПИРИРУЕМЫХ ФЬЮЧЕРСОВ USD/CNY (UCNY)
 * ==========================================================================================
 *
 * Стратегия: Пересечение двух EMA с фильтром RSI и Volume MA
 *
 * ОПИСАНИЕ:
 * --------
 * Скринер анализирует список инструментов и выдаёт сигналы (Long/Short/Flat)
 * на основе пересечения EMA с фильтром RSI и Volume MA.
 *
 * Особенности:
 * - Поддержка нескольких вкладок (инструментов) одновременно
 * - Гибкая настройка сигналов через параметры
 * - Визуальное отображение сигналов в таблице скринера
 * - Фильтрация по объёму (Volume MA)
 * - Работает из папки Custom/Robots без пересборки проекта
 *
 * ЛОГИКА СИГНАЛА:
 * ---------------
 * ЛОНГ:
 *   1. Быстрая EMA пересекает медленную EMA снизу вверх
 *   2. RSI > уровня перепроданности
 *   3. Текущий объём > Volume MA Upper (подтверждение интереса)
 *
 * ШОРТ:
 *   1. Быстрая EMA пересекает медленную EMA сверху вниз
 *   2. RSI < уровня перекупленности
 *   3. Текущий объём > Volume MA Upper (подтверждение интереса)
 *
 * ФЛЭТ (нет сигнала):
 *   - Нет пересечения EMA или RSI в запретной зоне
 *   - Или объём ниже порога
 */

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Windows.Forms;
using OsEngine.Entity;
using OsEngine.Indicators;
using OsEngine.OsTrader.Panels;
using OsEngine.OsTrader.Panels.Attributes;
using OsEngine.OsTrader.Panels.Tab;
using OsEngine.Logging;

namespace OsEngine.Robots.Custom
{
    /// <summary>
    /// Скринер для экспирируемых фьючерсов USD/CNY (UCNY)
    /// Стратегия: пересечение EMA + RSI + Volume MA
    /// Размещается в папке Custom/Robots — не требует пересборки проекта
    /// </summary>
    [Bot("CnyFuturesScreener")]
    public class CnyFuturesScreener : BotPanel
    {
        // -------------------------------------------------------------
        // ПОЛЯ КЛАССА
        // -------------------------------------------------------------

        // Список торговых вкладок (по одной на инструмент)
        private List<BotTabSimple> _tabs = new List<BotTabSimple>();

        // ============ ПАРАМЕТРЫ СКРИНЕРА ============

        // Базовые настройки
        private StrategyParameterString _regime;           // Режим работы (Off/On)
        private StrategyParameterString _timeFrame;        // Таймфрейм для анализа
        private StrategyParameterInt _lookbackBars;        // Глубина истории (баров)

        // Настройки EMA
        private StrategyParameterInt _fastEmaPeriod;       // Период быстрой EMA
        private StrategyParameterInt _slowEmaPeriod;       // Период медленной EMA

        // Настройки RSI
        private StrategyParameterInt _rsiPeriod;           // Период RSI
        private StrategyParameterInt _rsiOversold;         // Уровень перепроданности
        private StrategyParameterInt _rsiOverbought;       // Уровень перекупленности

        // Настройки Volume MA
        private StrategyParameterInt _volumeMaPeriod;      // Период Volume MA
        private StrategyParameterDecimal _volumeMultiplier; // Мультипликатор объёма
        private StrategyParameterBool _useVolumeFilter;   // Использовать фильтр по объёму

        // ============ ИНДИКАТОРЫ (по одному на вкладку) ============
        private List<Aindicator> _emaFastList = new List<Aindicator>();
        private List<Aindicator> _emaSlowList = new List<Aindicator>();
        private List<Aindicator> _rsiList = new List<Aindicator>();
        private List<Aindicator> _volumeMaList = new List<Aindicator>();

        // ============ ТАБЛИЦА СКРИНЕРА ============
        private DataGridView _screenerGrid;
        private List<ScreenerRow> _screenerRows = new List<ScreenerRow>();

        // ============ ВНУТРЕННИЕ СТРУКТУРЫ ============
        private class ScreenerRow
        {
            public string TabName { get; set; }
            public string SecurityName { get; set; }
            public string Signal { get; set; } = "Flat";
            public decimal Price { get; set; }
            public decimal FastEma { get; set; }
            public decimal SlowEma { get; set; }
            public decimal Rsi { get; set; }
            public decimal Volume { get; set; }
            public decimal VolumeMa { get; set; }
            public DateTime SignalTime { get; set; }
            public Color SignalColor { get; set; } = Color.Gray;
        }

        // -------------------------------------------------------------
        // КОНСТРУКТОР
        // -------------------------------------------------------------
        public CnyFuturesScreener(string name, StartProgram startProgram) : base(name, startProgram)
        {
            // ============ СОЗДАНИЕ ПАРАМЕТРОВ ============

            // --- Базовые настройки ---
            _regime = CreateParameter("Regime", "Off",
                new[] { "Off", "On" },
                "Base");
            _timeFrame = CreateParameter("TimeFrame", "TimeFrame.Minute15",
                new[] { "TimeFrame.Minute5", "TimeFrame.Minute15", "TimeFrame.Minute30", "TimeFrame.Hour1" },
                "Base");
            _lookbackBars = CreateParameter("Lookback Bars", 100, 50, 500, 10, "Base");

            // --- Настройки EMA ---
            _fastEmaPeriod = CreateParameter("Fast EMA Period", 12, 5, 50, 1, "EMA");
            _slowEmaPeriod = CreateParameter("Slow EMA Period", 26, 10, 100, 1, "EMA");

            // --- Настройки RSI ---
            _rsiPeriod = CreateParameter("RSI Period", 14, 7, 30, 1, "RSI");
            _rsiOversold = CreateParameter("RSI Oversold Level", 30, 10, 40, 5, "RSI");
            _rsiOverbought = CreateParameter("RSI Overbought Level", 70, 60, 90, 5, "RSI");

            // --- Настройки Volume MA ---
            _volumeMaPeriod = CreateParameter("Volume MA Period", 20, 5, 50, 1, "Volume MA");
            _volumeMultiplier = CreateParameter("Volume Multiplier", 1.5m, 1.0m, 3.0m, 0.1m, "Volume MA");
            _useVolumeFilter = CreateParameter("Use Volume Filter", true, "Volume MA");

            // ============ СОЗДАНИЕ ТАБЛИЦЫ СКРИНЕРА ============
            CreateScreenerGrid();

            // ============ ПОДПИСКА НА СОБЫТИЯ ============
            ParametrsChangeByUser += CnyFuturesScreener_ParametrsChangeByUser;
            TabSimpleEndEvent += CnyFuturesScreener_TabSimpleEndEvent;

            Description = "Скринер для фьючерсов USD/CNY. " +
                         "Стратегия: пересечение EMA + RSI + Volume MA. " +
                         "Анализирует несколько инструментов и выдаёт сигналы. " +
                         "Размещается в Custom/Robots без пересборки.";
        }

        // -------------------------------------------------------------
        // СОЗДАНИЕ ТАБЛИЦЫ СКРИНЕРА
        // -------------------------------------------------------------
        private void CreateScreenerGrid()
        {
            _screenerGrid = DataGridViewEngine.GetDataGridView("ScreenerGrid", 0, 0);
            _screenerGrid.Dock = DockStyle.Fill;
            _screenerGrid.AllowUserToAddRows = false;
            _screenerGrid.AllowUserToDeleteRows = false;
            _screenerGrid.ReadOnly = true;
            _screenerGrid.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill;

            // Колонки
            _screenerGrid.Columns.Add("Security", "Инструмент");
            _screenerGrid.Columns.Add("Signal", "Сигнал");
            _screenerGrid.Columns.Add("Price", "Цена");
            _screenerGrid.Columns.Add("FastEma", "Fast EMA");
            _screenerGrid.Columns.Add("SlowEma", "Slow EMA");
            _screenerGrid.Columns.Add("Rsi", "RSI");
            _screenerGrid.Columns.Add("Volume", "Объём");
            _screenerGrid.Columns.Add("VolumeMa", "Volume MA");
            _screenerGrid.Columns.Add("Time", "Время сигнала");

            // Выравнивание
            foreach (DataGridViewColumn col in _screenerGrid.Columns)
            {
                col.HeaderCell.Style.Alignment = DataGridViewContentAlignment.MiddleCenter;
            }

            // Добавляем таблицу на панель
            this.ChildPanel.Controls.Add(_screenerGrid);
        }

        // -------------------------------------------------------------
        // ОБРАБОТЧИК ДОБАВЛЕНИЯ НОВОЙ ВКЛАДКИ
        // -------------------------------------------------------------
        private void CnyFuturesScreener_TabSimpleEndEvent(BotTabSimple tab)
        {
            if (_tabs.Contains(tab))
            {
                return;
            }

            _tabs.Add(tab);

            // Создаём индикаторы для новой вкладки
            CreateIndicatorsForTab(tab);

            // Создаём строку в таблице скринера
            ScreenerRow row = new ScreenerRow
            {
                TabName = tab.TabName,
                SecurityName = tab.Security != null ? tab.Security.Name : tab.TabName
            };
            _screenerRows.Add(row);

            // Добавляем строку в DataGridView
            int rowIndex = _screenerGrid.Rows.Add();
            _screenerGrid.Rows[rowIndex].Cells["Security"].Value = row.SecurityName;
            _screenerGrid.Rows[rowIndex].Cells["Signal"].Value = "Flat";

            // Подписываемся на событие завершения свечи
            tab.CandleFinishedEvent += (candles) => OnCandleFinished(tab, candles);

            SendNewLogMessage($"Добавлен инструмент: {row.SecurityName}", LogMessageType.System);
        }

        // -------------------------------------------------------------
        // СОЗДАНИЕ ИНДИКАТОРОВ ДЛЯ ВКЛАДКИ
        // -------------------------------------------------------------
        private void CreateIndicatorsForTab(BotTabSimple tab)
        {
            // --- Быстрая EMA ---
            Aindicator emaFast = IndicatorsFactory.CreateIndicatorByName("Ema", tab.TabName + "FastEMA", false);
            emaFast = (Aindicator)tab.CreateCandleIndicator(emaFast, "Prime");
            ((IndicatorParameterInt)emaFast.Parameters[0]).ValueInt = _fastEmaPeriod.ValueInt;
            emaFast.Save();
            _emaFastList.Add(emaFast);

            // --- Медленная EMA ---
            Aindicator emaSlow = IndicatorsFactory.CreateIndicatorByName("Ema", tab.TabName + "SlowEMA", false);
            emaSlow = (Aindicator)tab.CreateCandleIndicator(emaSlow, "Prime");
            ((IndicatorParameterInt)emaSlow.Parameters[0]).ValueInt = _slowEmaPeriod.ValueInt;
            emaSlow.Save();
            _emaSlowList.Add(emaSlow);

            // --- RSI ---
            Aindicator rsi = IndicatorsFactory.CreateIndicatorByName("RSI", tab.TabName + "RSI", false);
            rsi = (Aindicator)tab.CreateCandleIndicator(rsi, "NewArea");
            ((IndicatorParameterInt)rsi.Parameters[0]).ValueInt = _rsiPeriod.ValueInt;
            rsi.Save();
            _rsiList.Add(rsi);

            // --- Volume MA ---
            Aindicator volumeMa = IndicatorsFactory.CreateIndicatorByName("VolumeMa", tab.TabName + "VolumeMA", false);
            volumeMa = (Aindicator)tab.CreateCandleIndicator(volumeMa, "NewArea0");
            ((IndicatorParameterInt)volumeMa.Parameters[0]).ValueInt = _volumeMaPeriod.ValueInt;
            // Устанавливаем тип MA (SMA) и мультипликатор
            if (volumeMa.Parameters.Count > 1)
            {
                ((IndicatorParameterString)volumeMa.Parameters[1]).ValueString = "SMA";
                ((IndicatorParameterDecimal)volumeMa.Parameters[2]).ValueDecimal = _volumeMultiplier.ValueDecimal;
            }
            volumeMa.Save();
            _volumeMaList.Add(volumeMa);
        }

        // -------------------------------------------------------------
        // ОБРАБОТЧИК ИЗМЕНЕНИЯ ПАРАМЕТРОВ
        // -------------------------------------------------------------
        private void CnyFuturesScreener_ParametrsChangeByUser()
        {
            // Обновляем индикаторы на всех вкладках
            for (int i = 0; i < _tabs.Count; i++)
            {
                if (i < _emaFastList.Count)
                {
                    ((IndicatorParameterInt)_emaFastList[i].Parameters[0]).ValueInt = _fastEmaPeriod.ValueInt;
                    _emaFastList[i].Save();
                    _emaFastList[i].Reload();
                }

                if (i < _emaSlowList.Count)
                {
                    ((IndicatorParameterInt)_emaSlowList[i].Parameters[0]).ValueInt = _slowEmaPeriod.ValueInt;
                    _emaSlowList[i].Save();
                    _emaSlowList[i].Reload();
                }

                if (i < _rsiList.Count)
                {
                    ((IndicatorParameterInt)_rsiList[i].Parameters[0]).ValueInt = _rsiPeriod.ValueInt;
                    _rsiList[i].Save();
                    _rsiList[i].Reload();
                }

                if (i < _volumeMaList.Count)
                {
                    ((IndicatorParameterInt)_volumeMaList[i].Parameters[0]).ValueInt = _volumeMaPeriod.ValueInt;
                    if (_volumeMaList[i].Parameters.Count > 2)
                    {
                        ((IndicatorParameterDecimal)_volumeMaList[i].Parameters[2]).ValueDecimal = _volumeMultiplier.ValueDecimal;
                    }
                    _volumeMaList[i].Save();
                    _volumeMaList[i].Reload();
                }
            }
        }

        // -------------------------------------------------------------
        // ОСНОВНОЙ ОБРАБОТЧИК СВЕЧИ
        // -------------------------------------------------------------
        private void OnCandleFinished(BotTabSimple tab, List<Candle> candles)
        {
            // Если робот выключен — выходим
            if (_regime.ValueString == "Off")
            {
                return;
            }

            // Находим индекс вкладки
            int tabIndex = _tabs.IndexOf(tab);
            if (tabIndex < 0 || tabIndex >= _screenerRows.Count)
            {
                return;
            }

            // Проверяем, достаточно ли свечей
            int minPeriod = Math.Max(
                Math.Max(_fastEmaPeriod.ValueInt, _slowEmaPeriod.ValueInt),
                Math.Max(_rsiPeriod.ValueInt, _volumeMaPeriod.ValueInt)
            );

            if (candles.Count <= minPeriod + 5)
            {
                return;
            }

            // Получаем текущие значения индикаторов
            decimal prevEmaFast = _emaFastList[tabIndex].DataSeries[0].Values[_emaFastList[tabIndex].DataSeries[0].Values.Count - 2];
            decimal prevEmaSlow = _emaSlowList[tabIndex].DataSeries[0].Values[_emaSlowList[tabIndex].DataSeries[0].Values.Count - 2];
            decimal lastEmaFast = _emaFastList[tabIndex].DataSeries[0].Last;
            decimal lastEmaSlow = _emaSlowList[tabIndex].DataSeries[0].Last;
            decimal lastRsi = _rsiList[tabIndex].DataSeries[0].Last;
            decimal lastVolumeMa = _volumeMaList[tabIndex].DataSeries[0].Last;
            decimal lastVolumeMaUpper = _volumeMaList[tabIndex].DataSeries[1].Last;

            Candle lastCandle = candles[candles.Count - 1];
            decimal lastPrice = lastCandle.Close;
            decimal lastVolume = lastCandle.Volume;

            // Определяем пересечения
            bool crossUp = prevEmaFast < prevEmaSlow && lastEmaFast > lastEmaSlow;
            bool crossDown = prevEmaFast > prevEmaSlow && lastEmaFast < lastEmaSlow;

            // Обновляем данные строки
            ScreenerRow row = _screenerRows[tabIndex];
            row.Price = lastPrice;
            row.FastEma = lastEmaFast;
            row.SlowEma = lastEmaSlow;
            row.Rsi = lastRsi;
            row.Volume = lastVolume;
            row.VolumeMa = lastVolumeMa;

            // ============ ЛОГИКА СИГНАЛА ============
            string newSignal = "Flat";
            Color newColor = Color.Gray;

            // --- ЛОНГ ---
            if (crossUp &&
                lastRsi > _rsiOversold.ValueInt &&
                (!_useVolumeFilter.ValueBool || lastVolume >= lastVolumeMaUpper))
            {
                newSignal = "Long";
                newColor = Color.LimeGreen;
            }
            // --- ШОРТ ---
            else if (crossDown &&
                     lastRsi < _rsiOverbought.ValueInt &&
                     (!_useVolumeFilter.ValueBool || lastVolume >= lastVolumeMaUpper))
            {
                newSignal = "Short";
                newColor = Color.Crimson;
            }

            // Если сигнал изменился — обновляем
            if (newSignal != row.Signal)
            {
                row.Signal = newSignal;
                row.SignalColor = newColor;
                row.SignalTime = DateTime.Now;

                // Логируем смену сигнала
                if (newSignal != "Flat")
                {
                    SendNewLogMessage(
                        $"=== СИГНАЛ {newSignal.ToUpper()} === | " +
                        $"Инструмент: {row.SecurityName} | " +
                        $"Цена: {lastPrice} | " +
                        $"RSI: {lastRsi:F2} | " +
                        $"Объём: {lastVolume} | " +
                        $"Volume MA Upper: {lastVolumeMaUpper:F0}",
                        LogMessageType.System);
                }
            }

            // Обновляем таблицу
            UpdateScreenerGridRow(tabIndex, row);
        }

        // -------------------------------------------------------------
        // ОБНОВЛЕНИЕ СТРОКИ ТАБЛИЦЫ
        // -------------------------------------------------------------
        private void UpdateScreenerGridRow(int rowIndex, ScreenerRow row)
        {
            if (InvokeRequired)
            {
                Invoke(new Action<int, ScreenerRow>(UpdateScreenerGridRow), rowIndex, row);
                return;
            }

            if (rowIndex >= _screenerGrid.Rows.Count)
            {
                return;
            }

            DataGridViewRow gridRow = _screenerGrid.Rows[rowIndex];

            gridRow.Cells["Security"].Value = row.SecurityName;
            gridRow.Cells["Signal"].Value = row.Signal;
            gridRow.Cells["Price"].Value = row.Price.ToString("F4");
            gridRow.Cells["FastEma"].Value = row.FastEma.ToString("F4");
            gridRow.Cells["SlowEma"].Value = row.SlowEma.ToString("F4");
            gridRow.Cells["Rsi"].Value = row.Rsi.ToString("F2");
            gridRow.Cells["Volume"].Value = row.Volume.ToString("N0");
            gridRow.Cells["VolumeMa"].Value = row.VolumeMa.ToString("N0");
            gridRow.Cells["Time"].Value = row.SignalTime.ToString("HH:mm:ss");

            // Раскраска строки по сигналу
            gridRow.DefaultCellStyle.BackColor = row.SignalColor;
            gridRow.DefaultCellStyle.ForeColor = row.Signal == "Flat" ? Color.Black : Color.White;

            // Выделение жирным при активном сигнале
            if (row.Signal != "Flat")
            {
                gridRow.DefaultCellStyle.Font = new Font(_screenerGrid.Font, FontStyle.Bold);
            }
            else
            {
                gridRow.DefaultCellStyle.Font = new Font(_screenerGrid.Font, FontStyle.Regular);
            }
        }

        // -------------------------------------------------------------
        // ИМЯ СТРАТЕГИИ
        // -------------------------------------------------------------
        public override string GetNameStrategyType()
        {
            return "CnyFuturesScreener";
        }

        public override void ShowIndividualSettingsDialog()
        {
        }

        // -------------------------------------------------------------
        // ДЕСТРУКТОР / ОЧИСТКА
        // -------------------------------------------------------------
        public void Delete()
        {
            // Отписываемся от событий
            foreach (var tab in _tabs)
            {
                tab.CandleFinishedEvent -= (candles) => OnCandleFinished(tab, candles);
            }

            ParametrsChangeByUser -= CnyFuturesScreener_ParametrsChangeByUser;
            TabSimpleEndEvent -= CnyFuturesScreener_TabSimpleEndEvent;

            base.Delete();
        }
    }
}
