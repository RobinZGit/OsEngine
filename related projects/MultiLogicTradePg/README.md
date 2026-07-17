# MultiLogicTradePg

PostgreSQL-схема торговой системы MultiLogic Trade: справочники, цены OHLCV, расчёт индикаторов, заготовка торговых логик.

## Развёртывание

Подключитесь к PostgreSQL и выполните файлы **по порядку**:

| Шаг | Файл | Описание |
|-----|------|----------|
| 0 | `00_create_database.sql` | **Удаление и создание** БД заново (подключение к `postgres`) |
| 1 | `01_multilogictrade_tables_and_data.sql` | Таблицы, индексы, справочники |
| 2 | `02_multilogictrade_functions_and_procedures.sql` | Функции и процедуры |
| 3 | `03_multilogictrade_examples.sql` | Примеры SELECT (необязательно) |

Все скрипты **идемпотентны** — их можно запускать повторно без дублирования объектов и строк.

### pgAdmin / DBeaver

1. Выполните `00_create_database.sql` из БД **`postgres`** (удалит старую `multilogictrade`, если была).
2. Подключитесь к `multilogictrade`.
3. Выполните `01_...sql`, затем `02_...sql`.

Контекст проекта: [`docs/PROJECT_CONTEXT.md`](docs/PROJECT_CONTEXT.md).  
**Локальный запуск (pgAdmin / DBeaver / PowerShell):** [`docs/LOCAL_SETUP.md`](docs/LOCAL_SETUP.md).

### psql

```bash
psql -U postgres -f 00_create_database.sql
psql -U postgres -d multilogictrade -f 01_multilogictrade_tables_and_data.sql
psql -U postgres -d multilogictrade -f 02_multilogictrade_functions_and_procedures.sql
```

## Веб-интерфейс (Angular + Express)

| Компонент | Папка | Назначение |
|-----------|-------|------------|
| API | `api/` | Express → PostgreSQL |
| UI | `web/` | Angular (страница logics, структура БД) |

**Локальный запуск:** `web\MultiLogic_Trade_Progress_Start.bat`

### Windows installer

Исходники Windows-инсталлятора лежат в [`installer/windows`](installer/windows).
Инсталлятор собирается в `.exe` через Inno Setup:

```powershell
.\installer\windows\build-installer.ps1
```

Он устанавливает недостающие Node.js/PostgreSQL, разворачивает БД из `00` → `01` → `02`
с паролем PostgreSQL `111`, выполняет `npm ci` для `api` и `web`, создаёт ярлыки
на рабочем столе и в меню Пуск.

**GitHub Pages (только UI, без API):**  
https://robinzgit.github.io/MultiLogicTradePg/  

Ссылка также на [странице документации OsEngine](https://robinzgit.github.io/OsEngine/).

Если API недоступен (типично на GitHub Pages), на форме показывается сообщение о невозможности подключения к БД.  
URL API настраивается в `web/src/assets/app-config.json`.

## HTTP-загрузка цен

В конце файла `02_...sql` — опциональный блок **pgsql-http** (T-Bank / MOEX).

Перед использованием:

```sql
CREATE EXTENSION IF NOT EXISTS http;
```

Если расширение не установлено — **не выполняйте** блок между комментариями «ОПЦИОНАЛЬНЫЙ БЛОК HTTP» и «КОНЕЦ HTTP». Остальные процедуры (расчёт индикаторов, `insert_candle`) работают без него.

Рабочие вызовы загрузки:

```sql
CALL load_prices_http(1, 4, '2026-06-01', '2026-06-24');  -- SBER, M5
CALL calculate_indicator(1, 4, (SELECT id FROM indicators WHERE code='RSI'), '2026-06-01', '2026-06-24', TRUE);
```

## Префиксы акций и фьючерсов

У акции и фьючерса может быть **одинаковый тикер** (например `VTBR`, `LKOH`):

- различаются записью в `securities` и полем `instrument_market` (`stock` / `futures`);
- уникальность: `(security_id, exchange_id)`, а не глобально по `prefix`.

Для фьючерсов активный контракт берётся из `futures_expirations` (обновляйте даты экспирации).

## Устаревший монолит

Файл `multilogictrade_full_database.sql` (v11) сохранён для истории; для новых установок используйте файлы `01`–`03`.
