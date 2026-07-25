import { splitMarkdownChapters } from './app-help-content';

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
