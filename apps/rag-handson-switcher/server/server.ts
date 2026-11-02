import { createApp, getExecutionContext, server } from '@databricks/appkit';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

// app.yaml の env・valueFrom で、databricks.yml の変数とリソースから値が入る
const AI_SEARCH_INDEX = process.env.AI_SEARCH_INDEX ?? '';
const LLM_ENDPOINT = process.env.LLM_ENDPOINT ?? '';
const GENIE_AGENT_ID = process.env.GENIE_AGENT_ID ?? '';

// 1-2 のエージェントと同じシステムプロンプト
const SYSTEM_PROMPT = `あなたは社内文書について答えるアシスタントである。
質問に答えるときは、与えられた文書の抜粋だけを根拠に日本語で答える。
回答の最後に、根拠にしたファイル名とページ番号を「出典: <ファイル名> p.<ページ>」の形で列挙する。
抜粋に根拠が見つからない場合は、分からないと答える。`;

const chatSchema = z.object({
  message: z.string().min(1),
  // Scratch: DurableAgentServer の session_id。Managed: Genie の conversation_id
  threadId: z.string().optional(),
});

type ChatReply = { text: string; threadId: string };

/** 現在の実行コンテキスト（サービスプリンシパルまたは asUser のユーザー）の認証ヘッダーとホスト */
async function currentAuth(): Promise<{ host: string; headers: Headers }> {
  const { client } = getExecutionContext();
  const headers = new Headers({ 'Content-Type': 'application/json' });
  await client.config.authenticate(headers);
  const host = (await client.config.getHost()).toString().replace(/\/$/, '');
  return { host, headers };
}

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
// Scratch の会話履歴（threadId ごと）。デモ用にプロセス内だけで持つ
const scratchThreads = new Map<string, ChatMessage[]>();

/**
 * Scratch：1-1 の AI Search 索引を質問者本人の権限でハイブリッド検索し、同じ LLM で回答を作る。
 * Agent Runtime のエージェント（1-2）と同じ索引・同じシステムプロンプトを使う。
 * （アプリから別のアプリを呼ぶと利用者のトークンが引き継がれないため、エージェントのアプリは呼ばない）
 */
async function askScratch(message: string, threadId?: string): Promise<ChatReply> {
  const { host, headers } = await currentAuth();
  const search = await fetch(`${host}/api/2.0/vector-search/indexes/${AI_SEARCH_INDEX}/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query_text: message,
      columns: ['file_name', 'pages', 'chunk_to_retrieve'],
      num_results: 5,
      query_type: 'HYBRID',
    }),
  });
  if (!search.ok) throw new Error(`AI Search の検索に失敗: ${search.status} ${await search.text()}`);
  const result = z
    .object({
      manifest: z.object({ columns: z.array(z.object({ name: z.string() })) }),
      result: z.object({ data_array: z.array(z.array(z.unknown())).optional() }),
    })
    .parse(await search.json());
  const names = result.manifest.columns.map((c) => c.name);
  const context = (result.result.data_array ?? [])
    .map((row) => {
      const r = Object.fromEntries(names.map((n, i) => [n, typeof row[i] === 'string' ? row[i] : JSON.stringify(row[i] ?? '')]));
      return `[${r.file_name} p.${r.pages}]\n${r.chunk_to_retrieve}`;
    })
    .join('\n\n');

  const id = threadId ?? randomUUID();
  const history = scratchThreads.get(id) ?? [];
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: `質問：${message}\n\n文書の抜粋：\n${context || '（該当なし）'}` },
  ];
  const llm = await fetch(`${host}/serving-endpoints/${LLM_ENDPOINT}/invocations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ messages, max_tokens: 2000 }),
  });
  if (!llm.ok) throw new Error(`LLM の呼び出しに失敗: ${llm.status} ${await llm.text()}`);
  const body = z
    .object({ choices: z.array(z.object({ message: z.object({ content: z.unknown() }) })) })
    .parse(await llm.json());
  const content = body.choices[0]?.message.content;
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const next: ChatMessage[] = [...history, { role: 'user', content: message }, { role: 'assistant', content: text }];
  scratchThreads.set(id, next.slice(-10));
  return { text, threadId: id };
}

/** Managed：Genie Agent の Agent mode API を呼ぶ（SSE を最後まで読む） */
async function askGenie(message: string, threadId?: string): Promise<ChatReply> {
  const { host, headers } = await currentAuth();
  const res = await fetch(`${host}/api/2.0/genie/agents/${GENIE_AGENT_ID}/responses`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: message }] }],
      ...(threadId ? { conversation_id: threadId } : {}),
    }),
  });
  if (!res.ok || !res.body) throw new Error(`Genie Agent の呼び出しに失敗: ${res.status} ${await res.text()}`);

  let conversationId = threadId ?? '';
  let finalOutput: unknown[] = [];
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = raw
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('');
      if (!data || data === '[DONE]') continue;
      const event = JSON.parse(data) as { type?: string; response?: { conversation_id?: string; output?: unknown[]; error?: unknown } };
      if (event.response?.conversation_id) conversationId = event.response.conversation_id;
      if (event.type === 'response.completed' && event.response?.output) finalOutput = event.response.output;
      if (event.type === 'response.failed') throw new Error(`Genie Agent の回答に失敗: ${JSON.stringify(event.response?.error)}`);
    }
  }
  const texts = finalOutput
    .filter((item) => (item as { type?: string }).type === 'message')
    .flatMap((item) => ((item as { content?: { type?: string; text?: string }[] }).content ?? []))
    .filter((part) => part.type === 'output_text' && part.text)
    .map((part) => part.text as string);
  // Genie の引用リンク（\[[1](URL)\]）を、Markdown のリンク [1](URL) に整える
  const text = texts.join('\n\n').replace(/\\\[\[(\d+)\]\(([^)]+)\)\\\]/g, '[[$1]]($2)');
  return { text: text || '（回答を取り出せなかった）', threadId: conversationId };
}

createApp({
  plugins: [server()],
  onPluginsReady(appkit) {
    appkit.server.extend((app) => {
      app.get('/api/backends', (_req, res) => {
        res.json({ scratch: Boolean(AI_SEARCH_INDEX && LLM_ENDPOINT), managed: Boolean(GENIE_AGENT_ID) });
      });

      app.post('/api/chat/:backend', async (req, res) => {
        const parsed = chatSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: '入力が正しくない' });
          return;
        }
        const { message, threadId } = parsed.data;
        try {
          if (req.params.backend === 'scratch') {
            // Scratch も質問したユーザー本人の権限（OBO）で索引を検索し、LLM を呼ぶ
            res.json(await appkit.asUser(req).run(() => askScratch(message, threadId)));
          } else if (req.params.backend === 'managed') {
            // 質問したユーザー本人の権限（OBO）で Genie Agent を呼ぶ
            res.json(await appkit.asUser(req).run(() => askGenie(message, threadId)));
          } else {
            res.status(404).json({ error: '不明なバックエンド' });
          }
        } catch (e) {
          console.error(e);
          res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
        }
      });
    });
  },
}).catch(console.error);
