import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { AppHelpPanelComponent } from './app-help-panel.component';

describe('AppHelpPanelComponent — markdown-ссылки (#1019)', () => {
  let fixture: ComponentFixture<AppHelpPanelComponent>;
  let component: AppHelpPanelComponent;
  let originalSections: typeof component.sections;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppHelpPanelComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();

    fixture = TestBed.createComponent(AppHelpPanelComponent);
    component = fixture.componentInstance;
    originalSections = component.sections.slice();
    component.open = true;
  });

  afterEach(() => {
    component.sections.splice(0, component.sections.length, ...originalSections);
  });

  it('рендерит ссылку на коммит как кликабельный <a>', () => {
    component.sections.push({
      id: 'links-test',
      title: 'Ссылки',
      body: 'Коммит: [5f69d67](https://github.com/RobinZGit/OsEngine/commit/deadbeef)',
    });
    component.select('links-test');
    fixture.detectChanges();

    const anchor = fixture.nativeElement.querySelector('pre.help-body a') as HTMLAnchorElement | null;
    expect(anchor).toBeTruthy();
    expect(anchor!.getAttribute('href')).toBe(
      'https://github.com/RobinZGit/OsEngine/commit/deadbeef'
    );
    expect(anchor!.textContent?.trim()).toBe('5f69d67');
  });

  it('не даёт внедрить HTML и оставляет угловые скобки буквально (формулы)', () => {
    component.sections.push({
      id: 'formula-test',
      title: 'Формула',
      body: 'pp < VALUE и <b>жирный</b>',
    });
    component.select('formula-test');
    fixture.detectChanges();

    const pre = fixture.nativeElement.querySelector('pre.help-body') as HTMLElement;
    expect(pre.querySelector('b')).toBeNull();
    expect(pre.textContent).toContain('pp < VALUE');
    expect(pre.textContent).toContain('<b>жирный</b>');
  });
});
