import { createApp, getExecutionContext, server } from '@databricks/appkit';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

// app.yaml の valueFrom で、databricks.yml のリソースから値が入る
const SCRATCH_AGENT_APP_NAME = process.env.SCRATCH_AGENT_APP_NAME ?? '';
const GENIE_AGENT_ID = process.env.GENIE_AGENT_ID ?? '';

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

let scratchAgentUrl: string | undefined;

/** Scratch：Agent Runtime（agent-bricks-<名前>）の /api/invocations を呼ぶ */
async function askScratch(message: string, threadId?: string): Promise<ChatReply> {
  const { host, headers } = await currentAuth();
  if (!scratchAgentUrl) {
    const res = await fetch(`${host}/api/2.0/apps/${SCRATCH_AGENT_APP_NAME}`, { headers });
    if (!res.ok) throw new Error(`アプリ ${SCRATCH_AGENT_APP_NAME} を取得できない: ${res.status}`);
    const app = z.object({ url: z.string() }).parse(await res.json());
    scratchAgentUrl = app.url.replace(/\/$/, '');
  }
  const sessionId = threadId ?? randomUUID();
  const res = await fetch(`${scratchAgentUrl}/api/invocations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id: randomUUID(),
      session_id: sessionId,
      input: { messages: [{ role: 'user', content: message }] },
    }),
  });
  if (!res.ok) throw new Error(`Scratch エージェントの呼び出しに失敗: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { output?: { output?: unknown[] } | unknown[] };
  return { text: lastAiText(body.output), threadId: sessionId };
}

/** DurableAgentServer の出力から、最後の AI メッセージの本文を取り出す */
function lastAiText(output: unknown): string {
  const items: unknown[] = Array.isArray(output)
    ? (output as unknown[])
    : Array.isArray((output as { output?: unknown[] } | undefined)?.output)
      ? (output as { output: unknown[] }).output
      : [];
  for (const item of [...items].reverse()) {
    const msg = item as { type?: string; content?: unknown };
    if (msg.type !== 'ai' || !msg.content) continue;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content
        .map((part) => (typeof part === 'string' ? part : ((part as { text?: string }).text ?? '')))
        .join('');
    }
  }
  return '（回答を取り出せなかった）';
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
        res.json({ scratch: Boolean(SCRATCH_AGENT_APP_NAME), managed: Boolean(GENIE_AGENT_ID) });
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
            res.json(await askScratch(message, threadId));
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
