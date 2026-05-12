/*
 * Your rights to use code governed by this license https://github.com/AlexWan/OsEngine/blob/master/LICENSE
 * Ваши права на использование кода регулируются данной лицензией http://o-s-a.net/doc/license_simple_engine.pdf
*/

using System;
using System.Collections.Generic;
using OsEngine.Entity;
using OsEngine.Indicators;
using OsEngine.Logging;
using OsEngine.Market;
using OsEngine.Market.Servers;
using OsEngine.OsTrader.Panels;
using OsEngine.OsTrader.Panels.Tab;

/* Description
Скринер: пересечение двух SMA (быстрой и медленной) по каждой бумаге из списка.

Золотой крест: закрыть шорты по инструменту, открыть лонг (если лонга ещё нет).
Мёртвый крест: закрыть лонги, открыть шорт (если шорта ещё нет).

Сигнал на закрытии свечи; индикаторы [0] и [1] на вкладке — быстрая и медленная SMA.
*/

namespace OsEngine.Robots.Custom
{
    public class SmaCross : BotPanel
    {
        private BotTabScreener _screenerTab;

        private StrategyParameterString _regime;
        private StrategyParameterInt _slippage;
        private StrategyParameterInt _maxPoses;

        private StrategyParameterString _volumeType;
        private StrategyParameterDecimal _volume;
        private StrategyParameterString _tradeAssetInPortfolio;

        private StrategyParameterInt _fastLength;
        private StrategyParameterInt _slowLength;

        public SmaCross(string name, StartProgram startProgram)
            : base(name, startProgram)
        {
            TabCreate(BotTabType.Screener);
            _screenerTab = TabsScreener[0];

            _regime = CreateParameter("Regime", "Off",
                new[] { "Off", "On", "OnlyLong", "OnlyShort", "OnlyClosePosition" });
            _slippage = CreateParameter("Slippage", 0, 0, 20, 1);
            _maxPoses = CreateParameter("Max positions (all tabs)", 20, 0, 200, 1);

            _volumeType = CreateParameter("Volume type", "Deposit percent",
                new[] { "Contracts", "Contract currency", "Deposit percent" });
            _volume = CreateParameter("Volume", 20, 1.0m, 50, 4);
            _tradeAssetInPortfolio = CreateParameter("Asset in portfolio", "Prime");

            _fastLength = CreateParameter("SMA fast period", 9, 2, 200, 1);
            _slowLength = CreateParameter("SMA slow period", 21, 2, 500, 1);

            _screenerTab.CreateCandleIndicator(1, "Sma",
                new List<string> { _fastLength.ValueInt.ToString(), "Close" }, "Prime");
            _screenerTab.CreateCandleIndicator(2, "Sma",
                new List<string> { _slowLength.ValueInt.ToString(), "Close" }, "Prime");

            ParametrsChangeByUser += SmaCross_ParametrsChangeByUser;
            _screenerTab.CandleFinishedEvent += ScreenerTab_CandleFinishedEvent;

            Description = "SMA Cross (скринер) — пересечение быстрой и медленной SMA по бумагам списка.";
        }

        private void SmaCross_ParametrsChangeByUser()
        {
            IndicatorOnTabs fastInd = _screenerTab._indicators.Find(ind => ind.Num == 1);
            IndicatorOnTabs slowInd = _screenerTab._indicators.Find(ind => ind.Num == 2);

            if (fastInd != null)
            {
                fastInd.Parameters = new List<string> { _fastLength.ValueInt.ToString(), "Close" };
            }

            if (slowInd != null)
            {
                slowInd.Parameters = new List<string> { _slowLength.ValueInt.ToString(), "Close" };
            }

            _screenerTab.UpdateIndicatorsParameters();
        }

        public override string GetNameStrategyType()
        {
            return "SmaCross";
        }

        public override void ShowIndividualSettingsDialog()
        {
        }

        private void ScreenerTab_CandleFinishedEvent(List<Candle> candles, BotTabSimple tab)
        {
            if (_regime.ValueString == "Off")
            {
                return;
            }

            int needBars = Math.Max(_fastLength.ValueInt, _slowLength.ValueInt) + 2;
            if (candles.Count < needBars)
            {
                return;
            }

            if (tab.Indicators.Count < 2)
            {
                return;
            }

            var smaFast = (Aindicator)tab.Indicators[0];
            var smaSlow = (Aindicator)tab.Indicators[1];

            if (smaFast.DataSeries[0].Values == null || smaSlow.DataSeries[0].Values == null)
            {
                return;
            }

            List<decimal> fastVals = smaFast.DataSeries[0].Values;
            List<decimal> slowVals = smaSlow.DataSeries[0].Values;

            if (fastVals.Count < 2 || slowVals.Count < 2)
            {
                return;
            }

            decimal prevFast = fastVals[fastVals.Count - 2];
            decimal currFast = fastVals[fastVals.Count - 1];
            decimal prevSlow = slowVals[slowVals.Count - 2];
            decimal currSlow = slowVals[slowVals.Count - 1];

            if (prevFast == 0 || currFast == 0 || prevSlow == 0 || currSlow == 0)
            {
                return;
            }

            bool goldenCross = prevFast <= prevSlow && currFast > currSlow;
            bool deathCross = prevFast >= prevSlow && currFast < currSlow;

            if (!goldenCross && !deathCross)
            {
                return;
            }

            decimal lastPrice = candles[candles.Count - 1].Close;
            decimal slip = _slippage.ValueInt * tab.Security.PriceStep;
            List<Position> openPositions = tab.PositionsOpenAll;

            if (goldenCross)
            {
                bool hadLong = false;
                if (openPositions != null)
                {
                    for (int i = 0; i < openPositions.Count; i++)
                    {
                        Position p = openPositions[i];
                        if (p.State != PositionStateType.Open)
                        {
                            continue;
                        }

                        if (p.Direction == Side.Buy)
                        {
                            hadLong = true;
                        }

                        if (p.Direction == Side.Sell)
                        {
                            tab.CloseAtLimit(p, lastPrice + slip, p.OpenVolume);
                        }
                    }
                }

                if (_regime.ValueString == "OnlyClosePosition" || _regime.ValueString == "OnlyShort")
                {
                    return;
                }

                if (hadLong)
                {
                    return;
                }

                if (PositionsCount >= _maxPoses.ValueInt)
                {
                    return;
                }

                tab.BuyAtLimit(GetVolume(tab), lastPrice + slip);
            }
            else if (deathCross)
            {
                bool hadShort = false;
                if (openPositions != null)
                {
                    for (int i = 0; i < openPositions.Count; i++)
                    {
                        Position p = openPositions[i];
                        if (p.State != PositionStateType.Open)
                        {
                            continue;
                        }

                        if (p.Direction == Side.Sell)
                        {
                            hadShort = true;
                        }

                        if (p.Direction == Side.Buy)
                        {
                            tab.CloseAtLimit(p, lastPrice - slip, p.OpenVolume);
                        }
                    }
                }

                if (_regime.ValueString == "OnlyClosePosition" || _regime.ValueString == "OnlyLong")
                {
                    return;
                }

                if (hadShort)
                {
                    return;
                }

                if (PositionsCount >= _maxPoses.ValueInt)
                {
                    return;
                }

                tab.SellAtLimit(GetVolume(tab), lastPrice - slip);
            }
        }

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
                    SendNewLogMessage("Can`t found portfolio " + _tradeAssetInPortfolio.ValueString,
                        LogMessageType.Error);
                    return 0;
                }

                decimal moneyOnPosition = portfolioPrimeAsset * (_volume.ValueDecimal / 100);

                decimal qty = moneyOnPosition / tab.PriceBestAsk / tab.Security.Lot;

                if (tab.StartProgram == StartProgram.IsOsTrader)
                {
                    if (tab.Security.UsePriceStepCostToCalculateVolume
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
