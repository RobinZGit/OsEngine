# -*- coding: utf-8 -*-
"""Добавляет XML-комментарии к методам TrendMultiIndicatorScreener.cs."""
import re
from pathlib import Path

FILE = Path(__file__).resolve().parents[1] / "project/OsEngine/bin/Debug/Custom/Robots/TrendMultiIndicatorScreener.cs"

DOCS = {
    "TrendMultiIndicatorScreener": (
        "Конструктор робота: скринер, параметры, индикаторы, MOEX, аварийная остановка, расписание."
    ),
    "TrendMultiIndicatorScreener_DeleteEvent": (
        "Обработчик удаления робота: удаляет настройки нерабочих периодов с диска."
    ),
    "TradePeriodsShowDialogButton_UserClickOnButtonEvent": (
        "Кнопка «Non trade periods»: открывает диалог календаря/времени запрета торговли."
    ),
    "ClusterShowLast_UserClickOnButtonEvent": (
        "Кнопка «Show last clusters»: выводит в лог состав кластеров волатильности по вкладкам скринера."
    ),
    "ApplyPrefixesFromOpenParameterDialog": (
        "Сохраняет значения из открытого окна параметров перед MOEX-перезагрузкой (reflection для старых DLL)."
    ),
    "MoexFuturesLoadButton_UserClickOnButtonEvent": (
        "Кнопка «Обновить фьючерсы»: пересборка списка бумаг скринера по префиксам корня FORTS."
    ),
    "MoexStockLoadButton_UserClickOnButtonEvent": (
        "Кнопка «Обновить акции»: пересборка списка бумаг скринера по точным тикерам MOEX."
    ),
    "ReloadMoexScreenerInstruments": (
        "Общая логика MOEX reload: коннектор, класс бумаг, фильтры, очистка, добавление ActivatedSecurity, перезагрузка вкладок."
    ),
    "ClearAllScreenerSecuritiesAndTabs": (
        "Очищает SecuritiesNames и удаляет все дочерние вкладки скринера; сбрасывает файл ScreenerTabSet."
    ),
    "RemoveCorruptScreenerTabSetFileIfNeeded": (
        "Удаляет пустой/битый ScreenerTabSet.txt, иначе TryLoadTabs падает с NRE при старте."
    ),
    "ClearScreenerPersistedTabListFile": (
        "Удаляет файл списка вкладок перед полной пересборкой бумаг."
    ),
    "TryInvokeScreenerRePaintSecuritiesGrid": (
        "Через reflection вызывает RePaintSecuritiesGrid у BotTabScreener для обновления таблицы бумаг."
    ),
    "IsTesterLikeServer": (
        "True, если сервер — Tester или Optimizer (особые правила имён и TestClass)."
    ),
    "GetMoexReloadInstrumentList": (
        "Список бумаг для сканирования: в лайве — Securities сервера; в тестере — SecuritiesTester с нужным ТФ."
    ),
    "BuildTesterConnectedSetSecurities": (
        "Строит список Security из SecuritiesTester с именем файла и ТФ как у скринера."
    ),
    "TryGetSecuritiesTesterList": (
        "Возвращает SecuritiesTester с TesterServer или OptimizerServer."
    ),
    "IsScreenerInstrument": (
        "Фильтр типа инструмента: фьючерс/акция; в тестере — по стилю имени, в лайве — по SecurityType."
    ),
    "IsPlainEquityTicker": (
        "Спот-тикер: только буквы, длина ≤6, без RUBF/TOM/TOD."
    ),
    "IsMoexFuturesStyleName": (
        "Имя в стиле FORTS: серия с цифрой, дефис с датой, RUBF/TOM/TOD, не голый спот."
    ),
    "IsMoexStockStyleName": (
        "Спот MOEX: проходит IsPlainEquityTicker и не является фьючерсным именем."
    ),
    "SecurityMatchesPrefixes": (
        "Сопоставление бумаги со списком: акции — точный тикер; фьючерсы — корень/префикс."
    ),
    "SecurityExactTickerMatchesAnyPrefix": (
        "Точное совпадение Name/NameId с одним из тикеров (с учётом расширения файла в тестере)."
    ),
    "GetSecurityClassName": (
        "NameClass бумаги или Stock/Futures/TestClass по SecurityType."
    ),
    "DetectFuturesSecuritiesClass": (
        "Определяет класс фьючерсов на сервере (TInvest: Futures; иначе SPBFUT)."
    ),
    "DetectTInvestFuturesSecuritiesClass": (
        "TInvest: класс Futures, если есть хотя бы один фьючерс в списке сервера."
    ),
    "DetectStockSecuritiesClass": (
        "Определяет класс акций на сервере (TInvest — через DetectTInvestStockSecuritiesClass)."
    ),
    "DetectTInvestStockSecuritiesClass": (
        "TInvest: класс Stock* с максимальным числом бумаг; при списке тикеров — только по ним; приоритет Stock rub."
    ),
    "PickBestMoexStockClass": (
        "Выбор класса акций: предпочтение Stock rub, иначе класс с максимальным счётчиком."
    ),
    "ResolveMoexTargetSecuritiesClass": (
        "Класс для MOEX reload: по тикерам на TInvest, иначе общий Detect*."
    ),
    "DetectTInvestFuturesSecuritiesClassForTickers": (
        "Класс фьючерсов только среди бумаг, подошедших под префиксы пользователя."
    ),
    "ShouldUseMoexTesterConnector": (
        "True в тестере/оптимизаторе — не переключать на TInvest."
    ),
    "HasConfiguredLiveScreenerConnection": (
        "В лайве заданы TInvest, имя сервера и портфель в настройках скринера."
    ),
    "CaptureMoexScreenerPreserveSettings": (
        "Снимок портфеля, сервера, ТФ и класса бумаг перед MOEX reload."
    ),
    "RestoreMoexScreenerPreserveSettings": (
        "Восстанавливает снимок настроек скринера после добавления бумаг."
    ),
    "TryValidateLiveScreenerBeforeMoexReload": (
        "Проверка перед первым MOEX reload: сервер, портфель и их наличие на коннекторе."
    ),
    "PortfolioExistsOnServer": (
        "Есть ли портфель с таким Number на сервере."
    ),
    "ServerNamesMatch": (
        "Совпадение имени сервера скринера с ServerNameAndPrefix (t-invest / TInvest_t-invest)."
    ),
    "FindTInvestServerByScreenerName": (
        "Ищет TInvest-сервер по имени из настроек скринера (полное или суффикс)."
    ),
    "TryApplyMoexConnectorToScreener": (
        "В лайве не меняет коннектор, если уже настроен TInvest; иначе назначает первый TInvest."
    ),
    "ResolveMoexLiveServer": (
        "Сервер для MOEX в лайве: из настроек скринера, иначе первый TInvest с бумагами."
    ),
    "FindTesterLikeServer": (
        "Первый Tester/Optimizer с непустым списком бумаг."
    ),
    "FindTInvestServer": (
        "Первый TInvest с загруженными бумагами (fallback)."
    ),
    "DetectMoexSecuritiesClass": (
        "Подсчёт классов на сервере; preferredClass или TestClass в тестере."
    ),
    "FindServerForScreener": (
        "IServer по ServerType и ServerName скринера."
    ),
    "ApplyMoexScreenerReload": (
        "Сохранение, ожидание TInvest, TryReLoadTabs, повтор при неполном создании вкладок."
    ),
    "BuildMoexScreenerReloadResultNote": (
        "Текст ошибки, если вкладки не созданы (портфель/сервер)."
    ),
    "CountActivatedScreenerSecurities": (
        "Число бумаг с IsOn в SecuritiesNames."
    ),
    "RunMoexScreenerTabsReloadPass": (
        "Один проход TryLoadTabs/TryReLoadTabs с инициализацией CandleSeriesRealization."
    ),
    "ScheduleMoexScreenerTabsReloadRetry": (
        "Отложенный повтор перезагрузки вкладок (до 5 раз) после подключения TInvest."
    ),
    "WaitForMoexServerReady": (
        "Ожидание Connect и непустого Securities на сервере."
    ),
    "EnsureScreenerCandleInfrastructure": (
        "Создаёт CandleSeriesRealization у скринера и дочерних вкладок при необходимости."
    ),
    "EnsureExistingScreenerTabsCandleInfrastructure": (
        "Проставляет CandleSeriesRealization на всех существующих вкладках скринера."
    ),
    "EnsureTabCandleSeriesRealization": (
        "Инициализирует CandleSeriesRealization на коннекторе вкладки из состояния скринера."
    ),
    "ParseTickerPrefixes": (
        "Разбор строки префиксов/тикеров через запятую без дубликатов."
    ),
    "SecurityLetterRootMatchesAnyPrefix": (
        "Корень FORTS бумаги совпадает с одним из префиксов (с алиасами CNY→CR)."
    ),
    "GetTesterInstrumentTicker": (
        "Имя тикера из имени файла истории: путь, расширение, суффикс после +."
    ),
    "FormatTesterSetNameSamples": (
        "Примеры имён из сета тестера для сообщения об ошибке."
    ),
    "NormalizeFuturesTicker": (
        "Обрезка суффикса после «+» (Quik: CRZ5+SPBFUT)."
    ),
    "ExpandPrefixWithMoexAliases": (
        "Префикс пользователя + биржевые алиасы (CNY→CR)."
    ),
    "ExtractFuturesLetterRoot": (
        "Буквенный корень из тикера фьючерса (до цифр/дефиса/точки)."
    ),
    "TryExtractMoexFortsSeriesBase": (
        "База серии FORTS для сравнения с префиксом."
    ),
    "RootMatchesExpandedPrefix": (
        "Совпадение корня с префиксом (включая вложенные префиксы)."
    ),
    "TickerLetterRootMatchesAnyPrefix": (
        "Корень тикера подходит под любой префикс из списка."
    ),
    "GetNameStrategyType": (
        "Имя типа стратегии для OsEngine."
    ),
    "ShowIndividualSettingsDialog": (
        "Отдельный диалог настроек не используется."
    ),
    "TrendMultiIndicatorScreener_ParametrsChangeByUser": (
        "При изменении параметров: сигнатура аварийки, SyncIndicators, обновление параметров на вкладках."
    ),
    "RefreshEmergencySettingsSignature": (
        "Сброс флага аварийной остановки при смене порогов/даты остановки."
    ),
    "GetDecisionTime": (
        "Время для расписания и аварийки: в тестере — свеча; в лайве — сервер или свеча."
    ),
    "GetCalendarDateForTimeOnly": (
        "Календарная дата для парсинга «только время» (HH:mm)."
    ),
    "TryParsePercentThreshold": (
        "Парсинг положительного процента из строкового параметра; пусто — выкл."
    ),
    "IsFilledStringParameter": (
        "Строковый параметр задан (не пустой и не пробелы)."
    ),
    "ContainsDigit": (
        "Есть ли цифра в строке (для отсечения мусора при парсинге даты)."
    ),
    "TryParseFlexibleDateTime": (
        "Парсинг даты/времени: dd.MM.yyyy, ISO, только HH:mm (дата — календарный день decision time)."
    ),
    "TryParseStopDeadline": (
        "Дедлайн из «Дата/время остановки»; пустой параметр — false."
    ),
    "IsBeforeScheduledWorkStart": (
        "True, если decision time строго меньше «Дата-время начала работы» (пустой параметр — false)."
    ),
    "TryGetMonitoredPortfolioValue": (
        "Текущее значение актива портфеля для стоп/тейк (Prime или выбранный инструмент)."
    ),
    "UpdateEmergencyRegimeAndBaseline": (
        "Фиксация базы портфеля при переходе Regime в On; сброс при Off и смене настроек."
    ),
    "TryBuildEmergencyReason": (
        "Причина аварийной остановки: время, % SL/TP от базы; пустые параметры не учитываются."
    ),
    "CloseAllBotPositionsAtMarket": (
        "CloseAtMarket по всем открытым позициям робота на всех вкладках скринера."
    ),
    "StopRobotButton_UserClickOnButtonEvent": (
        "Кнопка «Остановить робота»: закрытие позиций и Regime=Off."
    ),
    "ExecuteManualRobotStop": (
        "Ручная остановка: CloseAtMarket, Regime Off, лог System+User."
    ),
    "ExecuteEmergencyShutdown": (
        "Аварийная остановка один раз: закрытие, Regime Off, сообщение в лог."
    ),
    "TryEmergencyShutdownIfNeeded": (
        "На каждой свече: база, проверка TryBuildEmergencyReason, ExecuteEmergencyShutdown."
    ),
    "SyncIndicators": (
        "Создание/удаление индикаторов на всех вкладках скринера по флагам Use*."
    ),
    "EnsureIndicator": (
        "Добавляет или убирает индикатор с заданным номером и типом на всех вкладках."
    ),
    "GetMinBarsForTradingLogic": (
        "Минимум свечей для торговли по максимальному периоду включённых индикаторов."
    ),
    "ScreenerTab_CandleFinishedEvent": (
        "Главный цикл: аварийка, расписание, фильтры, сигналы, вход/выход/реверс."
    ),
    "CheckVolatilityCluster": (
        "Вкладка входит в выбранный кластер волатильности (1–3)."
    ),
    "BullSmaPasses": "SMA: close выше линии — бычье условие.",
    "BullRsiPasses": "RSI ≥ long min.",
    "BullStochPasses": "Stochastic K ≥ long min.",
    "BullMomentumPasses": "Momentum ≥ long min.",
    "BullBollingerPasses": "Close выше середины полос.",
    "BullLinRegPasses": "Close выше верхней линии LinReg.",
    "BullRziPasses": "RZI > уровня сигнала.",
    "BullVolumePasses": "Рост объёма свечи vs предыдущая.",
    "BullAverageProfitPercentLongPasses": "Avg Profit % Long > bull min.",
    "BearSmaPasses": "SMA: close ниже линии.",
    "BearRsiPasses": "RSI ≤ short max.",
    "BearStochPasses": "Stochastic K ≤ short max.",
    "BearMomentumPasses": "Momentum ≤ short max.",
    "BearBollingerPasses": "Close ниже середины полос.",
    "BearLinRegPasses": "Close ниже нижней линии LinReg.",
    "BearRziPasses": "RZI < −уровня.",
    "BearVolumePasses": "Рост объёма (то же условие, что для лонга).",
    "BearAverageProfitPercentLongPasses": "Avg Profit % Long < bear max.",
    "FindIndicator": (
        "Поиск индикатора на вкладке по номеру+типу+TabName или по имени типа."
    ),
    "TryOpenOnSignal": (
        "Открытие лонга/шорта по лимиту с учётом Regime и проскальзывания."
    ),
    "TryCloseOrReverse": (
        "Закрытие или реверс позиции при противоположном сигнале."
    ),
    "GetVolume": (
        "Расчёт объёма заявки: контракты, валюта контракта или % депозита."
    ),
}

# Overloads share name - handle static vs instance by signature line
OVERLOAD_EXTRA = {
    ("DetectTInvestStockSecuritiesClass", "List<string>"): "Перегрузка: класс только среди бумаг из списка тикеров.",
    ("HasConfiguredLiveScreenerConnection", "BotTabScreener"): "Перегрузка: проверка по переданной вкладке скринера.",
    ("CaptureMoexScreenerPreserveSettings", "BotTabScreener"): "Перегрузка: снимок настроек переданного скринера.",
}

def has_summary_before(lines, idx):
    j = idx - 1
    while j >= 0 and lines[j].strip() == "":
        j -= 1
    if j < 0:
        return False
    if lines[j].strip().startswith("///"):
        return True
    if lines[j].strip().startswith("["):
        return has_summary_before(lines, j)
    return False

def find_method_name(line):
    m = re.search(
        r"(?:public|private|protected)\s+(?:static\s+)?(?:override\s+)?[\w<>\[\],\s.?]+\s+(\w+)\s*\(",
        line,
    )
    return m.group(1) if m else None

def main():
    text = FILE.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)
    out = []
    i = 0
    while i < len(lines):
        line = lines[i]
        name = find_method_name(line)
        if name and name in DOCS and not has_summary_before(lines, i):
            extra = ""
            for (n, sig), doc in OVERLOAD_EXTRA.items():
                if n == name and sig in line:
                    extra = " " + doc
                    break
            doc = DOCS[name] + extra
            indent = re.match(r"^(\s*)", line).group(1)
            out.append(f"{indent}/// <summary>\n")
            out.append(f"{indent}/// {doc}\n")
            out.append(f"{indent}/// </summary>\n")
        out.append(line)
        i += 1

    # Class summary
    class_doc = (
        "/// <summary>\n"
        "/// Скринерный трендовый робот: несколько индикаторов, И-группы (AND внутри |№|, OR между |№|),\n"
        "/// MOEX reload (TInvest/Tester), аварийная остановка портфеля, расписание, кластеры волатильности.\n"
        "/// </summary>\n"
    )
    new_text = "".join(out)
    if "/// Скринерный трендовый робот" not in new_text:
        new_text = new_text.replace(
            "    public class TrendMultiIndicatorScreener : BotPanel\n    {",
            "    /// <summary>\n"
            "    /// Скринерный трендовый робот: несколько индикаторов, И-группы (AND внутри |№|, OR между |№|),\n"
            "    /// MOEX reload (TInvest/Tester), аварийная остановка портфеля, расписание, кластеры волатильности.\n"
            "    /// </summary>\n"
            "    public class TrendMultiIndicatorScreener : BotPanel\n    {",
            1,
        )

    # Enum/struct docs
    if "enum MoexScreenerInstrumentMode" in new_text and "/// Режим перезагрузки MOEX" not in new_text:
        new_text = new_text.replace(
            "        private enum MoexScreenerInstrumentMode\n        {",
            "        /// <summary>Режим перезагрузки MOEX: фьючерсы или акции.</summary>\n"
            "        private enum MoexScreenerInstrumentMode\n        {",
            1,
        )
    if "struct MoexScreenerPreserveSettings" in new_text and "/// Снимок настроек скринера" not in new_text:
        new_text = new_text.replace(
            "        private struct MoexScreenerPreserveSettings\n        {",
            "        /// <summary>Снимок настроек скринера перед MOEX reload (портфель, сервер, ТФ, класс).</summary>\n"
            "        private struct MoexScreenerPreserveSettings\n        {",
            1,
        )

    FILE.write_text(new_text, encoding="utf-8")
    print("Done:", FILE)

if __name__ == "__main__":
    main()
