/**
 * URL для файлов из assets/ с учётом base-href (GitHub Pages: /OsEngine/).
 * HttpClient с путём `assets/...` иначе бьёт в корень домена и 404.
 */
export function assetUrl(path: string): string {
  const clean = String(path || '').replace(/^\/+/, '');
  try {
    return new URL(clean, document.baseURI).toString();
  } catch {
    const base =
      typeof document !== 'undefined' && document.querySelector('base')?.href
        ? String(document.querySelector('base')?.href)
        : '/';
    return `${base.replace(/\/?$/, '/')}${clean}`;
  }
}
