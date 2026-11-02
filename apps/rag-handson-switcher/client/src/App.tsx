import { useEffect, useRef, useState } from 'react';
import { SimpleMarkdown } from './SimpleMarkdown';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  Spinner,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@databricks/appkit-ui/react';

type Backend = 'scratch' | 'managed';
type Message = { id: string; role: 'user' | 'assistant'; text: string; backend: Backend };

const BACKENDS: Record<Backend, { label: string; detail: string }> = {
  scratch: { label: 'Scratch', detail: 'AI Search + カスタムエージェント（Agent Runtime）' },
  managed: { label: 'Managed', detail: 'Genie Agent + content search（Agent mode）' },
};

const SAMPLE_QUESTIONS = [
  'プロセス能力レベル2を構成するプロセス属性は何か。',
  'SWE.1 ソフトウェア要求分析のプロセス目的は何か。',
  'プロセス属性の評定 N・P・L・F は、それぞれどの程度の達成を表すか。',
];

export default function App() {
  const [backend, setBackend] = useState<Backend>('scratch');
  const [available, setAvailable] = useState<Record<Backend, boolean>>({ scratch: true, managed: true });
  // 会話はバックエンドごとに分けて持つ（同じ質問を両方に投げて比べられるようにする）
  const [messages, setMessages] = useState<Record<Backend, Message[]>>({ scratch: [], managed: [] });
  const [threads, setThreads] = useState<Partial<Record<Backend, string>>>({});
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/backends')
      .then((r) => r.json())
      .then((b: Record<Backend, boolean>) => setAvailable(b))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, backend, pending]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || pending) return;
    const target = backend;
    setError(null);
    setInput('');
    setPending(true);
    setMessages((m) => ({ ...m, [target]: [...m[target], { id: crypto.randomUUID(), role: 'user', text: question, backend: target }] }));
    try {
      const res = await fetch(`/api/chat/${target}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: question, threadId: threads[target] }),
      });
      const body = (await res.json()) as { text?: string; threadId?: string; error?: string };
      if (!res.ok || !body.text) throw new Error(body.error ?? `HTTP ${res.status}`);
      setThreads((t) => ({ ...t, [target]: body.threadId }));
      setMessages((m) => ({ ...m, [target]: [...m[target], { id: crypto.randomUUID(), role: 'assistant', text: body.text ?? '', backend: target }] }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  function reset() {
    setMessages((m) => ({ ...m, [backend]: [] }));
    setThreads((t) => ({ ...t, [backend]: undefined }));
    setError(null);
  }

  const current = messages[backend];

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b px-4 md:px-6 py-3 flex flex-wrap items-center gap-4">
        <h1 className="text-lg font-semibold text-foreground">RAG エージェント比較チャット</h1>
        <Tabs value={backend} onValueChange={(v) => setBackend(v as Backend)}>
          <TabsList>
            {(Object.keys(BACKENDS) as Backend[]).map((b) => (
              <TabsTrigger key={b} value={b} disabled={!available[b]}>
                {BACKENDS[b].label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <span className="text-sm text-muted-foreground">{BACKENDS[backend].detail}</span>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={reset} disabled={pending}>
          会話をリセット
        </Button>
      </header>

      <main className="flex-1 w-full max-w-3xl mx-auto p-4 md:p-6 flex flex-col gap-4">
        {!available[backend] && (
          <Alert>
            <AlertDescription>このバックエンドは設定されていない。databricks.yml の変数を設定して再デプロイする。</AlertDescription>
          </Alert>
        )}

        {current.length === 0 && (
          <Card>
            <CardContent className="pt-6 space-y-3">
              <p className="text-sm text-muted-foreground">
                上のタブでエージェントを選んで質問する。同じ質問を Scratch と Managed の両方に投げて、回答と出典を比べる。
              </p>
              <div className="flex flex-wrap gap-2">
                {SAMPLE_QUESTIONS.map((q) => (
                  <Button key={q} variant="outline" size="sm" onClick={() => void send(q)} disabled={pending || !available[backend]}>
                    {q}
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <div className="flex flex-col gap-3">
          {current.map((m) => (
            <div key={m.id} className={m.role === 'user' ? 'self-end max-w-[85%]' : 'self-start max-w-[85%]'}>
              <div
                className={
                  m.role === 'user'
                    ? 'rounded-lg bg-primary text-primary-foreground px-4 py-2 whitespace-pre-wrap'
                    : 'rounded-lg border bg-card text-card-foreground px-4 py-3 whitespace-pre-wrap'
                }
              >
                {m.role === 'assistant' && (
                  <Badge variant="secondary" className="mb-2">
                    {BACKENDS[m.backend].label}
                  </Badge>
                )}
                {m.role === 'assistant' ? (
                  <div className="text-sm leading-relaxed whitespace-normal">
                    <SimpleMarkdown text={m.text} />
                  </div>
                ) : (
                  <div className="text-sm leading-relaxed">{m.text}</div>
                )}
              </div>
            </div>
          ))}
          {pending && (
            <div className="self-start flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> {BACKENDS[backend].label} が回答を作成中（Agent mode は数十秒かかることがある）
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <form
          className="sticky bottom-0 bg-background pt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="文書について質問する"
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send(input);
              }
            }}
          />
          <Button type="submit" disabled={pending || !input.trim() || !available[backend]}>
            送信
          </Button>
        </form>
      </main>
    </div>
  );
}
