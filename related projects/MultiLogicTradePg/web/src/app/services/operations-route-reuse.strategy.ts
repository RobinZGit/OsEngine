import { Injectable } from '@angular/core';
import {
  ActivatedRouteSnapshot,
  DetachedRouteHandle,
  RouteReuseStrategy,
} from '@angular/router';

/**
 * Keep top-level tab routes mounted when switching tabs so long-running UI state
 * (export/import/loading/progress) is preserved.
 */
@Injectable()
export class OperationsRouteReuseStrategy implements RouteReuseStrategy {
  private handles = new Map<string, DetachedRouteHandle>();

  private static readonly CACHED_PATHS = new Set([
    'operations',
    'references',
    'terminal',
    'trainer',
    'monitoring',
    'indicators',
  ]);

  shouldDetach(route: ActivatedRouteSnapshot): boolean {
    return this.isCached(route);
  }

  store(route: ActivatedRouteSnapshot, handle: DetachedRouteHandle | null): void {
    const path = this.path(route);
    if (!path) return;
    if (handle) this.handles.set(path, handle);
    else this.handles.delete(path);
  }

  shouldAttach(route: ActivatedRouteSnapshot): boolean {
    const path = this.path(route);
    return !!path && this.handles.has(path);
  }

  retrieve(route: ActivatedRouteSnapshot): DetachedRouteHandle | null {
    const path = this.path(route);
    return path ? this.handles.get(path) ?? null : null;
  }

  shouldReuseRoute(
    future: ActivatedRouteSnapshot,
    curr: ActivatedRouteSnapshot
  ): boolean {
    return future.routeConfig === curr.routeConfig;
  }

  private isCached(route: ActivatedRouteSnapshot): boolean {
    const path = this.path(route);
    return !!path && OperationsRouteReuseStrategy.CACHED_PATHS.has(path);
  }

  private path(route: ActivatedRouteSnapshot): string | null {
    return route.routeConfig?.path ?? null;
  }
}
