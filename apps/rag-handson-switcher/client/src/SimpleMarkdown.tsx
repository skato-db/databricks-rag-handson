import type { ReactNode } from 'react';

// エージェントの回答を表示するための最小限の Markdown（見出し・箇条書き・太字・リンク・段落）
function inline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:[^)\s]+)\)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1]) {
      nodes.push(<strong key={`${keyBase}-b${i}`}>{match[1]}</strong>);
    } else {
      nodes.push(
        <a key={`${keyBase}-a${i}`} href={match[3]} target="_blank" rel="noopener noreferrer" className="text-primary underline">
          {match[2]}
        </a>,
      );
    }
    last = pattern.lastIndex;
    i += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function SimpleMarkdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const key = `l${blocks.length}`;
    const items = list.items.map((item, j) => <li key={`${key}-${j}`}>{inline(item, `${key}-${j}`)}</li>);
    blocks.push(list.ordered ? <ol key={key} className="list-decimal pl-5 space-y-1">{items}</ol> : <ul key={key} className="list-disc pl-5 space-y-1">{items}</ul>);
    list = null;
  };
  text.split('\n').forEach((raw, idx) => {
    const line = raw.trimEnd();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        flush();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? numbered)?.[1] ?? '');
      return;
    }
    flush();
    if (!line.trim()) return;
    if (heading) {
      blocks.push(<p key={`h${idx}`} className="font-semibold">{inline(heading[1], `h${idx}`)}</p>);
    } else {
      blocks.push(<p key={`p${idx}`}>{inline(line, `p${idx}`)}</p>);
    }
  });
  flush();
  return <div className="space-y-2">{blocks}</div>;
}
