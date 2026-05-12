/*
* Your rights to use code governed by this license https://github.com/AlexWan/OsEngine/blob/master/LICENSE
* Ваши права на использование кода регулируются данной лицензией http://o-s-a.net/doc/license_simple_engine.pdf
*/
using System;
using System.Collections.Generic;
using OsEngine.Entity;
using OsEngine.Indicators;
using OsEngine.Market.Servers;
using OsEngine.Market;
using OsEngine.OsTrader.Panels;
using OsEngine.OsTrader.Panels.Attributes;
using OsEngine.OsTrader.Panels.Tab;
using System.IO;
using System.Globalization;
using OsEngine.Language;
using System.Drawing;
using System.Net.Http.Headers;
using System.ComponentModel;
using System.Linq.Expressions;
using System.Net;

//using System.ComponentModel.DataAnnotations.Schema;
/* 
Total Trail Stop  (TTSL)
  - параметр - сумма портфеля для TTSL. Параметры TSLPERCENT (он же процент для трайла вверх) 
  - on candle finish - если портфель меньше ttslSum 
     -LogicStop(AndInverse) - все продать, записать дату остановки, в _info суммы тек портфеля
  - логика входов и выходов - если есть дата остановки - вместо входов-выходов запись в _info += текущего фейкового дохода-расхода
                            - возврат из фейк режима - если _info > ttslSum (1+TSLPERCENT/100) vs просто ждать фикс
------------------------------------
Логики по существу
  - G>R 
  - Для пары - ищем самую давно не встречавшуюся комбинацию GG RR GR RG (срок давности - интервал от и до). Вход G=>B R=>S Выход есло комб встетилась в течении N свечей (парам)
  - Для полигона - естественное обобщение предыдущей. "colored candels"
------------------------------------
когда перетестить
поиск крюков           
---------------------------------
Робот - CCR - из tmonRebalancer
Сканирует всплеск и закупается.ТФ частый
Параметры - Управление -МаксСумПортф, ПроцВключенияПорог, TTP,  TSL, TrailPercent (тащит стоп и профит вверх), 
            Mess - {покупать, продавать, выкл}. 
            Инф - Портфель, Проц изменения портф за посл свечу, Процент изменения наблюдаемых за посл свечу
Алгоритм
  Скринер 1 - быстрый - индекс либо базовые бумаги ("наблюдаемые")
     - Вычисляет и пишер Инф и Месс параметры
     - Mess - покупать - по ПроцВключенияПорог от портф < Процент изменения наблюдаемых 
              , продавать - по TTP и TSL портфеля.
  Скринер 2 - "торгуемые". Трендовый.Логика по индикатору + фильтр cma + стадии волат + мб новый колво свечей
     Mess = покупать - работает по своим фильтрам и индикаторамъ
            продавать - все закрывает по рынку и если позиций нет - закупает tmon на МаксСумПортф (либо тек портф)
*/
namespace OsEngine.Robots.AlgoStart
{
[Bot("RzStrategyByPrevailCandles")]
public class RzStrategyByPrevailCandles : BotPanel
{
private BotTabScreener _tabScreenerFast;
private BotTabScreener _tabScreener1;
//...
private BotTabScreener _tabScreenerSlow;
// Basic settings
private StrategyParameterString _regime;
private StrategyParameterInt _icebergCount;
private StrategyParameterInt _maxPositions;
private StrategyParameterInt _clusterToTrade;
private StrategyParameterInt _clustersLookBack;
private StrategyParameterButton _clusterShowLast;
private StrategyParameterDecimal _procHeightTake;
private StrategyParameterDecimal _procHeightStop;

// Basic settings
private StrategyParameterString _volumeType;
private StrategyParameterDecimal _volume;
private StrategyParameterString _tradeAssetInPortfolio;
// Volatility settings
private StrategyParameterInt _daysVolatilityAdaptive;

private StrategyParameterDecimal _heightSoldiersVolaPercent;
// SmaFilter settings
private StrategyParameterBool _smaFilterIsOn;
private StrategyParameterInt _smaFilterLen;
private StrategyParameterString _buySellMode;
private StrategyParameterString _logicType; //new для возможности инверсии логики 
private StrategyParameterInt _candlePrevailsLen; //new
private StrategyParameterInt _candlePrevailsPorog; //new
private StrategyParameterDecimal _info_portffolio;//n
private StrategyParameterDecimal _info_fakePortffolio;//newew
private StrategyParameterDecimal _portffolioMinTotalSL;//new
private StrategyParameterString _riskManager; //вкл выкл крышу
private StrategyParameterDecimal _portffolioBySomeDaysBefore;//new
private StrategyParameterString _datePortffolioBySomeDaysBefore; //new
private StrategyParameterInt _portffolioSlowRithmMuliplySomeDaysBefore;//new 
private StrategyParameterString _dateStopToRetest; //new
private StrategyParameterString _dateBeginWork; //new
private StrategyParameterDecimal _totalTrailPercent; //new тащим сумму полтфеля для общего стоплосса скачками на этот процент
private StrategyParameterInt _daysWaitingAfterLoss;
private StrategyParameterString _info; //new  общая информация для отладки и информирования о статусах робота 
// private int _minTf; //установленный таймрейм (т.е. более мелкие свечи недоступны)
private StrategyParameterString _timeframe; //таймфрейм можно установить любой крупнее или равный текущего 
//параметры индикатора линейной регрессии
private StrategyParameterInt _lrLength;
private StrategyParameterDecimal _lrDeviation;
private StrategyParameterDecimal _selfEma; //ema всего портфеля
//private StrategyParameterString _selfCandles;//цены собственного портфеля на  том же тф - строка разделенная пробелом
private StrategyParameterInt _maxClosesWaitingPortfLessSelfEma; //при закрытии позиции если портфель ниже своей средней - не обращаем логику столько раз
private StrategyParameterInt _currClosesWaitingPortfLessSelfEma; //при закрытии позиции счетчик - сколько раз мы ниже средней

private StrategyParameterInt _selfCandlesLength;//хранить столько цен назад

//private StrategyParameterString _volumeType;
//
//private List<Candle> _seniorCandles  = new  List<Candle>(); //new
int _seniorStep = 1;// new колво свечей младшего тф в старшем (выбранном в параметре)
//private Aindicator _rsi;
public enum Timeframes  { //секунды единицы таймфреймов
  M1 = 60,
  M2 = 120,
  M3 = 180,
  M5 = 300,
  M10 = 600,
  M15 = 900,
  M30 = 1800,
  H1 = 3600,
  H2 = 7200,
  H4 = 14400,
  D1 = 86400
};
// Trade periods
private NonTradePeriods _tradePeriodsSettings;
private StrategyParameterButton _tradePeriodsShowDialogButton;
public RzStrategyByPrevailCandles(string name, StartProgram startProgram) : base(name, startProgram)
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
TabCreate(BotTabType.Screener);
//..
TabCreate(BotTabType.Screener);
_tabScreenerFast = TabsScreener[0]; //"крыша" - реализует TTSL и мб вывод (закупки фондов)  части профита. ! Ставить ему минимальный ТФ
_tabScreener1 = TabsScreener[1];
// Create indicator LinearRegressionChannelFast_Indicator
_lrLength = CreateParameter("Linear regression Length", 180, 20, 300, 10);
_lrDeviation = CreateParameter("Linear regression deviation", 4.4m, 1, 4, 0.1m);
_tabScreener1.CreateCandleIndicator(1, "LinearRegressionChannelFast_Indicator", new List<string>() { _lrLength.ValueInt.ToString(), "Close", _lrDeviation.ValueDecimal.ToString(), _lrDeviation.ValueDecimal.ToString() }, "Prime");
_tabScreener1.CreateCandleIndicator(2, "Bollinger", new List<string>() { "100" ,"2"}, "Prime");


//_selfCandles =  CreateParameter("Портфель на прошлых свечах", "");
_selfEma = CreateParameter("Ema портфеля", 0m, 1, 4, 0.001m);
_selfCandlesLength = CreateParameter("Период для расчета собственного Ema, штук", 20, 20, 300, 10); 
_maxClosesWaitingPortfLessSelfEma  = CreateParameter("При закрытии позиции если портфель ниже средней выждать, раз", 10, 0, 20, 1);
_currClosesWaitingPortfLessSelfEma  = CreateParameter("При закрытии позиции если портфель ниже средней выждали (тек.значение), раз", 0, 0, 20, 1);

//Create indicator RSI
_tabScreener1.CreateCandleIndicator(3, "RSI", new List<string>() { "25" }, "Second");
/*
_rsi = IndicatorsFactory.CreateIndicatorByName("RSI", name + "RSI", false);
_rsi = (Aindicator)_tabScreener1.CreateCandleIndicator(_rsi, "RsiArea");
((IndicatorParameterInt)_rsi.Parameters[0]).ValueInt = 20;
_rsi.DataSeries[0].Color = Color.Gold;
_rsi.Save();
*/

//...
_tabScreenerSlow = TabsScreener[2]; //..2 -> .. ежедневный или реже - для фиксации портфеля и профита 
// Subscribe to the candle finished event
_tabScreenerFast.CandleFinishedEvent += _tab_CandleFinishedEventFast;
_tabScreener1.CandleFinishedEvent += _tab_CandleFinishedEvent1;
_tabScreenerFast.CandleFinishedEvent += _tab_CandleFinishedEventSlow;
// Basic settings
_regime = CreateParameter("Regime", "Off", new[] { "Off", "On"});
_icebergCount = CreateParameter("Iceberg orders count", 1, 1, 3, 1);
_maxPositions = CreateParameter("Max positions", 10, 0, 20, 1);
_clusterToTrade = CreateParameter("Volatility cluster to trade", 2, 1, 3, 1); //! 3->2
_clustersLookBack = CreateParameter("Volatility cluster lookBack", 80, 10, 300, 1);
_clusterShowLast = CreateParameterButton("Show last clusters");
_clusterShowLast.UserClickOnButtonEvent += _clusterShowLast_UserClickOnButtonEvent;
_procHeightTake = CreateParameter("Profit % from height of pattern", 185m, 0, 20, 1m);
_procHeightStop = CreateParameter("Stop % from height of pattern", 106m, 0, 20, 1m);
_tradePeriodsShowDialogButton = CreateParameterButton("Non trade periods");
_tradePeriodsShowDialogButton.UserClickOnButtonEvent += _tradePeriodsShowDialogButton_UserClickOnButtonEvent;
// GetVolume settings
_volumeType = CreateParameter("Volume type", "Deposit percent", new[] { "Contracts", "Contract currency", "Deposit percent" });
_volume = CreateParameter("Volume", 10, 1.0m, 50, 4);
_tradeAssetInPortfolio = CreateParameter("Asset in portfolio", "Prime");
// Volatility settings
_daysVolatilityAdaptive = CreateParameter("Days volatility adaptive", 7, 0, 20, 1);
_heightSoldiersVolaPercent = CreateParameter("Height soldiers volatility percent", 80, 0, 20, 1m);
// SmaFilter settings
_smaFilterIsOn = CreateParameter("Sma filter is on", true);
_smaFilterLen = CreateParameter("Sma filter Len", 150, 10, 300, 10);
//new
_candlePrevailsLen = CreateParameter("Green more Red total looking count", 20, 0, 20, 1);
_candlePrevailsPorog = CreateParameter("Green more than Red by", 3, 0, 20, 1);



_buySellMode = CreateParameter("Buysell mode", "OnlyBuy", new[] { "OnlyBuy", "OnlySell", "BuyAndSell" });
_logicType = CreateParameter("Buy - стандартная логика, Sell - инверсия логики", "OpenIsBuy", new[] { "OpenIsBuy", "OpenIsSell" }); //new
_timeframe = CreateParameter("Timeframe", "H1", new[] {"M1","M2","M3","M5","M10","M15","H1","H4","D1" }); 
_info_fakePortffolio =CreateParameter("Fake портфель(инфо)", 0m, 0, 20, 1m);
_info_portffolio =CreateParameter("Портфель(инфо)", 0m, 0, 20, 1m);
_portffolioMinTotalSL = CreateParameter("MWhen less then TOTAL STOP LOSS AND INVERSE", 900000m, 0, 20, 1m);
_portffolioBySomeDaysBefore = CreateParameter("Прошлый портфель для сравнения и фикса", 900000m, 0, 20, 1m);
_datePortffolioBySomeDaysBefore = CreateParameter(" Дата прошлого портфеля для сравнения и фикса", "");//new
_datePortffolioBySomeDaysBefore.ValueString = DateTime.MinValue.ToString("dd.MM.yyyy");
_portffolioSlowRithmMuliplySomeDaysBefore = CreateParameter("Перезапись портфеля для фикса в базовом ритме умнож на этот коэф", 1, 10, 300, 10);
_dateStopToRetest = CreateParameter("Robot is in retesting since", "");//new
//_dateStopToRetest.ValueString =  ""; //new
_dateBeginWork = CreateParameter("Start date", DateTime.Now.ToString("dd.MM.yyyy")); //new
_totalTrailPercent = CreateParameter("Percent when min sum portfolio is increased", 0.5m, 0, 100, 0.01m);//new
_daysWaitingAfterLoss  = CreateParameter("После убытка выждать, дней", 10, 0, 20, 1);
_riskManager = CreateParameter("Тестовый Total SL and TP", "Off", new[] { "Off", "On"});
_info = CreateParameter("Info", "");//new


if (startProgram == StartProgram.IsOsTrader)
{
  LoadTradeSettings();
}
Description = OsLocalization.Description.DescriptionLabel325;
DeleteEvent += RzStrategyByPrevailCandles_DeleteEvent;
}
private void _tradePeriodsShowDialogButton_UserClickOnButtonEvent()
{
  _tradePeriodsSettings.ShowDialog();
}
// Volatility adaptation
private VolatilityStageClusters _volatilityStageClusters = new VolatilityStageClusters();
private DateTime _lastTimeSetClusters;
private List<SecuritiesTradeSettings> _tradeSettings = new List<SecuritiesTradeSettings>();
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
// save settings in .txt file
private void SaveTradeSettings()
{
  try
  {
    using (StreamWriter writer = new StreamWriter(@"Engine\" + NameStrategyUniq + @"SettingsBot.txt", false)
    )
    {
    for (int i = 0; i < _tradeSettings.Count; i++)
    {
      writer.WriteLine(_tradeSettings[i].GetSaveString());
    }
    writer.Close();
    }
  }
  catch (Exception)
  {
    // ignore
  }
}
// Load settins from .txt file
private void LoadTradeSettings()
{
  if (!File.Exists(@"Engine\" + NameStrategyUniq + @"SettingsBot.txt"))
  {
    return;
  }
  try
  {
  using (StreamReader reader = new StreamReader(@"Engine\" + NameStrategyUniq + @"SettingsBot.txt"))
  {
    while (reader.EndOfStream == false)
    {
      string line = reader.ReadLine();
      if (string.IsNullOrEmpty(line))
      {
        continue;
      }
      SecuritiesTradeSettings newSettings = new SecuritiesTradeSettings();
      newSettings.LoadFromString(line);
      _tradeSettings.Add(newSettings);
    }
    reader.Close();
  }
  }
  catch (Exception)
  {
  // ignore
  }
}
// Delete save file
private void RzStrategyByPrevailCandles_DeleteEvent()
{
  try
  {
    _tradePeriodsSettings.Delete();
    if (File.Exists(@"Engine\" + NameStrategyUniq + @"SettingsBot.txt"))
    {
      File.Delete(@"Engine\" + NameStrategyUniq + @"SettingsBot.txt");
    }
  }
  catch (Exception)
  {
    // ignore
  }
}
private void AdaptSoldiersHeight(List<Candle> candles, SecuritiesTradeSettings settings)
{
  if (_daysVolatilityAdaptive.ValueInt <= 0
  || _heightSoldiersVolaPercent.ValueDecimal <= 0)
  {
    return;
  }
  // 1 we calculate the movement from high to low within N days
  decimal minValueInDay = decimal.MaxValue;
  decimal maxValueInDay = decimal.MinValue;
  List<decimal> volaInDaysPercent = new List<decimal>();
  DateTime date = candles[candles.Count - 1].TimeStart.Date;
  int days = 0;
  for (int i = candles.Count - 1; i >= 0; i--)
  {
    Candle curCandle = candles[i];
    if (curCandle.TimeStart.Date < date)
    {
      date = curCandle.TimeStart.Date;
      days++;
      decimal volaAbsToday = maxValueInDay - minValueInDay;
      decimal volaPercentToday = volaAbsToday / (minValueInDay / 100);
      volaInDaysPercent.Add(volaPercentToday);
      minValueInDay = decimal.MaxValue;
      maxValueInDay = decimal.MinValue;
    }
    if (days >= _daysVolatilityAdaptive.ValueInt)
    {
      break;
    }
    if (curCandle.High > maxValueInDay)
    {
      maxValueInDay = curCandle.High;
    }
    if (curCandle.Low < minValueInDay)
    {
      minValueInDay = curCandle.Low;
    }
    if (i == 0)
    {
      days++;
      decimal volaAbsToday = maxValueInDay - minValueInDay;
      decimal volaPercentToday = volaAbsToday / (minValueInDay / 100);
      volaInDaysPercent.Add(volaPercentToday);
    }
  }
  if (volaInDaysPercent.Count == 0)
  {
    return;
  }
  // 2 we average this movement. We need average volatility percentage
  decimal volaPercentSma = 0;
  for (int i = 0; i < volaInDaysPercent.Count; i++)
  {
    volaPercentSma += volaInDaysPercent[i];
  }
  volaPercentSma = volaPercentSma / volaInDaysPercent.Count;
  // 3 we calculate the size of the candles taking this volatility into account
  decimal allSoldiersHeight = volaPercentSma * (_heightSoldiersVolaPercent.ValueDecimal / 100);
  settings.HeightSoldiers = allSoldiersHeight;
  settings.LastUpdateTime = candles[candles.Count - 1].TimeStart;
}

//new!!! сколько свечей младшего ТФ (в сете) в старшей (выбран в параметрах)// вычленяет лист свечей старшего тф 
private void getSeniorStep(List<Candle> candles)
{  if(candles.Count < 2)
   {
      _seniorStep = 1;
      return;
   }  //_seniorCandles = candles;
   int seniorSeconds = 0;
   switch (_timeframe.ValueString)
   {
      case "M1": 
        seniorSeconds = (int)Timeframes.M1;
        break;
      case "M2": 
        seniorSeconds = (int)Timeframes.M2;
        break;
      case "M3": 
        seniorSeconds = (int)Timeframes.M3;
        break;
      case "M5": 
        seniorSeconds = (int)Timeframes.M5;
        break;
      case "H1": 
        seniorSeconds = (int)Timeframes.H1;
        break;
      case "H2": 
        seniorSeconds = (int)Timeframes.H2;
        break;
      case "H4": 
        seniorSeconds = (int)Timeframes.H4;
        break;                                                
      case "D1": 
        seniorSeconds = (int)Timeframes.D1;
        break;
   }   
   int step = 1;//... определить step из соотношения  _timeframe.ValueString и тф свечей
   int diff = (int)(candles[candles.Count - 1].TimeStart - candles[candles.Count - 2].TimeStart).TotalSeconds;
   _seniorStep = (int)(seniorSeconds / diff);
   if (_seniorStep == 0) _seniorStep = 1; 
   ////List<Candle> seniorCandles = new  List<Candle>(); 
   //_seniorCandles.Clear();
   //for (int i = candles.Count - 1; i >= 0; i -= step)
   //{
   //  if(i >= 0) _seniorCandles.Insert(0,candles[i]);
   //}
   //_seniorCandles = candles;//??
   //_info.ValueString = (step) .ToString() +"   candles.Count="+ (candles.Count).ToString();
   return;// seniorCandles;     
}

private void checkLogic(BotTabSimple tab) //мб B <-> S _maxClosesWaitingPortfLessSelfEma
{
  if (tab.Portfolio.ValueCurrent < _selfEma.ValueDecimal){
    if (_currClosesWaitingPortfLessSelfEma.ValueInt < _maxClosesWaitingPortfLessSelfEma.ValueInt){
      _currClosesWaitingPortfLessSelfEma.ValueInt++;
    } else {
      _currClosesWaitingPortfLessSelfEma.ValueInt = 0;
      changeLogic();
    }
  }
  return;
}
private void changeLogic() //Open Buy <-> Sell
{
  if(_logicType.ValueString == "OpenIsBuy") {_logicType.ValueString = "OpenIsSell";} else {_logicType.ValueString = "OpenIsBuy";}
  return;
}

private void totalClose()
{
  for (int i = 0; i < _tabScreener1.Tabs.Count; i++)
  {
    if (_tabScreener1.Tabs[i].PositionsOpenAll.Count != 0)
    {
      Position pos = _tabScreener1.Tabs[i].PositionsOpenAll[0];
      if(pos.State == PositionStateType.Open)
      {
        _tabScreener1.Tabs[i].CloseAtMarket(pos, pos.OpenVolume);
      }
    }
  }     
    //! повторить для других _tabScreener.. если появятся  
    return;
}
//far data
private void _tab_CandleFinishedEventSlow(List<Candle> candles, BotTabSimple tab)
{  
  if (_regime.ValueString == "Off")
  {
    return;
  }

  DateTime dt = DateTime.Now;
  int kMult = 1;
  try
  {
    kMult = _portffolioSlowRithmMuliplySomeDaysBefore.ValueInt; 
  } 
  catch{}    
  try
  {
      dt = DateTime.ParseExact(_datePortffolioBySomeDaysBefore.ValueString, "dd.MM.yyyy", CultureInfo.InvariantCulture);
      if ((DateTime.Now - dt).TotalDays >= (1 * kMult)) 
      {
        _portffolioBySomeDaysBefore.ValueDecimal =   tab.Portfolio.ValueCurrent;
        _datePortffolioBySomeDaysBefore.ValueString = candles[^1].TimeStart.ToString("dd.MM.yyyy");
      }
  }    
  catch
  {
    _portffolioBySomeDaysBefore.ValueDecimal =   tab.Portfolio.ValueCurrent;
    _datePortffolioBySomeDaysBefore.ValueString = DateTime.MinValue.ToString("dd.MM.yyyy");
  }
 
  return;

}

//root logic
private void _tab_CandleFinishedEventFast(List<Candle> candles, BotTabSimple tab)
{
  //_info.ValueString = "root's here   " + (tab.Portfolio.ValueCurrent).ToString();//"   _seniorStep="+ (_seniorStep).ToString();

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

  SecuritiesTradeSettings mySettings = null;
  for (int i = 0; i < _tradeSettings.Count; i++)
  {
    if (_tradeSettings[i].SecName == tab.Security.Name &&
    _tradeSettings[i].SecClass == tab.Security.NameClass)
    {
      mySettings = _tradeSettings[i];
      break;
    }
  }
  if (mySettings == null)
  {
    mySettings = new SecuritiesTradeSettings();
    mySettings.SecName = tab.Security.Name;
    mySettings.SecClass = tab.Security.NameClass;
    _tradeSettings.Add(mySettings);
  }
  
  Portfolio myPortfolio = tab.Portfolio;
  if (myPortfolio == null)
  {
    return;
  }
  _info_portffolio.ValueDecimal = myPortfolio.ValueCurrent;
  
  bool lossTTSL = (myPortfolio.ValueCurrent < _portffolioMinTotalSL.ValueDecimal * ((100m - _totalTrailPercent.ValueDecimal) / 100m));
  //5m*_totalTrailPercent.ValueDecimal  !! мб другой пар для профита
  bool fixProfitTTSL = (myPortfolio.ValueCurrent >  _portffolioBySomeDaysBefore.ValueDecimal * ((100m + 3m*_totalTrailPercent.ValueDecimal) / 100m));
  bool moreTTSL = (myPortfolio.ValueCurrent > _portffolioMinTotalSL.ValueDecimal * ((100m + _totalTrailPercent.ValueDecimal) / 100m));
  bool fakeMode = (_dateStopToRetest.ValueString != "");
  if (/*lossTTSL && */fakeMode)
  { 
    try
    {
      DateTime dt = DateTime.ParseExact(_dateStopToRetest.ValueString, "dd.MM.yyyy", CultureInfo.InvariantCulture);
      /*!
      if ((DateTime.Now - dt).TotalDays >= _daysWaitingAfterLoss.ValueInt) //ЖДЕМ .. ДНЕЙ - ... ВРЕМЕННОЕ ...
      {
        _dateStopToRetest.ValueString = "";
        return;    
      }*/
    } catch {}
        
  }

  if (moreTTSL) //переводим TSL вверх (sic! 100m -)
  {
    if (fixProfitTTSL && (_riskManager.ValueString == "On")) totalClose();
    _portffolioMinTotalSL.ValueDecimal =  myPortfolio.ValueCurrent * (100m - _totalTrailPercent.ValueDecimal) / 100m;
  }

  if (lossTTSL && (_riskManager.ValueString == "On")) //Продать все по рынку
  {
    totalClose();
    _dateStopToRetest.ValueString = candles[candles.Count - 1].TimeStart.ToString("dd.MM.yyyy");

    //переводим TSL ниже текущего портфеля на процент TTSL
    //_portffolioMinTotalSL.ValueDecimal =  myPortfolio.ValueCurrent * ((100m - _totalTrailPercent.ValueDecimal) / 100m);// 0.9m;  //?????
    _info.ValueString = "TSL";
    //INVERSION
    //!! if(_logicType.ValueString == "OpenIsBuy") {_logicType.ValueString = "OpenIsSell";} else {_logicType.ValueString = "OpenIsBuy";}

  }

  return;

}

// logic
private void _tab_CandleFinishedEvent1(List<Candle> candles, BotTabSimple tab)
{ 
  //записываем  ema собственного портфеля
  _selfEma.ValueDecimal = (tab.Portfolio.ValueCurrent - _selfEma.ValueDecimal) * 2m / (1m + _selfCandlesLength.ValueInt) + _selfEma.ValueDecimal;
  /*_selfCandles.ValueString += " " + Math.Round(tab.Portfolio.ValueCurrent,8).ToString(); 
  string[] aSelfPrices = _selfCandles.ValueString.Split(" ");
  int cnt = aSelfPrices.Length;
  if (cnt < C){
    Array.Resize(ref aSelfPrices, aSelfPrices.Length - 1);
    _selfCandles.ValueString += string.Join(" ", aSelfPrices); 
  }  */

 getSeniorStep(candles);//!!!! new
 // _info.ValueString = "   _seniorStep="+ (_seniorStep).ToString();

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
      _volatilityStageClusters.Calculate(_tabScreener1.Tabs, _clustersLookBack.ValueInt);
      _lastTimeSetClusters = candles[^1].TimeStart;
    }
    if (_clusterToTrade.ValueInt == 1)
    {
      if (_volatilityStageClusters.ClusterOne.Find(source => source.Connector.SecurityName == tab.Connector.SecurityName) == null)
      {
        //if (false)//!!!! 
        return;
      }
    }
    else if (_clusterToTrade.ValueInt == 2)
    {
      if (_volatilityStageClusters.ClusterTwo.Find(source => source.Connector.SecurityName == tab.Connector.SecurityName) == null)
      {
        //if (false)//!!!! 
        return;
      }
    }
    else if (_clusterToTrade.ValueInt == 3)
    {
      if (_volatilityStageClusters.ClusterThree.Find(source => source.Connector.SecurityName == tab.Connector.SecurityName) == null)
      {
        //if (false)//!!!! 
        return;
      }
    }
    else
    {
      return;
    }
  }
  SecuritiesTradeSettings mySettings = null;
  for (int i = 0; i < _tradeSettings.Count; i++)
  {
    if (_tradeSettings[i].SecName == tab.Security.Name &&
    _tradeSettings[i].SecClass == tab.Security.NameClass)
    {
      mySettings = _tradeSettings[i];
      break;
    }
  }
  if (mySettings == null)
  {
    mySettings = new SecuritiesTradeSettings();
    mySettings.SecName = tab.Security.Name;
    mySettings.SecClass = tab.Security.NameClass;
    _tradeSettings.Add(mySettings);
  }
  if (mySettings.LastUpdateTime.Date != candles[candles.Count - 1].TimeStart.Date)
  {
    AdaptSoldiersHeight(candles, mySettings); //!!!!!!!!??????
    if (tab.StartProgram == StartProgram.IsOsTrader)
    {
      SaveTradeSettings();
    }
  }
  if (mySettings.HeightSoldiers == 0)
  {
    return;
  }

  Logic(candles, tab, mySettings);

}
// Logic
private void Logic(List<Candle> candles, BotTabSimple tab, SecuritiesTradeSettings settings)
{
  if (candles.Count < 5)
  {
    return;
  }
  //!!!!!!!!!!!!!!!!!!!!!!! ОСТАЕТСЯ НА МЛАДШЕМ ТФ
  bool fakeMode = (_dateStopToRetest.ValueString != "");
  if (!fakeMode) _info_fakePortffolio.ValueDecimal = _info_portffolio.ValueDecimal;
  //if ((_dateStopToRetest.ValueString != "")) return;
  //if (LogicTotalStopAndInverse(candles, tab)) return; //!!!!! TOTAL SL AND INVERSE
  //! ТЕСТИТЬ.. КОЭФ К МИН ТФ И ПР..  if (!isCandeleInTF(candles[candles.Count - 1], _timeframe.ValueString)) return; //!!! NEW ТОЛЬКО НА ТФ ИЗ ПАРАМЕТРОВ !!!
  //!!!!!!!!!!!!!!!!!!!!!!!!!
  List<Position> openPositions = tab.PositionsOpenAll;
  if (openPositions == null || openPositions.Count == 0)
  {
    string spos = LogicOpenPosition(candles, tab, settings, fakeMode);
  }
  else
  {
    bool fl = LogicClosePosition(candles, tab, fakeMode);
  }
}
// Opening position logic
//"" "buy" "sell"
private string LogicOpenPosition(List<Candle> candles, BotTabSimple tab, SecuritiesTradeSettings settings, bool fakeMode = false)
{
  //int[] ai = GetRangeIndices([76,99,89,765,89], 3);
    
  if (_tabScreener1.PositionsOpenAll.Count >= _maxPositions.ValueInt)
  {
    return "";
  }
  Aindicator lrIndicator = (Aindicator)tab.Indicators[0];
  decimal lrUp = lrIndicator.DataSeries[0].Values[^1];
  decimal lrDown = lrIndicator.DataSeries[2].Values[^1];
  //
  Aindicator bollinger = (Aindicator)tab.Indicators[1];
  if (bollinger.DataSeries[0].Values.Count == 0 ||
      bollinger.DataSeries[0].Last == 0)
  {
    return "";
  }
  decimal lastUpBollingerLine = bollinger.DataSeries[0].Last;
  //
  //rsi
  Aindicator rsi = (Aindicator)tab.Indicators[2];
  if ( rsi.DataSeries[0].Values == null)
  {
    return "";
  }

  decimal lastRsi = rsi.DataSeries[0].Last;

  decimal _lastPrice = candles[candles.Count - 1].Close; 
  
  /* !!! old
  if (Math.Abs(candles[candles.Count - 3].Open - candles[candles.Count - 1].Close)
  / (candles[candles.Count - 1].Close / 100) < settings.HeightSoldiers)
  {
  return;
  }
  */
  //  long
  if (( ((_buySellMode.ValueString == "OnlyBuy") || (_buySellMode.ValueString == "BuyAndSell") ) 
    //&& (_logicType.ValueString == "OpenIsBuy") 
    && candlesPrevails(candles , _candlePrevailsLen.ValueInt, _candlePrevailsPorog.ValueInt) 
    //&& candleBigChangesPrevails(candles , _candlePrevailsLen.ValueInt, _candlePrevailsPorog.ValueInt)

  )
  /*||
  (((_buySellMode.ValueString == "OnlyBuy") || (_buySellMode.ValueString == "BuyAndSell") ) &&
  (_logicType.ValueString == "OpenIsSell") 
   && candlesPrevails(candles, _candlePrevailsLen.ValueInt, _candlePrevailsPorog.ValueInt) 
   //&& candleBigChangesPrevails(candles , _candlePrevailsLen.ValueInt, _candlePrevailsPorog.ValueInt)
  )*/
  )
  {
    if (_smaFilterIsOn.ValueBool == true)
    {
      decimal smaValue = Sma(candles, _smaFilterLen.ValueInt, candles.Count - 1);
      decimal smaPrev = Sma(candles, _smaFilterLen.ValueInt, candles.Count - 2);
      if (((smaValue < smaPrev)&&(candles[candles.Count - 1].Open < candles[candles.Count - 1].Close)) ||
          ((smaValue > smaPrev)&&(candles[candles.Count - 1].Open > candles[candles.Count - 1].Close)))
      {
        return "";
      }
 
      if ( !(_lastPrice > lrUp)) return ""; //фильтр по лин регоесии
      //if(!(_lastPrice > lastUpBollingerLine)) return ""; //фильтр по болинжеру
      //if(!(lastRsi < 65)) return ""; //фильтр по RSI

      decimal fakeSum = (decimal) _icebergCount.ValueInt * (candles[candles.Count - 1].Open + candles[candles.Count - 1].Close) / 2m;
      //!!!
      if (!((candles[candles.Count - 1].Open < candles[candles.Count - 1].Close)))
      {
        if(_logicType.ValueString == "OpenIsBuy") {
          if (fakeMode)
          {  
            _info_fakePortffolio.ValueDecimal -= fakeSum;
            return "OpenIsBuy";
          }   
          else tab.BuyAtIcebergMarket(GetVolume(tab), _icebergCount.ValueInt, 1000);
        } else
        {
          if (fakeMode) 
          {
            _info_fakePortffolio.ValueDecimal += fakeSum; 
            return "OpenIsSell"; 
          }
          else tab.SellAtIcebergMarket(GetVolume(tab), _icebergCount.ValueInt, 1000);
        }
      }
      /* else 
      { if(_logicType.ValueString == "OpenIsSell") {
          if (fakeMode) 
          {
          _info_fakePortffolio.ValueDecimal += fakeSum;
            return "OpenIsSell"; 
          }
          else tab.SellAtIcebergMarket(GetVolume(tab), _icebergCount.ValueInt, 1000);
        } else
        {
          if (fakeMode) 
          {
            _info_fakePortffolio.ValueDecimal -= fakeSum;
            return "OpenIsBuy";
          } 
          else tab.BuyAtIcebergMarket(GetVolume(tab), _icebergCount.ValueInt, 1000); 
        }
      }*/
    }
  }//?  

  // ---------------

  //  short
  if (( ((_buySellMode.ValueString == "OnlySell") || (_buySellMode.ValueString == "BuyAndSell") ) 
    //&& (_logicType.ValueString == "OpenIsBuy") 
    && candlesPrevails(candles , _candlePrevailsLen.ValueInt, _candlePrevailsPorog.ValueInt, "red") 
    //&& candleBigChangesPrevails(candles , _candlePrevailsLen.ValueInt, _candlePrevailsPorog.ValueInt)

  )
  /*
  ||
  (((_buySellMode.ValueString == "OnlySell") || (_buySellMode.ValueString == "BuyAndSell") ) &&
  (_logicType.ValueString == "OpenIsSell") 
   && candlesPrevails(candles, _candlePrevailsLen.ValueInt, _candlePrevailsPorog.ValueInt, "red") 
   //&& candleBigChangesPrevails(candles , _candlePrevailsLen.ValueInt, _candlePrevailsPorog.ValueInt)
  )*/
  )
  {
    if (_smaFilterIsOn.ValueBool == true)
    {
      decimal smaValue = Sma(candles, _smaFilterLen.ValueInt, candles.Count - 1);
      decimal smaPrev = Sma(candles, _smaFilterLen.ValueInt, candles.Count - 2);
      if (((smaValue < smaPrev)&&(candles[candles.Count - 1].Open > candles[candles.Count - 1].Close)) ||
          ((smaValue > smaPrev)&&(candles[candles.Count - 1].Open < candles[candles.Count - 1].Close)))
      {
        return "";
      }
 
      if ( !(_lastPrice < lrDown)) return ""; //фильтр по лин оегоесии
      //if(!(_lastPrice > lastUpBollingerLine)) return ""; //фильтр по болинжеру
      //if(!(lastRsi < 65)) return ""; //фильтр по RSI

      decimal fakeSum = (decimal) _icebergCount.ValueInt * (candles[candles.Count - 1].Open + candles[candles.Count - 1].Close) / 2m;
      //!!!
      if (!((candles[candles.Count - 1].Open > candles[candles.Count - 1].Close)))
      {
        if(_logicType.ValueString == "OpenIsBuy") {
          if (fakeMode)
          {  
            _info_fakePortffolio.ValueDecimal -= fakeSum;
            return "OpenIsBuy";
          }   
          else tab.SellAtIcebergMarket(GetVolume(tab), _icebergCount.ValueInt, 1000);
        } else
        {
          if (fakeMode) 
          {
            _info_fakePortffolio.ValueDecimal += fakeSum; 
            return "OpenIsSell"; 
          }
          else tab.BuyAtIcebergMarket(GetVolume(tab), _icebergCount.ValueInt, 1000);
        }
      }
      /*else 
      { if(_logicType.ValueString == "OpenIsSell") {
          if (fakeMode) 
          {
          _info_fakePortffolio.ValueDecimal += fakeSum;
            return "OpenIsSell"; 
          }
          else tab.BuyAtIcebergMarket(GetVolume(tab), _icebergCount.ValueInt, 1000);
        } else
        {
          if (fakeMode) 
          {
            _info_fakePortffolio.ValueDecimal -= fakeSum;
            return "OpenIsBuy";
          } 
          else tab.SellAtIcebergMarket(GetVolume(tab), _icebergCount.ValueInt, 1000); 
        }
      }*/
    }
  }//?  

  return "";
}
// Close position logic
private bool LogicClosePosition(List<Candle> candles, BotTabSimple tab, bool fakeMode = false)
{
  
  List<Position> openPositions = tab.PositionsOpenAll;
  for (int i = 0; openPositions != null && i < openPositions.Count; i++)
  {
    Position pos = openPositions[i];
    //!!!!!! newPos.ValueCurrent = pos.Balance / instrument.Instrument.Lot;
    decimal fakeSum = (decimal) pos.OpenVolume * (candles[candles.Count - 1].Open + candles[candles.Count - 1].Close) / 2m;
  
    if (StartProgram == StartProgram.IsTester
    || StartProgram == StartProgram.IsOsOptimizer)
    {
      if (pos.State != PositionStateType.Open)
      {
        return false;
      }
    }
    if (pos.StopOrderPrice == 0) //? fot trail
    {
      int firstPatternIndex = tab.CandlesAll.Count;
      for (int i2 = candles.Count - 1; i2 >= 0; i2--)
      {
        Candle candle = candles[i2];
        if(candle.TimeStart <= pos.TimeOpen)
        {
          firstPatternIndex = i2 + 1;
          break;
        }
      }
      decimal lastPrice = candles[firstPatternIndex - 1].Close;
      decimal heightPattern =
      Math.Abs(tab.CandlesAll[firstPatternIndex - 4].Open - tab.CandlesAll[firstPatternIndex - 2].Close);
      decimal priceStop = lastPrice - (heightPattern * _procHeightStop.ValueDecimal) / 100;
      decimal priceTake = lastPrice + (heightPattern * _procHeightTake.ValueDecimal) / 100;

      //Trail - если цена больше TP то переставляем SL := TP; TP:= SL + 2 (Price - TP)
      /*
      if (lastPrice > priceTake)
      {  
         priceStop = priceTake;
         priceTake =  priceStop + 2m * (lastPrice - priceStop);  
      }
      */
      //

      pos.StopOrderPrice = priceStop;
      pos.ProfitOrderPrice = priceTake;
    

      if (StartProgram == StartProgram.IsOsTrader)
      {
      tab._journal.Save();
      }
    }
    decimal lastClose = candles[^1].Close;
    
    Aindicator lrIndicator = (Aindicator)tab.Indicators[0];
    decimal lrDown = lrIndicator.DataSeries[2].Last;
    if (lrDown == 0) return false;  //фильтр по лин оегрессии
    if (!(lastClose <= lrDown)) return false;

    if (lastClose <= pos.StopOrderPrice)
    {
      if (fakeMode) 
      {
        if(_logicType.ValueString == "OpenIsSell") 
          _info_fakePortffolio.ValueDecimal -= fakeSum;
        else 
          _info_fakePortffolio.ValueDecimal += fakeSum;

        return true; 
      }
      else 
      { 
        tab.CloseAtIcebergMarket(pos, pos.OpenVolume, _icebergCount.ValueInt, 1000);
        //checkLogic(tab); //мб B <-> S _maxClosesWaitingPortfLessSelfEma
      }  
    }
    if (lastClose >= pos.ProfitOrderPrice)
    {
      if (fakeMode) 
      {
        if(_logicType.ValueString == "OpenIsSell") 
          _info_fakePortffolio.ValueDecimal -= fakeSum;
        else 
          _info_fakePortffolio.ValueDecimal += fakeSum;
        return true;
      }   
      else
      {
        tab.CloseAtIcebergMarket(pos, pos.OpenVolume, _icebergCount.ValueInt, 1000);
        //checkLogic(tab); //мб B <-> S _maxClosesWaitingPortfLessSelfEma
      }  
    }
  }
  return false; //new
}

//!!!!!!!!!!!!  NEW ФУНКЦИЯ ТЕСТИРОВАНИЯ - ВЫДАЕТ ПРОЦЕНТ ПРОФИТА. ТРЕБУЕТ НАПИСАННЫХ Ф-Й ЛОГИКИ ОТКР-ЗАКР ОПРЕДЕЛЕННОЙ СИГНАТУРЫ
private decimal testProfitPercent(List<Candle> candles, BotTabSimple tab, SecuritiesTradeSettings settings, DateTime dbeg, DateTime dend)
{
  decimal rret = 0;
  decimal portfolio = 0;
  int posOpened = 0;
  string openDirection = "";
  //for (int i = candles.Count - 1; i >= 0; i--)
  for (int i = 0; i < candles.Count - 1; i++)
  {
  Candle candle = candles[i];
  if((candle.TimeStart >= dbeg) && (candle.TimeStart <= dend))
  {
     openDirection = LogicOpenPosition(candles.GetRange(0, (i + 1)), tab, settings, true); //проверка на обрезанном до тек свечи массиве
     if (openDirection == "OpenIsBuy")
     {
        posOpened++;
        rret -= (candle.Open + candle.Close) / 2;
        portfolio += (candle.Open + candle.Close) / 2;
        continue;
      }
      if (openDirection == "OpenIsSell")
      {
        posOpened++;
        rret += (candle.Open + candle.Close) / 2;
        portfolio += (candle.Open + candle.Close) / 2;
        continue;
      }    
      if (LogicClosePosition(candles.GetRange(0, (i + 1)), tab, true)) //проверка на обрезанном до тек свечи массиве
      {
        if (openDirection == "OpenIsBuy")
        {
          posOpened--;
          rret += (candle.Open + candle.Close) / 2;
          continue;
        }
        if (openDirection == "OpenIsSell")
        {
          posOpened--;
          rret -= (candle.Open + candle.Close) / 2;
          continue;
        }               
      }

  }
  }

  return rret / (portfolio + 0.00000000001m) ; 
}
//!!!!!!!!!!!


// Method for calculating the volume of entry into a positions
private int candleCounts(List<Candle> candles, string sсolor = "green", int countBack = 20, int step = 1) //new выдает кол-во красных или зеленых свечей за countBack назад 
    { int ret = 0;
      if (candles.Count > (countBack + 1))
        for (int i = 1; i < countBack; i+= step)
          if (
              ((candles[candles.Count - i].Open > candles[candles.Count - i].Close) && (sсolor == "red"))
              ||
              ((candles[candles.Count - i].Open < candles[candles.Count - i].Close) && (sсolor == "green"))
          )
            ret++; //else ret--;
      return ret;
    }

private bool candlesPrevails(List<Candle> candles, int countBack, int porog, string whatMustBeMore = "green") //new выдает кол-во красных или зеленых свечей за countBack назад 
    { //opt  20   3
      bool ret = true;
      string whatMustBeLess = (( whatMustBeMore == "green") ? "red" : "green");
      int tfStep = 1;//! уходим от .._seniorStep;// 1;
      ret = (decimal)candleCounts(candles, whatMustBeMore, countBack, tfStep) > (decimal)candleCounts(candles, whatMustBeLess, countBack, tfStep) + (decimal)porog/(decimal)tfStep;
      if (!ret) return ret;
      //(candles[candles.Count - 1].Close < candles[candles.Count -  countBack].Close);// >!! на всех и с 10.2021 - непроливайка 200% ret;
      //вообще 4 типа <>  * b-s

      tfStep = 2;
      ret = (decimal)candleCounts(candles, whatMustBeMore, countBack, tfStep) > (decimal)candleCounts(candles, whatMustBeLess, countBack, tfStep) + (decimal)porog/(decimal)tfStep;
      if (!ret) return ret;
      //
      /*
      tfStep = 4;
      ret = (decimal)candleCounts(candles, whatMustBeMore, countBack, tfStep) > (decimal)candleCounts(candles, whatMustBeLess, countBack, tfStep) + (decimal)porog/(decimal)tfStep;
      if (!ret) return ret;
      */
      /**/
     // tfStep = 8;
     // ret = (decimal)candleCounts(candles, whatMustBeMore, countBack, tfStep) > (decimal)candleCounts(candles, whatMustBeLess, countBack, tfStep) + (decimal)porog/(decimal)tfStep;
     // if (!ret) return ret;
      
      //tfStep = 10;
     //ret = (decimal)candleCounts(candles, whatMustBeMore, countBack, tfStep) > (decimal)candleCounts(candles, whatMustBeLess, countBack, tfStep) + (decimal)porog/(decimal)tfStep;
      //if (!ret) return ret;
      //
      return ret;
    }

//количество изменений red-green либо green-red  (позитивные или негативные перемены) Некая "первая производная" от пред меры оптимизма
private int candleChangesCounts(List<Candle> candles, string sсolor = "RG", int countBack = 20, int step = 1) //new выдает кол-во красных или зеленых свечей за countBack назад 
    { int ret = 0;
      if (candles.Count > (countBack + 1))
        for (int i = 1; i < countBack; i+= step){
          if ((candles.Count - i - step) < 0) continue;
          if (
              ((candles[candles.Count - i].Open > candles[candles.Count - i].Close) 
              && (candles[candles.Count - i -  step].Open < candles[candles.Count - i  -  step].Close) 
              && (sсolor == "RG"))
              ||
              ((candles[candles.Count - i].Open < candles[candles.Count - i].Close) 
              && (candles[candles.Count - i - step].Open > candles[candles.Count - i - step].Close) 
              && (sсolor == "GR"))
          )
            ret++; 
        }  
      return ret;
    }   

 private bool candleChangesPrevails(List<Candle> candles, int countBack, int porog) //new выдает кол-во красных или зеленых свечей за countBack назад 
    { //opt  20   3
      bool ret = true;
      int tfStep = 1;
      ret = (decimal)candleChangesCounts(candles, "RG", countBack, tfStep) > (decimal)candleChangesCounts(candles, "GR", countBack, tfStep) + (decimal)porog/(decimal)tfStep;
      if (!ret) return ret;
      //
/*
      tfStep = 2;
      ret = (decimal)candleChangesCounts(candles, "RG", countBack, tfStep) > (decimal)candleChangesCounts(candles, "GR", countBack, tfStep) + (decimal)porog/(decimal)tfStep;
      if (!ret) return ret;
      //
      
      tfStep = 4;
      ret = (decimal)candleChangesCounts(candles, "RG", countBack, tfStep) > (decimal)candleChangesCounts(candles, "GR", countBack, tfStep) + (decimal)porog/(decimal)tfStep;
      if (!ret) return ret;
*/
      return ret;
    }   

//количество значительных изменений цен свечи
private int candleBigChangesCounts(List<Candle> candles, string sсolor = "RG", int countBack = 20, int step = 1) //new выдает кол-во красных или зеленых свечей за countBack назад 
  {
            int ret = 0;
            decimal nPercPorog = 0.03m;//_nPercPorog.ValueDecimal;
            if (candles.Count > (countBack + 1))
                for (int i = 1; i < countBack; i+= step){
                    if ((candles.Count - i -  countBack) < 0) continue;
                    decimal delta = 1m - (((candles[candles.Count  - i - step].Close + candles[candles.Count  - i - step].Open) / 2m) 
                                      / ((candles[candles.Count  - i].Close + candles[candles.Count  - i].Open + 0.00001m)/2m))
                                    ;
                    if (
                        ((delta > (nPercPorog / 100m)) //&& (sсolor == "green"))
                       //||
                        //((delta < -(nPercPorog / 100m)) && (sсolor == "red")
                        )
                    ) ret = ret + 1;
                }      
  
      return ret;
    }   
 private bool candleBigChangesPrevails(List<Candle> candles, int countBack, int porog) //new выдает кол-во красных или зеленых свечей за countBack назад 
    { //opt  20   3
      bool ret = true;
      int tfStep = 1;
      ret = (decimal)candleBigChangesCounts(candles, "RG", countBack, tfStep) > (decimal)candleBigChangesCounts(candles, "GR", countBack, tfStep) + (decimal)porog/(decimal)tfStep;
      if (!ret) return ret;
      //
/*
      tfStep = 2;
      ret = (decimal)candleBigChangesCounts(candles, "RG", countBack, tfStep) > (decimal)candleBigChangesCounts(candles, "GR", countBack, tfStep) + (decimal)porog/(decimal)tfStep;
      if (!ret) return ret;
      //
      
      tfStep = 4;
      ret = (decimal)candleBigChangesCounts(candles, "RG", countBack, tfStep) > (decimal)candleBigChangesCounts(candles, "GR", countBack, tfStep) + (decimal)porog/(decimal)tfStep;
      if (!ret) return ret;
*/
      return ret;
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
// Method for calculating MovingAverage
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
}
public class SecuritiesTradeSettings
{
public string SecName;
public string SecClass;
public decimal HeightSoldiers;
public DateTime LastUpdateTime;
public string GetSaveString()
{
  string result = "";
  result += SecName + "%";
  result += SecClass + "%";
  result += HeightSoldiers + "%";
  result += LastUpdateTime.ToString(CultureInfo.InvariantCulture) + "%";
  return result;
}
public void LoadFromString(string str)
{
  string[] array = str.Split('%');
  SecName = array[0];
  SecClass = array[1];
  HeightSoldiers = array[2].ToDecimal();
  LastUpdateTime = Convert.ToDateTime(array[3], CultureInfo.InvariantCulture);
}



}
}
