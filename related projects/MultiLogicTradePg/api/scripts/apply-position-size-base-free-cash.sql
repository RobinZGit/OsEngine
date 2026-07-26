-- v51: default lot % base = free_cash (all logics + def)
UPDATE logic_param_defs
SET
    default_value = 'free_cash',
    description = 'free_cash (по умолчанию) — % от свободных денег; portfolio — % от портфеля без ден. фонда; portfolio_incl_fund — весь портфель с фондом'
WHERE param_key = 'position_size_base';

UPDATE logic_params
SET param_value = 'free_cash',
    updated_at = CURRENT_TIMESTAMP
WHERE param_key = 'position_size_base';

SELECT param_value, count(*) AS logics
FROM logic_params
WHERE param_key = 'position_size_base'
GROUP BY 1;

SELECT default_value
FROM logic_param_defs
WHERE param_key = 'position_size_base';
