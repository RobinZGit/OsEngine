import { renderInlineLinks, splitMarkdownChapters } from './app-help-content';

describe('splitMarkdownChapters', () => {
  it('splits ## headings into chapters', () => {
    const md = `# Doc\n\nIntro line.\n\n## Goal\n\nGoal text.\n\n## History\n\nHistory text.`;
    const ch = splitMarkdownChapters(md);
    expect(ch.length).toBe(3);
    expect(ch[0].title).toBe('Doc');
    expect(ch[0].body).toContain('Intro line');
    expect(ch[1].title).toBe('Goal');
    expect(ch[1].body).toContain('Goal text');
    expect(ch[2].title).toBe('History');
  });

  it('handles empty input', () => {
    const ch = splitMarkdownChapters('');
    expect(ch.length).toBe(1);
    expect(ch[0].body).toContain('sync:context');
  });
});

describe('renderInlineLinks', () => {
  it('turns a markdown link into an anchor', () => {
    const html = renderInlineLinks(
      'Коммит: [5f69d67](https://github.com/RobinZGit/OsEngine/commit/abc123)'
    );
    expect(html).toContain(
      '<a href="https://github.com/RobinZGit/OsEngine/commit/abc123" target="_blank" rel="noopener noreferrer">5f69d67</a>'
    );
  });

  it('escapes angle brackets in formulas, keeping them literal', () => {
    const html = renderInlineLinks('@SMA(period=20) pp < VALUE && pp <= VALUE');
    expect(html).toContain('pp &lt; VALUE &amp;&amp; pp &lt;= VALUE');
    expect(html).not.toContain('<VALUE');
  });

  it('leaves placeholder links without http(s) untouched (escaped)', () => {
    const html = renderInlineLinks('Коммит: [<короткий-sha>](<ссылка-на-коммит>)');
    expect(html).not.toContain('<a ');
    expect(html).toContain('&lt;короткий-sha&gt;');
  });

  it('handles null/undefined safely', () => {
    expect(renderInlineLinks('')).toBe('');
    expect(renderInlineLinks(null as unknown as string)).toBe('');
  });
});
