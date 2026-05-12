/*
 * Your rights to use code governed by this license https://github.com/AlexWan/OsEngine/blob/master/LICENSE
 * Ваши права на использование кода регулируются данной лицензией http://o-s-a.net/doc/license_simple_engine.pdf
*/

using System;
using System.Collections.Generic;
using OsEngine.Entity;
using OsEngine.Market.Servers;
using OsEngine.Market;
using OsEngine.OsTrader.Panels;
using OsEngine.OsTrader.Panels.Attributes;
using OsEngine.OsTrader.Panels.Tab;
using OsEngine.Indicators;
using OsEngine.Language;

/* Description
Trading robot for osEngine

The trend robot-screener on Adaptive Price Channel and Volatility group.

Buy:
1. The candle closed above the upper line of the Price Channel
2. Filter by volatility groups. All screener papers are divided into 3 groups. One of them is traded.

Exit for long: When the Price Channel bottom line is broken

*/
/*
Скальпер (проект)
1-5 минутки
Волатильность 3
Идеи:
 * Индикатор дискретного изменения (шаг - две комиссии) 0 - менее 1\-1 более (абс велич). Послед-ть изменений 010-10-1-11
   Предсказать в нем паттерн -11 для покупки или 1-1 для продажи

*/

namespace OsEngine.Robots.AlgoStart
{
    [Bot("RZsclp")]
    public class RZsclp : BotPanel
    {
        private BotTabScreener _screenerTab;

        // Basic settings
        private StrategyParameterString _regime;
        private StrategyParameterInt _icebergCount;
        private StrategyParameterInt _maxPositions;
        private StrategyParameterInt _clusterToTrade;
        private StrategyParameterInt _clustersLookBack;
        private StrategyParameterButton _clusterShowLast;

        // GetVolume settings
        private StrategyParameterString _volumeType;
        private StrategyParameterDecimal _volume;
        private StrategyParameterString _tradeAssetInPortfolio;

        // Indicator settings
        private StrategyParameterInt _pcAdxLength;
        private StrategyParameterInt _pcRatio;
        private StrategyParameterBool _smaFilterIsOn;
        private StrategyParameterInt _smaFilterLen;

        // Trade periods
        private NonTradePeriods _tradePeriodsSettings;
        private StrategyParameterButton _tradePeriodsShowDialogButton;

        //new cclp settings
         private StrategyParameterString _buySellMode;
        private StrategyParameterDecimal _widthPcCorridorPercent;//Ширина ценового коридора       
        private StrategyParameterDecimal _porogPercentPcCorridor; //позиции открываем не доходя до ценового канала на этот процент
        private StrategyParameterString _openType; //OpenIsВuy- контртренд  OpenIsSell - тренд
        private StrategyParameterString _logicType; //для возможности инверсировать логику
        //параметры индикатора линейной регрессии
        private StrategyParameterInt _lrLength;
        private StrategyParameterDecimal _lrDeviation;

        // Volatility clusters
        private VolatilityStageClusters _volatilityStageClusters = new VolatilityStageClusters();
        private DateTime _lastTimeSetClusters;

        public RZsclp(string name, StartProgram startProgram) : base(name, startProgram)
        {
            // non trade periods
            _tradePeriodsSettings = new NonTradePeriods(name);

            _tradePeriodsSettings.NonTradePeriodGeneral.NonTradePeriod1Start = new TimeOfDay() { Hour = 0, Minute = 0 };
            _tradePeriodsSettings.NonTradePeriodGeneral.NonTradePeriod1End = new TimeOfDay() { Hour = 10, Minute = 05 };
            _tradePeriodsSettings.NonTradePeriodGeneral.NonTradePeriod1OnOff = true;

            _tradePeriodsSettings.NonTradePeriodGeneral.NonTradePeriod2Start = new TimeOfDay() { Hour = 13, Minute = 54 };
            _tradePeriodsSettings.NonTradePeriodGeneral.NonTradePeriod2End = new TimeOfDay() { Hour = 14, Minute = 6 };
            _tradePeriodsSettings.NonTradePeriodGeneral.NonTradePeriod2OnOff = false;

            _tradePeriodsSettings.NonTradePeriodGeneral.NonTradePeriod3Start = new TimeOfDay() { Hour = 18, Minute = 1 };
            _tradePeriodsSettings.NonTradePeriodGeneral.NonTradePeriod3End = new TimeOfDay() { Hour = 23, Minute = 58 };
            _tradePeriodsSettings.NonTradePeriodGeneral.NonTradePeriod3OnOff = true;

            _tradePeriodsSettings.TradeInSunday = false;
            _tradePeriodsSettings.TradeInSaturday = false;

            _tradePeriodsSettings.Load();

            // Source creation
            TabCreate(BotTabType.Screener);
            _screenerTab = TabsScreener[0];

            // Subscribe to the candle finished event
            _screenerTab.CandleFinishedEvent += _screenerTab_CandleFinishedEvent;

            // Basic settings
            _regime = CreateParameter("Regime", "Off", new[] { "Off", "On" });
            _icebergCount = CreateParameter("Iceberg orders count", 1, 1, 3, 1);
            _clusterToTrade = CreateParameter("Volatility cluster to trade", 3, 1, 3, 1); //! 2->3
            _clustersLookBack = CreateParameter("Volatility cluster lookBack", 100, 10, 300, 1);
            _clusterShowLast = CreateParameterButton("Show last clusters");
            _clusterShowLast.UserClickOnButtonEvent += _clusterShowLast_UserClickOnButtonEvent;
            _maxPositions = CreateParameter("Max poses", 10, 1, 20, 1);
            _tradePeriodsShowDialogButton = CreateParameterButton("Non trade periods");
            _tradePeriodsShowDialogButton.UserClickOnButtonEvent += _tradePeriodsShowDialogButton_UserClickOnButtonEvent;

            // GetVolume settings
            _volumeType = CreateParameter("Volume type", "Deposit percent", new[] { "Contracts", "Contract currency", "Deposit percent" });
            _volume = CreateParameter("Volume", 10, 1.0m, 50, 4);
            _tradeAssetInPortfolio = CreateParameter("Asset in portfolio", "Prime");

            // Indicator settings
            _pcAdxLength = CreateParameter("Pc adx length", 50, 5, 300, 1);
            _pcRatio = CreateParameter("Pc ratio", 840, 5, 2000, 1);
            _smaFilterIsOn = CreateParameter("Sma filter is on", false); //! true -> false
            _smaFilterLen = CreateParameter("Sma filter Len", 70, 100, 300, 10);

            //new cclp settings
            _buySellMode = CreateParameter("Buysell mode", "OnlyBuy", new[] { "OnlyBuy", "OnlySell", "BuyAndSell" });
            _widthPcCorridorPercent = CreateParameter("Ширина ценового коридора, процент", 1.4m, 1.00m, 50, 4);
            _porogPercentPcCorridor = CreateParameter("Не доходить до границ ценового коридора (для контртренда), процент", 0.03m, 1.00m, 50, 4);
            _logicType = CreateParameter("Buy - стандартная логика, Sell - инверсия логики", "OpenIsBuy", new[] { "OpenIsBuy", "OpenIsSell" });
            _openType = CreateParameter("Тренд - контртренд", "Trend", new[] { "Trend", "ContrTrend" });

            // Create indicator PriceChannelAdaptive
            _screenerTab.CreateCandleIndicator(2,
                "PriceChannelAdaptive",
                new List<string>() { _pcAdxLength.ValueInt.ToString(), _pcRatio.ValueInt.ToString() },
                "Prime");

            // Create indicator LinearRegressionChannelFast_Indicator
            _lrLength = CreateParameter("Linear regression Length", 180, 20, 300, 10);
            _lrDeviation = CreateParameter("Linear regression deviation", 4.4m, 1, 4, 0.1m);
            _screenerTab.CreateCandleIndicator(1, "LinearRegressionChannelFast_Indicator", new List<string>() { _lrLength.ValueInt.ToString(), "Close", _lrDeviation.ValueDecimal.ToString(), _lrDeviation.ValueDecimal.ToString() }, "Prime");

            // Subscribe to the indicator update event
            ParametrsChangeByUser += SmaScreener_ParametrsChangeByUser;

            Description = OsLocalization.Description.DescriptionLabel326;
            DeleteEvent += AlgoStart3ScreenerPriceChannel_DeleteEvent;
        }

        private void SmaScreener_ParametrsChangeByUser()
        {
            _screenerTab._indicators[0].Parameters = new List<string>() { _pcAdxLength.ValueInt.ToString(), _pcRatio.ValueInt.ToString() };
            _screenerTab.UpdateIndicatorsParameters();
        }

        private void AlgoStart3ScreenerPriceChannel_DeleteEvent()
        {
            _tradePeriodsSettings.Delete();
        }

        private void _tradePeriodsShowDialogButton_UserClickOnButtonEvent()
        {
            _tradePeriodsSettings.ShowDialog();
        }

        private void _clusterShowLast_UserClickOnButtonEvent()
        {
            try
            {
                string message = "Volatility clusters. Bot " + this.NameStrategyUniq + "\n";

                message += "Cluster 1... ";
                for (int i = 0; i < _volatilityStageClusters.ClusterOne.Count; i++)
                {
                    message += _volatilityStageClusters.ClusterOne[i].Connector.SecurityName + " | ";
                }
                message += "\n";

                message += "Cluster 2... ";
                for (int i = 0; i < _volatilityStageClusters.ClusterTwo.Count; i++)
                {
                    message += _volatilityStageClusters.ClusterTwo[i].Connector.SecurityName + " | ";
                }
                message += "\n";

                message += "Cluster 3... ";
                for (int i = 0; i < _volatilityStageClusters.ClusterThree.Count; i++)
                {
                    message += _volatilityStageClusters.ClusterThree[i].Connector.SecurityName + " | ";
                }

                SendNewLogMessage(message, Logging.LogMessageType.Error);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), Logging.LogMessageType.Error);
            }
        }

        // Logic
        private void _screenerTab_CandleFinishedEvent(List<Candle> candles, BotTabSimple tab)
        {
            // 1 If there is a position, then we close the trailing stop

            // 2 There is no pose. Open long if the last N candles we were above the moving average

            if (_regime.ValueString == "Off")
            {
                return;
            }

            if (candles.Count < 50)
            {
                return;
            }

            if (_tradePeriodsSettings.CanTradeThisTime(candles[^1].TimeStart) == false)
            {
                return;
            }

            List<Position> openPositions = tab.PositionsOpenAll;

            if (openPositions.Count == 0 
                && _clusterToTrade.ValueInt != 0)
            {
                if (_lastTimeSetClusters == DateTime.MinValue
                 || _lastTimeSetClusters != candles[^1].TimeStart)
                {
                    _volatilityStageClusters.Calculate(_screenerTab.Tabs, _clustersLookBack.ValueInt);
                    _lastTimeSetClusters = candles[^1].TimeStart;
                }

                if (_clusterToTrade.ValueInt == 1)
                {
                    if (_volatilityStageClusters.ClusterOne.Find(source => source.Connector.SecurityName == tab.Connector.SecurityName) == null)
                    {
                        return;
                    }
                }
                else if (_clusterToTrade.ValueInt == 2)
                {
                    if (_volatilityStageClusters.ClusterTwo.Find(source => source.Connector.SecurityName == tab.Connector.SecurityName) == null)
                    {
                        return;
                    }
                }
                else if (_clusterToTrade.ValueInt == 3)
                {
                    if (_volatilityStageClusters.ClusterThree.Find(source => source.Connector.SecurityName == tab.Connector.SecurityName) == null)
                    {
                        return;
                    }
                }
                else
                {
                    return;
                }
            }

            List<Position> positions = tab.PositionsOpenAll;
            
            //new analogues long bot
            Aindicator lrIndicator = (Aindicator)tab.Indicators[1];
            decimal lrUp = lrIndicator.DataSeries[0].Values[^1];
            decimal lrDown = lrIndicator.DataSeries[2].Values[^1];

            if (positions.Count == 0) // Open position logic
            {
                int allPosesInAllTabs = this.PositionsCount;

                if (allPosesInAllTabs >= _maxPositions.ValueInt)
                {
                    return;
                }

                Aindicator priceChannel = (Aindicator)tab.Indicators[0];

                decimal pcUp = priceChannel.DataSeries[0].Values[priceChannel.DataSeries[0].Values.Count - 2];
                decimal pcDown = priceChannel.DataSeries[1].Values[^2];
                if ((pcDown == 0) || (pcUp == 0))//if (pcUp == 0)
                {
                    return;
                }

                if (Math.Abs((pcUp - pcDown) * 100m / pcUp) < _widthPcCorridorPercent.ValueDecimal) return;
                
                decimal candleClose = candles[candles.Count - 1].Close;

                if ( !(candleClose > lrUp)) return; //фильтр по лин регресии

                if (((_buySellMode.ValueString == "OnlyBuy") || (_buySellMode.ValueString == "BuyAndSell") ) &&
                   ((candleClose <= pcDown * (1m + _porogPercentPcCorridor.ValueDecimal)) && (_openType.ValueString == "ContrTrend")
                    ||
                    (candleClose > pcUp) && (_openType.ValueString == "Trend") && bigChangesPrevails(candles ,20, 5)
                     )
                )
                {

                    if (_smaFilterIsOn.ValueBool == true)
                    {
                        decimal smaValue = Sma(candles, _smaFilterLen.ValueInt, candles.Count - 1);
                        decimal smaPrev = Sma(candles, _smaFilterLen.ValueInt, candles.Count - 2);

                        if (smaValue < smaPrev)
                        {
                            return;
                        }
                    }
                    if (_logicType.ValueString == "OpenIsBuy")
                      tab.BuyAtIcebergMarket(GetVolume(tab), _icebergCount.ValueInt, 1000);
                    else  
                      tab.SellAtIcebergMarket(GetVolume(tab), _icebergCount.ValueInt, 1000);

                }
                //sell
                if (((_buySellMode.ValueString == "OnlySell") || (_buySellMode.ValueString == "BuyAndSell") ) &&
                   ((candleClose > pcUp * (1m - _porogPercentPcCorridor.ValueDecimal)) && (_openType.ValueString == "ContrTrend")
                    ||
                    (candleClose < pcDown) && (_openType.ValueString == "Trend") && bigChangesPrevails(candles ,20, 5, "red") 
                     )
                )
                {   
                    if ( !(candleClose < lrDown)) return; //фильтр по лин регресии

                    if (_smaFilterIsOn.ValueBool == true)
                    {
                        decimal smaValue = Sma(candles, _smaFilterLen.ValueInt, candles.Count - 1);
                        decimal smaPrev = Sma(candles, _smaFilterLen.ValueInt, candles.Count - 2);

                        if (smaValue < smaPrev)
                        {
                            return;
                        }
                    }
                    if (_logicType.ValueString == "OpenIsBuy")
                      tab.SellAtIcebergMarket(GetVolume(tab), _icebergCount.ValueInt, 1000);
                    else
                      tab.BuyAtIcebergMarket(GetVolume(tab), _icebergCount.ValueInt, 1000);  

                }
            }
            else // Close logic
            {
                Position pos = positions[0];

                if (StartProgram == StartProgram.IsTester
                    || StartProgram == StartProgram.IsOsOptimizer)
                {
                    if (pos.State != PositionStateType.Open)
                    {
                        return;
                    }
                }

                Aindicator priceChannel = (Aindicator)tab.Indicators[0];

                decimal pcDown = priceChannel.DataSeries[1].Values[^2];
                decimal pcUp = priceChannel.DataSeries[0].Values[priceChannel.DataSeries[0].Values.Count - 2];//
                if ((pcDown == 0) || (pcUp == 0))
                {
                    return;
                }

                //! if (Math.Abs((pcUp - pcDown) * 100m / pcUp) < _widthPcCorridorPercent.ValueDecimal) return;

                decimal lastClose = candles[^1].Close;

                if ( !(lastClose < lrDown)) return; //фильтр по лин регресии
//!!!!!!!!!!!!  todo Просто SL и TP
                if((lastClose > pcUp * (1m - _porogPercentPcCorridor.ValueDecimal))  && (_openType.ValueString == "ContrTrend")
                   ||
                   (lastClose <= pcDown)  && (_openType.ValueString == "Trend")
                   )
                {
                    tab.CloseAtIcebergMarket(pos,pos.OpenVolume,_icebergCount.ValueInt,1000);
                }
            }
        }

        // Method for calculating Sma
        private decimal Sma(List<Candle> candles, int len, int index)
        {
            if (candles.Count == 0
                || index >= candles.Count
                || index <= 0)
            {
                return 0;
            }

            decimal summ = 0;

            int countPoints = 0;

            for (int i = index; i >= 0 && i > index - len; i--)
            {
                countPoints++;
                summ += candles[i].Close;
            }

            if (countPoints == 0)
            {
                return 0;
            }

            return summ / countPoints;
        }

        // Method for calculating the volume of entry into a position

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
                else // Tester or Optimizer
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
                    SendNewLogMessage("Can`t found portfolio " + _tradeAssetInPortfolio.ValueString, Logging.LogMessageType.Error);
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
                    {// расчёт количества контрактов для фьючерсов и опционов на Мосбирже
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

        //--------------------------------------------------------
        private int candleCounts(List<Candle> candles, string sсolor = "green", int countBack = 20, int step = 1) //new выдает кол-во красных или зеленых свечей за countBack назад 
        { int ret = 0;
            if (candles.Count > (countBack + 1))
                for (int i = 1; i < countBack; i+= step)
                if (
                    ((candles[candles.Count - i].Open > candles[candles.Count - i].Close) && (sсolor == "red"))
                    ||
                    ((candles[candles.Count - i].Open < candles[candles.Count - i].Close) && (sсolor == "green"))
                ) ret++; //else ret--;
          return ret;
        }

        private bool candlesPrevails(List<Candle> candles, int countBack, int porog, string wwhatMustBeMore = "green") //new выдает кол-во красных или зеленых свечей за countBack назад 
        { //opt  20   3
        bool ret = true;
        string whatMustBeLess = (( wwhatMustBeMore == "green") ? "red" : "green");
        int tfStep = 1;//! уходим от .._seniorStep;// 1;
        ret = (decimal)candleCounts(candles, wwhatMustBeMore, countBack, tfStep) > (decimal)candleCounts(candles, whatMustBeLess, countBack, tfStep) + (decimal)porog/(decimal)tfStep;
        if (!ret) return ret;
        //(candles[candles.Count - 1].Close < candles[candles.Count -  countBack].Close);// >!! на всех и с 10.2021 - непроливайка 200% ret;
        //вообще 4 типа <>  * b-s

        tfStep = 2;
        ret = (decimal)candleCounts(candles, wwhatMustBeMore, countBack, tfStep) > (decimal)candleCounts(candles, whatMustBeLess, countBack, tfStep) + (decimal)porog/(decimal)tfStep;
        if (!ret) return ret;
        //
        /*
        tfStep = 4;
        ret = (decimal)candleCounts(candles, wwhatMustBeMore, countBack, tfStep) > (decimal)candleCounts(candles, whatMustBeLess, countBack, tfStep) + (decimal)porog/(decimal)tfStep;
        if (!ret) return ret;
        */
        /**/
        // tfStep = 8;
        // ret = (decimal)candleCounts(candles, wwhatMustBeMore, countBack, tfStep) > (decimal)candleCounts(candles, whatMustBeLess, countBack, tfStep) + (decimal)porog/(decimal)tfStep;
        // if (!ret) return ret;
        
        //tfStep = 10;
        //ret = (decimal)candleCounts(candles, wwhatMustBeMore, countBack, tfStep) > (decimal)candleCounts(candles, whatMustBeLess, countBack, tfStep) + (decimal)porog/(decimal)tfStep;
        //if (!ret) return ret;
        //
        return ret;
        }

        //------------------
        //кол-во  свечейпредыдущая средняя цена <-> (green-red) следующей более 0,1% (в настройки!)
        private int bigChangesCount(List<Candle> candles, string sсolor = "green", int countBack = 20, int step = 1) 
        {   
            int ret = 0;
            decimal nPercPorog = 0.04m;
            if (candles.Count > (countBack + 1))
                for (int i = 1; i < countBack; i+= step){
                    if ((candles.Count - i -  step) < 0) continue;
                    decimal delta = 1m -
                                     ((candles[candles.Count - i - step].Close + candles[candles.Count - i -  step].Open) / 2m) 
                                      / ((candles[candles.Count - i].Close + candles[candles.Count - i].Open + 0.00001m)/2m)
                                    ;
                    if (
                        ((delta > (nPercPorog / 100m)) && (sсolor == "green"))
                        ||
                        ((delta < -(nPercPorog / 100m)) && (sсolor == "red"))
                    ) ret++; //else ret--;
                }       
          return ret;
        }

        private bool bigChangesPrevails(List<Candle> candles, int countBack, int porog, string whatMustBeMore = "green") 
            { //opt  20   3
            bool ret = true;
            string whatMustBeLess = (( whatMustBeMore == "green") ? "red" : "green");
            int tfStep = 1;//! уходим от .._seniorStep;// 1;
            ret = (decimal)bigChangesCount(candles, whatMustBeMore, countBack, tfStep) > (decimal)bigChangesCount(candles, whatMustBeLess, countBack, tfStep) + (decimal)porog/(decimal)tfStep;
            if (!ret) return ret;
            //(candles[candles.Count - 1].Close < candles[candles.Count -  countBack].Close);// >!! на всех и с 10.2021 - непроливайка 200% ret;
            //вообще 4 типа <>  * b-s

            tfStep = 2;
            ret = (decimal)bigChangesCount(candles, whatMustBeMore, countBack, tfStep) > (decimal)bigChangesCount(candles, whatMustBeLess, countBack, tfStep) + (decimal)porog/(decimal)tfStep;
            if (!ret) return ret;
            //
            
            //tfStep = 4;
            //ret = (decimal)bigChangesCount(candles, whatMustBeMore, countBack, tfStep) > (decimal)bigChangesCount(candles, whatMustBeLess, countBack, tfStep) + (decimal)porog/(decimal)tfStep;
           // if (!ret) return ret;

            return ret;
        }
        
    }
}