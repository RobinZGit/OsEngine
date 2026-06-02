//+------------------------------------------------------------------+
//|                              TrendMultiIndicatorScreener.mq5     |
//|  Порт OsEngine: Custom/Robots/TrendMultiIndicatorScreener.cs     |
//|  Один символ графика (в OsEngine — скринер на много вкладок).    |
//+------------------------------------------------------------------+
// УСТАНОВКА И ЗАПУСК (MetaTrader 5)
//   1. Скопируйте файл в MetaTrader 5/MQL5/Experts/ (или подпапку).
//   2. MetaEditor: открыть файл → Compile (F7), без ошибок.
//   3. На график нужного символа и таймфрейма перетащите советник.
//   4. Включите «Algo Trading» (автоторговля).
//   5. InpRegime = On (сначала проверьте на демо-счёте).
//
// СИГНАЛЫ (как в OsEngine)
//   - На ЗАКРЫТОЙ свече: shift=1 (последний закрытый бар), не формирующийся.
//   - И-группы («№ И-группы»): G и −G — одна группа |G|; внутри AND; между |номерами| OR.
//   - Отрицательный Inp*Group = NOT условия индикатора. Ноль трактуется как 1.
//   - По умолчанию: SMA(100), VWAP, ATR, LinReg(50, dev 2) — все Inp*Group = 1.
//     Bull: close > SMA, close > VWAP, close > верх LinReg, ATR вырос на % за lookback.
//     Bear: close < SMA, close < VWAP, close < низ LinReg, тот же фильтр ATR.
//
// ВХОД / ВЫХОД
//   - Нет позиции: Buy при bull, Sell при bear (InpRegime, InpInvertEntryLogic).
//   - Есть позиция: противоположный сигнал → закрыть и открыть в другую сторону (реверс).
//   - InpInvertEntryLogic = true: bull → Sell, bear → Buy.
//
// ЧТО ПЕРЕНЕСЕНО В MT5
//   - SMA, VWAP (сброс по календарному дню, typical=(H+L+C)/3), ATR (рост %),
//     LinReg-канал, RSI, Stochastic, Momentum, Bollinger, Volume, MACD (флаги InpUse*).
//   - Нерабочие периоды (3 окна), трейлинг позиции %, режимы Regime.
//
// ЧЕГО НЕТ В MT5 (только в OsEngine)
//   - Скринер / много бумаг и префиксов MOEX одновременно.
//   - Самоиндикация, кластеры волатильности, кнопки «Обновить фьючерсы/акции».
//   - Страховка портфеля (просадка equity), рандомный сдвиг цен.
//   - Расписание «Дата-время начала/окончания работы».
//   - DiscreteMidBestPair, RZIgreensMinusReds, Average Profit Percent Long.
//   - Max positions (all tabs) — здесь одна позиция на символ + Magic.
//
// СООТВЕТСТВИЕ ПАРАМЕТРОВ OsEngine → MT5
//   Regime                          → InpRegime
//   Инверсия логики                 → InpInvertEntryLogic
//   Volume                          → InpLots
//   Use SMA / SMA length            → InpUseSma, InpSmaLen, InpSmaGroup
//   Use VWAP                        → InpUseVwap, InpVwapGroup
//   Use ATR / grow % / lookback     → InpUseAtr, InpAtrGrowPercent, InpAtrGrowLookback, InpAtrGroup
//   Use Linear Regression           → InpUseLinReg, InpLinRegLen, InpLinRegDev, InpLinRegGroup
//   Use RSI / long min / short max  → InpUseRsi, InpRsiLongMin, InpRsiShortMax, InpRsiGroup
//   Use Stochastic / Momentum / Bollinger / Volume / MACD → InpUse*, Inp*Group
//   Трейлинг позиции                → InpUsePositionTrailing, InpPositionTrailingPercent
//   Non trade periods               → InpUseNonTradePeriods, InpNt1/2/3*
//   Trade in Saturday / Sunday      → InpTradeSaturday, InpTradeSunday
//
// ПРИМЕРЫ И-ГРУПП
//   InpSmaGroup=1, InpRsiGroup=1        → (SMA ∧ RSI).
//   InpSmaGroup=1, InpRsiGroup=-1       → (SMA ∧ ¬RSI) в группе |1|.
//   InpSmaGroup=2, InpRsiGroup=-2, InpVolumeGroup=1 → (SMA₂∧¬RSI₂) ∨ (Volume₁).
//+------------------------------------------------------------------+
#property copyright "OsEngine TrendMultiIndicatorScreener"
#property link      "https://github.com/AlexWan/OsEngine"
#property version   "1.00"
#property description "TrendMultiIndicatorScreener: И-группы, SMA/VWAP/ATR/LinReg, реверс. См. комментарии в начале .mq5"

#include <Trade/Trade.mqh>

//--- OsEngine: Regime — Off / On / OnlyLong / OnlyShort / OnlyClosePosition
enum ENUM_TMIS_REGIME
  {
   TMIS_OFF = 0,              // Off
   TMIS_ON = 1,               // On
   TMIS_ONLY_LONG = 2,        // OnlyLong
   TMIS_ONLY_SHORT = 3,       // OnlyShort
   TMIS_ONLY_CLOSE = 4        // OnlyClosePosition
  };

//--- Общие (OsEngine: вкладка торговли)
input group "=== Общие ==="
input ENUM_TMIS_REGIME InpRegime = TMIS_OFF;       // Regime
input bool   InpInvertEntryLogic = false;          // Инверсия логики (покупка ↔ продажа)
input double InpLots = 0.1;                        // Volume (лоты на символ)
input ulong  InpMagic = 20260520;                  // Magic (одна позиция на символ+Magic)
input int    InpSlippagePoints = 10;               // Slippage (пункты)

//--- SMA — по умолчанию вкл., как в OsEngine
input group "=== SMA ==="
input bool InpUseSma = true;                         // Use SMA
input int  InpSmaLen = 100;                          // SMA length
input int  InpSmaGroup = 1;                          // SMA: № И-группы (минус = NOT)

//--- VWAP — сброс накопления в начале календарного дня
input group "=== VWAP ==="
input bool InpUseVwap = true;                        // Use VWAP
input int  InpVwapGroup = 1;                         // VWAP: № И-группы

//--- ATR — фильтр роста волатильности (без направления)
input group "=== ATR ==="
input bool   InpUseAtr = true;                       // Use ATR
input int    InpAtrLen = 14;                         // ATR length
input double InpAtrGrowPercent = 3.0;                // ATR min grow % vs lookback
input int    InpAtrGrowLookback = 5;                 // ATR grow lookback (candles)
input int    InpAtrGroup = 1;                        // ATR: № И-группы

//--- LinReg — LinearRegressionChannelFast_Indicator
input group "=== LinReg ==="
input bool   InpUseLinReg = true;                    // Use Linear Regression
input int    InpLinRegLen = 50;                      // LinReg length
input double InpLinRegDev = 2.0;                     // Up/Down channel deviation
input int    InpLinRegGroup = 1;                     // bull: close > верх; bear: close < низ

//--- RSI
input group "=== RSI ==="
input bool   InpUseRsi = false;                      // Use RSI
input int    InpRsiLen = 14;
input double InpRsiLongMin = 55.0;                   // RSI long min
input double InpRsiShortMax = 45.0;                  // RSI short max
input int    InpRsiGroup = 1;

//--- Stochastic
input group "=== Stochastic ==="
input bool   InpUseStoch = false;                    // Use Stochastic
input int    InpStochK = 5;
input int    InpStochD = 3;
input int    InpStochSlow = 3;
input double InpStochLongMin = 55.0;
input double InpStochShortMax = 45.0;
input int    InpStochGroup = 1;

//--- Momentum
input group "=== Momentum ==="
input bool   InpUseMom = false;                      // Use Momentum
input int    InpMomLen = 15;
input double InpMomLongMin = 100.0;
input double InpMomShortMax = 100.0;
input int    InpMomGroup = 1;

//--- Bollinger — close vs середина полос
input group "=== Bollinger ==="
input bool   InpUseBoll = false;                     // Use Bollinger
input int    InpBollLen = 100;
input double InpBollDev = 2.0;
input int    InpBollGroup = 1;

//--- Volume — рост объёма vs пред. свеча, %
input group "=== Volume ==="
input bool   InpUseVolumeInd = false;                // Use Volume indicator
input double InpVolumeMinGrowPercent = 5.0;
input int    InpVolumeGroup = 1;

//--- MACD — линия vs сигнальная
input group "=== MACD ==="
input bool InpUseMacd = false;                         // Use MACD
input int  InpMacdFast = 12;
input int  InpMacdSlow = 26;
input int  InpMacdSignal = 9;
input int  InpMacdGroup = 1;

//--- Стопы и нерабочие периоды (OsEngine: вкладка «Стопы», Non trade periods)
input group "=== Стопы и время ==="
input bool   InpUsePositionTrailing = true;          // Трейлинг позиции
input double InpPositionTrailingPercent = 1.0;       // % отката от пика цены
input bool   InpUseNonTradePeriods = true;            // Non trade periods
input bool   InpNt1On = true;                        // Период 1: по умолч. 00:00–10:05
input int    InpNt1StartH = 0,  InpNt1StartM = 0,  InpNt1EndH = 10, InpNt1EndM = 5;
input bool   InpNt2On = false;
input int    InpNt2StartH = 13, InpNt2StartM = 54, InpNt2EndH = 14, InpNt2EndM = 6;
input bool   InpNt3On = true;                        // Период 3: 18:01–23:58
input int    InpNt3StartH = 18, InpNt3StartM = 1,  InpNt3EndH = 23, InpNt3EndM = 58;
input bool   InpTradeSaturday = false;                 // TradeInSaturday
input bool   InpTradeSunday = false;                   // TradeInSunday

#define TMIS_MAX_GROUP_ITEMS 16
#define TMIS_MAX_GROUPS 32

CTrade g_trade;
datetime g_lastBarTime = 0;
double   g_trailPeak = 0.0;

int g_hSma = INVALID_HANDLE;
int g_hAtr = INVALID_HANDLE;
int g_hRsi = INVALID_HANDLE;
int g_hStoch = INVALID_HANDLE;
int g_hMom = INVALID_HANDLE;
int g_hBoll = INVALID_HANDLE;
int g_hMacd = INVALID_HANDLE;

//+------------------------------------------------------------------+
int OnInit()
  {
   g_trade.SetExpertMagicNumber(InpMagic);
   g_trade.SetDeviationInPoints(InpSlippagePoints);
   ENUM_ORDER_TYPE_FILLING fill = ORDER_FILLING_FOK;
   long fm = SymbolInfoInteger(_Symbol, SYMBOL_FILLING_MODE);
   if((fm & SYMBOL_FILLING_IOC) == SYMBOL_FILLING_IOC) fill = ORDER_FILLING_IOC;
   else if((fm & SYMBOL_FILLING_FOK) == SYMBOL_FILLING_FOK) fill = ORDER_FILLING_FOK;
   else fill = ORDER_FILLING_RETURN;
   g_trade.SetTypeFilling(fill);

   if(InpUseSma)
      g_hSma = iMA(_Symbol, PERIOD_CURRENT, InpSmaLen, 0, MODE_SMA, PRICE_CLOSE);
   if(InpUseAtr)
      g_hAtr = iATR(_Symbol, PERIOD_CURRENT, InpAtrLen);
   if(InpUseRsi)
      g_hRsi = iRSI(_Symbol, PERIOD_CURRENT, InpRsiLen, PRICE_CLOSE);
   if(InpUseStoch)
      g_hStoch = iStochastic(_Symbol, PERIOD_CURRENT, InpStochK, InpStochD, InpStochSlow, MODE_SMA, STO_LOWHIGH);
   if(InpUseMom)
      g_hMom = iMomentum(_Symbol, PERIOD_CURRENT, InpMomLen, PRICE_CLOSE);
   if(InpUseBoll)
      g_hBoll = iBands(_Symbol, PERIOD_CURRENT, InpBollLen, 0, InpBollDev, PRICE_CLOSE);
   if(InpUseMacd)
      g_hMacd = iMACD(_Symbol, PERIOD_CURRENT, InpMacdFast, InpMacdSlow, InpMacdSignal, PRICE_CLOSE);

   if(InpUseSma && g_hSma == INVALID_HANDLE) { Print("SMA handle error"); return INIT_FAILED; }
   if(InpUseAtr && g_hAtr == INVALID_HANDLE) { Print("ATR handle error"); return INIT_FAILED; }

   Print("TrendMultiIndicatorScreener MT5: OK. Сигналы на закрытой свече (shift=1). См. комментарии в .mq5");
   return INIT_SUCCEEDED;
  }

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   if(g_hSma != INVALID_HANDLE) IndicatorRelease(g_hSma);
   if(g_hAtr != INVALID_HANDLE) IndicatorRelease(g_hAtr);
   if(g_hRsi != INVALID_HANDLE) IndicatorRelease(g_hRsi);
   if(g_hStoch != INVALID_HANDLE) IndicatorRelease(g_hStoch);
   if(g_hMom != INVALID_HANDLE) IndicatorRelease(g_hMom);
   if(g_hBoll != INVALID_HANDLE) IndicatorRelease(g_hBoll);
   if(g_hMacd != INVALID_HANDLE) IndicatorRelease(g_hMacd);
  }

//+------------------------------------------------------------------+
void OnTick()
  {
   if(InpRegime == TMIS_OFF)
      return;

   datetime barTime = iTime(_Symbol, PERIOD_CURRENT, 1);
   if(barTime == 0 || barTime == g_lastBarTime)
     {
      if(InpUsePositionTrailing)
         ManageTrailing();
      return;
     }
   g_lastBarTime = barTime;

   if(!CanTradeThisTime())
      return;

   const int shift = 1; // см. заголовок: сигнал только по последней ЗАКРЫТОЙ свече
   bool bull = IsBullSignal(shift);
   bool bear = IsBearSignal(shift);
   ApplyInvert(bull, bear);

   if(InpUsePositionTrailing)
      ManageTrailing();

   if(!PositionExists())
     {
      if(InpRegime == TMIS_ONLY_CLOSE)
         return;
      if(bull && InpRegime != TMIS_ONLY_SHORT)
         OpenMarket(ORDER_TYPE_BUY);
      else if(bear && InpRegime != TMIS_ONLY_LONG)
         OpenMarket(ORDER_TYPE_SELL);
      return;
     }

   // Реверс при противоположном сигнале
   long posType = PositionType();
   if(posType == POSITION_TYPE_BUY && bear && InpRegime != TMIS_ONLY_LONG)
     {
      CloseAll();
      if(InpRegime != TMIS_ONLY_CLOSE)
         OpenMarket(ORDER_TYPE_SELL);
     }
   else if(posType == POSITION_TYPE_SELL && bull && InpRegime != TMIS_ONLY_SHORT)
     {
      CloseAll();
      if(InpRegime != TMIS_ONLY_CLOSE)
         OpenMarket(ORDER_TYPE_BUY);
     }
  }

//+------------------------------------------------------------------+
void ApplyInvert(bool &bull, bool &bear)
  {
   if(!InpInvertEntryLogic)
      return;
   bool t = bull;
   bull = bear;
   bear = t;
  }

//+------------------------------------------------------------------+
int NormalizeGroup(const int g)
  {
   if(g == 0) return 1;
   return g;
  }

//+------------------------------------------------------------------+
void AddGroupItem(int &keys[], bool &passes[], int &count, const int groupParam, const int passVal)
  {
   if(passVal < 0) return; // -1 = индикатор выкл.
   if(count >= TMIS_MAX_GROUP_ITEMS) return;

   int raw = NormalizeGroup(groupParam);
   int key = MathAbs(raw);
   bool p = (passVal != 0);
   if(raw < 0) p = !p;

   keys[count] = key;
   passes[count] = p;
   count++;
  }

//+------------------------------------------------------------------+
bool CombineGroups(const int &keys[], const bool &passes[], const int count)
  {
   if(count == 0)
      return true;

   bool groupOk[TMIS_MAX_GROUPS];
   ArrayInitialize(groupOk, true);

   for(int i = 0; i < count; i++)
     {
      int k = keys[i];
      if(k < 0 || k >= TMIS_MAX_GROUPS)
         continue;
      if(!passes[i])
         groupOk[k] = false;
     }

   for(int g = 0; g < TMIS_MAX_GROUPS; g++)
     {
      bool hasItem = false;
      for(int i = 0; i < count; i++)
        {
         if(keys[i] == g) { hasItem = true; break; }
        }
      if(hasItem && groupOk[g])
         return true;
     }
   return false;
  }

//+------------------------------------------------------------------+
bool IsBullSignal(const int shift)
  {
   double close = iClose(_Symbol, PERIOD_CURRENT, shift);
   int keys[TMIS_MAX_GROUP_ITEMS];
   bool passes[TMIS_MAX_GROUP_ITEMS];
   int cnt = 0;

   AddGroupItem(keys, passes, cnt, InpSmaGroup, BullSma(close, shift));
   AddGroupItem(keys, passes, cnt, InpVwapGroup, BullVwap(close, shift));
   AddGroupItem(keys, passes, cnt, InpAtrGroup, AtrFilter(shift));
   AddGroupItem(keys, passes, cnt, InpLinRegGroup, BullLinReg(close, shift));
   AddGroupItem(keys, passes, cnt, InpRsiGroup, BullRsi(shift));
   AddGroupItem(keys, passes, cnt, InpStochGroup, BullStoch(shift));
   AddGroupItem(keys, passes, cnt, InpMomGroup, BullMom(shift));
   AddGroupItem(keys, passes, cnt, InpBollGroup, BullBoll(close, shift));
   AddGroupItem(keys, passes, cnt, InpVolumeGroup, BullVolume(shift));
   AddGroupItem(keys, passes, cnt, InpMacdGroup, BullMacd(shift));

   return CombineGroups(keys, passes, cnt);
  }

//+------------------------------------------------------------------+
bool IsBearSignal(const int shift)
  {
   double close = iClose(_Symbol, PERIOD_CURRENT, shift);
   int keys[TMIS_MAX_GROUP_ITEMS];
   bool passes[TMIS_MAX_GROUP_ITEMS];
   int cnt = 0;

   AddGroupItem(keys, passes, cnt, InpSmaGroup, BearSma(close, shift));
   AddGroupItem(keys, passes, cnt, InpVwapGroup, BearVwap(close, shift));
   AddGroupItem(keys, passes, cnt, InpAtrGroup, AtrFilter(shift));
   AddGroupItem(keys, passes, cnt, InpLinRegGroup, BearLinReg(close, shift));
   AddGroupItem(keys, passes, cnt, InpRsiGroup, BearRsi(shift));
   AddGroupItem(keys, passes, cnt, InpStochGroup, BearStoch(shift));
   AddGroupItem(keys, passes, cnt, InpMomGroup, BearMom(shift));
   AddGroupItem(keys, passes, cnt, InpBollGroup, BearBoll(close, shift));
   AddGroupItem(keys, passes, cnt, InpVolumeGroup, BearVolume(shift));
   AddGroupItem(keys, passes, cnt, InpMacdGroup, BearMacd(shift));

   return CombineGroups(keys, passes, cnt);
  }

//+------------------------------------------------------------------+
//| Индикаторы: -1 выкл, 0 fail, 1 pass                              |
//+------------------------------------------------------------------+
int BullSma(const double close, const int shift)
  {
   if(!InpUseSma) return -1;
   double buf[];
   if(CopyBuffer(g_hSma, 0, shift, 1, buf) != 1) return 0;
   return (close > buf[0]) ? 1 : 0;
  }

int BearSma(const double close, const int shift)
  {
   if(!InpUseSma) return -1;
   double buf[];
   if(CopyBuffer(g_hSma, 0, shift, 1, buf) != 1) return 0;
   return (close < buf[0]) ? 1 : 0;
  }

//+------------------------------------------------------------------+
double CalcVwap(const int shift)
  {
   MqlDateTime barDt;
   TimeToStruct(iTime(_Symbol, PERIOD_CURRENT, shift), barDt);
   int barDay = barDt.day_of_year;

   double cumTv = 0, cumV = 0;
   int total = Bars(_Symbol, PERIOD_CURRENT);
   for(int i = shift; i < total; i++)
     {
      MqlDateTime dt;
      TimeToStruct(iTime(_Symbol, PERIOD_CURRENT, i), dt);
      if(dt.day_of_year != barDay)
         break;

      double h = iHigh(_Symbol, PERIOD_CURRENT, i);
      double l = iLow(_Symbol, PERIOD_CURRENT, i);
      double c = iClose(_Symbol, PERIOD_CURRENT, i);
      long   v = iVolume(_Symbol, PERIOD_CURRENT, i);
      if(v <= 0) continue;
      double typical = (h + l + c) / 3.0;
      cumTv += typical * (double)v;
      cumV += (double)v;
     }
   if(cumV <= 0) return 0;
   return cumTv / cumV;
  }

int BullVwap(const double close, const int shift)
  {
   if(!InpUseVwap) return -1;
   double v = CalcVwap(shift);
   if(v == 0) return 0;
   return (close > v) ? 1 : 0;
  }

int BearVwap(const double close, const int shift)
  {
   if(!InpUseVwap) return -1;
   double v = CalcVwap(shift);
   if(v == 0) return 0;
   return (close < v) ? 1 : 0;
  }

//+------------------------------------------------------------------+
int AtrFilter(const int shift)
  {
   if(!InpUseAtr) return -1;
   int lb = MathMax(1, InpAtrGrowLookback);
   double atrNow[], atrPast[];
   if(CopyBuffer(g_hAtr, 0, shift, 1, atrNow) != 1) return 0;
   if(CopyBuffer(g_hAtr, 0, shift + lb, 1, atrPast) != 1) return 0;
   if(atrPast[0] <= 0) return 0;
   double grow = atrNow[0] / (atrPast[0] / 100.0) - 100.0;
   return (grow >= InpAtrGrowPercent) ? 1 : 0;
  }

//+------------------------------------------------------------------+
bool CalcLinRegBands(const int shift, const int period, const double dev,
                     double &upper, double &lower)
  {
   upper = 0; lower = 0;
   if(shift + period > Bars(_Symbol, PERIOD_CURRENT))
      return false;

   double sumY = 0, sumX = 0, sumXY = 0, sumX2 = 0;
   for(int i = 0; i < period; i++)
     {
      int bar = shift + period - 1 - i;
      double y = iClose(_Symbol, PERIOD_CURRENT, bar);
      double x = (double)i;
      sumY += y; sumX += x; sumXY += y * x; sumX2 += x * x;
     }
   double c = sumX2 * period - sumX * sumX;
   if(c == 0) return false;
   double b = (sumXY * period - sumX * sumY) / c;
   double a = (sumY - sumX * b) / period;

   double err = 0;
   for(int i = 0; i < period; i++)
     {
      int bar = shift + period - 1 - i;
      double y = iClose(_Symbol, PERIOD_CURRENT, bar);
      double line = a + b * (double)i;
      err += MathAbs(y - line);
     }
   err /= period;
   double central = a + b * (period - 1);
   upper = central + err * dev;
   lower = central - err * dev;
   return true;
  }

int BullLinReg(const double close, const int shift)
  {
   if(!InpUseLinReg) return -1;
   double up, lo;
   if(!CalcLinRegBands(shift, InpLinRegLen, InpLinRegDev, up, lo)) return 0;
   return (close > up) ? 1 : 0;
  }

int BearLinReg(const double close, const int shift)
  {
   if(!InpUseLinReg) return -1;
   double up, lo;
   if(!CalcLinRegBands(shift, InpLinRegLen, InpLinRegDev, up, lo)) return 0;
   return (close < lo) ? 1 : 0;
  }

//+------------------------------------------------------------------+
int BullRsi(const int shift)
  {
   if(!InpUseRsi) return -1;
   double buf[];
   if(CopyBuffer(g_hRsi, 0, shift, 1, buf) != 1) return 0;
   return (buf[0] >= InpRsiLongMin) ? 1 : 0;
  }

int BearRsi(const int shift)
  {
   if(!InpUseRsi) return -1;
   double buf[];
   if(CopyBuffer(g_hRsi, 0, shift, 1, buf) != 1) return 0;
   return (buf[0] <= InpRsiShortMax) ? 1 : 0;
  }

int BullStoch(const int shift)
  {
   if(!InpUseStoch) return -1;
   double k[];
   if(CopyBuffer(g_hStoch, 0, shift, 1, k) != 1) return 0;
   return (k[0] >= InpStochLongMin) ? 1 : 0;
  }

int BearStoch(const int shift)
  {
   if(!InpUseStoch) return -1;
   double k[];
   if(CopyBuffer(g_hStoch, 0, shift, 1, k) != 1) return 0;
   return (k[0] <= InpStochShortMax) ? 1 : 0;
  }

int BullMom(const int shift)
  {
   if(!InpUseMom) return -1;
   double buf[];
   if(CopyBuffer(g_hMom, 0, shift, 1, buf) != 1) return 0;
   return (buf[0] >= InpMomLongMin) ? 1 : 0;
  }

int BearMom(const int shift)
  {
   if(!InpUseMom) return -1;
   double buf[];
   if(CopyBuffer(g_hMom, 0, shift, 1, buf) != 1) return 0;
   return (buf[0] <= InpMomShortMax) ? 1 : 0;
  }

int BullBoll(const double close, const int shift)
  {
   if(!InpUseBoll) return -1;
   double up[], dn[];
   if(CopyBuffer(g_hBoll, 1, shift, 1, up) != 1) return 0;
   if(CopyBuffer(g_hBoll, 2, shift, 1, dn) != 1) return 0;
   double mid = (up[0] + dn[0]) / 2.0;
   return (close > mid) ? 1 : 0;
  }

int BearBoll(const double close, const int shift)
  {
   if(!InpUseBoll) return -1;
   double up[], dn[];
   if(CopyBuffer(g_hBoll, 1, shift, 1, up) != 1) return 0;
   if(CopyBuffer(g_hBoll, 2, shift, 1, dn) != 1) return 0;
   double mid = (up[0] + dn[0]) / 2.0;
   return (close < mid) ? 1 : 0;
  }

int BullVolume(const int shift)
  {
   if(!InpUseVolumeInd) return -1;
   long v0 = iVolume(_Symbol, PERIOD_CURRENT, shift);
   long v1 = iVolume(_Symbol, PERIOD_CURRENT, shift + 1);
   if(v1 <= 0) return 0;
   return (v0 >= v1 * (1.0 + InpVolumeMinGrowPercent / 100.0)) ? 1 : 0;
  }

int BearVolume(const int shift)
  {
   return BullVolume(shift);
  }

int BullMacd(const int shift)
  {
   if(!InpUseMacd) return -1;
   double macd[], sig[];
   if(CopyBuffer(g_hMacd, 0, shift, 1, macd) != 1) return 0;
   if(CopyBuffer(g_hMacd, 1, shift, 1, sig) != 1) return 0;
   return (macd[0] > sig[0]) ? 1 : 0;
  }

int BearMacd(const int shift)
  {
   if(!InpUseMacd) return -1;
   double macd[], sig[];
   if(CopyBuffer(g_hMacd, 0, shift, 1, macd) != 1) return 0;
   if(CopyBuffer(g_hMacd, 1, shift, 1, sig) != 1) return 0;
   return (macd[0] < sig[0]) ? 1 : 0;
  }

//+------------------------------------------------------------------+
bool CanTradeThisTime()
  {
   if(!InpUseNonTradePeriods)
      return true;

   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);

   if(dt.day_of_week == 0 && !InpTradeSunday) return false;
   if(dt.day_of_week == 6 && !InpTradeSaturday) return false;

   int mins = dt.hour * 60 + dt.min;
   if(InpNt1On && InPeriod(mins, InpNt1StartH, InpNt1StartM, InpNt1EndH, InpNt1EndM)) return false;
   if(InpNt2On && InPeriod(mins, InpNt2StartH, InpNt2StartM, InpNt2EndH, InpNt2EndM)) return false;
   if(InpNt3On && InPeriod(mins, InpNt3StartH, InpNt3StartM, InpNt3EndH, InpNt3EndM)) return false;
   return true;
  }

bool InPeriod(const int mins, const int h1, const int m1, const int h2, const int m2)
  {
   int a = h1 * 60 + m1;
   int b = h2 * 60 + m2;
   if(a <= b)
      return (mins >= a && mins < b);
   return (mins >= a || mins < b);
  }

//+------------------------------------------------------------------+
bool PositionExists()
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) == _Symbol &&
         PositionGetInteger(POSITION_MAGIC) == InpMagic)
         return true;
     }
   return false;
  }

long PositionType()
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) == _Symbol &&
         PositionGetInteger(POSITION_MAGIC) == InpMagic)
         return PositionGetInteger(POSITION_TYPE);
     }
   return -1;
  }

void OpenMarket(const ENUM_ORDER_TYPE type)
  {
   double price = (type == ORDER_TYPE_BUY) ? SymbolInfoDouble(_Symbol, SYMBOL_ASK)
                                           : SymbolInfoDouble(_Symbol, SYMBOL_BID);
   g_trade.PositionOpen(_Symbol, type, InpLots, price, 0, 0, "TMIS");
   g_trailPeak = price;
  }

void CloseAll()
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) == _Symbol &&
         PositionGetInteger(POSITION_MAGIC) == InpMagic)
         g_trade.PositionClose(ticket);
     }
   g_trailPeak = 0;
  }

void ManageTrailing()
  {
   if(!PositionExists()) return;

   double close = iClose(_Symbol, PERIOD_CURRENT, 0);
   long type = PositionType();

   if(type == POSITION_TYPE_BUY)
     {
      if(g_trailPeak <= 0 || close > g_trailPeak) g_trailPeak = close;
      double stop = g_trailPeak * (1.0 - InpPositionTrailingPercent / 100.0);
      if(close <= stop)
         CloseAll();
     }
   else if(type == POSITION_TYPE_SELL)
     {
      if(g_trailPeak <= 0 || close < g_trailPeak) g_trailPeak = close;
      double stop = g_trailPeak * (1.0 + InpPositionTrailingPercent / 100.0);
      if(close >= stop)
         CloseAll();
     }
  }
//+------------------------------------------------------------------+
