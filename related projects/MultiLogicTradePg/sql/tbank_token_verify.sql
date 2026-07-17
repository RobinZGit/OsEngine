-- Проверка токена T-Bank (GetAccounts). Заглушка — в части A 02; HTTP-версия — в блоке pgsql-http.

CREATE OR REPLACE FUNCTION tbank_verify_token()
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_token TEXT;
    v_api_url TEXT;
    v_headers http_header[];
    v_response http_response;
    v_content JSONB;
BEGIN
    v_token := get_tbank_token();
    IF v_token IS NULL OR btrim(v_token) = '' THEN
        RETURN jsonb_build_object(
            'has_token', false,
            'valid', false,
            'error_message', 'Токен T-Bank не задан'
        );
    END IF;

    PERFORM configure_http_ssl();
    v_api_url := get_tbank_api_url();

    v_headers := ARRAY[
        http_header('Authorization', 'Bearer ' || v_token),
        http_header('Accept', 'application/json')
    ];

    SELECT * INTO v_response FROM http((
        'POST',
        rtrim(v_api_url, '/')
            || '/tinkoff.public.invest.api.contract.v1.UsersService/GetAccounts',
        v_headers,
        'application/json',
        '{}'
    )::http_request);

    IF v_response.status = 200 THEN
        v_content := v_response.content::JSONB;
        IF v_content ? 'code' AND btrim(COALESCE(v_content->>'code', '')) NOT IN ('', '0') THEN
            RETURN jsonb_build_object(
                'has_token', true,
                'valid', false,
                'error_message', COALESCE(
                    v_content->>'message',
                    'T-Bank API отклонил токен'
                )
            );
        END IF;
        RETURN jsonb_build_object(
            'has_token', true,
            'valid', true,
            'error_message', NULL
        );
    END IF;

    IF v_response.status = 401 THEN
        RETURN jsonb_build_object(
            'has_token', true,
            'valid', false,
            'error_message', 'Токен T-Bank неактивен или просрочен. Введите новый API-токен.'
        );
    END IF;

    RETURN jsonb_build_object(
        'has_token', true,
        'valid', false,
        'error_message', format('T-Bank API HTTP %s', v_response.status)
    );
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object(
            'has_token', true,
            'valid', false,
            'error_message', SQLERRM
        );
END;
$$;

COMMENT ON FUNCTION tbank_verify_token() IS
'Проверка API-токена T-Bank (UsersService/GetAccounts); JSON: has_token, valid, error_message';
