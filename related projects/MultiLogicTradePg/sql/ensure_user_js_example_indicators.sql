-- ensure_user_js_example_indicators.sql
-- Идемпотентно добавляет/обновляет примерные пользовательские JS-индикаторы
-- (PRICE_DIR, LOCAL_EXTREMUM). Безопасно для повторного запуска (fresh install / reinstall / upgrade).

DO $$
DECLARE v_id INTEGER;
BEGIN
  -- Требуются колонки для JS-индикаторов (добавляются миграцией/в 01).
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'indicators' AND column_name = 'js_code') THEN
    RAISE NOTICE 'ensure_user_js_example_indicators: indicators.js_code missing, skip';
    RETURN;
  END IF;

  -- LOCAL_EXTREMUM (4 серии: UPPER, LOWER, BREAK_UPPER, BREAK_LOWER)
  SELECT id INTO v_id FROM indicators WHERE code = 'LOCAL_EXTREMUM';
  IF v_id IS NULL THEN
    INSERT INTO indicators (code, name, description, category, js_code, calc_kind, script, formula, is_custom, is_active)
    VALUES ('LOCAL_EXTREMUM', 'Локальный экстремум (пробой-возврат)', 'Пользовательский JS-индикатор "Локальный экстремум (пробой-возврат ценового канала)" с 4 сериями: UPPER/LOWER — уровни верхней/нижней границы канала (max high/min low за period прошлых баров до пробойного); BREAK_UPPER=1 при верхнем ложном пробое с возвратом (иначе 0), BREAK_LOWER=1 при нижнем ложном пробое с возвратом (иначе 0). Параметры: period/bars/count (длина канала, по умолчанию 20), tf (опц. таймфрейм). Подробные комментарии — в коде индикатора.', 'custom', $js$function calc(ctx, params) {
  // ============================================================
  // Индикатор: "Локальный экстремум (пробой-возврат ценового канала)"
  //
  // Возвращает 4 серии (для использования в сигналах указывайте series=...):
  //   UPPER        — верхняя граница ценового канала (уровень): максимум high
  //                  за "прошлые" period баров, предшествующих пробойному бару.
  //   LOWER        — нижняя граница ценового канала (уровень): минимум low
  //                  за те же "прошлые" period баров.
  //   BREAK_UPPER  — сигнал верхнего пробоя-возврата (ложный пробой вверх):
  //                  1, если предыдущий (пробойный) бар пробил UPPER сверху,
  //                  а текущий бар закрылся обратно НИЖЕ UPPER; иначе 0.
  //   BREAK_LOWER  — сигнал нижнего пробоя-возврата (ложный пробой вниз):
  //                  1, если предыдущий (пробойный) бар пробил LOWER снизу,
  //                  а текущий бар закрылся обратно ВЫШЕ LOWER; иначе 0.
  //
  // Параметры (передаются в формуле сигнала, напр. @LOCAL_EXTREMUM(period=20, series=BREAK_UPPER)):
  //   period | bars | count  — длина канала в барах, по которым строятся границы
  //                            (по умолчанию 20). Канал = high/low этих "прошлых" баров.
  //   tf                     — таймфрейм данных (опционально). Если не указан,
  //                            используется таймфрейм контекста расчёта.
  //
  // Как считаются бары (окно из period + 2 баров, по времени слева направо):
  //   [0 .. period-1]        — "прошлые" бары, по ним строится канал (границы UPPER/LOWER)
  //   [period] = probe       — ПРЕДЫДУЩИЙ (пробойный) бар: проверяем, пробил ли он границу
  //   [period+1] = curr      — ТЕКУЩИЙ бар: проверяем, вернулась ли цена внутрь канала (закрытие)
  // ============================================================
  const empty = { UPPER: null, LOWER: null, BREAK_UPPER: 0, BREAK_LOWER: 0 };

  // 1) Читаем параметры. Берём period/bars/count (что указано), иначе 20. Минимум 2 бара.
  const period = Math.max(2, Number(params.period ?? params.bars ?? params.count ?? 20) || 20);

  // 2) Запрашиваем бары: period (канал) + 1 (пробойный) + 1 (текущий) = period + 2.
  //    ctx.bars({count, timeframe}) возвращает объект p с полями:
  //      p.n, p.open[], p.high[], p.low[], p.close[], p.volume[], p.dt[]
  //    (также доступны алиасы o/h/l/c/v/t; last/prev — последний и предпоследний бар).
  const p = ctx.bars({ count: period + 2, timeframe: params.tf });

  // 3) Если баров недостаточно для расчёта — границы неизвестны, сигналов нет.
  if (!p || p.n < period + 2) return empty;

  // 4) Индексы ключевых баров в массиве:
  const curr = p.n - 1;   // текущий (последний) бар — на нём ждём ВОЗВРАТ (закрытие внутри канала)
  const probe = p.n - 2;  // предыдущий (пробойный) бар — на нём ищем ПРОБОЙ границы канала

  // 5) Строим границы ценового канала по "прошлым" барам [0 .. probe-1],
  //    т.е. по всем барам до пробойного (пробойный бар в канал не входит).
  //    UPPER = максимум high за период, LOWER = минимум low за период.
  let upper = -Infinity;
  let lower = Infinity;
  for (let i = 0; i <= probe - 1; i++) {
    const h = Number(p.high[i]);
    const l = Number(p.low[i]);
    if (Number.isFinite(h) && h > upper) upper = h; // обновляем верхнюю границу канала
    if (Number.isFinite(l) && l < lower) lower = l; // обновляем нижнюю границу канала
  }
  // Если границы не удалось вычислить — возвращаем пустой результат.
  if (!Number.isFinite(upper) || !Number.isFinite(lower)) return empty;

  // 6) Значения пробойного и текущего баров, нужные для проверки условий:
  const probeLow = Number(p.low[probe]);    // минимум пробойного бара (для нижнего пробоя)
  const probeHigh = Number(p.high[probe]);  // максимум пробойного бара (для верхнего пробоя)
  const currClose = Number(p.close[curr]);  // цена закрытия текущего бара (подтверждение возврата)

  // 7) УСЛОВИЕ BREAK_LOWER (нижний ложный пробой → возврат вверх, локальный минимум):
  //    Пробой: минимум пробойного бара СТРОГО НИЖЕ нижней границы (LOWER).
  //    Возврат: текущий бар закрылся СТРОГО ВЫШЕ нижней границы (вернулся внутрь канала).
  const breakLower = Number.isFinite(probeLow) && Number.isFinite(currClose) && probeLow < lower && currClose > lower ? 1 : 0;

  // 8) УСЛОВИЕ BREAK_UPPER (верхний ложный пробой → возврат вниз, локальный максимум):
  //    Пробой: максимум пробойного бара СТРОГО ВЫШЕ верхней границы (UPPER).
  //    Возврат: текущий бар закрылся СТРОГО НИЖЕ верхней границы (вернулся внутрь канала).
  const breakUpper = Number.isFinite(probeHigh) && Number.isFinite(currClose) && probeHigh > upper && currClose < upper ? 1 : 0;

  // 9) Возвращаем все 4 серии. При необходимости можно скорректировать условия
  //    подтверждения возврата (например, требовать закрытие пробойного бара за границей,
  //    учитывать тело свечи и т.п.).
  return {
    UPPER: upper,
    LOWER: lower,
    BREAK_UPPER: breakUpper,
    BREAK_LOWER: breakLower,
  };
}$js$, 'js', NULL, NULL, TRUE, TRUE)
    RETURNING id INTO v_id;
  ELSE
    UPDATE indicators SET
      name = 'Локальный экстремум (пробой-возврат)',
      description = 'Пользовательский JS-индикатор "Локальный экстремум (пробой-возврат ценового канала)" с 4 сериями: UPPER/LOWER — уровни верхней/нижней границы канала (max high/min low за period прошлых баров до пробойного); BREAK_UPPER=1 при верхнем ложном пробое с возвратом (иначе 0), BREAK_LOWER=1 при нижнем ложном пробое с возвратом (иначе 0). Параметры: period/bars/count (длина канала, по умолчанию 20), tf (опц. таймфрейм). Подробные комментарии — в коде индикатора.',
      category = 'custom',
      js_code = $js$function calc(ctx, params) {
  // ============================================================
  // Индикатор: "Локальный экстремум (пробой-возврат ценового канала)"
  //
  // Возвращает 4 серии (для использования в сигналах указывайте series=...):
  //   UPPER        — верхняя граница ценового канала (уровень): максимум high
  //                  за "прошлые" period баров, предшествующих пробойному бару.
  //   LOWER        — нижняя граница ценового канала (уровень): минимум low
  //                  за те же "прошлые" period баров.
  //   BREAK_UPPER  — сигнал верхнего пробоя-возврата (ложный пробой вверх):
  //                  1, если предыдущий (пробойный) бар пробил UPPER сверху,
  //                  а текущий бар закрылся обратно НИЖЕ UPPER; иначе 0.
  //   BREAK_LOWER  — сигнал нижнего пробоя-возврата (ложный пробой вниз):
  //                  1, если предыдущий (пробойный) бар пробил LOWER снизу,
  //                  а текущий бар закрылся обратно ВЫШЕ LOWER; иначе 0.
  //
  // Параметры (передаются в формуле сигнала, напр. @LOCAL_EXTREMUM(period=20, series=BREAK_UPPER)):
  //   period | bars | count  — длина канала в барах, по которым строятся границы
  //                            (по умолчанию 20). Канал = high/low этих "прошлых" баров.
  //   tf                     — таймфрейм данных (опционально). Если не указан,
  //                            используется таймфрейм контекста расчёта.
  //
  // Как считаются бары (окно из period + 2 баров, по времени слева направо):
  //   [0 .. period-1]        — "прошлые" бары, по ним строится канал (границы UPPER/LOWER)
  //   [period] = probe       — ПРЕДЫДУЩИЙ (пробойный) бар: проверяем, пробил ли он границу
  //   [period+1] = curr      — ТЕКУЩИЙ бар: проверяем, вернулась ли цена внутрь канала (закрытие)
  // ============================================================
  const empty = { UPPER: null, LOWER: null, BREAK_UPPER: 0, BREAK_LOWER: 0 };

  // 1) Читаем параметры. Берём period/bars/count (что указано), иначе 20. Минимум 2 бара.
  const period = Math.max(2, Number(params.period ?? params.bars ?? params.count ?? 20) || 20);

  // 2) Запрашиваем бары: period (канал) + 1 (пробойный) + 1 (текущий) = period + 2.
  //    ctx.bars({count, timeframe}) возвращает объект p с полями:
  //      p.n, p.open[], p.high[], p.low[], p.close[], p.volume[], p.dt[]
  //    (также доступны алиасы o/h/l/c/v/t; last/prev — последний и предпоследний бар).
  const p = ctx.bars({ count: period + 2, timeframe: params.tf });

  // 3) Если баров недостаточно для расчёта — границы неизвестны, сигналов нет.
  if (!p || p.n < period + 2) return empty;

  // 4) Индексы ключевых баров в массиве:
  const curr = p.n - 1;   // текущий (последний) бар — на нём ждём ВОЗВРАТ (закрытие внутри канала)
  const probe = p.n - 2;  // предыдущий (пробойный) бар — на нём ищем ПРОБОЙ границы канала

  // 5) Строим границы ценового канала по "прошлым" барам [0 .. probe-1],
  //    т.е. по всем барам до пробойного (пробойный бар в канал не входит).
  //    UPPER = максимум high за период, LOWER = минимум low за период.
  let upper = -Infinity;
  let lower = Infinity;
  for (let i = 0; i <= probe - 1; i++) {
    const h = Number(p.high[i]);
    const l = Number(p.low[i]);
    if (Number.isFinite(h) && h > upper) upper = h; // обновляем верхнюю границу канала
    if (Number.isFinite(l) && l < lower) lower = l; // обновляем нижнюю границу канала
  }
  // Если границы не удалось вычислить — возвращаем пустой результат.
  if (!Number.isFinite(upper) || !Number.isFinite(lower)) return empty;

  // 6) Значения пробойного и текущего баров, нужные для проверки условий:
  const probeLow = Number(p.low[probe]);    // минимум пробойного бара (для нижнего пробоя)
  const probeHigh = Number(p.high[probe]);  // максимум пробойного бара (для верхнего пробоя)
  const currClose = Number(p.close[curr]);  // цена закрытия текущего бара (подтверждение возврата)

  // 7) УСЛОВИЕ BREAK_LOWER (нижний ложный пробой → возврат вверх, локальный минимум):
  //    Пробой: минимум пробойного бара СТРОГО НИЖЕ нижней границы (LOWER).
  //    Возврат: текущий бар закрылся СТРОГО ВЫШЕ нижней границы (вернулся внутрь канала).
  const breakLower = Number.isFinite(probeLow) && Number.isFinite(currClose) && probeLow < lower && currClose > lower ? 1 : 0;

  // 8) УСЛОВИЕ BREAK_UPPER (верхний ложный пробой → возврат вниз, локальный максимум):
  //    Пробой: максимум пробойного бара СТРОГО ВЫШЕ верхней границы (UPPER).
  //    Возврат: текущий бар закрылся СТРОГО НИЖЕ верхней границы (вернулся внутрь канала).
  const breakUpper = Number.isFinite(probeHigh) && Number.isFinite(currClose) && probeHigh > upper && currClose < upper ? 1 : 0;

  // 9) Возвращаем все 4 серии. При необходимости можно скорректировать условия
  //    подтверждения возврата (например, требовать закрытие пробойного бара за границей,
  //    учитывать тело свечи и т.п.).
  return {
    UPPER: upper,
    LOWER: lower,
    BREAK_UPPER: breakUpper,
    BREAK_LOWER: breakLower,
  };
}$js$,
      calc_kind = 'js',
      script = NULL,
      formula = NULL,
      is_custom = TRUE,
      is_active = TRUE
    WHERE id = v_id;
  END IF;

  -- Типы значений (серии) LOCAL_EXTREMUM: UPPER/LOWER (уровни канала) + BREAK_UPPER/BREAK_LOWER (сигналы 0/1)
  INSERT INTO indicator_value_types (indicator_id, code, name, value_type, is_threshold, threshold_value, description, display_order)
  SELECT v_id, x.code, x.name, 'float', FALSE, NULL, x.description, x.display_order
  FROM (VALUES
    ('UPPER',       'Верхняя граница',  'Максимум high за period прошлых баров (верхняя граница канала)',               1),
    ('LOWER',       'Нижняя граница',   'Минимум low за period прошлых баров (нижняя граница канала)',                 2),
    ('BREAK_UPPER', 'Пробой вверх',     '1 = верхний ложный пробой с возвратом вниз (иначе 0)',                       3),
    ('BREAK_LOWER', 'Пробой вниз',      '1 = нижний ложный пробой с возвратом вверх (иначе 0)',                       4)
  ) AS x(code, name, description, display_order)
  ON CONFLICT (indicator_id, code) DO UPDATE SET
    name = EXCLUDED.name,
    value_type = EXCLUDED.value_type,
    is_threshold = EXCLUDED.is_threshold,
    threshold_value = EXCLUDED.threshold_value,
    description = EXCLUDED.description,
    display_order = EXCLUDED.display_order;

  -- Удаляем устаревшие типы значений этого индикатора (напр. прежний VALUE),
  -- чтобы остались только актуальные серии.
  DELETE FROM indicator_value_types
  WHERE indicator_id = v_id
    AND code NOT IN ('UPPER', 'LOWER', 'BREAK_UPPER', 'BREAK_LOWER');

  -- PRICE_DIR
  SELECT id INTO v_id FROM indicators WHERE code = 'PRICE_DIR';
  IF v_id IS NULL THEN
    INSERT INTO indicators (code, name, description, category, js_code, calc_kind, script, formula, is_custom, is_active)
    VALUES ('PRICE_DIR', 'Направление цены (JS)', 'Пользовательский JS-индикатор направления цены: +1 если close вырос относительно предыдущего бара, -1 если снизился, 0 если не изменился. Параметры: tf (опц. таймфрейм).', 'custom', $js$function calc(ctx, params) {
  // ctx.bars({ count, timeframe?, ... }) -> объект цен p
  // p.close/p.open/p.high/p.low/p.volume (алиасы c/o/h/l/v), p.dt (t), p.n, p.last/p.prev
  // params: произвольные параметры из @CODE(...), напр. period/bars, tf
  const p = ctx.bars({ count: 2, timeframe: params.tf });
  if (!p || p.n < 2) return 0;
  const prev = Number(p.close[p.n - 2]);
  const curr = Number(p.close[p.n - 1]);
  if (!Number.isFinite(prev) || !Number.isFinite(curr)) return 0;
  if (curr > prev) return 1;
  if (curr < prev) return -1;
  return 0;
}$js$, 'js', NULL, NULL, TRUE, TRUE)
    RETURNING id INTO v_id;
  ELSE
    UPDATE indicators SET
      name = 'Направление цены (JS)',
      description = 'Пользовательский JS-индикатор направления цены: +1 если close вырос относительно предыдущего бара, -1 если снизился, 0 если не изменился. Параметры: tf (опц. таймфрейм).',
      category = 'custom',
      js_code = $js$function calc(ctx, params) {
  // ctx.bars({ count, timeframe?, ... }) -> объект цен p
  // p.close/p.open/p.high/p.low/p.volume (алиасы c/o/h/l/v), p.dt (t), p.n, p.last/p.prev
  // params: произвольные параметры из @CODE(...), напр. period/bars, tf
  const p = ctx.bars({ count: 2, timeframe: params.tf });
  if (!p || p.n < 2) return 0;
  const prev = Number(p.close[p.n - 2]);
  const curr = Number(p.close[p.n - 1]);
  if (!Number.isFinite(prev) || !Number.isFinite(curr)) return 0;
  if (curr > prev) return 1;
  if (curr < prev) return -1;
  return 0;
}$js$,
      calc_kind = 'js',
      script = NULL,
      formula = NULL,
      is_custom = TRUE,
      is_active = TRUE
    WHERE id = v_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM indicator_value_types WHERE indicator_id = v_id AND code = 'VALUE') THEN
    INSERT INTO indicator_value_types (indicator_id, code, name, value_type, is_threshold, threshold_value, description, display_order)
    VALUES (v_id, 'VALUE', 'Направление', 'float', FALSE, NULL, '1 рост, -1 падение, 0 без изменений', 1);
  ELSE
    UPDATE indicator_value_types SET
      name = 'Направление',
      value_type = 'float',
      is_threshold = FALSE,
      threshold_value = NULL,
      description = '1 рост, -1 падение, 0 без изменений',
      display_order = 1
    WHERE indicator_id = v_id AND code = 'VALUE';
  END IF;

END $$;
