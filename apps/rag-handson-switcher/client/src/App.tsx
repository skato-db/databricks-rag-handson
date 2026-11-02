import { useEffect, useRef, useState } from 'react';
import { SimpleMarkdown } from './SimpleMarkdown';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  Input,
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

// Genie Agent の URL（.../genie/rooms/<ID>）か ID から、32桁の ID を取り出す
const GENIE_ID_STORAGE_KEY = 'genieAgentId';
function parseGenieId(text: string): string | null {
  return text.match(/[0-9a-f]{32}/i)?.[0] ?? null;
}

const SAMPLE_QUESTIONS = [
  'プロセス能力レベル2を構成するプロセス属性は何か。',
  'SWE.1 ソフトウェア要求分析のプロセス目的は何か。',
  'プロセス属性の評定 N・P・L・F は、それぞれどの程度の達成を表すか。',
];

export default function App() {
  const [backend, setBackend] = useState<Backend>('scratch');
  const [scratchReady, setScratchReady] = useState(true);
  const [genieConfigured, setGenieConfigured] = useState(true);
  // 環境変数で Genie Agent が設定されていないときは、画面で入力した ID をブラウザーに保存して使う
  const [genieId, setGenieId] = useState<string | null>(() => localStorage.getItem(GENIE_ID_STORAGE_KEY));
  const [genieInput, setGenieInput] = useState('');
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
      .then((b: { scratch: boolean; genieConfigured: boolean }) => {
        setScratchReady(b.scratch);
        setGenieConfigured(b.genieConfigured);
      })
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
        body: JSON.stringify({
          message: question,
          threadId: threads[target],
          ...(target === 'managed' && !genieConfigured && genieId ? { genieAgentId: genieId } : {}),
        }),
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

  function saveGenieId() {
    const id = parseGenieId(genieInput);
    if (!id) {
      setError('Genie Agent の URL か ID（32桁の英数字）を入力する');
      return;
    }
    localStorage.setItem(GENIE_ID_STORAGE_KEY, id);
    setGenieId(id);
    setGenieInput('');
    setError(null);
    setMessages((m) => ({ ...m, managed: [] }));
    setThreads((t) => ({ ...t, managed: undefined }));
  }

  function clearGenieId() {
    localStorage.removeItem(GENIE_ID_STORAGE_KEY);
    setGenieId(null);
    setMessages((m) => ({ ...m, managed: [] }));
    setThreads((t) => ({ ...t, managed: undefined }));
  }

  const available: Record<Backend, boolean> = { scratch: scratchReady, managed: genieConfigured || Boolean(genieId) };
  const current = messages[backend];

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b px-4 md:px-6 py-3 flex flex-wrap items-center gap-4">
        <h1 className="text-lg font-semibold text-foreground">RAG エージェント比較チャット</h1>
        <Tabs value={backend} onValueChange={(v) => setBackend(v as Backend)}>
          <TabsList>
            {(Object.keys(BACKENDS) as Backend[]).map((b) => (
              <TabsTrigger key={b} value={b}>
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
        {backend === 'scratch' && !scratchReady && (
          <Alert>
            <AlertDescription>
              AI Search の索引が設定されていない。アプリの「設定」→「リソース」で AI Search index（キー vector-search-index）を追加して、再デプロイする。
            </AlertDescription>
          </Alert>
        )}

        {backend === 'managed' && !genieConfigured && !genieId && (
          <Card>
            <CardContent className="pt-6 space-y-3">
              <p className="text-sm text-muted-foreground">
                2 で作った Genie Agent を開き、ブラウザーのアドレス欄の URL（.../genie/rooms/&lt;ID&gt;）をコピーして貼り付ける。ID はこのブラウザーに保存される。
              </p>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveGenieId();
                }}
              >
                <Input value={genieInput} onChange={(e) => setGenieInput(e.target.value)} placeholder="Genie Agent の URL か ID" />
                <Button type="submit" disabled={!genieInput.trim()}>
                  保存
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {backend === 'managed' && !genieConfigured && genieId && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            Genie Agent：{genieId}
            <Button variant="ghost" size="sm" onClick={clearGenieId} disabled={pending}>
              変更
            </Button>
          </div>
        )}

        {current.length === 0 && available[backend] && (
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
