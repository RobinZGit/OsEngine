import { Injectable } from '@angular/core';
import {
  ActivatedRouteSnapshot,
  DetachedRouteHandle,
  RouteReuseStrategy,
} from '@angular/router';

/**
 * Keep «Торговые операции» (LogicsComponent) mounted when switching to other tabs.
 * Otherwise the component is destroyed and yellow/progress UI is lost until Start again.
 */
@Injectable()
export class OperationsRouteReuseStrategy implements RouteReuseStrategy {
  private operationsHandle: DetachedRouteHandle | null = null;

  shouldDetach(route: ActivatedRouteSnapshot): boolean {
    return this.isOperations(route);
  }

  store(_route: ActivatedRouteSnapshot, handle: DetachedRouteHandle | null): void {
    this.operationsHandle = handle;
  }

  shouldAttach(route: ActivatedRouteSnapshot): boolean {
    return this.isOperations(route) && this.operationsHandle != null;
  }

  retrieve(route: ActivatedRouteSnapshot): DetachedRouteHandle | null {
    return this.isOperations(route) ? this.operationsHandle : null;
  }

  shouldReuseRoute(
    future: ActivatedRouteSnapshot,
    curr: ActivatedRouteSnapshot
  ): boolean {
    return future.routeConfig === curr.routeConfig;
  }

  private isOperations(route: ActivatedRouteSnapshot): boolean {
    return route.routeConfig?.path === 'operations';
  }
}
