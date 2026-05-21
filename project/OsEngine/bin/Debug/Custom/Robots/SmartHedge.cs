/*
 * Your rights to use code governed by this license https://github.com/AlexWan/OsEngine/blob/master/LICENSE
 * Ваши права на использование кода регулируются данной лицензией http://o-s-a.net/doc/license_simple_engine.pdf
*/

using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Threading;
using OsEngine.Candles;
using OsEngine.Candles.Factory;
using OsEngine.Candles.Series;
using OsEngine.Entity;
using OsEngine.Logging;
using OsEngine.Market;
using OsEngine.Market.Connectors;
using OsEngine.Market.Servers;
using OsEngine.OsTrader.Panels;
using OsEngine.OsTrader.Panels.Attributes;
using OsEngine.OsTrader.Panels.Tab;

/*
 * Смарт Хедж — ручной календарный хедж фьючерсов MOEX (только кнопки, без автосигналов).
 * Префиксы и подбор — как в TrendMultiIndicatorScreener.
 */

namespace OsEngine.Robots.Custom
{
    [Bot("SmartHedge")]
    public class SmartHedge : BotPanel
    {
        private const string DefaultMoexFuturesTickerPrefixes =
            "Si,USDRUBF,Eu,EURRUBF,CNY,MX,MM,IMOEXF,RI,BR,BRM,CL,NG,NGM,GD,GLDRUBF,SV,PT,PD,CU,SR,GZ,LK,RN,NK,GN,TT,VB,SN,SG,RL";

        private static readonly Dictionary<string, string[]> MoexFuturesPrefixAliases =
            new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase)
            {
                { "CNY", new[] { "CR" } },
                { "UCNY", new[] { "CR" } },
            };

        private BotTabScreener _screenerTab;

        private StrategyParameterString _futuresPrefixes;
        private StrategyParameterButton _moexFuturesResetPrefixesButton;
        private StrategyParameterButton _loadFuturesButton;
        private StrategyParameterButton _buyPairButton;
        private StrategyParameterButton _adjustPairButton;
        private StrategyParameterButton _sellAllButton;

        private StrategyParameterString _volumeType;
        private StrategyParameterDecimal _volume;
        private StrategyParameterString _tradeAssetInPortfolio;

        private readonly List<HedgePairState> _hedgePairs = new List<HedgePairState>();

        public SmartHedge(string name, StartProgram startProgram)
            : base(name, startProgram)
        {
            TabCreate(BotTabType.Screener);
            _screenerTab = TabsScreener[0];
            RemoveCorruptScreenerTabSetFileIfNeeded();

            const string moexTab = "MOEX фьючерсы";
            const string tradeTab = "Торговля";

            _futuresPrefixes = CreateParameter(
                "Префиксы корня тикера фьючерса",
                DefaultMoexFuturesTickerPrefixes,
                moexTab);
            _moexFuturesResetPrefixesButton = CreateParameterButton(
                "Установить префиксы фьючерсов по умолчанию",
                moexTab);
            _moexFuturesResetPrefixesButton.UserClickOnButtonEvent += MoexFuturesResetPrefixesButton_UserClickOnButtonEvent;
            _loadFuturesButton = CreateParameterButton("Подобрать фьючерсы", moexTab);
            _loadFuturesButton.UserClickOnButtonEvent += LoadFuturesButton_UserClickOnButtonEvent;

            _buyPairButton = CreateParameterButton("Купить пару", tradeTab);
            _buyPairButton.UserClickOnButtonEvent += BuyPairButton_UserClickOnButtonEvent;
            _adjustPairButton = CreateParameterButton("Скорректировать пару", tradeTab);
            _adjustPairButton.UserClickOnButtonEvent += AdjustPairButton_UserClickOnButtonEvent;
            _sellAllButton = CreateParameterButton("Продать всё", tradeTab);
            _sellAllButton.UserClickOnButtonEvent += SellAllButton_UserClickOnButtonEvent;

            _volumeType = CreateParameter("Volume type", "Contracts", new[] { "Contracts", "Contract currency", "Deposit percent" });
            _volume = CreateParameter("Volume", 1, 1m, 500m, 1m);
            _tradeAssetInPortfolio = CreateParameter("Asset in portfolio", "Prime");

            Description = "Смарт Хедж: календарный хедж фьючерсов MOEX только по кнопкам.";
        }

        public override string GetNameStrategyType()
        {
            return "SmartHedge";
        }

        public override void ShowIndividualSettingsDialog()
        {
        }

        private void MoexFuturesResetPrefixesButton_UserClickOnButtonEvent()
        {
            _futuresPrefixes.ValueString = DefaultMoexFuturesTickerPrefixes;
            RepaintParameterGuiTables();
            SendNewLogMessage(
                "Префиксы корня фьючерсов установлены по умолчанию (подбор бумаг не выполнялся).",
                LogMessageType.System);
        }

        private void RepaintParameterGuiTables()
        {
            if (ParamGuiSettings != null)
            {
                ParamGuiSettings.RePaintParameterTables();
            }
        }

        private void LoadFuturesButton_UserClickOnButtonEvent()
        {
            try
            {
                LoadNearestFuturesPairsIntoScreener();
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        private void BuyPairButton_UserClickOnButtonEvent()
        {
            try
            {
                ExecuteBuyPairs();
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        private void AdjustPairButton_UserClickOnButtonEvent()
        {
            try
            {
                ExecuteAdjustPairs();
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        private void SellAllButton_UserClickOnButtonEvent()
        {
            try
            {
                CloseAllScreenerPositions("SmartHedgeSellAll");
                SendNewLogMessage(NameStrategyUniq + ": все позиции закрыты по рынку.", LogMessageType.System);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        private void LoadNearestFuturesPairsIntoScreener()
        {
            List<string> prefixes = ParsePrefixes(_futuresPrefixes?.ValueString);
            if (prefixes.Count == 0)
            {
                SendNewLogMessage(NameStrategyUniq + ": заполните «Префиксы корня тикера фьючерса».", LogMessageType.Error);
                return;
            }

            bool useTester = StartProgram == StartProgram.IsTester || StartProgram == StartProgram.IsOsOptimizer;
            if (!TryApplyMoexConnectorToScreener(useTester, out string connectorError))
            {
                SendNewLogMessage(NameStrategyUniq + ": " + connectorError, LogMessageType.Error);
                return;
            }

            IServer server = ResolveServer();
            if (server?.Securities == null || server.Securities.Count == 0)
            {
                SendNewLogMessage(NameStrategyUniq + ": нет бумаг на сервере скринера.", LogMessageType.Error);
                return;
            }

            DateTime now = DateTime.Now;
            if (_screenerTab.Tabs != null && _screenerTab.Tabs.Count > 0
                && _screenerTab.Tabs[0].TimeServerCurrent != DateTime.MinValue)
            {
                now = _screenerTab.Tabs[0].TimeServerCurrent;
            }

            if (!useTester)
            {
                WaitForMoexServerReady(server, 8000);
            }

            EnsureScreenerCandleInfrastructure();

            _hedgePairs.Clear();
            ClearScreenerSecuritiesAndTabs();

            List<string> added = new List<string>();
            List<string> errors = new List<string>();

            for (int p = 0; p < prefixes.Count; p++)
            {
                string prefix = prefixes[p];
                if (!TryPickTwoNearestFutures(server, prefix, now, out Security near, out Security far, out string error))
                {
                    errors.Add(prefix + ": " + error);
                    continue;
                }

                _screenerTab.SecuritiesNames.Add(new ActivatedSecurity
                {
                    SecurityName = near.Name,
                    SecurityClass = GetSecurityClassName(near),
                    IsOn = true
                });
                _screenerTab.SecuritiesNames.Add(new ActivatedSecurity
                {
                    SecurityName = far.Name,
                    SecurityClass = GetSecurityClassName(far),
                    IsOn = true
                });

                _hedgePairs.Add(new HedgePairState
                {
                    Prefix = prefix,
                    NearSecurityName = near.Name,
                    FarSecurityName = far.Name
                });

                added.Add(near.Name + " / " + far.Name);
            }

            if (_hedgePairs.Count == 0)
            {
                SendNewLogMessage(
                    NameStrategyUniq + ": пары не найдены. " + string.Join("; ", errors),
                    LogMessageType.Error);
                return;
            }

            if (useTester || string.IsNullOrWhiteSpace(_screenerTab.SecuritiesClass))
            {
                _screenerTab.SecuritiesClass = useTester
                    ? "TestClass"
                    : SecurityType.Futures.ToString();
            }

            _screenerTab.SaveSettings();
            TryInvokeScreenerRePaintSecuritiesGrid();
            ReloadScreenerTabs();

            string msg = NameStrategyUniq + ": пар " + _hedgePairs.Count + ", вкладок " + (_screenerTab.Tabs?.Count ?? 0)
                + ". " + string.Join("; ", added);
            if (errors.Count > 0)
            {
                msg += ". Пропуски: " + string.Join("; ", errors);
            }

            if (useTester)
            {
                msg += " Тестер: в сете Tester для каждой бумаги включите галочку и ТФ «"
                    + _screenerTab.TimeFrame + "» (как в настройках скринера).";
            }

            SendNewLogMessage(msg, LogMessageType.System);
        }

        private bool TryPickTwoNearestFutures(
            IServer server,
            string prefix,
            DateTime now,
            out Security near,
            out Security far,
            out string error)
        {
            near = null;
            far = null;
            error = string.Empty;

            List<Security> matched = new List<Security>();

            for (int i = 0; i < server.Securities.Count; i++)
            {
                Security sec = server.Securities[i];
                if (sec == null || !IsMoexFuturesInstrument(sec))
                {
                    continue;
                }

                if (!SecurityMatchesPrefix(sec, prefix))
                {
                    continue;
                }

                if (sec.Expiration != DateTime.MinValue && sec.Expiration.Date < now.Date)
                {
                    continue;
                }

                matched.Add(sec);
            }

            if (matched.Count < 2)
            {
                error = "найдено " + matched.Count;
                return false;
            }

            matched.Sort(CompareByExpiration);
            near = matched[0];
            far = matched[1];
            return true;
        }

        private static int CompareByExpiration(Security a, Security b)
        {
            DateTime ea = a.Expiration == DateTime.MinValue ? DateTime.MaxValue : a.Expiration;
            DateTime eb = b.Expiration == DateTime.MinValue ? DateTime.MaxValue : b.Expiration;
            int cmp = ea.CompareTo(eb);
            return cmp != 0 ? cmp : string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase);
        }

        private void ClearScreenerSecuritiesAndTabs()
        {
            _screenerTab.SecuritiesNames?.Clear();

            if (_screenerTab.Tabs != null)
            {
                for (int i = _screenerTab.Tabs.Count - 1; i >= 0; i--)
                {
                    BotTabSimple tab = _screenerTab.Tabs[i];
                    if (tab == null)
                    {
                        _screenerTab.Tabs.RemoveAt(i);
                        continue;
                    }

                    tab.Clear();
                    tab.Delete();
                    _screenerTab.Tabs.RemoveAt(i);
                }
            }

            ClearScreenerPersistedTabListFile();
            _screenerTab.NeedToReloadTabs = true;
            TryInvokeScreenerRePaintSecuritiesGrid();
        }

        private void ReloadScreenerTabs()
        {
            EnsureScreenerCandleInfrastructure();

            _screenerTab.NeedToReloadTabs = true;
            _screenerTab.TryLoadTabs();
            _screenerTab.TryReLoadTabs();

            EnsureExistingScreenerTabsCandleInfrastructure();
            _screenerTab.SaveSettings();
            TryInvokeScreenerRePaintSecuritiesGrid();
        }

        private void RemoveCorruptScreenerTabSetFileIfNeeded()
        {
            if (string.IsNullOrEmpty(_screenerTab?.TabName))
            {
                return;
            }

            try
            {
                string path = Path.Combine("Engine", _screenerTab.TabName + "ScreenerTabSet.txt");
                if (!File.Exists(path))
                {
                    return;
                }

                using (StreamReader reader = new StreamReader(path))
                {
                    string firstLine = reader.ReadLine();
                    if (firstLine == null || firstLine.Length == 0)
                    {
                        File.Delete(path);
                    }
                }
            }
            catch
            {
                // ignore
            }
        }

        private void ClearScreenerPersistedTabListFile()
        {
            if (string.IsNullOrEmpty(_screenerTab?.TabName))
            {
                return;
            }

            try
            {
                string path = Path.Combine("Engine", _screenerTab.TabName + "ScreenerTabSet.txt");
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch
            {
                // ignore
            }
        }

        private void TryInvokeScreenerRePaintSecuritiesGrid()
        {
            try
            {
                MethodInfo repaint = _screenerTab.GetType().GetMethod(
                    "RePaintSecuritiesGrid",
                    BindingFlags.Instance | BindingFlags.NonPublic);
                repaint?.Invoke(_screenerTab, null);
            }
            catch
            {
                // ignore
            }
        }

        private void EnsureScreenerCandleInfrastructure()
        {
            if (_screenerTab == null)
            {
                return;
            }

            if (_screenerTab.CandleSeriesRealization == null)
            {
                string seriesType = string.IsNullOrWhiteSpace(_screenerTab.CandleCreateMethodType)
                    ? "Simple"
                    : _screenerTab.CandleCreateMethodType;
                _screenerTab.CandleSeriesRealization = CandleFactory.CreateCandleSeriesRealization(seriesType);
                _screenerTab.CandleSeriesRealization?.Init(StartProgram);
            }

            EnsureExistingScreenerTabsCandleInfrastructure();
        }

        private void EnsureExistingScreenerTabsCandleInfrastructure()
        {
            if (_screenerTab?.Tabs == null || _screenerTab.CandleSeriesRealization == null)
            {
                return;
            }

            string screenerSeriesState = _screenerTab.CandleSeriesRealization.GetSaveString();

            for (int i = 0; i < _screenerTab.Tabs.Count; i++)
            {
                EnsureTabCandleSeriesRealization(_screenerTab.Tabs[i], screenerSeriesState);
            }
        }

        private void EnsureTabCandleSeriesRealization(BotTabSimple tab, string screenerSeriesState)
        {
            if (tab?.Connector?.TimeFrameBuilder == null)
            {
                return;
            }

            TimeFrameBuilder builder = tab.Connector.TimeFrameBuilder;
            if (builder.CandleSeriesRealization == null)
            {
                string seriesType = string.IsNullOrWhiteSpace(tab.Connector.CandleCreateMethodType)
                    ? "Simple"
                    : tab.Connector.CandleCreateMethodType;
                builder.CandleSeriesRealization = CandleFactory.CreateCandleSeriesRealization(seriesType);
                builder.CandleSeriesRealization?.Init(StartProgram);
            }

            if (builder.CandleSeriesRealization == null)
            {
                return;
            }

            if (!string.IsNullOrEmpty(screenerSeriesState))
            {
                builder.CandleSeriesRealization.SetSaveString(screenerSeriesState);
                builder.CandleSeriesRealization.OnStateChange(CandleSeriesState.ParametersChange);
            }
        }

        private bool TryApplyMoexConnectorToScreener(bool useTester, out string error)
        {
            error = null;

            if (useTester)
            {
                IServer server = FindTesterLikeServer();
                if (server == null)
                {
                    error = "В тестере не найден коннектор Tester.";
                    return false;
                }

                _screenerTab.ServerType = server.ServerType;
                _screenerTab.ServerName = server.ServerType == ServerType.Tester
                    ? ServerType.Tester.ToString()
                    : server.ServerNameAndPrefix;
                return true;
            }

            if (HasConfiguredLiveScreenerConnection())
            {
                return true;
            }

            IServer tInvest = FindTInvestServer();
            if (tInvest == null)
            {
                error = "Подключите T-Инвестиции или задайте сервер и портфель во вкладке скринера.";
                return false;
            }

            _screenerTab.ServerType = ServerType.TInvest;
            _screenerTab.ServerName = tInvest.ServerNameAndPrefix;
            return true;
        }

        private bool HasConfiguredLiveScreenerConnection()
        {
            return _screenerTab != null
                && _screenerTab.ServerType == ServerType.TInvest
                && !string.IsNullOrWhiteSpace(_screenerTab.ServerName)
                && !string.IsNullOrWhiteSpace(_screenerTab.PortfolioName);
        }

        private static bool WaitForMoexServerReady(IServer server, int maxWaitMs)
        {
            if (server == null || maxWaitMs <= 0)
            {
                return false;
            }

            DateTime deadline = DateTime.Now.AddMilliseconds(maxWaitMs);
            while (DateTime.Now < deadline)
            {
                if (server.ServerStatus == ServerConnectStatus.Connect)
                {
                    if (server.Securities == null || server.Securities.Count == 0)
                    {
                        Thread.Sleep(250);
                        continue;
                    }

                    return true;
                }

                Thread.Sleep(250);
            }

            return server.ServerStatus == ServerConnectStatus.Connect;
        }

        private void ExecuteBuyPairs()
        {
            if (_hedgePairs.Count == 0)
            {
                RebuildPairsFromScreenerSecurities();
            }

            if (_hedgePairs.Count == 0)
            {
                SendNewLogMessage(NameStrategyUniq + ": сначала «Подобрать фьючерсы».", LogMessageType.Error);
                return;
            }

            int opened = 0;
            string botType = GetNameStrategyType();

            for (int i = 0; i < _hedgePairs.Count; i++)
            {
                HedgePairState pair = _hedgePairs[i];
                BotTabSimple nearTab = FindTabBySecurity(pair.NearSecurityName);
                BotTabSimple farTab = FindTabBySecurity(pair.FarSecurityName);

                if (nearTab == null || farTab == null)
                {
                    continue;
                }

                decimal volume = GetVolume(nearTab);
                if (volume <= 0m)
                {
                    continue;
                }

                pair.PairVolume = volume;

                if (GetFirstOpenPosition(nearTab, botType) != null || GetFirstOpenPosition(farTab, botType) != null)
                {
                    continue;
                }

                nearTab.BuyAtMarket(volume, "SmartHedgeBuyNear");
                farTab.SellAtMarket(volume, "SmartHedgeSellFar");
                opened++;
            }

            SendNewLogMessage(
                NameStrategyUniq + ": «Купить пару» — открыто пар: " + opened + " (ближний лонг, дальний шорт).",
                LogMessageType.System);
        }

        private void ExecuteAdjustPairs()
        {
            if (_hedgePairs.Count == 0)
            {
                RebuildPairsFromScreenerSecurities();
            }

            if (_hedgePairs.Count == 0)
            {
                return;
            }

            int adjusted = 0;
            string botType = GetNameStrategyType();

            for (int i = 0; i < _hedgePairs.Count; i++)
            {
                HedgePairState pair = _hedgePairs[i];
                BotTabSimple nearTab = FindTabBySecurity(pair.NearSecurityName);
                BotTabSimple farTab = FindTabBySecurity(pair.FarSecurityName);

                if (nearTab == null || farTab == null)
                {
                    continue;
                }

                Position nearPos = GetFirstOpenPosition(nearTab, botType);
                Position farPos = GetFirstOpenPosition(farTab, botType);

                if (nearPos == null && farPos == null)
                {
                    continue;
                }

                if (nearPos == null || farPos == null)
                {
                    SendNewLogMessage(
                        NameStrategyUniq + " [" + pair.Prefix + "]: открыта одна нога — используйте «Продать всё».",
                        LogMessageType.Error);
                    continue;
                }

                BotTabSimple profitTab;
                BotTabSimple lossTab;
                Position profitPos;
                Position lossPos;

                if (nearPos.ProfitPortfolioAbs >= farPos.ProfitPortfolioAbs)
                {
                    profitTab = nearTab;
                    lossTab = farTab;
                    profitPos = nearPos;
                    lossPos = farPos;
                }
                else
                {
                    profitTab = farTab;
                    lossTab = nearTab;
                    profitPos = farPos;
                    lossPos = nearPos;
                }

                CloseOpenPosition(profitTab, profitPos, "SmartHedgeCloseProfit");
                CloseOpenPosition(lossTab, lossPos, "SmartHedgeCloseLoss");

                BotTabSimple secondTab = farTab;
                decimal baseVol = pair.PairVolume > 0m ? pair.PairVolume : GetVolume(secondTab);
                decimal addVol = RoundVolume(secondTab, baseVol / 3m);

                if (addVol > 0m)
                {
                    secondTab.BuyAtMarket(addVol, "SmartHedgeAddThird");
                }

                adjusted++;
            }

            SendNewLogMessage(
                NameStrategyUniq + ": «Скорректировать пару» — пар: " + adjusted
                + " (закрыты обе ноги, на дальний контракт докупка 1/3).",
                LogMessageType.System);
        }

        private void CloseAllScreenerPositions(string signal)
        {
            if (_screenerTab?.Tabs == null)
            {
                return;
            }

            string botType = GetNameStrategyType();

            for (int i = 0; i < _screenerTab.Tabs.Count; i++)
            {
                BotTabSimple tab = _screenerTab.Tabs[i];
                if (tab?.PositionsOpenAll == null)
                {
                    continue;
                }

                for (int p = 0; p < tab.PositionsOpenAll.Count; p++)
                {
                    Position pos = tab.PositionsOpenAll[p];
                    if (pos == null || pos.State != PositionStateType.Open || pos.OpenVolume == 0m)
                    {
                        continue;
                    }

                    if (!string.IsNullOrEmpty(pos.NameBotClass) && pos.NameBotClass != botType)
                    {
                        continue;
                    }

                    tab.CloseAtMarket(pos, pos.OpenVolume, signal);
                }
            }
        }

        private static void CloseOpenPosition(BotTabSimple tab, Position pos, string signal)
        {
            if (tab == null || pos == null || pos.State != PositionStateType.Open || pos.OpenVolume == 0m)
            {
                return;
            }

            tab.CloseAtMarket(pos, pos.OpenVolume, signal);
        }

        private static Position GetFirstOpenPosition(BotTabSimple tab, string botType)
        {
            if (tab?.PositionsOpenAll == null)
            {
                return null;
            }

            for (int i = 0; i < tab.PositionsOpenAll.Count; i++)
            {
                Position pos = tab.PositionsOpenAll[i];
                if (pos == null || pos.State != PositionStateType.Open || pos.OpenVolume <= 0m)
                {
                    continue;
                }

                if (!string.IsNullOrEmpty(pos.NameBotClass) && pos.NameBotClass != botType)
                {
                    continue;
                }

                return pos;
            }

            return null;
        }

        private BotTabSimple FindTabBySecurity(string securityName)
        {
            if (_screenerTab?.Tabs == null || string.IsNullOrWhiteSpace(securityName))
            {
                return null;
            }

            for (int i = 0; i < _screenerTab.Tabs.Count; i++)
            {
                BotTabSimple tab = _screenerTab.Tabs[i];
                if (tab?.Connector != null
                    && string.Equals(tab.Connector.SecurityName, securityName, StringComparison.OrdinalIgnoreCase))
                {
                    return tab;
                }
            }

            return null;
        }

        private void RebuildPairsFromScreenerSecurities()
        {
            _hedgePairs.Clear();
            List<string> prefixes = ParsePrefixes(_futuresPrefixes?.ValueString);
            IServer server = ResolveServer();

            if (prefixes.Count == 0 || _screenerTab?.SecuritiesNames == null)
            {
                return;
            }

            for (int p = 0; p < prefixes.Count; p++)
            {
                string prefix = prefixes[p];
                List<Security> matched = new List<Security>();

                for (int i = 0; i < _screenerTab.SecuritiesNames.Count; i++)
                {
                    ActivatedSecurity act = _screenerTab.SecuritiesNames[i];
                    if (act == null || !act.IsOn)
                    {
                        continue;
                    }

                    Security sec = FindSecurityByName(server, act.SecurityName);
                    if (sec != null && SecurityMatchesPrefix(sec, prefix))
                    {
                        matched.Add(sec);
                    }
                }

                if (matched.Count < 2)
                {
                    continue;
                }

                matched.Sort(CompareByExpiration);
                _hedgePairs.Add(new HedgePairState
                {
                    Prefix = prefix,
                    NearSecurityName = matched[0].Name,
                    FarSecurityName = matched[1].Name
                });
            }
        }

        private static Security FindSecurityByName(IServer server, string name)
        {
            if (server?.Securities == null || string.IsNullOrWhiteSpace(name))
            {
                return null;
            }

            for (int i = 0; i < server.Securities.Count; i++)
            {
                Security sec = server.Securities[i];
                if (sec != null && string.Equals(sec.Name, name, StringComparison.OrdinalIgnoreCase))
                {
                    return sec;
                }
            }

            return null;
        }

        private decimal GetVolume(BotTabSimple tab)
        {
            if (tab == null)
            {
                return 0m;
            }

            if (_volumeType.ValueString == "Contracts")
            {
                return RoundVolume(tab, _volume.ValueDecimal);
            }

            if (_volumeType.ValueString == "Contract currency")
            {
                if (tab.PriceBestAsk <= 0m)
                {
                    return 0m;
                }

                return RoundVolume(tab, _volume.ValueDecimal / tab.PriceBestAsk);
            }

            Portfolio portfolio = tab.Portfolio;
            if (portfolio == null || tab.PriceBestAsk <= 0m || tab.Security.Lot <= 0m)
            {
                return 0m;
            }

            decimal portfolioValue = portfolio.ValueCurrent;
            if (_tradeAssetInPortfolio.ValueString != "Prime")
            {
                List<PositionOnBoard> onBoard = portfolio.GetPositionOnBoard();
                if (onBoard != null)
                {
                    for (int i = 0; i < onBoard.Count; i++)
                    {
                        if (onBoard[i].SecurityNameCode == _tradeAssetInPortfolio.ValueString)
                        {
                            portfolioValue = onBoard[i].ValueCurrent;
                            break;
                        }
                    }
                }
            }

            if (portfolioValue <= 0m)
            {
                return 0m;
            }

            decimal money = portfolioValue * (_volume.ValueDecimal / 100m);
            return RoundVolume(tab, money / tab.PriceBestAsk / tab.Security.Lot);
        }

        private static decimal RoundVolume(BotTabSimple tab, decimal volume)
        {
            return tab?.Security == null
                ? volume
                : Math.Round(volume, tab.Security.DecimalsVolume, MidpointRounding.AwayFromZero);
        }

        private IServer ResolveServer()
        {
            if (StartProgram == StartProgram.IsTester || StartProgram == StartProgram.IsOsOptimizer)
            {
                return FindTesterLikeServer();
            }

            IServer fromScreener = FindServerForScreener();
            if (fromScreener != null)
            {
                return fromScreener;
            }

            return FindTInvestServer();
        }

        private IServer FindServerForScreener()
        {
            if (_screenerTab == null)
            {
                return null;
            }

            List<IServer> servers = ServerMaster.GetServers();
            if (servers == null || servers.Count == 0)
            {
                return null;
            }

            for (int i = 0; i < servers.Count; i++)
            {
                IServer s = servers[i];
                if (s == null || s.ServerType != _screenerTab.ServerType)
                {
                    continue;
                }

                if (string.IsNullOrEmpty(_screenerTab.ServerName))
                {
                    if (string.Equals(s.ServerNameAndPrefix, _screenerTab.ServerType.ToString(), StringComparison.Ordinal))
                    {
                        return s;
                    }

                    continue;
                }

                if (ServerNamesMatch(_screenerTab.ServerName, s))
                {
                    return s;
                }
            }

            return FindTInvestServerByScreenerName(_screenerTab.ServerName);
        }

        private static IServer FindTesterLikeServer()
        {
            List<IServer> servers = ServerMaster.GetServers();
            if (servers == null || servers.Count == 0)
            {
                return null;
            }

            IServer firstTester = null;

            for (int i = 0; i < servers.Count; i++)
            {
                IServer s = servers[i];
                if (s == null)
                {
                    continue;
                }

                if (s.ServerType != ServerType.Tester && s.ServerType != ServerType.Optimizer)
                {
                    continue;
                }

                if (firstTester == null)
                {
                    firstTester = s;
                }

                if (s.Securities != null && s.Securities.Count > 0)
                {
                    return s;
                }
            }

            return firstTester;
        }

        private static IServer FindTInvestServer()
        {
            List<IServer> servers = ServerMaster.GetServers();
            if (servers == null || servers.Count == 0)
            {
                return null;
            }

            IServer firstTInvest = null;

            for (int i = 0; i < servers.Count; i++)
            {
                IServer s = servers[i];
                if (s == null || s.ServerType != ServerType.TInvest)
                {
                    continue;
                }

                if (firstTInvest == null)
                {
                    firstTInvest = s;
                }

                if (s.Securities != null && s.Securities.Count > 0)
                {
                    return s;
                }
            }

            return firstTInvest;
        }

        private static IServer FindTInvestServerByScreenerName(string screenerServerName)
        {
            if (string.IsNullOrWhiteSpace(screenerServerName))
            {
                return null;
            }

            List<IServer> servers = ServerMaster.GetServers();
            if (servers == null || servers.Count == 0)
            {
                return null;
            }

            IServer partialMatch = null;

            for (int i = 0; i < servers.Count; i++)
            {
                IServer s = servers[i];
                if (s == null || s.ServerType != ServerType.TInvest)
                {
                    continue;
                }

                if (!ServerNamesMatch(screenerServerName, s))
                {
                    continue;
                }

                if (s.Securities != null && s.Securities.Count > 0)
                {
                    return s;
                }

                if (partialMatch == null)
                {
                    partialMatch = s;
                }
            }

            return partialMatch;
        }

        private static bool ServerNamesMatch(string screenerServerName, IServer server)
        {
            if (server == null || string.IsNullOrWhiteSpace(screenerServerName))
            {
                return false;
            }

            string wanted = screenerServerName.Trim();
            string full = server.ServerNameAndPrefix?.Trim() ?? string.Empty;

            if (wanted.Length == 0 || full.Length == 0)
            {
                return false;
            }

            if (string.Equals(wanted, full, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            return full.EndsWith("_" + wanted, StringComparison.OrdinalIgnoreCase);
        }

        private bool IsMoexFuturesInstrument(Security sec)
        {
            if (StartProgram == StartProgram.IsTester || StartProgram == StartProgram.IsOsOptimizer)
            {
                return IsMoexFuturesStyleName(GetTesterTicker(sec.Name));
            }

            return sec.SecurityType == SecurityType.Futures;
        }

        private static List<string> ParsePrefixes(string raw)
        {
            List<string> result = new List<string>();
            if (string.IsNullOrWhiteSpace(raw))
            {
                return result;
            }

            string[] parts = raw.Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries);
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            for (int i = 0; i < parts.Length; i++)
            {
                string p = parts[i].Trim();
                if (p.Length > 0 && seen.Add(p))
                {
                    result.Add(p);
                }
            }

            return result;
        }

        private static bool SecurityMatchesPrefix(Security sec, string prefix)
        {
            HashSet<string> tickers = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            string[] candidates = { sec.Name, sec.NameFull, sec.NameId };

            for (int c = 0; c < candidates.Length; c++)
            {
                if (string.IsNullOrWhiteSpace(candidates[c]))
                {
                    continue;
                }

                string tester = GetTesterTicker(candidates[c]);
                if (!string.IsNullOrEmpty(tester))
                {
                    tickers.Add(tester);
                }

                tickers.Add(NormalizeTicker(candidates[c]));
            }

            foreach (string ticker in tickers)
            {
                if (TickerMatchesPrefix(ticker, prefix))
                {
                    return true;
                }
            }

            return false;
        }

        private static bool TickerMatchesPrefix(string ticker, string userPrefix)
        {
            string root = ExtractLetterRoot(ticker);
            if (root.Length == 0)
            {
                return false;
            }

            foreach (string expanded in ExpandPrefixAliases(userPrefix))
            {
                if (RootMatchesPrefix(root, expanded))
                {
                    return true;
                }
            }

            return false;
        }

        private static IEnumerable<string> ExpandPrefixAliases(string userPrefix)
        {
            yield return userPrefix.Trim();

            if (MoexFuturesPrefixAliases.TryGetValue(userPrefix.Trim(), out string[] aliases))
            {
                for (int i = 0; i < aliases.Length; i++)
                {
                    if (!string.IsNullOrWhiteSpace(aliases[i]))
                    {
                        yield return aliases[i].Trim();
                    }
                }
            }
        }

        private static bool RootMatchesPrefix(string root, string prefix)
        {
            return string.Equals(root, prefix, StringComparison.OrdinalIgnoreCase)
                || (prefix.Length <= root.Length && root.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                || (root.Length <= prefix.Length && prefix.StartsWith(root, StringComparison.OrdinalIgnoreCase));
        }

        private static string ExtractLetterRoot(string ticker)
        {
            string t = NormalizeTicker(ticker);
            int dash = t.IndexOf('-');
            if (dash > 0)
            {
                return t.Substring(0, dash);
            }

            string fort = TryFortsBase(t);
            if (fort.Length > 0)
            {
                return fort;
            }

            int end = 0;
            while (end < t.Length && char.IsLetter(t[end]))
            {
                end++;
            }

            return end > 0 ? t.Substring(0, end) : string.Empty;
        }

        private static string TryFortsBase(string ticker)
        {
            if (ticker.Length < 3)
            {
                return string.Empty;
            }

            int len = ticker.Length;
            if (!char.IsLetter(ticker[len - 2]) || !char.IsDigit(ticker[len - 1]))
            {
                return string.Empty;
            }

            string basePart = ticker.Substring(0, len - 2);
            for (int i = 0; i < basePart.Length; i++)
            {
                if (!char.IsLetter(basePart[i]))
                {
                    return string.Empty;
                }
            }

            return basePart;
        }

        private static bool IsMoexFuturesStyleName(string ticker)
        {
            if (string.IsNullOrWhiteSpace(ticker))
            {
                return false;
            }

            string t = NormalizeTicker(ticker);
            if (IsPlainEquity(t))
            {
                return false;
            }

            int dash = t.IndexOf('-');
            if (dash > 0 && dash < t.Length - 1)
            {
                for (int i = dash + 1; i < t.Length; i++)
                {
                    if (char.IsDigit(t[i]))
                    {
                        return true;
                    }
                }
            }

            if (t.EndsWith("RUBF", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            string fort = TryFortsBase(t);
            return fort.Length > 0 && fort.Length < t.Length;
        }

        private static bool IsPlainEquity(string ticker)
        {
            for (int i = 0; i < ticker.Length; i++)
            {
                if (!char.IsLetter(ticker[i]))
                {
                    return false;
                }
            }

            return ticker.Length >= 2 && ticker.Length <= 5;
        }

        private static string GetTesterTicker(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw))
            {
                return string.Empty;
            }

            string t = raw.Trim();
            int slash = Math.Max(t.LastIndexOf('\\'), t.LastIndexOf('/'));
            if (slash >= 0 && slash < t.Length - 1)
            {
                t = t.Substring(slash + 1);
            }

            int dot = t.LastIndexOf('.');
            if (dot > 0)
            {
                t = t.Substring(0, dot);
            }

            return NormalizeTicker(t);
        }

        private static string NormalizeTicker(string ticker)
        {
            if (string.IsNullOrWhiteSpace(ticker))
            {
                return string.Empty;
            }

            string t = ticker.Trim();
            int plus = t.IndexOf('+');
            if (plus > 0)
            {
                t = t.Substring(0, plus).Trim();
            }

            return t;
        }

        private static string GetSecurityClassName(Security sec)
        {
            if (!string.IsNullOrWhiteSpace(sec?.NameClass))
            {
                return sec.NameClass;
            }

            return sec?.SecurityType == SecurityType.Futures
                ? SecurityType.Futures.ToString()
                : "TestClass";
        }

        private sealed class HedgePairState
        {
            public string Prefix;
            public string NearSecurityName;
            public string FarSecurityName;
            public decimal PairVolume;
        }
    }
}
