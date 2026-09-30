import { ApplicationConfig, APP_INITIALIZER } from '@angular/core';
import { provideRouter, RouteReuseStrategy } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { registerLocaleData } from '@angular/common';
import localeRu from '@angular/common/locales/ru';

import { routes } from './app.routes';
import { AppConfigService } from './services/app-config.service';
import { OperationsRouteReuseStrategy } from './services/operations-route-reuse.strategy';

// Данные локали 'ru' нужны, чтобы пайп number умел русский разделитель
// разрядов (пробел) и запятую: «44 599,17», а не «44,599.17».
// Указывается явно в шаблонах третьим аргументом: '1.0-2' : 'ru'.
// Даты в этих компонентах уже форматируются как ru-RU.
registerLocaleData(localeRu, 'ru');

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideHttpClient(),
    { provide: RouteReuseStrategy, useClass: OperationsRouteReuseStrategy },
    {
      provide: APP_INITIALIZER,
      multi: true,
      deps: [AppConfigService],
      useFactory: (cfg: AppConfigService) => () => cfg.load(),
    },
  ],
};
