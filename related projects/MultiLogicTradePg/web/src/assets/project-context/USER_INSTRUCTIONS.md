# Инструкции пользователя (Sergey)

Живой список формулировок запросов к проекту MultiLogicTradePg.  
Язык оригинала сохраняется (русский / английский).  
Новые пункты — **в начало** списка (наибольший номер сверху).

Полный контекст разработки — `docs/PROJECT_CONTEXT.md`. Эта справка в приложении: раздел «Инструкции пользователя».

708. Look at the local testing now. Maybe a long hanging. Why is it hanging? Well, maybe it doesn't hang. But if there are any locks, look. Maybe something can be done to make it go faster.

707. And this should, of course, consist of percents: no more than 10 x 10 = 100% of the deposit can be shorted; if 20 positions of 10%, then no more than 200%. Follows from % and max open positions; for shorts same as longs.

706. I agree that there should be a margin if we trade in the short, but it is almost twice as much as the balance… Why open the second one? … in the case of a short, we should not get out of our balance… take into account with this shoulder first.

705. Scheduled cleanup error procedure set_app_cleanup_last_at(timestamp with time zone) does not exist

704. Along with the installer, which is an .exe file with an .exe extension, do exactly the same next to the same folder, but with a different extension, for example, .exe. That is, instead of the last letter, put the lower underline. It is necessary to be downloaded without problems to the remote server.

703. Now Pavel is testing for the second time. Testing new logic. Look, what is it because of? It can be because of your updates? Or is there some kind of mistake that needs to be corrected? (backtest fail: logic_trades_signal_kind_check / OPT signal_kind=opt).

702. Anyway, this new logic did not appear, although it seems that the assembly number appeared in the installer. (protocol Build 59, ExitCode 1, install.ps1 ParserError on DbMode=$DbMode:).

701. Add the assembly number to the form of the installer, when it is installed, so that it is immediately visible. There is now version 1.0.0 and the assembly number after the version of some. and immediately put it in the repository.

700. The same thing is not established in the logic of VINREC FADE OPTIMIZED. Look, maybe you still need to add the assembly number somewhere in the installers, increase it every time when unloading and export it to the protocol for installation. Although, I think, maybe you will understand anyway whether I have a new version or not. (protocol 16:42: upgrade, logics 46→46, old reset message).

699. Still, when installing on top, it did not install (protocol: upgrade, logics 46→46, old 01 without v54).

698. Installation on top, on a new repository, the logic of linregoptimized, the last one, has not been transferred. You need to make it and all other logics by default installed on top, if they are not. It was. Check. If you fix it, then upload it immediately to the repository.

697. Add the choice of buying bonds to a couple of funds similar to Tinkoff, because the link may be inaccessible, so that you can read the list from some other sources. And immediately upload to the repository.

696. And look at why the annual interest was not calculated in the test, there is a mark.

695. Install on top: ng serve NG5002 Incomplete block "" — @ in buy-bonds template; fix and push.

694. Restarted start — amount, fund choice and Calculate still not available for editing; fix.

693. Why is there no button in buy-obligations? Amount must always be editable; Calculate brighter first, then Buy brighter after calc; try to buy and put failures in the report; Obligation Fund available to anyone; push to repo.

692. Make such types inaccessible to the choice for stop-losses (visible but not choosable): paper inversion of non-repetitive drawdown; portfolio with update. Take-profit inaccessible for the whole logic portfolio. Also: separate file with only my instructions + Help section; push to repo.

691. Yes, do OPT in the test too so testing is not slowed much; on param change just rewrite/history for the report.

690. In the transactions report, add history of parameter changes if optimized (or once if no optimization).

689. Restarted start; test yellow briefly then disappeared — maybe crashed with error.

688. Test moved to transactions but none opened yet — find problems and speed up.

687. Look at the test again — accelerated but still on load; speed up what is slowing it down.

686. Go on — need OPT so I can test it on the new logic.

685. OPT(param, pct%): 2^n opt lanes + real; isolate from test/shadow; cap 3 params global; opt_eval_candles; LinRegFadeOptimized; tests.

684. Make a GitHub release of this build; name it around «real trade» — emphasize that real trading has started to work.

683. Sold everything via account button but logic trades stayed open — sync closes; maybe sell then close-all; prefer a better approach.

682. FLOT (Sovcomflot) real on account/logic but listed as shadow — fix if bug; then push. Also check test: do shadow mix with real accounting?

681. PUSH

680. Real trades «deviated» (rejected): why; show reason in Status brackets; row grows in height.

678. Move Pages to OsEngine; do not delete MultiLogicTradePg repo — archive it.

677. PUSH!

676. Check live FinRes vs T‑Bank (−30 vs +10): use broker commissions, not commission_pct %.

675. Lot % base default = free money for everyone — install script and DB.

674. Logic param execution type limit/market, default market; accounts sell-all always market.

673. Top process bar changes height → screen twitches / logics jump — fixed size, keep visible, push.

672. After form/API restart, running tests must continue from the bar where they stopped.

671. Post everything to the repo and publish on GitHub Pages (Pages still old).

670. Main «Финрез теста» vs Testing bar finres mismatch / one empty — must be the same.

669. GitHub Pages looks old / no top-bar icons; want context in help even without DB.

668. Accounts: Sell all + Buy bonds (Tinkoff/TBRU, risky/yield first); buttons only on real accounts.

667. Rename/clarify «Текущий остаток» label + tip so it is not confused with historical backtest balance.

666. Prices loaded by one shared key; others wait and read cache; each run calculates its own indicators in SQL — implement (1)+(2) in logic-backtest.js without changing trade math.

665. Rename linear TP from paper to whole portfolio with renewal (portfolio_ltp_renew); remove per-paper cut. Always update PROJECT_CONTEXT on push.

664. Copied logic spam take_profit:portfolio while equity falls — was cash-based TP + wrong scope vs linear TP on source.

663. Lot base: three choices — free cash / portfolio without cash fund (default) / portfolio including cash fund; show current backtest date next to progress %.

662. Linear Take Profit on paper with renewal — arm at base%+TP%, sell on price drop, shadow renew, disarm below base% (later moved to portfolio).

661. Why account select hangs; logic on/off signals empty for seconds; positions lag — small DB.

### 2026-07-12 (ранние)

1. Обзор репо, исправления, split SQL, DROP в `00`, контекст в проект.
2. Локальный запуск, pgsql-http, logics + Angular + Express.
3. Правило БД: изменения в CREATE TABLE, прогон локально.

### 2026-07-12 (фьючерсы и загрузка)

4. «Загрузка фьючерсов по группам (CR/Si), обход контрактов назад, contract_prefix».
5. «Проверка SQL перед build, CI».
6. «Пустая futures_expirations — только sync при load; TRUNCATE и прогнать тест».
7. Ошибка id=51 (CNYRUBF): «Активный фьючерс не найден…» — исправить вечные фьючерсы.

### 2026-07-12 (контекст)

8. «Правила проекта: файлы контекста с каждой новой выкладкой…»

9. «Бумаги и индикаторы: 2-я вкладка; 3-я — Справочники; drag индикатора на бумагу → security_indicators; список и графики по calculate_indicator с параметрами по умолчанию; полный прогон 00–02.»

### 2026-07-12 (индикаторы, график, тесты)

10. «security_indicator_series, calc_ind_*_array, sync инкрементальный; пересоздать БД 00–02».
11. «Зависание при развороте акции без цен — исправить».
12. «Автотесты на expand без цен + prebuild».
13. «Загрузка цен без T-Bank — MOEX D1/H1; M15 нужен токен».
14. «На графике пересчёт индикаторов; полный экран с zoom/pan; крупнее подписи в fullscreen; выложить в репо».
15. «Индикатор ускорения цены PACC, парсер многочленов, формула pp*(1;-2;1)».
16. «Зависание при добавлении PACC на ALRS — fix + прогресс».
17. «Линия нуля на графике (fullscreen и обычный); обновить контекст; выложить в репо».
18. «Индикатор = многочлен: свёртки, умножение, pp, sma(), единый парсер для всех формул».
19. «Кнопка + в списке индикаторов; форма код/название/описание/формула; хинт и кнопка «И.» с подробной справкой; обновить контекст; в репо».
20. «При drag индикатора страница зависает — сразу показывать в списке, пересчёт в PostgreSQL в фоне, спиннер «Пересчёт …» как при загрузке цен».
21. «SMAT3 — sma(pp)*sma(pp)*sma(pp) (свёртка рядов); SMAT3COMP — sma(sma(sma(pp))) (композиция); при том же N числа разные; * без подмены ядром».
22. «После пересоздания БД теряется токен T-Bank — диалог ввода при загрузке цен, хранить в глобальных параметрах, отмена → MOEX; пересоздать БД; в репо».
26. «Drag индикатора: сразу в таблицу, расчёт async; жёсткий verify-async-sync в prebuild».
27. «SMAT3 при перемотке в одну сторону OK, в обратную — зависает; таблица tech log в БД; галочка Логирование (выкл.); логировать start/end по потокам; пересобрать БД; контекст; в репо».
28. «На странице logics под сигналами — блок стоп-лосс/тейк-профит; кнопки + стоп-лосс и + тейк-профит; таблица logic_stops; форма: вид, тип (по логике / портфель логики), значение, единица % или ATR; строки в списке; контекст; в репо».
29. «Файлы контекста обновлять локально и выкладывать в репо каждый раз — правило проекта, не забывать».
30. «Тип стопа: не «по логике», а **по бумаге** и **по всему портфелю логики**; исправить и в репо».
31. «Зависание при добавлении индикатора с логированием — исправить гонку sync (gen, defer full sync, лог poll); в репо».
32. «Снова зависание при добавлении нескольких индикаторов на бумагу — разбор app_tech_log; очередь assign + debounced flush; в репо».
33. «На logics третий блок «Ценные бумаги»: таблица logic_securities, picker акции/фьючерсы с галочками и «выбрать все», bulk add; все три блока свёрнуты по умолчанию; контекст; в репо».
34. «Контекст обновляй при каждой выкладке; запиши в правила проекта, что перед push нужно обновлять PROJECT_CONTEXT.md».
35. «Сделки по включённой логике в реальном времени по сигналам; реальный/фейковый счёт; поле Фиктивная (резерв); блок «Сделки» на logics; таблица сделок».
36. «Параметры логики: % депозита, макс. открытых позиций, начальный остаток (фейк); текущий остаток в logics; блок «Параметры» сверху; расчёт лота и лимит позиций; сделки по выбранным сигналам индикаторов; демо SMA на FAKE-EFF-001 (выше SMA покупаем, ниже продаём) + SBER».
37. «Fix: % депозита 10.0000 / не сохраняются параметры; TS2322; T-Bank токен при включении фейковой логики; в репо».
38. «Сигналы: поле Long/Short; кнопки + Long/+ Short; тренд/к-тренд на форме; выложить».
39. «Параметры логики не сохраняются — таблица logic_params (ключ/значение/тип); выложить».
40. «Собери базу с нуля и выложи в репозиторий».
41. «Poll каждые 2 с сбрасывает параметры — не refresh'ить редактируемое; правило проекта; выложить».
42. «Демо-логика: long при цене выше SMA, short при ниже; пересобрать БД; в репо».
43. «Из демо убрать counter-сигналы — только long-trend и short-trend».
44. «Сделки не идут — переделать runner: timeframe в параметрах, цикл в PostgreSQL (pg_cron job), парсинг сигналов в БД; пересобрать БД; в репо».
45. «Финансовый результат сделок: комиссия % от депозита (фейк) / с биржи (реал); метод FIFO или средняя; таблица пакетов по сделкам; разворот сделки в UI; параметры в блоке параметров; блок «Сделки» не разворачивается — исправить».
46. «Проверка токена T-Bank при сделках: если не валиден — сообщение и диалог ввода; если диалог уже открыт — не дублировать; пересобрать БД с нуля».
47. «На графике бумаг теста: убрать кнопку пересчёта индикаторов; добавить полный экран; PnL/точки/стопы пересчитывать в фоне при rewind; бледные зоны пока бумага выкл.; Timeout has occurred при rewind — убрать».
48. «Сигналы: open/close и trend/counter на форме; кнопки выбора; поле в таблице; демо — сигнал открытия и закрытия; все акции; take profit 3% и stop loss 1%; в репо; БД с нуля; обновить контекст».
49. «Те же % от депозита и годовые — в строке Позиций (фин. результат) и в Тестировании; стоп-лосс по умолчанию — не просто по бумаге, а по бумаге с обновлением (security_resume)».
50. «Сводка лишнего в БД → удалить: logics_detail, дубли колонок logics, legacy write-only колонки» (v39).
51. «Комментарии таблиц/колонок оставить; в окне структуры (шестерёнка) — вкладка диаграммы со связями полей; потом БД с нуля».
52. «Выложить в репозиторий для публикации на GitHub Pages».
53. «Сигналы одной стороны — AND (все open/close); рейтинг сигнала на логике (+1/−1 по следующей свече, порог от годовой ставки); демо SMA+BB+STOCH; предупреждение в UI».
54. «The rating of indicators is not quite accurate — rating of the indicator signal is exactly the one on the logic bookmark».
55. «Тест логики без сделок — сигналы слишком жёсткие; оставить SMA+BB+STOCH, сделать логичнее; возможно follow/fade и профили по индикаторам».
56. «В Тестировании — блок рейтингов сигналов с графиком; считать независимо от сделок; test/combat раздельно».
57. «Рейтинги не отдельным блоком, а под графиком бумаги; по ценам этой бумаги; не +1 за срабатывание, а pending → следующая свеча → % годовых vs base_annual (20) → +1/−1».
58. «Стоп зависает — остановить сразу; после стопа всё протестированное оставить».
59. «Выложить в репозиторий и собрать базу с нуля».
60. «Добавить ~10 частых успешных стратегий из OsEngine; демо оставить; все на фейк + все акции; можно в репо».
61. «Рейтинг на вкладке Сигналы — только бой (сумма по бумагам); сигнал раскрывается → бумаги → график рейтинга; как в тесте по всем свечам без сделок; при enable — предрасчёт за N дней (param default 7) в фоне + иконка; тест в колонке не показывать».
62. «Где финрез на плитках (тест и бой) — добавить комиссии; на главной форме у логики — колонка финрез теста (онлайн, зелёный/красный; без хранения; если теста не было — пусто)».
63. «Комиссия default 0.03; добавить L1–L4 из MultiLogicTradeA (адаптировать под Pg); недостающие индикаторы; в репо; БД с нуля».
64. «Новые индикаторы считать как SMA/STOCH: SQL-функции, каталог indicators, тот же парсинг — без отдельной схемы».
65. «Исправить блокировки: тест всех логик + бой одновременно не должны блокировать друг друга».
66. «Колонка Финрез (бой) рядом с Финрез теста; крутилка теста с %; плавнее progress загрузки цен и прогона».
67. «Финрез теста не должен смешиваться: в большой таблице одно, в развороте теста другое/пусто; надёжная привязка тестовых сделок к логике/этому прогону».
68. «Включил первую логику — рейтинги нули, в бумагах пусто; должны считаться за lookback по сигналам и ценам».
69. «Тест снова зависает при открытии бумаги; логирование включено».
70. «Сейчас зависло раскрытие бумаги. Логирование включено. Посмотри, почему он обвисет».
71. «Всё равно зависает. Всмотри, переразворачивание бумаги, регулирование включено».
72. «Зависло при развертывании вони бумаги, как и в прошлый раз».
73. «Закрыл вкладку, запустил заново батник — всё равно зависание при раскрытии бумаги; может недобравил страницу / жёстче обновление в bat / или не поправил».
74. «Не помогло. Запустил батника ещё раз, разворачивает бумагу и зависает».
75. «Сейчас бумага развернулась. Но график не отрисовывается, пишут загрузка графика и висит».
76. «График рисуется, но не отрисовывается; пишет отрисовка; бумагу обратно не свернуть — зависание UI».
77. «Бумага развернулась с графиком; через время все сделки сдвинулись на последнюю свечу (вход/выход); сначала было нормально».
78. «8-я стратегия, бумага ММК — часть маркеров в начале, часть в конце, много входов/выходов на одной линии».
79. «Запустил несколько тестирований — UI медленно реагирует, например при выборе даты начала теста; посмотри подписки / что блокирует Angular».
80. «Поле примечание у логики — для seed написать тренд/контртренд/демо и OsEngine; добавить 5 контртрендовых OsEngine в сборку; пересобрать БД с нуля».
81. «Комиссия по сделке должна быть % от номинала сделки (суммы), не от всего депозита».
82. «Проверь, учитывается ли лотность бумаги; если нет — добавить лотность и её учёт».
83. «Собери базу данных с нуля».
84. «Галочка инверсия в параметрах (условия наоборот + другая сторона); в тесте флажок эквити/график с лонгами/шортами; у финреза в скобках % депозита».
85. «For this project, you need to create an installer and put it in the repository. The installer is probably in the form of an .exe file. The installer must install needed programs like node and postgres if missing; deploy the database by scripts; install what is needed for Angular; put shortcuts on Desktop and launch panel; if the program is found, propose to delete it and install again from scratch. Postgres password is 111».
86. «Push installer changes to MultiLogicTradePg main» — Cloud Agent на OsEngine не имел write в MultiLogicTradePg; дан доступ Cursor App / токен обсуждался (`MULTILOGIC_GITHUB_TOKEN` в env не появился).
87. «If I can't create a circle in this repository, create a folder for MultiLogicTradePg in OsEngine, copy everything, push to main» — сделано: `related projects/MultiLogicTradePg` на OsEngine `main`.
88. «Сделай инсталлятор в виде одного exe файла» — собран и закоммичен `MultiLogicTradePgSetup.exe`.
89. «After using the installer, desktop button closes the window; Angular does not open; old bat kept window open and raised ports» — fix ярлыков `cmd /k` + hardened Start.bat; пересобран Setup.exe.
90. «Сохрани контекст в репо» — обновление этого файла + push.
91. «Read the context and correct the installer's error. That's it for this repository.» Ошибки `cmd`: `--no-fund`, `SSWORDPGHOSTPGDATABASEPGUSERPORT`, `Unknown argument: port` — исправить установленный launcher.
92. Повтор того же лога (`'--no-fund' is not recognized`, `Unknown argument: port`) + старый bat в source поднимает API/Angular, но пишет `The system cannot find the file \\.` — вернуть старый рабочий `.bat` flow, исправить delayed browser opener, не переустанавливать npm при наличии `node_modules`.
93. «Can the installer itself install packages as administrator, not when the batch file is launched? ... why old logic remains after reset?» — убрать npm install из bat, сделать npm обязательным в installer, reset базы по имени с FORCE и логом host/port/db.
94. «Connect to PostgreSQL user/server `postgres`, password `111`; delete database completely and roll scripts again. If installer could connect, why could it not delete?» — искать локальный PostgreSQL-порт, где реально есть `multilogictrade`, сбрасывать именно его и записывать выбранный порт в `api\.env`.
95. «Did you put it in main? He still did not update/delete the database.» — подтвердить main и сделать reset БД безусловным при каждой установке.
96. «database is still not reset; add installation protocol so I can throw it to you; add checkbox enabled to run program after installation» — добавить `INSTALL_PROTOCOL.txt`, shortcut протокола и checked run-after-install checkbox.
97. Скрин Блокнота: «Не удаётся найти файл C:\Program Files\MultiLogicTradePg\INSTALL_PROTOCOL.txt» — добавить placeholder протокола в installer files и `Check: FileExists` для открытия.
98. Placeholder протокола остался неизменённым после setup — запускать post-install через `.cmd` wrapper, который пишет stdout/stderr в `INSTALL_PROTOCOL.txt` независимо от внутреннего finally PowerShell.
99. Протокол показал `ParserError` в `install.ps1` на строке `Write-Utf8NoBomText ... api\.env` и mojibake строк — убрать here-string и non-ASCII из PowerShell-скрипта.
100. «Make a copy button in logics; trim columns so edit/delete visible; in testing add equity-common/long/short for portfolio; in testing/live show open/closed trade counts after block name; after financial result show % of deposit.»
101. Скрин: при установке пустое окно `cmd.exe` поверх Setup сбивает пользователя — скрыть post-install cmd wrapper, оставить прогресс в окне Setup и лог в `INSTALL_PROTOCOL.txt`.
102. «I don't see the copy button… always commit to main… add working process indicator… fix shares/futures all checkbox… signal formula as textarea full length… collect/export because I don't see current changes.» — причина невидимости: installer не был пересобран после UI; добавить process strip, textarea формул, select-all fix, пересобрать Setup.exe.
103. «always need to reassemble the installer… sql scripts if database structure changes… write project rules» — добавить Cursor rule: SQL scripts and Windows installer must always match shipped state; rebuild installer before push for shipped changes.
104. Скрин installer: status text обрезан, progress bar 100% на долгом post-install — укоротить StatusMsg и держать progress ниже 100% до завершения post-install.
105. «If inversion checkbox is enabled highlight logic; add stop-loss type on paper with inversion; if paper equity falls below SL percent, invert logic on that paper; if falls again switch back; highlight inversion period on equity/chart.»
106. «Add logic parameter checkbox warm-up/preliminary testing, default on; for security_resume/security_inversion stop-loss, enabling logic first runs testing for rating_lookback_days, real trade starts only after test; transfer paused/inverted paper states from test to live logic_securities.»
107. «After copying the logic, report that the logic has been copied and in the same name. Also, the plus button to copy the logic, make it the same color as the icons pencil and basket are black.» + «Do it and post it.»
108. Ошибка после установки с «Нет» (поверх): Out-File/nul в FreePorts; Angular CLI не найден в web\node_modules — починить install-over и launcher.
109. После успешного старта: `EPERM mkdir ... Program Files\...\web\.angular\cache\...\vite\deps_temp_*` — права на запись кэша Angular под Program Files.
110. «When copying the logic, after the message… clicks OK, rewind the form so that this new logic is visible» — прокрутка к копии после OK; разворот уже есть; выложить + контекст.
111. «Add comments to all procedures and functions… write help… next to the gear… icon… white on black… put in the repository.»
112. Upgrade DB on installer «No»: keep table data; ALTER/add columns via 01; recreate procedures/functions; do not DROP DATABASE.
113. Keep CREATE full schema + ALTER that never fail; comment why each ALTER (upgrade existing DBs).
114. Remember test period; portfolio SL/TP verticals on equity; live equity+papers same as test (lazy/non-block); fix table vs panel test finres mismatch.
115. «Always put changes in the installer when needed (DB, Angular, everything at once)… then put out what I corrected in the repository, installer, everything.»
116. After local Setup + No: no equity tiles, finres still differ — INSTALL_PROTOCOL ExitCode 1: install.ps1 ParserError on em-dash; post-install never finished (npm/API restart).
117. «Add cash fund param (TMON/LQDT) + amount threshold default 100000; gear → general settings with cleanup checkbox for unused prices/tests/logs; DB icon for schema.»
118. «Make a plan and post it» / «Do what you planned» / «Stop planning and do what is planned!» — implement cash-fund park + scheduled cleanup.
119. «The product that is purchased must be visible in the block of securities, both in the test and in the real trade… at the top of the list.»
120. «Learn Futures… when I choose Futures in testing it loads prices and tests; same for combat… T-Bank token didn’t save / can it fly off?»
121. «Futures again, not a single test transaction… look, is it right or again something fell?»
122. «Add export/import for logics: checkboxes on the right, Export/Import buttons on the subtitle row; message with names; papers included, tests not.»
123. «Add 5 trend + 10 counter-trend OsEngine logics not yet in seed; on upgrade do not erase existing/copied logics — insert if not exists.»
124. «Update Help DB structure for all changes and idempotence; tables/routines from DB when connected, else from SQL scripts; check it is not broken.»
125. «Show testing period on the test line as day/month/year from–to, readable; keep existing places.»
126. «TMON not purchased in test; empty papers list though params set.»
127. «Post changes in the repository. Only the installer needs to be assembled first.»
128. «В тесте дата/время сделки = по свечам, не wall-clock прогона; блок «Торговые периоды» до ЦБ с галочкой учитывать неторговые (вкл. по умолчанию) и кнопкой установить как на MOEX; параметр закрывать позиции в конце дня (кроме фондов), выкл. по умолчанию.»
129. «Make another installer for linux for macbook… updated every time when changing the project» — Linux tar.gz + freshness like Windows.
130. Sunday trades with NTP off; need add/delete/edit period lines; TMON not bought with positive PnL; reassemble installer and post.
131. Same test: TMON must buy each candle on equity excess over 1M; +13k finres → buy as much free cash allows ≤ excess; do not sell fund / stay in it.
132. After SQL-robots / hang fixes: hard rewind — «I'll have to twist this very tightly» to **19.07.2026 ~12:57 / `29ed3ba`** (last ship before SQL-robots message).
133. Hang finally over; TMON in papers but zero — park TMON in Angular/Node test; exclude from SL/TP test+live; show bought qty (ост.) in papers.
134. Test passed: TMON «ост. 0» though +70 — never sell fund (no SL/signals); remainder must stay.
135. After test TMON still shows 0 with ост. +70 — show money at current/period price (в портф.), not realized 0.
136. Papers list: next to ост. — short money remainder + current price; test and live.
137. New indicator ≈ LINREG but vary period max→3, pick min max|distance to line|; logic like LinReg Fade with new indicator.
138. Copied logics ask for T-Bank token again on test; defaults don’t — use same saved global token.
139. Default seed SL: portfolio (whole logic), not paper security_resume; check upgrade re-apply.
140. Remove unsuccessful LINREGV / LinRegV Fade and related functions from scripts.
141. Export button on test+live trades: all open/close/shadow/etc. + logic params and full context for AI analysis.
142. Quadratic indicator SQUARE (like LINREG but b+a·x+c·x²) + Square Fade logic like LinReg Fade.
143. During test switched Angular tab — yellow and test finres gone; keep backtest UI state across tabs.
144. «The parameter of the equity portfolio threshold for purchasing the Temon fund must be set by default not 100,000, but 1,000,000… Correct this in the installers and everywhere and re-postpone this release.»
145. «In the testing tab, the yellow color fades away when I close it or go to other tabs… yellow color remains if the testing is not completed… re-upload the release.»
146. «In the testing block, next to export and stop… report the results… HTML… separate window… parameters like OsEngine… profit factor, maximum loss… put in repository and release.»
147. «Add another type of stop-loss… with an update throughout the portfolio… below % all real stop, shadow continue… when portfolio to previous level real again… warmup must not affect… upload release and installer.»
148. «Testing security_resume: finres stopped — papers off and never on again; shadow opens should close. Fix resume; also audit portfolio_resume; build/install/upload release.»
149. «OsEngine counter-trend robots appeared; if new vs Postgres seed — add them (ContrTrend*/Countertrend* list).»
150. «Installer ExitCode 1: psql connection refused on 5433; Angular CLI missing — fix and put in repo.»
151. «Same mistake again: upgrade fails UPDATE logic_params does not exist (line 1303) — fix and ship.»
152. «Again: Angular CLI missing; 01 ERROR logic_trade_lots does not exist (LINREGV DELETE) — fix and ship.»
153. «Real trading (LRTC): seems to trade from deposited million not real balance; orders deviate; current remainder added to million — fix real sizing; do not postpone/make release — continue, new release later when real trading is ready.»
156. «Lot calc: choose whole portfolio or free money; real=real account; test=current; group + auto shoulder.»
155. «Initial state: for test use params; for real take from real account.»
154. «When installing on top: logics on real account — initial remainder from real account only, never a million; if unavailable then 0/empty; export repo but do not release.»
157. «Change security_resume stop-loss: add long/short side; rename (paper and side); split drawdown by paper×side; shadow only that side, other side stays real; add side columns; thank you.»
158. «When you upload to the repository, do not forget to update the context of the context file.»
159. «Put the context files in the description, which opens on the main top bar. In a separate chapter, take them out, so that you can turn around and see the context on which this whole project was going.»
160. «Test + logic with take-profit with renewal: working often, portfolio sagging — see why, improve so it is fixed on the splash and does not fade.»
161. «Tests with re-launches clog resources / hang longer; two tests running — optimize Angular to free resources.»
162. «each testing should save your report… browser cache or Postgres… on the main page… top plushes… log button… forward-backward… saving should not interfere with testing… periodicity… separate process… immediately upload to the repository.»

