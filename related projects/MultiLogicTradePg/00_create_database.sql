-- ============================================
-- MultiLogicTrade — шаг 0: пересоздание базы данных
-- ============================================
-- Выполнить от имени суперпользователя,
-- подключившись к служебной БД postgres (НЕ к multilogictrade).
--
-- Скрипт:
--   1) завершает активные подключения к multilogictrade
--   2) удаляет базу, если она есть (DROP DATABASE IF EXISTS)
--   3) создаёт базу заново
--
-- ВНИМАНИЕ: все данные в multilogictrade будут уничтожены.
--
-- ================================================================
-- ПОЛНАЯ ПОСЛЕДОВАТЕЛЬНОСТЬ РАЗВЁРТЫВАНИЯ «С НУЛЯ» (ручной повтор)
-- ================================================================
--
-- Подготовка (один раз на машине):
--   • PostgreSQL 15, служба postgresql-x64-15 — Running
--   • psql:  C:\Program Files\PostgreSQL\15\bin\psql.exe
--   • pgAdmin / DBeaver — по желанию (Query Tool на нужной БД)
--
-- Шаг 0 — ЭТОТ ФАЙЛ (00_create_database.sql)
--   Подключение: postgres
--   Расширения: не требуются
--
-- Шаг 1 — 01_multilogictrade_tables_and_data.sql
--   Подключение: multilogictrade
--   Расширения: не требуются
--
-- Шаг 2a — ПЕРЕД HTTP-блоком в 02: установить pgsql-http на сервере
--   (см. комментарии в начале 02 и перед блоком «HTTP-ЗАГРУЗКА»)
--   Windows: scripts\install_pgsql_http.ps1  (от администратора)
--   Linux:   сборка из github.com/pramsey/pgsql-http (см. 02)
--
-- Шаг 2b — 02_multilogictrade_functions_and_procedures.sql
--   Подключение: multilogictrade
--   Основная часть (функции, индикаторы, загрузка-заглушки) — без http.
--   Блок «HTTP-ЗАГРУЗКА» в конце — только после установки pgsql-http.
--
-- Шаг 3 — 03_multilogictrade_examples.sql (необязательно)
--   Подключение: multilogictrade, только SELECT/CALL
--
-- Автоматизация (PowerShell, из корня репозитория):
--   $env:PGPASSWORD = '<пароль postgres>'
--   .\scripts\run_multilogictrade.ps1              # шаги 0,1,2
--   .\scripts\install_pgsql_http.ps1               # один раз, от админа, перед HTTP
--   .\scripts\run_multilogictrade.ps1 -Steps 2     # повтор шага 2 после http
--
-- pgAdmin: Query Tool → выбрать нужную БД → File → Open → выполнить скрипт.
-- psql:    psql -U postgres -d postgres  -f 00_create_database.sql
--          psql -U postgres -d multilogictrade -f 01_...sql
-- ================================================================
-- ============================================

-- ============================================
-- Шаг 1: завершить активные сессии к целевой БД
-- ============================================
-- Без этого DROP DATABASE может не выполниться, если открыт pgAdmin/DBeaver/psql.
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = 'multilogictrade'
  AND pid <> pg_backend_pid();

-- ============================================
-- Шаг 2: удалить базу (если существует — без ошибки)
-- ============================================
DROP DATABASE IF EXISTS multilogictrade;

-- ============================================
-- Шаг 3: создать пустую базу
-- ============================================
CREATE DATABASE multilogictrade
    ENCODING 'UTF8'
    TEMPLATE template0;

-- После выполнения подключитесь к multilogictrade и запустите 01, затем 02, затем 03.
-- pgAdmin: Query Tool на multilogictrade → открыть 01_...sql
-- psql:    psql -U postgres -d multilogictrade -f 01_multilogictrade_tables_and_data.sql
