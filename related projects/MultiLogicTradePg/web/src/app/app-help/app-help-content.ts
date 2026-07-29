/** Текст справки MultiLogic Trade (панель «?» / книга рядом с шестерёнкой). */

export interface HelpSection {
  id: string;
  title: string;
  body: string;
  /** Раздел загружает markdown из assets (живой контекст проекта). */
  kind?: 'static' | 'project-context';
}

/** Файлы контекста в assets/project-context/ (копия docs/ через sync:context). */
export const PROJECT_CONTEXT_DOCS: { id: string; title: string; asset: string }[] = [
  {
    id: 'project-context',
    title: 'Контекст проекта',
    asset: 'assets/project-context/PROJECT_CONTEXT.md',
  },
  {
    id: 'user-instructions',
    title: 'Инструкции пользователя',
    asset: 'assets/project-context/USER_INSTRUCTIONS.md',
  },
  {
    id: 'local-setup',
    title: 'Локальная установка (контекст)',
    asset: 'assets/project-context/LOCAL_SETUP.md',
  },
];

/** Разбить markdown на главы по заголовкам ## */
export function splitMarkdownChapters(
  markdown: string
): { id: string; title: string; body: string }[] {
  const text = (markdown || '').replace(/^\uFEFF/, '').trim();
  if (!text) {
    return [{ id: 'empty', title: 'Пусто', body: 'Файл контекста не найден. Запустите npm run sync:context.' }];
  }

  const lines = text.split(/\r?\n/);
  const chapters: { id: string; title: string; body: string }[] = [];
  let currentTitle = 'Введение';
  let buf: string[] = [];

  const flush = () => {
    const body = buf.join('\n').trim();
    if (!body && chapters.length === 0) {
      return;
    }
    const slug = currentTitle
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48);
    chapters.push({
      id: slug || `ch-${chapters.length}`,
      title: currentTitle,
      body: body || '(пусто)',
    });
  };

  for (const line of lines) {
    const m = /^(#{1,2})\s+(.+?)\s*$/.exec(line);
    if (m && (m[1] === '#' || m[1] === '##')) {
      // H1 — название документа; H2 — глава
      if (m[1] === '#' && chapters.length === 0 && buf.length === 0) {
        currentTitle = m[2].trim();
        continue;
      }
      if (m[1] === '##' || (m[1] === '#' && (buf.length > 0 || chapters.length > 0))) {
        flush();
        currentTitle = m[2].trim();
        buf = [];
        continue;
      }
    }
    buf.push(line);
  }
  flush();

  if (chapters.length === 0) {
    return [{ id: 'full', title: 'Документ', body: text }];
  }
  return chapters;
}

export const APP_HELP_SECTIONS: HelpSection[] = [
  {
    id: 'overview',
    title: 'О системе',
    body: `MultiLogic Trade — торговая оболочка над PostgreSQL: цены, индикаторы и правила сделок считаются в базе; Angular показывает формы и графики, Express API вызывает SQL.

Биржа: MOEX (акции и фьючерсы). Цены: T-Bank API и/или MOEX ISS (нужен токен T-Bank для коротких таймфреймов).

В шапке:
• My Projects — хаб опубликованных проектов: https://robinzgit.github.io/OsEngine/my-projects.html (Crypt, MultiLogic Trade PG, FINRESP, UN Calculator, Диетолог, Total Calendar)
• Crypt — parity stego: https://robinzgit.github.io/OsEngine/crypt-parity-stego.html
• Логирование — пишет события в app_tech_log (trade runner, сигналы, ошибки).
• Книга (эта справка) — описание экранов и понятий; «Контекст проекта» — docs/PROJECT_CONTEXT.md; «Инструкции пользователя» — только формулировки запросов Sergey (docs/USER_INSTRUCTIONS.md).
• Шестерёнка — структура БД (таблицы / функции / процедуры / диаграмма FK). При работающем API читает живую PostgreSQL; если БД недоступна — из SQL-скриптов репозитория (schema-offline.json).`,
  },
  {
    id: 'project-context',
    title: 'Контекст проекта',
    kind: 'project-context',
    body: '',
  },
  {
    id: 'user-instructions',
    title: 'Инструкции пользователя',
    kind: 'project-context',
    body: '',
  },
  {
    id: 'local-setup',
    title: 'Локальная установка (контекст)',
    kind: 'project-context',
    body: '',
  },
  {
    id: 'tabs',
    title: 'Вкладки',
    body: `1) Торговые операции — логики, сигналы, стопы, бумаги, позиции и тестирование.
2) Бумаги и индикаторы — загрузка цен, назначение индикаторов на бумагу, график.
3) Справочники — биржи, брокеры, счета (в т.ч. «Продать всё» / облигации на real), бумаги, индикаторы, таймфреймы.`,
  },
  {
    id: 'logics',
    title: 'Логики (торговые операции)',
    body: `Строка логики: чекбокс «Вкл.» (бой), ID, имя, счёт, финрез боя/теста, чекбокс экспорта, справа иконки: карандаш, «+» (копия), метла (сброс shadow), корзина. Импорт/экспорт логик — только в шапке (иконки) по отмеченным чекбоксам. При узком экране вторичные колонки (acc_id, брокер, …) скрываются; «Вкл.» и действия остаются видимыми (sticky).

Копирование: создаёт выключенную копию с именем «… copy» (параметры, сигналы, стопы, бумаги; без сделок). После OK список прокручивается к новой развёрнутой строке.

Метла: очистить live shadow-сделки логики, снять паузы/инверсию, включить все бумаги; при включённой логике — предрасчёт рейтинга.

Экспорт JSON (шапка): настройки, бумаги, сигналы, стопы + кэш last OPT; без сделок/свечей/тестов. Импорт: по имени — перезапись, иначе новая; восстанавливает кэш OPT для «Применить лучшие OPT».

Раскрытие строки — блоки:
• Параметры — таймфрейм, % позиции, лимит позиций, балансы, комиссия, FIFO/AVERAGE, базовая ставка рейтинга, lookback, галочка «Инверсия» (см. отдельную главу «Инверсия логики»), прогрев (warmup_pretest), «Не снижать цель возобновления SL» (resume_sl_no_reduce, по умолчанию выкл.: для security_resume цель track только вверх / HWM), денежный фонд (cash_fund_code / cash_fund_threshold: на каждой закрытой свече TF, если equity > порога — BUY TMON/LQDT/SBMM на min(кэш, избыток−уже_в_фонде); фонд не продаём; тест и бой; fake — sim), сброс баланса.
В тесте колонка «Бар» — время свечи сигнала, не момент прогона теста.
• Сигналы — open/close × long/short; AND внутри группы (все условия группы должны сработать). Формула вида @SMA(period=20) VALUE > pp. Рейтинг боя — сумма по бумагам. Оптимизация параметров на лету — OPT() (см. главу «Формулы сигналов и OPT()»).
• Стоп-лосс / тейк-профит — в списке типов видны все варианты; недоступны для выбора (серые): SL «портфель с обновлением», любые TP по всему портфелю логики. Доступны: SL security / security_resume / security_inversion / portfolio; TP только по бумаге. «По бумаге и стороне с возобновлением» (security_resume): просадка стороны ≥ % → close + shadow только этой стороны; возобновление при достижении цели track. Параметр resume_sl_no_reduce: при повторном стопе цель не ниже прежнего максимума (HWM). «По бумаге и стороне (инверсия при достижении суммы прерывания)» (security_inversion): то же по стороне (long/short независимо), но когда shadow стороны возвращается к нулю (пику на стопе) — сторона снова в бой и переключается флаг инверсии бумаги; тот же % на инвертированной логике; снова стоп по стороне → shadow → ноль → снятие/включение инверсии. Уже сохранённые недоступные типы остаются в таблице.
• Ценные бумаги — портфель логики; колонка «Лот» = securities.lot_size (MOEX TQBR; при PostOrder лот уточняется с T-Bank и кэшируется).
• Позиции — боевые сделки; Тестирование — бэктест с эквити и рейтингами на бумаге; кнопки Экспорт сделок / Отчёт HTML / Запуск·Стоп; галочка «Оптимизировать» — в том же прогоне бумажные ветки сетки (шаг, итерации ±, лимит 81), Отчёт OPT открывается сам; кэш сетки на логике (last_opt_grid_*) до «Параметры по умолчанию» / «Сброс OPT»; на панели «Сигналы» — «Применить лучшие OPT» / «Параметры по умолчанию».

Инверсия параметра логики — отдельная глава «Инверсия логики». Локальная инверсия по бумаге — стоп security_inversion (там же кратко).
Прогрев: при включении боя со стопами resume/inversion сначала прогон теста за lookback, затем перенос пауз/инверсий в live.`,
  },
  {
    id: 'inversion',
    title: 'Инверсия логики',
    body: `Параметр логики «Инверсия» (logic_params.inversion, галочка в блоке «Параметры»).

Цель
• Получить зеркальный путь позиций и примерно зеркальную кривую эквити относительно той же логики без галочки.
• На тех же барах открывать/закрывать противоположную сторону (Long↔Short).

Что делает галочка
• Условия в формулах сигналов НЕ меняются (≥ остаётся ≥, ≤ остаётся ≤).
• Меняется только сторона исполнения: сигнал группы open/long → сделка Open Short; open/short → Open Long; close/long → Close Short; close/short → Close Long.
• Закрытия идут «как открыли»: те же close-условия, но для перевёрнутой стороны.
• Локальный флаг бумаги real_trading_inverted (стоп security_inversion) XOR с галочкой: включён ровно один из двух → эффективная инверсия сторон.

Чего галочка НЕ делает
• Не переворачивает операторы сравнения в формуле (не «условия наоборот»).
• Для каналов/полос (LOWER/UPPER) переворот ≥/≤ давал бы почти всегда true и ломал зеркало — поэтому убран.

Пример 1 — простой тренд по SMA (только лонг)
Без инверсии:
  open long:  @SMA(period=100) pp > VALUE
  close long: @SMA(period=100) pp < VALUE
С инверсией (те же формулы):
  → Open Short, когда pp > SMA
  → Close Short, когда pp < SMA
На тех же барах, что и исходный лонг; эквити ≈ отражение (при фикс. размере и нулевой комиссии — почти идеально; %-от-эквити и слоты чуть сдвигают).

Пример 2 — два направления (лонг и шорт)
Без инверсии:
  open long:  @SMA(period=100) pp > VALUE
  close long: @SMA(period=100) pp < VALUE
  open short: @SMA(period=100) pp < VALUE
  close short: @SMA(period=100) pp > VALUE
С инверсией:
  open-long условие → Open Short
  close-long условие → Close Short
  open-short условие → Open Long
  close-short условие → Close Long
Снова те же бары, стороны наоборот.

Пример 3 — LinReg Fade (канал)
Без инверсии (отскок):
  open long:  @LINREG(...,series=LOWER) pp <= VALUE
  open short: @LINREG(...,series=UPPER) pp >= VALUE
  close *:    к MIDDLE
С инверсией (те же условия, стороны flip):
  → Short у LOWER, Long у UPPER (как «пробой» на тех же касаниях полос)
Это зеркало сторон на тех же сигналах, а не другая формула с перевёрнутыми ≥/≤.

Почему «условия + стороны» ломают зеркало
Если ещё инвертировать знаки (pp > SMA → pp ≤ SMA) и стороны, входы уходят на другие бары — эквити уже не −эквити исходного прогона. В MultiLogicTradeA при обоих ReverseSides+ReverseSignals из‑за XOR эффективно оставались только стороны — тот угол и давал «правильные» зеркальные графики.

Стоп security_inversion (не путать с галочкой)
• Тип SL «по бумаге и стороне»: просадка стороны ≥ % → close + shadow только этой стороны (как security_resume); возврат shadow к нулю → бой стороны снова + toggle real_trading_inverted на бумаге.
• Галочка в параметрах — на всю логику сразу; стоп — локально по бумаге×стороне.

Как проверить зеркало в тесте
• Две копии логики: у одной галочка выкл., у другой вкл.; один период; желательно 0 комиссии и простой размер.
• Кривые «общая» эквити должны быть примерно противоположны по знаку.`,
  },
  {
    id: 'signal-opt',
    title: 'Формулы сигналов и OPT()',
    body: `Формат сигнала:
  @CODE(param=value,...) условие
Пример без оптимизации:
  @LINREG(period=20,std_dev=2,series=LOWER) pp <= VALUE

OPT — пометить числовой параметр для оптимизации на лету (±%) пока логика в бою.
Синтаксис: рядом с базой key=value добавить OPT(key, percent).
База обязательна в той же формуле; OPT без базы не сохранится.

Один параметр (например только std_dev ±10%):
  @LINREG(period=20,std_dev=2,series=LOWER,OPT(std_dev,10)) pp <= VALUE
• Чемпион: std_dev=2 (как написано), реальные/фейковые сделки как обычно.
• Challenger-ветки (бумажные, без брокера): std_dev вверх 2.2 и вниз 1.8.
• В сделках бейдж «опт ↑/↓ …»; колонка opt_lane, не смешивается с тестом и shadow стопов.

Два параметра (period и std_dev, каждый ±10%):
  @LINREG(period=20,std_dev=2,series=LOWER,OPT(period,10),OPT(std_dev,10)) pp <= VALUE
• Чемпион: period=20, std_dev=2.
• Challenger’ы: 2² = 4 комбинации (каждый OPT ↑ или ↓), например:
    period:up|std_dev:up, period:up|std_dev:down,
    period:down|std_dev:up, period:down|std_dev:down.
• Проценты могут отличаться: OPT(period,5),OPT(std_dev,10).
• series=LOWER (и другие нечисловые) не оптимизируются — без OPT.
• Порядок OPT(...) в скобках не важен. Алиас: OPT(std,10) = std_dev.

Три параметра — аналогично, 2³ = 8 веток + чемпион.
Лимит: не больше 3 разных имён OPT на все логики сразу (сохранение формулы отклонится с текстом ошибки).

Окно оценки: параметр логики «Свечей окна OPT» (opt_eval_candles, по умолчанию 200) — в блоке «Параметры логики». Сравнение на окне: FinRes закрытых + изменение MTM открытых (MTM на конце окна − MTM на начале) — одинаково для чемпиона и OPT-веток.
Кнопка «Сброс OPT» слева от поля свечей: вернуть начальные базы в формулах (из первого snapshot / params_prev первого promote), удалить live-сделки с opt_lane (бумажная книга OPT) и сбросить курсор окна. Чемпионские сделки не трогает.
Каждые N закрытых свечей TF сравнивается FinRes Close чемпиона и веток; если challenger лучше — базы в формулах переписываются (например std_dev=2.2), OPT(...) остаётся, окно начинается заново.

Офлайн-сетка в том же тесте (не путать с OPT() в формуле):
• В блоке «Тестирование» — галочка «Оптимизировать»: форма по числовым параметрам всех сигналов (шаг, итерации ± в обе стороны, лимит 81 комбинаций).
• Один прогон: чемпион = базы по умолчанию (эквити/сделки как обычно); сетка = бумажные opt_lane без mid-run promote; в конце — Отчёт OPT и rank FinRes; результат сетки пишется в logics.last_opt_grid_* (живёт после cleanup тестов, пока не «Сброс OPT» / «Параметры по умолчанию»).
• На панели «Сигналы»: «Применить лучшие OPT» (из кэша или последнего run) и «Параметры по умолчанию» (как Сброс OPT). Отчёты теста и OPT открываются сами после прогона.

Пример close long с двумя OPT:
  @LINREG(period=20,std_dev=2,series=MIDDLE,OPT(period,10),OPT(std_dev,10)) pp >= VALUE

Демо-логики:
• «LinReg Fade Optimized» — fade с OPT(std_dev,10);
• «LinReg Fade Twice Optimized» — fade с OPT(std_dev,10) и OPT(period,10) (4 ветки + чемпион).

Производительность:
• Цены и indicator_values общие на бумагу/TF — OPT-ветки их не дублируют в БД.
• Challenger считает LINREG на лету; кэш на бар: один регресс на (бумага, period, std_dev) → LOWER/MIDDLE/UPPER.
• Первый прогон после добавления ~30 бумаг всё равно долгий (HTTP load_prices по каждой). Дальше — только недостающие свечи.
• Для быстрого теста OPT можно временно оставить 3–5 бумаг вместо всего портфеля.`,
  },
  {
    id: 'real-trading',
    title: 'Бой T-Bank: лоты, заявки, «Продать всё»',
    body: `Объём в книге (logic_trades.quantity) — в штуках инструмента, кратно securities.lot_size.
T-Invest PostOrder.quantity — всегда в лотах.

tbank_post_order(account, figi, quantity, price, direction, execution, is_lots):
• is_lots=FALSE (по умолчанию, runner / стопы / cash-fund): quantity = штуки → деление на instrument.lot (GetInstrumentBy по FIGI, кэш в securities.lot_size).
• is_lots=TRUE (sell-all, покупка облигаций по плану): quantity уже в лотах — без повторного деления.

Плечо 1: база открытия = LEAST(free_cash|portfolio, net equity брокера); потолок номинала ≈ % × max_open_positions от этой базы. Не раздувать базу выручкой шорта / заёмным кэшем.

Справочники → Счета (реальный T-Bank):
• «Продать всё» — market sell всех невалютных позиций GetPortfolio: лоты из quantity(штуки) − blockedLots×lot; затем book-close открытых logic_trades без второй заявки (trade_reason=account:sell_all).
• Покупка облигаций TBRU — план в лотах, PostOrder с is_lots=TRUE.

Hotfix remote без полного upgrade: api/scripts/apply-tbank-post-order-lots.sql (PostOrder + sell-all + refresh lot_size MOEX).
UI-only install без наката 01/02/hotfix бой не чинит.`,
  },
  {
    id: 'exports-reports',
    title: 'Экспорт и отчёты',
    body: `Логики (шапка списка):
• Экспорт отмеченных — JSON bundle v2: params/signals/stops/securities + last_opt_grid; без сделок/свечей/тестов.
• Импорт — по имени перезапись, иначе новая; OPT-кэш восстанавливается.

Позиции / Тестирование:
• Экспорт сделок — полный dump для разбора (params + все флаги сделок + lots).
• Отчёт теста — HTML (profit factor, просадки, …); после прогона открывается сам.
• Отчёт OPT — HTML по сетке; после OPT-прогона открывается сам; Apply best читает кэш на логике.

Структура БД в Help (шестерёнка) и отчёты не хранят историю прогонов в файлах репозитория — только актуальные скрипты 01/02 и schema-offline.json.`,
  },
  {
    id: 'indicators',
    title: 'Бумаги и индикаторы',
    body: `Перетащите индикатор на бумагу — создаются серии и фоновый пересчёт.
График: zoom/pan, полноэкранный режим, линия нуля для осцилляторов.
Формулы индикаторов (кнопка «И.» в редакторе): pp, sma()/ema(), свёртка *, @CODE.
Загрузка цен: T-Bank (токен в диалоге) или MOEX; у фьючерсов — rollover по контрактам / вечные группы.`,
  },
  {
    id: 'schema',
    title: 'Структура БД и комментарии',
    body: `Шестерёнка (иконка БД) открывает дерево таблиц, функций и процедур.

Откуда берётся структура:
• Есть связь с PostgreSQL (API /api/schema) — таблицы, колонки, индексы, FK и все прикладные функции/процедуры public читаются из каталога БД. Кнопка SQL — pg_get_functiondef. COMMENT ON видно под именем.
• Нет связи (Pages / API выключен) — тот же вид из schema-offline.json, собранного из скриптов 01 и 02 (npm run generate:schema). Берутся CREATE TABLE + ALTER ADD COLUMN IF NOT EXISTS и все CREATE OR REPLACE FUNCTION/PROCEDURE из 02; при дублях в файле остаётся последнее определение (как OR REPLACE).

Идемпотентность скриптов (upgrade без потери данных):
• 01 — CREATE TABLE IF NOT EXISTS; новые колонки — ALTER … ADD COLUMN IF NOT EXISTS; seed логик — INSERT IF NOT EXISTS / ON CONFLICT DO NOTHING (копии и правки пользователя не стираются).
• 02 — CREATE OR REPLACE для функций/процедур; модули sql/*.sql подставляются в 02 (sync-sql-modules-to-02).

Комментарии: COMMENT ON в 01/02 и sql/routine_comments_missing.sql → obj_description после наката 02.`,
  },
  {
    id: 'api',
    title: 'API и сервисы (для понимания)',
    body: `Express: тонкий api/server.js (bootstrap) + маршруты api/routes/* + общие хелперы api/lib/server-shared.js. URL те же. Группы файлов:
• settings — health, settings, maintenance cleanup
• indicators / market — индикаторы, бумаги, цены, серии
• references — brokers, exchanges, accounts (+ sell-all / buy-bonds)
• logics / trades / backtest — логики, параметры, сигналы, стопы, бумаги, сделки, бэктест, pnl, export/import, shadow-reset, opt
• ops — tech-log, processes, schema
• Авто: после бэктеста — cleanup_unused_indicator_values(); по расписанию — если APP_CLEANUP_DISK включён.
• Trade runner — фоновый цикл сделок при открытом UI (heartbeat).

В Angular сервисы (web/src/app/services/*.ts) — тонкие обёртки над этими URL; JSDoc у публичных методов.`,
  },
  {
    id: 'install',
    title: 'Установка Windows',
    body: `Setup.exe ставит Node, PostgreSQL (пароль часто 111), npm ci для api/web, ярлыки.

Повторная установка:
• Да — удалить старое + пересоздать БД (данные стираются).
• Нет — поверх: файлы/npm обновляются; база НЕ удаляется, схема через 01/02 (цены, сделки, логики сохраняются); функции/процедуры пересоздаются.

Post-install даёт группе Users права на запись .angular\\cache в Program Files.
Протокол: INSTALL_PROTOCOL.txt (там же DbMode).

Подробный LOCAL_SETUP.md — в главе «Локальная установка (контекст)» слева в этой справке.`,
  },
];
