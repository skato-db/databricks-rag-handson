# 非構造データ分析 RAG エージェント ハンズオン

同じ PDF を使って、RAG エージェントを2つの実装パターンで作り、違いを体験するハンズオンである。

| パターン | 作り方 | 主な機能 |
|---|---|---|
| **Scratch** | ノートブックのコードで作る | `ai_parse_document`、`ai_prep_search`、AI Search、LangGraph、MLflow、Agent Bricks CLI（Agent Runtime on Databricks Apps） |
| **Managed** | 画面の操作だけで作る | Genie Agent（Agent mode）、ボリュームの content search、Genie One |

```mermaid
flowchart LR
  V[(UC マネージドボリューム<br/>PDF)]
  subgraph Managed
    GA[Genie Agent<br/>Agent mode] --> CS[content search]
  end
  subgraph Scratch
    P[ai_parse_document] --> S[ai_prep_search] --> T[(docs_chunks<br/>CDF)] --> I[AI Search 索引]
    A[LangGraph エージェント<br/>Agent Runtime] --> I
  end
  V --> CS
  V --> P
  APP[切り替えチャット<br/>AppKit] --> GA
  APP --> A
```

> 2026年10月時点で、ボリュームの解析（content search）、`ai_prep_search`、Agent Bricks CLI などは **Beta** である。実行前に各ドキュメントで最新の状態を確かめる。

## ファイル構成

| パス | 内容 | 所要時間の目安 |
|---|---|---|
| `00_データ準備.ipynb` | カタログ（任意）・スキーマ・マネージドボリュームを作り、PDF を置く | 5分 |
| `1-1_Scratch_パースとAI Search索引の作成.ipynb` | PDF のパース、チャンク化、AI Search の索引作成、ANN とハイブリッドの検索 | 30分 |
| `1-2_Scratch_RAGエージェントの構築とデプロイ.ipynb` | エージェントの試作、MLflow のトレースと評価、Agent Bricks CLI でのデプロイ | 45分 |
| `2_Managed_Genie AgentとContent Search.ipynb` | Genie Agent の作成と Agent mode での質問（画面操作のガイド） | 30分 |
| `agent/` | Agent Bricks のプロジェクト（1-2 でデプロイする） | — |
| `apps/rag-handson-switcher/` | （任意）2つのエージェントを切り替えるチャットアプリ（AppKit） | 20分 |

## 前提条件

- Unity Catalog が有効なワークスペース。AWS の Tokyo など、content search をリージョン内で処理できるリージョン（[対応リージョン](https://docs.databricks.com/aws/ja/genie-agents/volumes)）
- ワークスペース管理者が **プレビュー** で「Analyze Files in Volumes with Genie Agents」を有効にしている（Managed パターン）
- 参加者に **Workspace access** と **Databricks SQL access** の entitlement がある
- サーバーレスのノートブック（環境バージョン 4 で動作確認）、サーバーレスの SQL ウェアハウス
- Foundation Model API の `databricks-qwen3-embedding-0-6b`（埋め込み）と、Claude などの LLM
- カタログの `USE CATALOG` と `CREATE SCHEMA`、AI Search エンドポイントと Databricks Apps を作る権限

## ノートブックのインポート（Git フォルダー）

1. 左サイドバーの「ワークスペース」で、取り込み先のフォルダー（例：自分のホーム）を開く
2. 右上の「作成」→「Git フォルダー」をクリックする
3. 「Git リポジトリの URL」に `https://github.com/skato-db/databricks-rag-handson.git` を入力し、Git プロバイダー（GitHub）とフォルダー名を確かめて「Git フォルダーを作成」をクリックする

> このリポジトリは private である。取り込むには、リポジトリへのアクセス権と、ワークスペースの Git 資格情報（「設定」→「リンクされたアカウント」で GitHub を連携）が必要である。

取り込んだフォルダーの中で、ノートブックを番号の順に開く。各ノートブックの上部の widget でカタログ名などを自分の環境に合わせ、上のセルから順に実行する。

## 実行順

1. `00_データ準備` — widget の `CATALOG_NAME` を自分のカタログにする
2. `1-1_Scratch_...` — 同じカタログ・スキーマを指定する
3. `1-2_Scratch_...` — `AGENT_NAME` は参加者ごとに重ならない名前にする。デプロイは Web Terminal で行う
4. `2_Managed_...` — 画面の操作でGenie Agent を作る
5. （任意）`apps/rag-handson-switcher` — 1-2 と 2 で作ったエージェントを切り替えて比べる

## 切り替えチャットアプリ（任意）

`apps/rag-handson-switcher` は AppKit（TypeScript/React）のアプリである。どちらのタブも、**質問したユーザー本人の権限**（user authorization）で呼ぶ。

- **Scratch**：1-1 の AI Search 索引をハイブリッド検索し、1-2 のエージェントと同じシステムプロンプト・同じ LLM で回答を作る（スコープ `vector-search`、`model-serving`）。アプリから別のアプリ（1-2 の Agent Runtime）を呼ぶと利用者のトークンが引き継がれないため、エージェントのアプリは呼ばない
- **Managed**：Genie Agent の Agent mode API を呼ぶ（スコープ `genie`）

ローカル PC でデプロイする（Node.js v22 以上、Databricks CLI が必要）。

```bash
cd apps/rag-handson-switcher
npm install
databricks bundle deploy -p <プロファイル> \
  --var ai_search_index=<カタログ>.rag_handson.docs_chunks_index \
  --var genie_agent_id=<Genie Agent の ID>
databricks bundle run app -p <プロファイル>
```

Genie Agent の ID は、Genie Agent の URL の `/genie/rooms/` の後ろの値である。初めて開くと、アプリが利用者に代わって Vector Search・Genie・Model Serving を使うことへの同意画面が出る。

## 後片付け

作ったものを、作った順と逆に消す。

| 対象 | 消し方 |
|---|---|
| 切り替えアプリ | `databricks bundle destroy -p <プロファイル>`（`apps/rag-handson-switcher` で実行） |
| Scratch のエージェント | Web Terminal で `agentbricks deployments delete agent-bricks-<AGENT_NAME> --delete-source` |
| Genie Agent | Genie の一覧で該当の Genie Agent を削除する |
| AI Search の索引とエンドポイント | 索引はスキーマと一緒に消える。エンドポイントは「コンピュート」→「AI Search」で削除する（ほかの索引がないことを確かめる） |
| MLflow エクスペリメント | 「エクスペリメント」で `rag-handson-agent` を削除する |
| スキーマ（テーブル・ボリューム・索引） | 中身を確かめてから `DROP SCHEMA <カタログ>.rag_handson CASCADE` |

## サンプルデータ

サンプルの PDF は、VDA QMC が公開している「Automotive SPICE® PAM 4.0 日本語版」である。リポジトリには含めず、`00_データ準備` が公式の URL からダウンロードする。内容に疑義がある場合は、www.vda-qmc.de の英語版が正とされている。別の PDF を使うときは、`00_データ準備` の widget で URL とファイル名を変え、1-2 の評価データセットを書き換える。
