# FinrespCalculator

Самодостаточная папка калькулятора FINRESP и реальной торговли T-Bank для MultiLogic.

## Состав

| Файл | Назначение |
|------|------------|
| `MultiLogic_FinrespCalculator.html` | Калькулятор (UI) |
| `MultiLogic_FinrespCalculator.engine.js` | Движок расчёта и MOEX |
| `MultiLogic_FinrespCalculator_Help.html` | Справка |
| `serve-calculator.ps1` | Локальный HTTP-сервер (MOEX) |
| `price-cache/` | Резервные копии базы цен (JSON) |

## Запуск

```powershell
.\serve-calculator.ps1
```

Откроется `http://127.0.0.1:8765/MultiLogic_FinrespCalculator.html`

GitHub Pages: `multilogic/FinrespCalculator/MultiLogic_FinrespCalculator.html`

## Перенос

Скопируйте **всю папку** `FinrespCalculator` — расчёт FINRESP и торговля работают без остальных файлов OsEngine.
