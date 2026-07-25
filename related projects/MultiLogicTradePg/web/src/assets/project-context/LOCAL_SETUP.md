# Локальный запуск SQL-скриптов MultiLogicTrade

Инструкция для **Windows**, PostgreSQL **15**, **pgAdmin 4** и **DBeaver**.

---

## Что установлено на этом ПК

| Компонент | Версия / путь |
|-----------|----------------|
| PostgreSQL Server | **15.2**, служба `postgresql-x64-15` — **Running** |
| Каталог данных | `C:\Program Files\PostgreSQL\15\data` |
| Утилиты (`psql`) | `C:\Program Files\PostgreSQL\15\bin\psql.exe` |
| pgAdmin 4 | `C:\Program Files\pgAdmin 4\v6\runtime\pgAdmin4.exe` |
| DBeaver | `%LOCALAPPDATA%\DBeaver\dbeaver.exe` |
| Порт | **5432** (по умолчанию) |
| Суперпользователь | `postgres` (пароль — тот, что задавали при установке) |

`psql` **не в PATH** — для командной строки используйте скрипт `scripts/run_multilogictrade.ps1` или полный путь к `bin`.

---

## Способ 1: pgAdmin (как «в школе в PostgreSQL»)

### Подключение к серверу (один раз)

1. Запустите **pgAdmin 4**.
2. **Servers → Register → Server…**
   - **General → Name:** `Local PostgreSQL 15`
   - **Connection → Host:** `localhost`
   - **Connection → Port:** `5432`
   - **Connection → Username:** `postgres`
   - **Connection → Password:** ваш пароль (можно сохранить)
3. **Save**.

### Полное развёртывание скриптов

Корень проекта: `C:\Users\Сергей\VsCodeProjects\MultiLogicTradePg`

| Шаг | База в Query Tool | Файл |
|-----|-------------------|------|
| 0 | **postgres** | `00_create_database.sql` |
| 1 | **multilogictrade** | `01_multilogictrade_tables_and_data.sql` |
| 2 | **multilogictrade** | `02_multilogictrade_functions_and_procedures.sql` |
| 3 | **multilogictrade** (необяз.) | `03_multilogictrade_examples.sql` |

**Как выполнить файл:**

1. Правый клик на нужную БД → **Query Tool**.
2. **File → Open** → выберите `.sql` файл.
3. **Execute / F5** (▶).

После шага **00** в дереве слева: правый клик **Servers → Refresh**, появится БД `multilogictrade`.

**HTTP-блок в `02`:** в конце файла, между комментариями «ОПЦИОНАЛЬНЫЙ БЛОК HTTP» и «КОНЕЦ HTTP». Если расширение `http` не установлено — **выделите только этот блок и не выполняйте** (или закомментируйте). Остальная часть `02` работает без него.

---

## Способ 2: DBeaver

### Подключение (один раз)

1. **Database → New Database Connection → PostgreSQL**.
2. **Host:** `localhost`, **Port:** `5432`, **Database:** `postgres`, **Username:** `postgres`, пароль.
3. **Test Connection → Finish**.

### Выполнение скриптов

1. **SQL Editor → Open SQL script** (Ctrl+O) → файл из таблицы выше.
2. Для **00**: в выпадающем списке подключения должна быть БД **`postgres`**.
3. Для **01–03**: переключите активную БД на **`multilogictrade`** (после шага 00; при необходимости Refresh).
4. **Execute SQL Script** (Alt+X) — выполнит весь файл; или **Execute** (Ctrl+Enter) по выделенному фрагменту.

Кодировка: **UTF-8** (DBeaver обычно подхватывает сам).

---

## Способ 3: PowerShell-скрипт (как в школе — одной командой)

Из папки проекта:

```powershell
cd C:\Users\Сергей\VsCodeProjects\MultiLogicTradePg
.\scripts\run_multilogictrade.ps1
```

Скрипт:

- спросит пароль `postgres` (или возьмёт из `%APPDATA%\postgresql\pgpass.conf`);
- выполнит **00 → 01 → 02** (шаг 03 — по желанию, ключ `-IncludeExamples`).

Только пересоздать БД:

```powershell
.\scripts\run_multilogictrade.ps1 -Steps 0
```

---

## Сохранить пароль (не вводить каждый раз)

Создайте файл (если папки нет — создайте):

`C:\Users\Сергей\AppData\Roaming\postgresql\pgpass.conf`

Строка (замените `ВАШ_ПАРОЛЬ`):

```text
localhost:5432:*:postgres:ВАШ_ПАРОЛЬ
```

Права: только ваш пользователь Windows. В PowerShell один раз:

```powershell
icacls "$env:APPDATA\postgresql\pgpass.conf" /inheritance:r /grant:r "$env:USERNAME:(R)"
```

---

## Добавить psql в PATH (необязательно)

**Параметры Windows → Система → О системе → Доп. параметры → Переменные среды → Path (пользователь) → Создать:**

```text
C:\Program Files\PostgreSQL\15\bin
```

После перезапуска терминала: `psql --version`.

---

## Проверка после установки

В Query Tool (БД `multilogictrade`):

```sql
SELECT COUNT(*) AS securities FROM securities;
SELECT code, name FROM indicators ORDER BY id LIMIT 5;
```

Ожидается: ~54 бумаги, 32 индикатора (SMA, SMAT3, PACC, …).

**T-Bank токен после пересоздания БД:** при первой «Загрузить цены» UI предложит ввести токен; он сохранится в `parameter_values` (`TBANK_API_TOKEN`, набор Default). Отмена — загрузка через MOEX. Альтернатива: `CALL set_tbank_token('ваш_токен');` в psql.

---

## Автотесты перед сборкой

Из каталога `web/`:

```powershell
npm run test:unit          # Angular (разворот бумаги без цен, график)
npm run verify:sql         # SQL 01/02 + verify-indicators + verify-async-sync + verify-chart-sync
npm run build              # prebuild: verify:sql → test:unit → generate:schema
```

Пропуск (не рекомендуется): `SKIP_SQL_VERIFY=1` или `SKIP_INDICATOR_VERIFY=1`.

---

## Частые ошибки

| Ошибка | Решение |
|--------|---------|
| `password authentication failed` | Неверный пароль `postgres`; сброс через pgAdmin или переустановка пароля |
| `DROP DATABASE ... being accessed` | Закройте Query Tool/DBeaver, подключённые к `multilogictrade`; скрипт **00** сам завершает сессии |
| `extension "http" is not available` | Не выполняйте HTTP-блок в **02** или установите [pgsql-http](https://github.com/pramsey/pgsql-http) |
| «Загрузить цены» висит на «с сегодня назад…» | Часто **блокировка в PostgreSQL** (прерванный `psql -f 02`, зависший `ALTER TABLE`). Остановите Start.bat, в psql: `SELECT pid, query FROM pg_stat_activity WHERE datname='multilogictrade' AND state<>'idle';` — завершите зависшие сессии (`pg_terminate_backend(pid)`), перезапустите Start.bat |
| Кракозябры в комментариях | UTF-8 в редакторе; для `psql`: `$env:PGCLIENTENCODING='UTF8'` |

---

## Забыли пароль postgres?

1. pgAdmin → подключение с сохранённым паролем, или  
2. Сброс через `pg_hba.conf` (trust на localhost) — только локально, затем вернуть `scram-sha-256`.

Если пароль не помните — напишите, подготовим пошаговый сброс под вашу установку.
