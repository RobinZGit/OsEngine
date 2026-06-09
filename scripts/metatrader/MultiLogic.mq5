//+------------------------------------------------------------------+
//|                                              MultiLogic.mq5      |
//|  Порт OsEngine: Custom/Robots/MultiLogic.cs (упрощённый)         |
//|  Один символ графика; 4 слота логики L1–L4; строки Op/Cl/Regime. |
//+------------------------------------------------------------------+
// УСТАНОВКА: MQL5/Experts/ → Compile (F7) → на график → Algo Trading.
//
// ПЕРЕНЕСЕНО
//   • 4 слота «Логика N» (строки как в OsEngine, токен @LR → InpLinRegLen)
//   • Парсер: Disabled, Regime(LinReg;…), AND, атомы SMA/LinReg/ATR/CCI/MACD/Stoch/RSI/Boll/Mom
//   • Op/Cl: Ab, Bl, AbUp, BlLo, GrOk, Macd>Sig, CCI>=, K<=, RSI>=, SlopeUp, …
//   • Regime Entry=MatchSide / FlatOnly, OnFlip=Close, SlopeDead
//   • Инверсия логики, Regime Off/On/OnlyLong/OnlyShort/OnlyClose
//   • Общепортфельный SL/TP (% от equity, high-water ref)
//   • Просадка от пика (% от max equity, только закрытие)
//   • Пауза входов после значительного пика (годовая доходность впадина→пик)
//   • Инверсия: Buy↔Sell и Op↔Cl (как OsEngine / TMIS)
//   • Приоритет входа: L1 → L2 → L3 → L4 (упрощённая металогика)
//
// НЕ ПЕРЕНЕСЕНО (только OsEngine)
//   • HTML-отчёт, кнопки GUI, импорт/рандом логик, MOEX-скринер, много вкладок
//   • Металогика PnlSMA / распределение Volume, shadow-позиции, FAKE2
//   • Полный OR/NOT в строке, SL[…]/TP[…] в логике, каталог трендов, оптимизатор
//   • OR внутри Op[…] (кроме простых кодов), Note(…), Regime(Auto)
//
// СИГНАЛЫ: только на ЗАКРЫТОЙ свече (shift=1).
//+------------------------------------------------------------------+
#property copyright "OsEngine MultiLogic port"
#property version   "1.01"
#property description "MultiLogic: 4 logic slots, Regime, portfolio stopper. See file header."

#include <Trade/Trade.mqh>

enum ENUM_ML_REGIME
  {
   ML_OFF = 0,
   ML_ON = 1,
   ML_ONLY_LONG = 2,
   ML_ONLY_SHORT = 3,
   ML_ONLY_CLOSE = 4
  };

enum ENUM_ML_SIDE { ML_BUY=0, ML_SELL=1 };

//--- inputs
input group "=== Общие ==="
input ENUM_ML_REGIME InpRegime = ML_OFF;
input bool   InpLogicInversion = false;
input double InpLots = 0.1;
input ulong  InpMagic = 20260608;
input int    InpSlippagePoints = 10;

input group "=== Линейная регрессия (@LR в строках) ==="
input int InpLinRegLen = 50;

input group "=== Логика 1 (лонг-тренд по умолчанию) ==="
input bool   InpL1Enable = true;
input string InpLogic1 =
   "Regime(LinReg;L=@LR;Dev=2;SlopeLb=3;OnFlip=Close;Entry=MatchSide) "
   "(SMA(100) Op[Ab] Cl[Bl]) AND "
   "(LinReg(@LR;Dev=2) Op[AbUp] Cl[BlLo]) AND "
   "(ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-]) AND "
   "(CCI(20;Lmin=100;Smax=-100) Op[CCI>=100] Cl[CCI<=-100]) AND "
   "(MACD(12,26,9) Op[Macd>Sig] Cl[Macd<Sig])";

input group "=== Логика 2 (лонг-боковик) ==="
input bool   InpL2Enable = true;
input string InpLogic2 =
   "Regime(LinReg;L=@LR;Dev=2;SlopeLb=3;SlopeDead=0.05%;OnFlip=Close;Entry=FlatOnly) "
   "(SMA(100) Op[Ab] Cl[Bl]) AND "
   "(Stoch(14-3-3;Lmin=90;Smax=10) Op[K<=10] Cl[K>=90]) AND "
   "(ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-]) AND "
   "(MACD(12,26,9) Op[Macd>Sig] Cl[Macd<Sig])";

input group "=== Логика 3 (шорт-тренд) ==="
input bool   InpL3Enable = true;
input string InpLogic3 =
   "Regime(LinReg;L=@LR;Dev=2;SlopeLb=3;OnFlip=Close;Entry=MatchSide) "
   "(SMA(100) Side[S] Op[Bl] Cl[Ab]) AND "
   "(LinReg(@LR;Dev=2) Op[BlLo] Cl[AbUp]) AND "
   "(ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-]) AND "
   "(CCI(20;Lmin=100;Smax=-100) Op[CCI<=-100] Cl[CCI>=100]) AND "
   "(MACD(12,26,9) Op[Macd<Sig] Cl[Macd>Sig])";

input group "=== Логика 4 (шорт-боковик) ==="
input bool   InpL4Enable = true;
input string InpLogic4 =
   "Regime(LinReg;L=@LR;Dev=2;SlopeLb=3;SlopeDead=0.05%;OnFlip=Close;Entry=FlatOnly) "
   "(SMA(100) Side[S] Op[Bl] Cl[Ab]) AND "
   "(Stoch(14-3-3;Lmin=90;Smax=10) Op[K>=90] Cl[K<=10]) AND "
   "(ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-]) AND "
   "(MACD(12,26,9) Op[Macd<Sig] Cl[Macd>Sig])";

input group "=== Общепортфельный Stopper ==="
input bool   InpPortfSlOn = false;
input double InpPortfSlPct = 1.0;
input bool   InpPortfTpOn = false;
input double InpPortfTpPct = 2.0;
input bool   InpPeakDrawdownOn = false;
input double InpPeakDrawdownPct = 1.0;
input bool   InpSigPeakPauseOn = false;
input double InpSigPeakAnnualPct = 100.0;
input double InpSigPeakWidthMult = 10.0;

input group "=== Стопы и время ==="
input bool   InpUseTrailing = false;
input double InpTrailingPct = 1.0;
input bool   InpUseNonTrade = true;
input bool   InpNt1On = true;
input int    InpNt1SH=0, InpNt1SM=0, InpNt1EH=10, InpNt1EM=5;
input bool   InpNt2On = false;
input int    InpNt2SH=13,InpNt2SM=54,InpNt2EH=14,InpNt2EM=6;
input bool   InpNt3On = true;
input int    InpNt3SH=18,InpNt3SM=1, InpNt3EH=23,InpNt3EM=58;
input bool   InpTradeSat = false;
input bool   InpTradeSun = false;

#define ML_MAX_ATOMS 16

struct MLRegime
  {
   bool     valid;
   bool     entryMatchSide;
   bool     entryFlatOnly;
   bool     closeOnFlip;
   int      slopeLb;
   double   slopeDeadPct;
   int      linLen;
   double   linDev;
  };

struct MLAtom
  {
   string   kind;
   int      p1,p2,p3;
   double   dev, grPct;
   int      grLb;
   double   lmin, smax;
   string   opSig;
   string   clSig;
   bool     isShort;
  };

struct MLSlot
  {
   bool     enabled;
   bool     disabled;
   MLRegime regime;
   int      atomCount;
   MLAtom   atoms[ML_MAX_ATOMS];
  };

CTrade     g_trade;
datetime   g_lastBar = 0;
int        g_activeSlot = 0;
double     g_trailPeak = 0;
double     g_refEquity = 0;
double     g_portfolioPeak = 0;
datetime   g_sigPeakPauseUntil = 0;
datetime   g_sigPeakLastPeakTime = 0;
#define    ML_EQ_HIST 128
double     g_eqHist[ML_EQ_HIST];
datetime   g_eqHistTime[ML_EQ_HIST];
int        g_eqHistCount = 0;
MLSlot     g_slots[4];

int g_hCci = INVALID_HANDLE;
int g_hMacd = INVALID_HANDLE;
int g_hStoch = INVALID_HANDLE;

//+------------------------------------------------------------------+
string ML_ReplaceLR(string s)
  {
   string n = IntegerToString(InpLinRegLen);
   StringReplace(s, "@LR", n);
   return s;
  }

string ML_Upper(string s)
  {
   StringToUpper(s);
   return s;
  }

string ML_Trim(string s)
  {
   StringTrimLeft(s);
   StringTrimRight(s);
   return s;
  }

bool ML_TryExtractParenBlock(string &work, const string prefix, string &inner)
  {
   inner = "";
   if(StringFind(work, prefix, 0) != 0)
      return false;
   int i0 = StringLen(prefix);
   if(i0 >= StringLen(work) || StringGetCharacter(work, i0) != '(')
      return false;
   int depth = 0;
   for(int i = i0; i < StringLen(work); i++)
     {
      ushort c = StringGetCharacter(work, i);
      if(c == '(') depth++;
      else if(c == ')')
        {
         depth--;
         if(depth == 0)
           {
            inner = StringSubstr(work, i0 + 1, i - i0 - 1);
            work = ML_Trim(StringSubstr(work, i + 1));
            return true;
           }
        }
     }
   return false;
  }

bool ML_ParseDisabled(string &work, bool &disabled)
  {
   disabled = false;
   string inner;
   if(ML_TryExtractParenBlock(work, "Disabled", inner) || ML_TryExtractParenBlock(work, "Disable", inner))
     {
      string u = ML_Upper(inner);
      disabled = (u == "TRUE" || u == "1");
      return true;
     }
   return false;
  }

bool ML_ParseRegime(string &work, MLRegime &r)
  {
   r.valid = false;
   string inner;
   if(!ML_TryExtractParenBlock(work, "Regime", inner))
      return false;
   r.linLen = InpLinRegLen;
   r.linDev = 2.0;
   r.slopeLb = 3;
   r.slopeDeadPct = 0;
   r.entryMatchSide = false;
   r.entryFlatOnly = false;
   r.closeOnFlip = false;

   string parts[];
   int n = StringSplit(inner, ';', parts);
   for(int i = 0; i < n; i++)
     {
      string kv = ML_Trim(parts[i]);
      int eq = StringFind(kv, "=");
      string key = (eq < 0) ? kv : ML_Trim(StringSubstr(kv, 0, eq));
      string val = (eq < 0) ? "" : ML_Trim(StringSubstr(kv, eq + 1));
      string ku = ML_Upper(key);
      if(ku == "L")
         r.linLen = (int)StringToInteger(val);
      else if(ku == "DEV")
         r.linDev = StringToDouble(val);
      else if(ku == "SLOPELB")
         r.slopeLb = (int)StringToInteger(val);
      else if(ku == "SLOPEDEAD")
        {
         if(StringFind(val, "%") >= 0)
           {
            StringReplace(val, "%", "");
            r.slopeDeadPct = StringToDouble(val);
           }
        }
      else if(ku == "ENTRY" && ML_Upper(val) == "MATCHSIDE")
         r.entryMatchSide = true;
      else if(ku == "ENTRY" && ML_Upper(val) == "FLATONLY")
         r.entryFlatOnly = true;
      else if(ku == "ONFLIP" && ML_Upper(val) == "CLOSE")
         r.closeOnFlip = true;
     }
   r.valid = true;
   return true;
  }

bool ML_ExtractBrackets(string atom, const string tag, string &val)
  {
   val = "";
   string pat = tag + "[";
   int p = StringFind(atom, pat, 0);
   if(p < 0) return false;
   int e = StringFind(atom, "]", p);
   if(e < 0) return false;
   val = StringSubstr(atom, p + StringLen(pat), e - p - StringLen(pat));
   return true;
  }

bool ML_ParseAtom(string token, MLAtom &a)
  {
   ZeroMemory(a);
   token = ML_Trim(token);
   if(StringLen(token) >= 2 && StringGetCharacter(token, 0) == '(')
      token = StringSubstr(token, 1, StringLen(token) - 2);
   token = ML_Trim(token);

   int opPos = StringFind(token, " Op[", 0);
   if(opPos < 0) opPos = StringFind(token, " op[", 0);
   if(opPos < 0) return false;

   string head = ML_Trim(StringSubstr(token, 0, opPos));
   string tail = StringSubstr(token, opPos + 1);
   ML_ExtractBrackets(tail, "Op", a.opSig);
   ML_ExtractBrackets(tail, "Cl", a.clSig);
   a.isShort = (StringFind(tail, "Side[S]", 0) >= 0 || StringFind(tail, "Side[SELL]", 0) >= 0);

   int p0 = StringFind(head, "(", 0);
   string params = "";
   if(p0 < 0)
     {
      a.kind = ML_Upper(ML_Trim(head));
      if(a.kind != "VWAP")
         return false;
     }
   else
     {
      a.kind = ML_Upper(ML_Trim(StringSubstr(head, 0, p0)));
      params = StringSubstr(head, p0 + 1);
      StringReplace(params, ")", "");
     }

   if(a.kind == "VWAP")
      return true;
   if(a.kind == "SMA" || a.kind == "MOM" || a.kind == "MOMENTUM")
      a.p1 = (int)StringToInteger(params);
   else if(a.kind == "CCI" || a.kind == "RSI")
     {
      string cp[];
      int cn = StringSplit(params, ';', cp);
      if(cn > 0) a.p1 = (int)StringToInteger(ML_Trim(cp[0]));
      for(int j = 1; j < cn; j++)
        {
         string kv = ML_Trim(cp[j]);
         if(StringFind(kv, "Lmin=", 0) == 0) a.lmin = StringToDouble(StringSubstr(kv, 5));
         if(StringFind(kv, "Smax=", 0) == 0) a.smax = StringToDouble(StringSubstr(kv, 5));
        }
     }
   else if(a.kind == "MACD")
     {
      string mp[];
      if(StringSplit(params, ',', mp) >= 3)
        { a.p1=(int)StringToInteger(ML_Trim(mp[0])); a.p2=(int)StringToInteger(ML_Trim(mp[1])); a.p3=(int)StringToInteger(ML_Trim(mp[2])); }
     }
   else if(a.kind == "LINREG" || a.kind == "LR")
     {
      string lp[];
      StringSplit(params, ';', lp);
      if(ArraySize(lp) > 0) a.p1 = (int)StringToInteger(ML_Trim(lp[0]));
      for(int i = 1; i < ArraySize(lp); i++)
        {
         string kv = ML_Trim(lp[i]);
         if(StringFind(kv, "Dev=", 0) == 0) a.dev = StringToDouble(StringSubstr(kv, 4));
        }
      if(a.dev <= 0) a.dev = 2.0;
     }
   else if(a.kind == "ATR")
     {
      string ap[];
      StringSplit(params, ';', ap);
      if(ArraySize(ap) > 0) a.p1 = (int)StringToInteger(ML_Trim(ap[0]));
      for(int i = 1; i < ArraySize(ap); i++)
        {
         string kv = ML_Trim(ap[i]);
         if(StringFind(kv, "Gr=", 0) == 0)
           {
            string g = StringSubstr(kv, 3);
            StringReplace(g, "%", "");
            a.grPct = StringToDouble(g);
           }
         if(StringFind(kv, "Lb=", 0) == 0)
            a.grLb = (int)StringToInteger(StringSubstr(kv, 3));
        }
      if(a.grPct <= 0) a.grPct = 3;
      if(a.grLb <= 0) a.grLb = 5;
     }
   else if(a.kind == "STOCH" || a.kind == "STOCHASTIC")
     {
      string sp[];
      StringSplit(params, ';', sp);
      if(ArraySize(sp) > 0)
        {
         string dash[];
         if(StringSplit(ML_Trim(sp[0]), '-', dash) >= 3)
           { a.p1=(int)StringToInteger(dash[0]); a.p2=(int)StringToInteger(dash[1]); a.p3=(int)StringToInteger(dash[2]); }
        }
      for(int i = 1; i < ArraySize(sp); i++)
        {
         string kv = ML_Trim(sp[i]);
         if(StringFind(kv, "Lmin=", 0) == 0) a.lmin = StringToDouble(StringSubstr(kv, 5));
         if(StringFind(kv, "Smax=", 0) == 0) a.smax = StringToDouble(StringSubstr(kv, 5));
        }
     }
   else if(a.kind == "BOLL" || a.kind == "BOLLINGER")
     {
      string bp[];
      StringSplit(params, ';', bp);
      if(ArraySize(bp) > 0) a.p1 = (int)StringToInteger(ML_Trim(bp[0]));
      for(int i = 1; i < ArraySize(bp); i++)
        {
         string kv = ML_Trim(bp[i]);
         if(StringFind(kv, "Dev=", 0) == 0) a.dev = StringToDouble(StringSubstr(kv, 4));
        }
      if(a.p1 <= 0) a.p1 = 20;
      if(a.dev <= 0) a.dev = 2.0;
     }
   else
      return false;

   if(a.kind == "CCI" && a.lmin == 0) a.lmin = 100;
   if(a.kind == "CCI" && a.smax == 0) a.smax = -100;
   if(a.kind == "RSI" && a.lmin == 0) a.lmin = 55;
   if(a.kind == "RSI" && a.smax == 0) a.smax = 45;
   return true;
  }

bool ML_ParseSlot(const string rawLine, const bool enabled, MLSlot &slot)
  {
   ZeroMemory(slot);
   slot.enabled = enabled;
   string work = ML_ReplaceLR(rawLine);
   ML_ParseDisabled(work, slot.disabled);
   ML_ParseRegime(work, slot.regime);
   string parts[];
   int n = 0;
   ArrayResize(parts, 0);
   int start = 0;
   string marker = " AND ";
   while(true)
     {
      int p = StringFind(work, marker, start);
      string chunk = (p < 0) ? StringSubstr(work, start) : StringSubstr(work, start, p - start);
      chunk = ML_Trim(chunk);
      if(StringLen(chunk) > 0)
        {
         ArrayResize(parts, n + 1);
         parts[n++] = chunk;
        }
      if(p < 0) break;
      start = p + StringLen(marker);
     }
   slot.atomCount = 0;
   for(int i = 0; i < n && slot.atomCount < ML_MAX_ATOMS; i++)
     {
      MLAtom a;
      if(ML_ParseAtom(parts[i], a))
         slot.atoms[slot.atomCount++] = a;
     }
   return slot.atomCount > 0 || slot.regime.valid;
  }

//--- LinReg bands (OsEngine LinearRegressionChannelFast style)
bool ML_LinRegBands(const int shift, const int len, const double dev,
                    double &up, double &mid, double &lo)
  {
   up=mid=lo=0;
   if(len < 2 || shift + len > Bars(_Symbol, PERIOD_CURRENT)) return false;
   double sumY=0,sumX=0,sumXY=0,sumX2=0;
   for(int i=0;i<len;i++)
     {
      int bar = shift + len - 1 - i;
      double y = iClose(_Symbol, PERIOD_CURRENT, bar);
      double x = (double)i;
      sumY+=y; sumX+=x; sumXY+=y*x; sumX2+=x*x;
     }
   double c = sumX2*len - sumX*sumX;
   if(c==0) return false;
   double b = (sumXY*len - sumX*sumY)/c;
   double a0 = (sumY - sumX*b)/len;
   double err=0;
   for(int i=0;i<len;i++)
     {
      int bar = shift + len - 1 - i;
      double y = iClose(_Symbol, PERIOD_CURRENT, bar);
      err += MathAbs(y - (a0 + b*(double)i));
     }
   err /= len;
   mid = a0 + b*(len-1);
   up = mid + err*dev;
   lo = mid - err*dev;
   return true;
  }

int ML_RegimeSign(const MLRegime &r, const int shift)
  {
   if(!r.valid) return 0;
   double up,mid,lo;
   if(!ML_LinRegBands(shift, r.linLen, r.linDev, up, mid, lo)) return 0;
   int lb = MathMax(1, r.slopeLb);
   double up2,m2,lo2;
   if(!ML_LinRegBands(shift+lb, r.linLen, r.linDev, up2, m2, lo2)) return 0;
   double delta = mid - m2;
   double dead = (r.slopeDeadPct > 0) ? MathAbs(mid)*r.slopeDeadPct/100.0 : 0;
   if(delta > dead) return 1;
   if(delta < -dead) return -1;
   return 0;
  }

bool ML_RegimeAllowsEntry(const MLRegime &r, const ENUM_ML_SIDE side, const int sign)
  {
   if(!r.valid) return true;
   if(r.entryFlatOnly) return sign == 0;
   if(r.entryMatchSide)
     {
      if(sign > 0) return side == ML_BUY;
      if(sign < 0) return side == ML_SELL;
      return false;
     }
   return true;
  }

bool ML_RegimeShouldClose(const MLRegime &r, const ENUM_ML_SIDE side, const int sign)
  {
   if(!r.valid || !r.closeOnFlip) return false;
   if(r.entryFlatOnly) return sign != 0;
   if(sign > 0) return side == ML_SELL;
   if(sign < 0) return side == ML_BUY;
   return false;
  }

double ML_Sma(const int shift, const int len)
  {
   double s=0;
   for(int i=0;i<len;i++) s += iClose(_Symbol, PERIOD_CURRENT, shift+i);
   return s/len;
  }

int ML_RegimeSignFromAtom(const MLAtom &a, const int shift)
  {
   MLRegime r;
   r.valid=true; r.linLen=a.p1; r.linDev=a.dev; r.slopeLb=3; r.slopeDeadPct=0;
   return ML_RegimeSign(r, shift);
  }

double ML_CalcVwap(const int shift)
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

bool ML_BollBands(const int shift, const int len, const double dev,
                  double &upper, double &mid, double &lower)
  {
   upper = mid = lower = 0;
   int h = iBands(_Symbol, PERIOD_CURRENT, len, 0, dev, PRICE_CLOSE);
   double bu[], bm[], bl[];
   if(CopyBuffer(h, 1, shift, 1, bu) != 1) { IndicatorRelease(h); return false; }
   if(CopyBuffer(h, 0, shift, 1, bm) != 1) { IndicatorRelease(h); return false; }
   if(CopyBuffer(h, 2, shift, 1, bl) != 1) { IndicatorRelease(h); return false; }
   IndicatorRelease(h);
   upper = bu[0]; mid = bm[0]; lower = bl[0];
   return (upper != 0 && lower != 0);
  }

bool ML_AtrGrow(const int shift, const int len, const double grPct, const int lb)
  {
   int h = iATR(_Symbol, PERIOD_CURRENT, len);
   double a0[],a1[];
   if(CopyBuffer(h,0,shift,1,a0)!=1) return false;
   if(CopyBuffer(h,0,shift+lb,1,a1)!=1) { IndicatorRelease(h); return false; }
   IndicatorRelease(h);
   if(a1[0]<=0) return false;
   return (a0[0]/(a1[0]/100.0)-100.0) >= grPct;
  }

bool ML_EvalSignal(const string sig, const MLAtom &a, const int shift, const bool forClose)
  {
   string s = ML_Upper(ML_Trim(sig));
   if(s=="" || s=="-" || s=="NONE") return forClose ? false : false;
   double close = iClose(_Symbol, PERIOD_CURRENT, shift);

   if(a.kind=="SMA")
     {
      double v = ML_Sma(shift, a.p1);
      if(s=="AB") return close > v;
      if(s=="BL") return close < v;
     }
   if(a.kind=="LINREG" || a.kind=="LR")
     {
      double up,mid,lo;
      if(!ML_LinRegBands(shift, a.p1, a.dev, up, mid, lo)) return false;
      if(s=="ABUP" || s=="AB") return close > up;
      if(s=="BLLO" || s=="BL") return close < lo;
      if(s=="SLOPEUP" || s=="REGUP") return ML_RegimeSignFromAtom(a, shift) > 0;
      if(s=="SLOPEDN" || s=="REGDN") return ML_RegimeSignFromAtom(a, shift) < 0;
     }
   if(a.kind=="ATR" && s=="GROK")
      return ML_AtrGrow(shift, a.p1, a.grPct, a.grLb);
   if(a.kind=="MACD")
     {
      int h = iMACD(_Symbol, PERIOD_CURRENT, a.p1, a.p2, a.p3, PRICE_CLOSE);
      double m[],sigl[];
      if(CopyBuffer(h,0,shift,1,m)!=1) { IndicatorRelease(h); return false; }
      if(CopyBuffer(h,1,shift,1,sigl)!=1) { IndicatorRelease(h); return false; }
      IndicatorRelease(h);
      if(s=="MACD>SIG") return m[0] > sigl[0];
      if(s=="MACD<SIG") return m[0] < sigl[0];
     }
   if(a.kind=="CCI")
     {
      int h = iCCI(_Symbol, PERIOD_CURRENT, a.p1, PRICE_TYPICAL);
      double b[];
      if(CopyBuffer(h,0,shift,1,b)!=1) { IndicatorRelease(h); return false; }
      IndicatorRelease(h);
      if(StringFind(s,"CCI>=")==0) return b[0] >= StringToDouble(StringSubstr(s,5));
      if(StringFind(s,"CCI<=")==0) return b[0] <= StringToDouble(StringSubstr(s,5));
      if(StringFind(s,"CCI<")==0)  return b[0] <  StringToDouble(StringSubstr(s,4));
     }
   if(a.kind=="RSI")
     {
      int h = iRSI(_Symbol, PERIOD_CURRENT, a.p1, PRICE_CLOSE);
      double b[];
      if(CopyBuffer(h,0,shift,1,b)!=1) { IndicatorRelease(h); return false; }
      IndicatorRelease(h);
      if(StringFind(s,"RSI>=")==0) return b[0] >= StringToDouble(StringSubstr(s,5));
      if(StringFind(s,"RSI<=")==0) return b[0] <= StringToDouble(StringSubstr(s,5));
      if(StringFind(s,"RSI<")==0)  return b[0] <  StringToDouble(StringSubstr(s,4));
     }
   if(a.kind=="VWAP")
     {
      double v = ML_CalcVwap(shift);
      if(v <= 0) return false;
      if(s=="AB") return close > v;
      if(s=="BL") return close < v;
     }
   if(a.kind=="BOLL" || a.kind=="BOLLINGER")
     {
      double up, mid, lo;
      if(!ML_BollBands(shift, a.p1, a.dev, up, mid, lo)) return false;
      if(s=="AB" || s=="ABUP") return close > up;
      if(s=="BL" || s=="BLLO") return close < lo;
      if(s=="ABMID") return close > mid;
      if(s=="BLMID") return close < mid;
     }
   if(a.kind=="STOCH" || a.kind=="STOCHASTIC")
     {
      int h = iStochastic(_Symbol, PERIOD_CURRENT, a.p1, a.p2, a.p3, MODE_SMA, STO_LOWHIGH);
      double k[];
      if(CopyBuffer(h,0,shift,1,k)!=1) { IndicatorRelease(h); return false; }
      IndicatorRelease(h);
      if(StringFind(s,"K>=")==0) return k[0] >= StringToDouble(StringSubstr(s,3));
      if(StringFind(s,"K<=")==0) return k[0] <= StringToDouble(StringSubstr(s,3));
     }
   return false;
  }

bool ML_EvalAtom(const MLAtom &a, const int shift, const bool forClose)
  {
   string sig = forClose ? a.clSig : a.opSig;
   return ML_EvalSignal(sig, a, shift, forClose);
  }

bool ML_EvalOpen(const MLSlot &slot, const int shift)
  {
   if(!slot.enabled || slot.disabled) return false;
   for(int i=0;i<slot.atomCount;i++)
      if(!ML_EvalAtom(slot.atoms[i], shift, false)) return false;
   return slot.atomCount > 0;
  }

bool ML_EvalClose(const MLSlot &slot, const int shift)
  {
   for(int i=0;i<slot.atomCount;i++)
     {
      string cl = ML_Upper(slot.atoms[i].clSig);
      if(cl=="" || cl=="-") continue;
      if(ML_EvalAtom(slot.atoms[i], shift, true)) return true;
     }
   return false;
  }

ENUM_ML_SIDE ML_SlotSide(const MLSlot &slot)
  {
   for(int i=0;i<slot.atomCount;i++)
      if(slot.atoms[i].isShort) return ML_SELL;
   return ML_BUY;
  }

bool ML_EvalEntrySignal(const MLSlot &slot, const int shift)
  {
   return InpLogicInversion ? ML_EvalClose(slot, shift) : ML_EvalOpen(slot, shift);
  }

bool ML_EvalExitSignal(const MLSlot &slot, const int shift)
  {
   return InpLogicInversion ? ML_EvalOpen(slot, shift) : ML_EvalClose(slot, shift);
  }

void ML_AppendEquitySnapshot(const datetime barTime)
  {
   double eq = AccountInfoDouble(ACCOUNT_EQUITY);
   if(g_eqHistCount > 0 && g_eqHistTime[g_eqHistCount - 1] == barTime)
     {
      g_eqHist[g_eqHistCount - 1] = eq;
      return;
     }
   if(g_eqHistCount >= ML_EQ_HIST)
     {
      for(int i = 1; i < ML_EQ_HIST; i++)
        {
         g_eqHist[i - 1] = g_eqHist[i];
         g_eqHistTime[i - 1] = g_eqHistTime[i];
        }
      g_eqHistCount = ML_EQ_HIST - 1;
     }
   g_eqHist[g_eqHistCount] = eq;
   g_eqHistTime[g_eqHistCount] = barTime;
   g_eqHistCount++;
  }

bool ML_TryComputeSigPeakAnnualPct(
   const double troughEq,
   const double peakEq,
   const datetime troughTime,
   const datetime peakTime,
   double &annualPct)
  {
   annualPct = 0.0;
   if(troughEq <= 0.0 || peakEq <= troughEq)
      return false;
   double totalReturn = (peakEq - troughEq) / troughEq;
   if(totalReturn <= -1.0)
      return false;
   double days = (double)(peakTime - troughTime) / 86400.0;
   if(days < 1.0 / 24.0)
      days = 1.0 / 24.0;
   double exponent = 365.0 / days;
   if(exponent > 10000.0)
      exponent = 10000.0;
   double growth = MathPow(1.0 + totalReturn, exponent);
   if(!MathIsValidNumber(growth) || growth <= 0.0)
      return false;
   if(growth >= DBL_MAX / 100.0)
     {
      annualPct = 1.0e12;
      return true;
     }
   annualPct = (growth - 1.0) * 100.0;
   return MathIsValidNumber(annualPct);
  }

void ML_UpdateSigPeakPause(const datetime barTime)
  {
   if(!InpSigPeakPauseOn || g_eqHistCount < 3)
      return;
   int peakIdx = g_eqHistCount - 2;
   double peakEq = g_eqHist[peakIdx];
   double prevEq = g_eqHist[peakIdx - 1];
   double nextEq = g_eqHist[peakIdx + 1];
   if(!(peakEq >= prevEq && peakEq > nextEq))
      return;
   datetime peakTime = g_eqHistTime[peakIdx];
   if(peakTime <= g_sigPeakLastPeakTime)
      return;
   g_sigPeakLastPeakTime = peakTime;
   int troughIdx = peakIdx;
   for(int j = peakIdx - 1; j >= 0; j--)
     {
      if(g_eqHist[j] < g_eqHist[troughIdx])
         troughIdx = j;
      else if(g_eqHist[j] > g_eqHist[troughIdx])
         break;
     }
   double troughEq = g_eqHist[troughIdx];
   datetime troughTime = g_eqHistTime[troughIdx];
   double annualPct = 0.0;
   if(!ML_TryComputeSigPeakAnnualPct(troughEq, peakEq, troughTime, peakTime, annualPct))
      return;
   if(annualPct < InpSigPeakAnnualPct)
      return;
   double mult = InpSigPeakWidthMult;
   if(mult < 0.1)
      mult = 0.1;
   long pauseSec = (long)((peakTime - troughTime) * mult);
   if(pauseSec <= 0)
      pauseSec = 3600;
   datetime pauseUntil = peakTime + pauseSec;
   if(pauseUntil > g_sigPeakPauseUntil)
      g_sigPeakPauseUntil = pauseUntil;
  }

bool ML_IsSigPeakEntryPaused(const datetime barTime)
  {
   return InpSigPeakPauseOn && g_sigPeakPauseUntil > 0 && barTime < g_sigPeakPauseUntil;
  }

bool ML_CheckPeakDrawdown()
  {
   if(!InpPeakDrawdownOn || InpPeakDrawdownPct <= 0.0)
      return false;
   double eq = AccountInfoDouble(ACCOUNT_EQUITY);
   if(eq <= 0.0)
      return false;
   if(g_portfolioPeak <= 0.0 || eq > g_portfolioPeak)
      g_portfolioPeak = eq;
   double floor = g_portfolioPeak * (1.0 - InpPeakDrawdownPct / 100.0);
   if(eq > floor)
      return false;
   ML_CloseAll();
   g_portfolioPeak = eq;
   return true;
  }

//+------------------------------------------------------------------+
int OnInit()
  {
   g_trade.SetExpertMagicNumber(InpMagic);
   g_trade.SetDeviationInPoints(InpSlippagePoints);
   g_refEquity = AccountInfoDouble(ACCOUNT_EQUITY);
   g_portfolioPeak = g_refEquity;

   string lines[4] = {InpLogic1, InpLogic2, InpLogic3, InpLogic4};
   bool ens[4] = {InpL1Enable, InpL2Enable, InpL3Enable, InpL4Enable};
   for(int i=0;i<4;i++)
     {
      if(!ML_ParseSlot(lines[i], ens[i], g_slots[i]))
         Print("MultiLogic: L", i+1, " parse warning");
     }
   Print("MultiLogic MT5 OK. LinRegLen=", InpLinRegLen, " slots parsed.");
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason) {}

bool ML_CanTradeTime()
  {
   if(!InpUseNonTrade) return true;
   MqlDateTime dt; TimeToStruct(TimeCurrent(), dt);
   if(dt.day_of_week==0 && !InpTradeSun) return false;
   if(dt.day_of_week==6 && !InpTradeSat) return false;
   int mins = dt.hour*60+dt.min;
   if(InpNt1On && ML_InPeriod(mins,InpNt1SH,InpNt1SM,InpNt1EH,InpNt1EM)) return false;
   if(InpNt2On && ML_InPeriod(mins,InpNt2SH,InpNt2SM,InpNt2EH,InpNt2EM)) return false;
   if(InpNt3On && ML_InPeriod(mins,InpNt3SH,InpNt3SM,InpNt3EH,InpNt3EM)) return false;
   return true;
  }

bool ML_InPeriod(const int mins,const int h1,const int m1,const int h2,const int m2)
  {
   int a=h1*60+m1, b=h2*60+m2;
   if(a<=b) return (mins>=a && mins<b);
   return (mins>=a || mins<b);
  }

bool ML_HasPos()
  {
   for(int i=PositionsTotal()-1;i>=0;i--)
     {
      if(!PositionSelectByTicket(PositionGetTicket(i))) continue;
      if(PositionGetString(POSITION_SYMBOL)==_Symbol && PositionGetInteger(POSITION_MAGIC)==(long)InpMagic)
         return true;
     }
   return false;
  }

long ML_PosType()
  {
   for(int i=PositionsTotal()-1;i>=0;i--)
     {
      if(!PositionSelectByTicket(PositionGetTicket(i))) continue;
      if(PositionGetString(POSITION_SYMBOL)==_Symbol && PositionGetInteger(POSITION_MAGIC)==(long)InpMagic)
         return PositionGetInteger(POSITION_TYPE);
     }
   return -1;
  }

void ML_CloseAll()
  {
   for(int i=PositionsTotal()-1;i>=0;i--)
     {
      ulong t = PositionGetTicket(i);
      if(t==0) continue;
      if(!PositionSelectByTicket(t)) continue;
      if(PositionGetString(POSITION_SYMBOL)==_Symbol && PositionGetInteger(POSITION_MAGIC)==(long)InpMagic)
         g_trade.PositionClose(t);
     }
   g_activeSlot=0; g_trailPeak=0;
  }

void ML_Open(const ENUM_ORDER_TYPE type, const int slot)
  {
   double price = (type==ORDER_TYPE_BUY) ? SymbolInfoDouble(_Symbol,SYMBOL_ASK) : SymbolInfoDouble(_Symbol,SYMBOL_BID);
   string cmt = "ML-L"+IntegerToString(slot);
   g_trade.PositionOpen(_Symbol, type, InpLots, price, 0, 0, cmt);
   g_activeSlot = slot;
   g_trailPeak = price;
  }

bool ML_CheckPortfStopper()
  {
   double eq = AccountInfoDouble(ACCOUNT_EQUITY);
   if(eq > g_refEquity) g_refEquity = eq;
   if(InpPortfSlOn && InpPortfSlPct>0 && eq <= g_refEquity*(1.0-InpPortfSlPct/100.0))
     { ML_CloseAll(); g_refEquity=eq; return true; }
   if(InpPortfTpOn && InpPortfTpPct>0 && eq >= g_refEquity*(1.0+InpPortfTpPct/100.0))
     { ML_CloseAll(); g_refEquity=eq; return true; }
   return false;
  }

void ML_Trailing()
  {
   if(!InpUseTrailing || !ML_HasPos()) return;
   double c = iClose(_Symbol, PERIOD_CURRENT, 0);
   long t = ML_PosType();
   if(t==POSITION_TYPE_BUY)
     {
      if(g_trailPeak<=0 || c>g_trailPeak) g_trailPeak=c;
      if(c <= g_trailPeak*(1.0-InpTrailingPct/100.0)) ML_CloseAll();
     }
   else if(t==POSITION_TYPE_SELL)
     {
      if(g_trailPeak<=0 || c<g_trailPeak) g_trailPeak=c;
      if(c >= g_trailPeak*(1.0+InpTrailingPct/100.0)) ML_CloseAll();
     }
  }

void OnTick()
  {
   if(InpRegime==ML_OFF) return;
   ML_Trailing();

   datetime bt = iTime(_Symbol, PERIOD_CURRENT, 1);
   if(bt==0 || bt==g_lastBar) return;
   g_lastBar = bt;
   if(!ML_CanTradeTime()) return;
   ML_AppendEquitySnapshot(bt);
   ML_UpdateSigPeakPause(bt);
   if(ML_CheckPeakDrawdown()) return;
   if(ML_CheckPortfStopper()) return;

   const int sh = 1;

   if(ML_HasPos() && g_activeSlot>=1 && g_activeSlot<=4)
     {
      int si = g_activeSlot - 1;
      ENUM_ML_SIDE side = ML_SlotSide(g_slots[si]);
      if(InpLogicInversion) side = (side==ML_BUY)?ML_SELL:ML_BUY;
      int sign = ML_RegimeSign(g_slots[si].regime, sh);
      if(ML_RegimeShouldClose(g_slots[si].regime, side, sign) || ML_EvalExitSignal(g_slots[si], sh))
        { ML_CloseAll(); return; }
     }

   if(ML_HasPos()) return;
   if(ML_IsSigPeakEntryPaused(bt)) return;

   int pick = 0;
   for(int s=0;s<4;s++)
     {
      if(!g_slots[s].enabled || g_slots[s].disabled) continue;
      if(!ML_EvalEntrySignal(g_slots[s], sh)) continue;
      ENUM_ML_SIDE side = ML_SlotSide(g_slots[s]);
      if(InpLogicInversion) side = (side==ML_BUY)?ML_SELL:ML_BUY;
      int sign = ML_RegimeSign(g_slots[s].regime, sh);
      if(!ML_RegimeAllowsEntry(g_slots[s].regime, side, sign)) continue;
      if(InpRegime==ML_ONLY_CLOSE) continue;
      if(side==ML_BUY && InpRegime==ML_ONLY_SHORT) continue;
      if(side==ML_SELL && InpRegime==ML_ONLY_LONG) continue;
      pick = s+1;
      break;
     }

   if(pick==0) return;
   ENUM_ML_SIDE side = ML_SlotSide(g_slots[pick-1]);
   if(InpLogicInversion) side = (side==ML_BUY)?ML_SELL:ML_BUY;
   if(side==ML_BUY) ML_Open(ORDER_TYPE_BUY, pick);
   else ML_Open(ORDER_TYPE_SELL, pick);
  }
//+------------------------------------------------------------------+
