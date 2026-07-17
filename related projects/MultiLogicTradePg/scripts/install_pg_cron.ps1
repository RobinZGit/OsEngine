#Requires -Version 5.1
<#
.SYNOPSIS
  Установка pg_cron для PostgreSQL (Linux / WSL). На Windows EDB-сборке pg_cron обычно недоступен.

.DESCRIPTION
  После установки перезапустите PostgreSQL и выполните 02 (блок @optional-pgcron-block)
  или вручную:
    CREATE EXTENSION pg_cron;
    SELECT cron.schedule('multilogictrade_trade_cycle', '* * * * *', $$SELECT run_trade_cycle()$$);

  На Windows без pg_cron API вызывает run_trade_cycle() каждую минуту (TRADE_RUNNER_ENABLED=1).

.EXAMPLE
  # Ubuntu / Debian (от root):
  sudo apt install postgresql-15-cron
  # postgresql.conf: shared_preload_libraries = 'pg_cron'
  # pg_hba + cron.database_name = 'multilogictrade'
  sudo systemctl restart postgresql
#>
Write-Host "pg_cron: см. комментарии в scripts/install_pg_cron.ps1 и docs/LOCAL_SETUP.md" -ForegroundColor Yellow
Write-Host "Windows: используйте Node fallback (TRADE_RUNNER_ENABLED=1) → SELECT run_trade_cycle()"
