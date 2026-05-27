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
 * Смарт Хедж — ручной календарный хедж фьючерсов MOEX (только кнопки).
 * «Подобрать фьючерсы»: по префиксу — ближняя экспирация и следующая более поздняя (календарный спред).
 * «Купить пару»: ближний лонг + дальний шорт, объём = «Количество позиций в одну сторону» (по умолчанию 3).
 * «Скорректировать пару (Trail)»: ожидание локального максимума профита на закрытии свечи ноги в плюсе,
 *   затем закрыть профитную ногу и добавить 1/3 объёма на убыточную (3→4).
 * «Скорректировать пару (сразу)»: та же коррекция без ожидания — по всем открытым парам сразу.
 */

namespace OsEngine.Robots.Custom
{
    [Bot("SmartHedge")]
    public class SmartHedge : BotPanel
    {
        private const string DefaultMoexFuturesTickerPrefixes =
            "Si,USDRUBF,Eu,EURRUBF,CNY,MX,MM,IMOEXF,RI,BR,BRM,CL,NG,NGM,GD,GLDRUBF,SV,PT,PD,CU,SR,GZ,LK,RN,NK,GN,TT,VB,SN,SG,RL";

        /// <summary>Минимальная длина префикса для сопоставления «корень начинается с префикса» (иначе «C» = CR, CL, CU, …).</summary>
        private const int MinPrefixLengthForStartsWithMatch = 2;

        private static readonly Dictionary<string, string[]> MoexFuturesPrefixAliases =
            new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase)
            {
                { "CNY", new[] { "CR", "CNYRUBF" } },
                { "UCNY", new[] { "CR", "CNYRUBF" } },
            };

        private BotTabScreener _screenerTab;

        private StrategyParameterString _futuresPrefixes;
        private StrategyParameterButton _moexFuturesResetPrefixesButton;
        private StrategyParameterButton _loadFuturesButton;
        private StrategyParameterButton _buyPairButton;
        private StrategyParameterButton _adjustPairTrailButton;
        private StrategyParameterButton _adjustPairImmediateButton;
        private StrategyParameterButton _sellAllButton;

        private StrategyParameterInt _positionsPerSide;
        private StrategyParameterString _volumeType;
        private StrategyParameterDecimal _volume;
        private StrategyParameterString _tradeAssetInPortfolio;

        private readonly List<HedgePairState> _hedgePairs = new List<HedgePairState>();

        /// <summary>После «Скорректировать пару (Trail)» ждём снижения профита на свечах профитной ноги.</summary>
        private bool _adjustPairsPending;

        private readonly Dictionary<string, decimal> _adjustProfitByPairPrefix =
            new Dictionary<string, decimal>(StringComparer.OrdinalIgnoreCase);

        private readonly HashSet<string> _adjustCompletedPairPrefixes =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        private bool _buyPairButtonEnabledState;

        public SmartHedge(string name, StartProgram startProgram)
            : base(name, startProgram)
        {
            TabCreate(BotTabType.Screener);
            _screenerTab = TabsScreener[0];
            _screenerTab.CandleFinishedEvent += ScreenerTab_CandleFinishedEvent;
            _screenerTab.NewTabCreateEvent += ScreenerTab_NewTabCreateEvent;
            _screenerTab.NewTickEvent += ScreenerTab_NewTickEvent;
            EnsureScreenerEventsOn();
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
            _buyPairButton.SetEnabled(false);
            _buyPairButtonEnabledState = false;
            _buyPairButton.UserClickOnButtonEvent += BuyPairButton_UserClickOnButtonEvent;
            _adjustPairTrailButton = CreateParameterButton("Скорректировать пару (Trail)", tradeTab);
            _adjustPairTrailButton.UserClickOnButtonEvent += AdjustPairTrailButton_UserClickOnButtonEvent;
            _adjustPairImmediateButton = CreateParameterButton("Скорректировать пару (сразу)", tradeTab);
            _adjustPairImmediateButton.UserClickOnButtonEvent += AdjustPairImmediateButton_UserClickOnButtonEvent;
            _sellAllButton = CreateParameterButton("Продать всё", tradeTab);
            _sellAllButton.UserClickOnButtonEvent += SellAllButton_UserClickOnButtonEvent;

            _positionsPerSide = CreateParameter("Количество позиций в одну сторону", 3, 1, 100, 1, tradeTab);
            _volumeType = CreateParameter("Volume type", "Contracts", new[] { "Contracts", "Contract currency", "Deposit percent" }, tradeTab);
            _volume = CreateParameter("Volume", 3, 1m, 500m, 1m, tradeTab);
            _tradeAssetInPortfolio = CreateParameter("Asset in portfolio", "Prime", tradeTab);

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
                if (!_buyPairButton.IsEnabled)
                {
                    SendNewLogMessage(
                        NameStrategyUniq + ": «Купить пару» недоступна — дождитесь Bid и Ask на всех вкладках пары "
                        + "(ближний и дальний после «Подобрать фьючерсы»).",
                        LogMessageType.Error);
                    return;
                }

                ExecuteBuyPairs();
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        private void ScreenerTab_NewTickEvent(Trade trade, BotTabSimple tab)
        {
            UpdateBuyPairButtonEnabledState();
        }

        private void AdjustPairTrailButton_UserClickOnButtonEvent()
        {
            try
            {
                ArmAdjustPairsWaiting();
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        private void AdjustPairImmediateButton_UserClickOnButtonEvent()
        {
            try
            {
                ExecuteAdjustAllPairsImmediately();
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        private void ScreenerTab_NewTabCreateEvent(BotTabSimple tab)
        {
            if (tab == null || _screenerTab == null || !_screenerTab.EventsIsOn)
            {
                return;
            }

            tab.EventsIsOn = true;
            UpdateBuyPairButtonEnabledState();
        }

        private void UpdateBuyPairButtonEnabledState()
        {
            if (_buyPairButton == null)
            {
                return;
            }

            bool ready = AreAllHedgePairTabsQuoted();
            if (ready == _buyPairButtonEnabledState)
            {
                return;
            }

            _buyPairButtonEnabledState = ready;
            _buyPairButton.SetEnabled(ready);
            RepaintParameterGuiTables();
        }

        /// <summary>
        /// Все вкладки ближнего и дальнего фьючерса по каждой паре: Trade + Bid + Ask.
        /// </summary>
        private bool AreAllHedgePairTabsQuoted()
        {
            if (_hedgePairs.Count == 0)
            {
                RebuildPairsFromScreenerSecurities();
            }

            if (_hedgePairs.Count == 0)
            {
                return false;
            }

            for (int i = 0; i < _hedgePairs.Count; i++)
            {
                HedgePairState pair = _hedgePairs[i];
                BotTabSimple nearTab = FindTabBySecurity(pair.NearSecurityName);
                BotTabSimple farTab = FindTabBySecurity(pair.FarSecurityName);

                if (nearTab == null || farTab == null)
                {
                    return false;
                }

                if (!IsTabQuotedForPairTrade(nearTab) || !IsTabQuotedForPairTrade(farTab))
                {
                    return false;
                }
            }

            return true;
        }

        private static bool IsTabQuotedForPairTrade(BotTabSimple tab)
        {
            if (tab?.Connector == null)
            {
                return false;
            }

            return tab.Connector.IsConnected
                && tab.Connector.IsReadyToTrade
                && tab.PriceBestAsk > 0m
                && tab.PriceBestBid > 0m;
        }

        private void EnsureScreenerEventsOn()
        {
            if (_screenerTab == null)
            {
                return;
            }

            if (!_screenerTab.EventsIsOn)
            {
                _screenerTab.EventsIsOn = true;
                SendNewLogMessage(
                    NameStrategyUniq + ": включены события скринера (нужны для коррекции Trail по свечам).",
                    LogMessageType.System);
            }

            if (_screenerTab.Tabs == null)
            {
                return;
            }

            for (int i = 0; i < _screenerTab.Tabs.Count; i++)
            {
                BotTabSimple tab = _screenerTab.Tabs[i];
                if (tab != null && !tab.EventsIsOn)
                {
                    tab.EventsIsOn = true;
                }
            }
        }

        private void ScreenerTab_CandleFinishedEvent(List<Candle> candles, BotTabSimple tab)
        {
            if (!_adjustPairsPending || tab == null)
            {
                return;
            }

            try
            {
                TryProcessAdjustPairsOnCandle(tab);
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
                if (prefix.Length < MinPrefixLengthForStartsWithMatch)
                {
                    SendNewLogMessage(
                        NameStrategyUniq + ": префикс «" + prefix + "» слишком короткий — укажите код серии целиком "
                        + "(доллар: Si или USDRUBF; юань: CNY или CR; серебро в руб.: S2 или SL). "
                        + "Одна буква «C» подбирает все корни CR, CL, CU, …, но не Si и не S2.",
                        LogMessageType.Error);
                    continue;
                }

                if (!TryPickTwoNearestFutures(server, prefix, now, out Security near, out Security far, out string error))
                {
                    errors.Add(prefix + ": " + error);
                    continue;
                }

                AddActivatedSecurityIfNew(near);
                AddActivatedSecurityIfNew(far);

                _hedgePairs.Add(new HedgePairState
                {
                    Prefix = prefix,
                    NearSecurityName = near.Name,
                    FarSecurityName = far.Name
                });

                added.Add(FormatSecurityExpiration(near) + " / " + FormatSecurityExpiration(far));
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
                + ". " + string.Join("; ", added)
                + " [префиксы: " + string.Join(", ", prefixes) + "]";
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
            UpdateBuyPairButtonEnabledState();
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

                if (sec.Expiration != DateTime.MinValue && sec.Expiration.Date < now.Date)
                {
                    continue;
                }

                if (!SecurityMatchesExactFuturesRoot(sec, prefix))
                {
                    continue;
                }

                matched.Add(sec);
            }

            return TrySelectNearAndFarByExpiration(matched, out near, out far, out error);
        }

        /// <summary>
        /// Ближний контракт — минимальная дата экспирации по префиксу; дальний — та же серия, следующая экспирация позже.
        /// </summary>
        private static bool TrySelectNearAndFarByExpiration(
            List<Security> matched,
            out Security near,
            out Security far,
            out string error)
        {
            near = null;
            far = null;
            error = string.Empty;

            if (matched == null || matched.Count < 2)
            {
                error = "найдено " + (matched?.Count ?? 0)
                    + (matched != null && matched.Count > 0
                        ? " [" + FormatMatchedFuturesTickers(matched) + " → корни: "
                          + FormatMatchedFuturesRoots(matched) + "]"
                        : string.Empty);
                return false;
            }

            matched.Sort(CompareByExpiration);
            near = matched[0];
            DateTime nearExp = GetExpirationSortKey(near);

            for (int i = 1; i < matched.Count; i++)
            {
                Security candidate = matched[i];
                DateTime candidateExp = GetExpirationSortKey(candidate);

                if (candidateExp > nearExp)
                {
                    far = candidate;
                    return true;
                }
            }

            error = "нет второй серии с экспирацией позже "
                + FormatSecurityExpiration(near)
                + " (в списке: " + FormatMatchedFuturesWithExpiration(matched) + ")";
            return false;
        }

        private static DateTime GetExpirationSortKey(Security sec)
        {
            if (sec == null || sec.Expiration == DateTime.MinValue)
            {
                return DateTime.MaxValue;
            }

            return sec.Expiration;
        }

        private static string FormatSecurityExpiration(Security sec)
        {
            if (sec == null)
            {
                return "?";
            }

            if (sec.Expiration == DateTime.MinValue)
            {
                return sec.Name + " (без даты экспирации)";
            }

            return sec.Name + " (" + sec.Expiration.ToString("yyyy-MM-dd") + ")";
        }

        private static string FormatMatchedFuturesWithExpiration(List<Security> matched)
        {
            if (matched == null || matched.Count == 0)
            {
                return string.Empty;
            }

            var parts = new List<string>(matched.Count);
            for (int i = 0; i < matched.Count; i++)
            {
                parts.Add(FormatSecurityExpiration(matched[i]));
            }

            return string.Join(", ", parts);
        }

        private static bool SecurityMatchesExactFuturesRoot(Security sec, string prefix)
        {
            string root = GetFuturesLetterRoot(sec);
            if (root.Length == 0)
            {
                return false;
            }

            foreach (string expanded in ExpandPrefixAliases(prefix))
            {
                if (RootMatchesExpandedPrefix(root, expanded))
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Корень только из SECID (Name / NameId). NameFull «Si-6.26» у S0M6 (SOFL) давал ложный корень Si.
        /// </summary>
        private static string GetFuturesLetterRoot(Security sec)
        {
            if (sec == null)
            {
                return string.Empty;
            }

            string[] candidates = { sec.Name, sec.NameId };

            for (int i = 0; i < candidates.Length; i++)
            {
                if (string.IsNullOrWhiteSpace(candidates[i]))
                {
                    continue;
                }

                string tester = GetTesterTicker(candidates[i]);
                string ticker = string.IsNullOrEmpty(tester)
                    ? NormalizeTicker(candidates[i])
                    : tester;
                string root = ExtractLetterRoot(ticker);

                if (root.Length > 0)
                {
                    return root;
                }
            }

            return string.Empty;
        }

        private static string FormatMatchedFuturesRoots(List<Security> matched)
        {
            if (matched == null || matched.Count == 0)
            {
                return string.Empty;
            }

            var parts = new List<string>(matched.Count);
            for (int i = 0; i < matched.Count; i++)
            {
                Security sec = matched[i];
                if (sec != null)
                {
                    parts.Add((sec.Name ?? "?") + "→" + GetFuturesLetterRoot(sec));
                }
            }

            return string.Join(", ", parts);
        }

        private static string FormatMatchedFuturesTickers(List<Security> matched)
        {
            if (matched == null || matched.Count == 0)
            {
                return string.Empty;
            }

            var names = new List<string>(matched.Count);
            for (int i = 0; i < matched.Count; i++)
            {
                Security sec = matched[i];
                if (sec != null && !string.IsNullOrWhiteSpace(sec.Name))
                {
                    names.Add(sec.Name);
                }
            }

            return string.Join(", ", names);
        }

        private static int CompareByExpiration(Security a, Security b)
        {
            DateTime ea = a.Expiration == DateTime.MinValue ? DateTime.MaxValue : a.Expiration;
            DateTime eb = b.Expiration == DateTime.MinValue ? DateTime.MaxValue : b.Expiration;
            int cmp = ea.CompareTo(eb);
            return cmp != 0 ? cmp : string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase);
        }

        private void AddActivatedSecurityIfNew(Security sec)
        {
            if (sec == null || string.IsNullOrWhiteSpace(sec.Name) || _screenerTab.SecuritiesNames == null)
            {
                return;
            }

            for (int i = 0; i < _screenerTab.SecuritiesNames.Count; i++)
            {
                ActivatedSecurity existing = _screenerTab.SecuritiesNames[i];
                if (existing != null
                    && string.Equals(existing.SecurityName, sec.Name, StringComparison.OrdinalIgnoreCase))
                {
                    existing.IsOn = true;
                    return;
                }
            }

            _screenerTab.SecuritiesNames.Add(new ActivatedSecurity
            {
                SecurityName = sec.Name,
                SecurityClass = GetSecurityClassName(sec),
                IsOn = true
            });
        }

        private void ClearScreenerSecuritiesAndTabs()
        {
            if (_screenerTab.SecuritiesNames == null)
            {
                _screenerTab.SecuritiesNames = new List<ActivatedSecurity>();
            }
            else
            {
                _screenerTab.SecuritiesNames.Clear();
            }

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
            EnsureScreenerEventsOn();
            _screenerTab.SaveSettings();
            TryInvokeScreenerRePaintSecuritiesGrid();
            UpdateBuyPairButtonEnabledState();
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
            int skipped = 0;
            string botType = GetNameStrategyType();

            for (int i = 0; i < _hedgePairs.Count; i++)
            {
                HedgePairState pair = _hedgePairs[i];
                BotTabSimple nearTab = FindTabBySecurity(pair.NearSecurityName);
                BotTabSimple farTab = FindTabBySecurity(pair.FarSecurityName);

                if (nearTab == null || farTab == null)
                {
                    skipped++;
                    SendNewLogMessage(
                        NameStrategyUniq + " [" + pair.Prefix + "]: пропуск — нет вкладки скринера (ближний="
                        + (pair.NearSecurityName ?? "?") + " найден=" + (nearTab != null)
                        + ", дальний=" + (pair.FarSecurityName ?? "?") + " найден=" + (farTab != null)
                        + "). Сначала «Подобрать фьючерсы» и дождитесь загрузки всех вкладок.",
                        LogMessageType.Error);
                    continue;
                }

                decimal volume = GetTradeVolume(nearTab);
                if (volume <= 0m)
                {
                    skipped++;
                    SendNewLogMessage(
                        NameStrategyUniq + " [" + pair.Prefix + "]: объём ноги = 0 — проверьте «Количество позиций в одну сторону».",
                        LogMessageType.Error);
                    continue;
                }

                pair.PairVolume = volume;

                if (GetFirstOpenPosition(nearTab, botType) != null || GetFirstOpenPosition(farTab, botType) != null)
                {
                    skipped++;
                    continue;
                }

                if (TryOpenCalendarPair(pair, nearTab, farTab, volume))
                {
                    opened++;
                }
                else
                {
                    skipped++;
                }
            }

            SendNewLogMessage(
                NameStrategyUniq + ": «Купить пару» — открыто пар: " + opened
                + (skipped > 0 ? ", пропущено/ошибка: " + skipped : string.Empty)
                + " (ближний лонг, дальний шорт, по " + _positionsPerSide.ValueInt + " в сторону).",
                LogMessageType.System);
        }

        /// <summary>Ближний Buy + дальний Sell; при сбое второй ноги пишем причину в лог робота.</summary>
        private bool TryOpenCalendarPair(
            HedgePairState pair,
            BotTabSimple nearTab,
            BotTabSimple farTab,
            decimal volume)
        {
            WaitForTabTradeReady(nearTab, needAsk: true, maxWaitMs: 5000);
            WaitForTabTradeReady(farTab, needAsk: false, maxWaitMs: 5000);

            if (!TryDescribeTabTradeBlock(nearTab, needAsk: true, out string nearBlock))
            {
                SendNewLogMessage(
                    NameStrategyUniq + " [" + pair.Prefix + "]: ближняя нога не готова — " + nearBlock,
                    LogMessageType.Error);
                return false;
            }

            if (!TryDescribeTabTradeBlock(farTab, needAsk: false, out string farBlock))
            {
                SendNewLogMessage(
                    NameStrategyUniq + " [" + pair.Prefix + "]: дальняя нога не готова — " + farBlock,
                    LogMessageType.Error);
                return false;
            }

            Position buyPos = nearTab.BuyAtMarket(volume, "SmartHedgeBuyNear");
            if (buyPos == null)
            {
                SendNewLogMessage(
                    NameStrategyUniq + " [" + pair.Prefix + "]: Buy на ближнем «"
                    + (nearTab.Connector?.SecurityName ?? "?") + "» не отправлен (см. лог вкладки).",
                    LogMessageType.Error);
                return false;
            }

            Position sellPos = farTab.SellAtMarket(volume, "SmartHedgeSellFar");
            if (sellPos == null)
            {
                SendNewLogMessage(
                    NameStrategyUniq + " [" + pair.Prefix + "]: Sell на дальнем «"
                    + (farTab.Connector?.SecurityName ?? "?") + "» не отправлен — часто нет Bid или вкладка ещё не в Trade. "
                    + "Открыт только лонг на ближнем. Повторите «Купить пару» после котировок на дальнем или закройте лонг вручную.",
                    LogMessageType.Error);
                return false;
            }

            SendNewLogMessage(
                NameStrategyUniq + " [" + pair.Prefix + "]: пара открыта — Buy «"
                + (nearTab.Connector?.SecurityName ?? "?") + "», Sell «"
                + (farTab.Connector?.SecurityName ?? "?") + "», объём " + volume.ToString("0.########"),
                LogMessageType.System);
            return true;
        }

        private static void WaitForTabTradeReady(BotTabSimple tab, bool needAsk, int maxWaitMs)
        {
            if (tab?.Connector == null || maxWaitMs <= 0)
            {
                return;
            }

            DateTime deadline = DateTime.Now.AddMilliseconds(maxWaitMs);
            while (DateTime.Now < deadline)
            {
                if (tab.Connector.IsConnected
                    && tab.Connector.IsReadyToTrade
                    && (needAsk ? tab.PriceBestAsk > 0m : tab.PriceBestBid > 0m))
                {
                    return;
                }

                Thread.Sleep(200);
            }
        }

        private static bool TryDescribeTabTradeBlock(BotTabSimple tab, bool needAsk, out string reason)
        {
            reason = string.Empty;
            if (tab == null)
            {
                reason = "вкладка не найдена";
                return false;
            }

            if (tab.Connector == null)
            {
                reason = "нет коннектора";
                return false;
            }

            string name = tab.Connector.SecurityName ?? tab.TabName;

            if (!tab.Connector.IsConnected)
            {
                reason = name + ": нет подключения";
                return false;
            }

            if (!tab.Connector.IsReadyToTrade)
            {
                reason = name + ": коннектор не в режиме Trade (дождитесь загрузки вкладки)";
                return false;
            }

            if (needAsk && tab.PriceBestAsk <= 0m)
            {
                reason = name + ": нет Ask (котировки)";
                return false;
            }

            if (!needAsk && tab.PriceBestBid <= 0m)
            {
                reason = name + ": нет Bid (котировки) — для шорта дальнего нужен Bid";
                return false;
            }

            return true;
        }

        private void ArmAdjustPairsWaiting()
        {
            if (_hedgePairs.Count == 0)
            {
                RebuildPairsFromScreenerSecurities();
            }

            if (_hedgePairs.Count == 0)
            {
                SendNewLogMessage(
                    NameStrategyUniq + ": нет пар — сначала «Подобрать фьючерсы» и «Купить пару».",
                    LogMessageType.Error);
                return;
            }

            EnsureScreenerEventsOn();
            EnsureScreenerCandleInfrastructure();

            _adjustPairsPending = true;
            _adjustProfitByPairPrefix.Clear();
            _adjustCompletedPairPrefixes.Clear();

            SendNewLogMessage(
                NameStrategyUniq + ": «Скорректировать пару (Trail)» — ожидание локального максимума профита. "
                + "Сделки по паре выполнятся, когда на закрытии свечи ноги в плюсе профит станет ниже, чем на пред. свече "
                + "(пока текущий ≥ предыдущего — ждём; первая закрытая свеча только фиксирует базу).",
                LogMessageType.System);
        }

        private void ExecuteAdjustAllPairsImmediately()
        {
            if (_hedgePairs.Count == 0)
            {
                RebuildPairsFromScreenerSecurities();
            }

            if (_hedgePairs.Count == 0)
            {
                SendNewLogMessage(
                    NameStrategyUniq + ": нет пар — сначала «Подобрать фьючерсы» и «Купить пару».",
                    LogMessageType.Error);
                return;
            }

            string botType = GetNameStrategyType();
            int adjusted = 0;
            int skipped = 0;

            for (int i = 0; i < _hedgePairs.Count; i++)
            {
                HedgePairState pair = _hedgePairs[i];

                if (string.IsNullOrWhiteSpace(pair.Prefix))
                {
                    continue;
                }

                BotTabSimple nearTab = FindTabBySecurity(pair.NearSecurityName);
                BotTabSimple farTab = FindTabBySecurity(pair.FarSecurityName);

                if (nearTab == null || farTab == null)
                {
                    skipped++;
                    continue;
                }

                Position nearPos = GetFirstOpenPosition(nearTab, botType);
                Position farPos = GetFirstOpenPosition(farTab, botType);

                if (nearPos == null || farPos == null)
                {
                    skipped++;
                    continue;
                }

                if (!TryResolveProfitAndLossLegs(
                        nearTab, farTab, nearPos, farPos,
                        out BotTabSimple profitTab,
                        out Position profitPos,
                        out BotTabSimple lossTab,
                        out Position lossPos))
                {
                    skipped++;
                    continue;
                }

                if (ExecuteAdjustForPair(pair, profitTab, profitPos, lossTab, lossPos))
                {
                    _adjustCompletedPairPrefixes.Add(pair.Prefix);
                    adjusted++;
                }
            }

            if (!HasOpenPairsWaitingForAdjust())
            {
                _adjustPairsPending = false;
            }

            SendNewLogMessage(
                NameStrategyUniq + ": «Скорректировать пару (сразу)» — скорректировано пар: " + adjusted
                + (skipped > 0 ? ", пропущено (нет обеих ног или вкладок): " + skipped : string.Empty) + ".",
                LogMessageType.System);
        }

        private void TryProcessAdjustPairsOnCandle(BotTabSimple tab)
        {
            if (_hedgePairs.Count == 0)
            {
                RebuildPairsFromScreenerSecurities();
            }

            string botType = GetNameStrategyType();

            for (int i = 0; i < _hedgePairs.Count; i++)
            {
                HedgePairState pair = _hedgePairs[i];

                if (string.IsNullOrWhiteSpace(pair.Prefix)
                    || _adjustCompletedPairPrefixes.Contains(pair.Prefix))
                {
                    continue;
                }

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
                    _adjustCompletedPairPrefixes.Add(pair.Prefix);
                    continue;
                }

                if (nearPos == null || farPos == null)
                {
                    continue;
                }

                if (!TryResolveProfitAndLossLegs(
                        nearTab, farTab, nearPos, farPos,
                        out BotTabSimple profitTab,
                        out Position profitPos,
                        out BotTabSimple lossTab,
                        out Position lossPos))
                {
                    continue;
                }

                if (!ReferenceEquals(tab, profitTab))
                {
                    continue;
                }

                decimal currentProfit = profitPos.ProfitPortfolioAbs;

                if (!_adjustProfitByPairPrefix.TryGetValue(pair.Prefix, out decimal previousProfit))
                {
                    _adjustProfitByPairPrefix[pair.Prefix] = currentProfit;
                    SendNewLogMessage(
                        NameStrategyUniq + " [" + pair.Prefix + "]: Trail — база профита "
                        + currentProfit.ToString("0.########") + " на «"
                        + (profitTab.Connector?.SecurityName ?? "?") + "», ждём снижения на след. свечах.",
                        LogMessageType.System);
                    continue;
                }

                _adjustProfitByPairPrefix[pair.Prefix] = currentProfit;

                if (currentProfit >= previousProfit)
                {
                    continue;
                }

                if (ExecuteAdjustForPair(pair, profitTab, profitPos, lossTab, lossPos))
                {
                    _adjustCompletedPairPrefixes.Add(pair.Prefix);
                }
            }

            if (!HasOpenPairsWaitingForAdjust())
            {
                _adjustPairsPending = false;
            }
        }

        /// <summary>
        /// Профитная нога — с большим P&amp;L (ProfitPortfolioAbs), убыточная — с меньшим.
        /// </summary>
        private static bool TryResolveProfitAndLossLegs(
            BotTabSimple nearTab,
            BotTabSimple farTab,
            Position nearPos,
            Position farPos,
            out BotTabSimple profitTab,
            out Position profitPos,
            out BotTabSimple lossTab,
            out Position lossPos)
        {
            profitTab = null;
            profitPos = null;
            lossTab = null;
            lossPos = null;

            if (nearTab == null || farTab == null || nearPos == null || farPos == null)
            {
                return false;
            }

            decimal nearProfit = nearPos.ProfitPortfolioAbs;
            decimal farProfit = farPos.ProfitPortfolioAbs;

            if (nearProfit > farProfit)
            {
                profitTab = nearTab;
                profitPos = nearPos;
                lossTab = farTab;
                lossPos = farPos;
            }
            else if (farProfit > nearProfit)
            {
                profitTab = farTab;
                profitPos = farPos;
                lossTab = nearTab;
                lossPos = nearPos;
            }
            else
            {
                profitTab = nearTab;
                profitPos = nearPos;
                lossTab = farTab;
                lossPos = farPos;
            }

            return profitTab != null && lossTab != null && profitPos != null && lossPos != null;
        }

        private bool HasOpenPairsWaitingForAdjust()
        {
            string botType = GetNameStrategyType();

            for (int i = 0; i < _hedgePairs.Count; i++)
            {
                HedgePairState pair = _hedgePairs[i];

                if (string.IsNullOrWhiteSpace(pair.Prefix)
                    || _adjustCompletedPairPrefixes.Contains(pair.Prefix))
                {
                    continue;
                }

                BotTabSimple nearTab = FindTabBySecurity(pair.NearSecurityName);
                BotTabSimple farTab = FindTabBySecurity(pair.FarSecurityName);

                if (nearTab == null || farTab == null)
                {
                    continue;
                }

                Position nearPos = GetFirstOpenPosition(nearTab, botType);
                Position farPos = GetFirstOpenPosition(farTab, botType);

                if (nearPos != null && farPos != null)
                {
                    return true;
                }
            }

            return false;
        }

        private bool ExecuteAdjustForPair(
            HedgePairState pair,
            BotTabSimple profitTab,
            Position profitPos,
            BotTabSimple lossTab,
            Position lossPos)
        {
            string botType = GetNameStrategyType();
            decimal sideVol = pair.PairVolume > 0m ? pair.PairVolume : GetTradeVolume(lossTab);
            decimal profitBefore = profitPos.ProfitPortfolioAbs;
            decimal lossBefore = lossPos.ProfitPortfolioAbs;
            decimal lossOpenBefore = lossPos.OpenVolume;

            CloseAllBotOpenPositionsOnTab(profitTab, botType, "SmartHedgeCloseProfit");

            decimal addVol = GetAddVolumeForLossLeg(lossTab, sideVol);

            if (addVol > 0m)
            {
                AddToOpenPosition(lossTab, lossPos, addVol, "SmartHedgeAddToLoss");
            }

            string profitName = profitTab.Connector?.SecurityName ?? "?";
            string lossName = lossTab.Connector?.SecurityName ?? "?";
            string lossSide = lossPos.Direction == Side.Buy ? "лонг" : "шорт";
            SendNewLogMessage(
                NameStrategyUniq + " [" + pair.Prefix + "]: коррекция — закрыта профитная «" + profitName
                + "» (P/L " + profitBefore.ToString("0.########") + "), на убыточную «" + lossName + "» "
                + lossSide + " +" + addVol.ToString("0.########") + " (P/L " + lossBefore.ToString("0.########")
                + ", было " + lossOpenBefore.ToString("0.########") + " контр., ожидается "
                + (lossOpenBefore + addVol).ToString("0.########") + ").",
                LogMessageType.System);
            return true;
        }

        private static void AddToOpenPosition(BotTabSimple tab, Position pos, decimal volume, string signal)
        {
            if (tab == null || pos == null || volume <= 0m || pos.State != PositionStateType.Open)
            {
                return;
            }

            if (pos.Direction == Side.Buy)
            {
                tab.BuyAtMarketToPosition(pos, volume, signal);
            }
            else
            {
                tab.SellAtMarketToPosition(pos, volume, signal);
            }
        }

        private void CloseAllBotOpenPositionsOnTab(BotTabSimple tab, string botType, string signal)
        {
            if (tab?.PositionsOpenAll == null)
            {
                return;
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

                tab.CloseAtMarket(pos, pos.OpenVolume, signal);
            }
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
                if (prefix.Length < MinPrefixLengthForStartsWithMatch)
                {
                    continue;
                }

                List<Security> matched = new List<Security>();

                for (int i = 0; i < _screenerTab.SecuritiesNames.Count; i++)
                {
                    ActivatedSecurity act = _screenerTab.SecuritiesNames[i];
                    if (act == null || !act.IsOn)
                    {
                        continue;
                    }

                    Security sec = FindSecurityByName(server, act.SecurityName);
                    if (sec != null && SecurityMatchesExactFuturesRoot(sec, prefix))
                    {
                        matched.Add(sec);
                    }
                }

                if (!TrySelectNearAndFarByExpiration(matched, out Security near, out Security far, out _))
                {
                    continue;
                }

                _hedgePairs.Add(new HedgePairState
                {
                    Prefix = prefix,
                    NearSecurityName = near.Name,
                    FarSecurityName = far.Name
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

        /// <summary>Объём одной ноги пары (кнопка «Купить пару»).</summary>
        private decimal GetTradeVolume(BotTabSimple tab)
        {
            if (tab == null)
            {
                return 0m;
            }

            if (_volumeType.ValueString == "Contracts")
            {
                return RoundVolume(tab, _positionsPerSide.ValueInt);
            }

            return GetVolumeByMoneySettings(tab);
        }

        /// <summary>Докупка на убыточную ногу: 1 контракт при объёме пары 3 (1/3 от ноги).</summary>
        private decimal GetAddVolumeForLossLeg(BotTabSimple tab, decimal sideVolume)
        {
            if (tab == null || sideVolume <= 0m)
            {
                return RoundVolume(tab, 1m);
            }

            decimal raw = sideVolume / 3m;
            if (raw < 1m)
            {
                raw = 1m;
            }

            return RoundVolume(tab, raw);
        }

        private decimal GetVolumeByMoneySettings(BotTabSimple tab)
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

        private decimal GetVolume(BotTabSimple tab)
        {
            return GetTradeVolume(tab);
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
            return SecurityMatchesExactFuturesRoot(sec, prefix);
        }

        private static bool RootMatchesExpandedPrefix(string root, string expandedPrefix)
        {
            if (string.IsNullOrEmpty(root) || string.IsNullOrWhiteSpace(expandedPrefix))
            {
                return false;
            }

            expandedPrefix = expandedPrefix.Trim();

            if (string.Equals(root, expandedPrefix, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            // Доллар Si: только корень «Si», без SILV/S0/SOFL (не StartsWith).
            if (string.Equals(expandedPrefix, "Si", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            // BR → BRM и т.п.: корень длиннее префикса, та же серия FORTS.
            if (expandedPrefix.Length >= MinPrefixLengthForStartsWithMatch
                && root.Length > expandedPrefix.Length
                && root.StartsWith(expandedPrefix, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            return false;
        }

        private static bool TickerMatchesPrefix(string ticker, string userPrefix)
        {
            string norm = NormalizeTicker(ticker);
            if (string.IsNullOrEmpty(norm))
            {
                return false;
            }

            string root = ExtractLetterRoot(norm);
            if (root.Length == 0)
            {
                return false;
            }

            foreach (string expanded in ExpandPrefixAliases(userPrefix))
            {
                if (RootMatchesExpandedPrefix(root, expanded))
                {
                    return true;
                }

                if (expanded.Length >= 6
                    && norm.StartsWith(expanded, StringComparison.OrdinalIgnoreCase))
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
