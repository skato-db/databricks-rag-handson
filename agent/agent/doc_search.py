"""ハンズオン用の文書検索ツール。1-1 で作った AI Search の索引をハイブリッド検索する。

索引は質問したユーザー本人の権限で検索する（agent.toml の [auth.user]）。そのため、アプリの
サービスプリンシパルに索引の権限を付ける必要はなく、利用者ごとの Unity Catalog の権限がそのまま効く。
ローカルで動かすとき（agentbricks dev）は、アプリの資格情報（プロファイル）を使う。

索引名は app.yaml の env（AI_SEARCH_INDEX）で渡す。
"""

import os
from collections.abc import Callable

import mlflow
from databricks.sdk import WorkspaceClient
from langchain_core.tools import BaseTool, tool
from mlflow.entities import Document, SpanType

from databricks_agentkit import workspace_client

INDEX_NAME = os.environ.get("AI_SEARCH_INDEX", "")
COLUMNS = ["chunk_id", "file_name", "pages", "chunk_to_retrieve"]
NUM_RESULTS = 5


def doc_search_tool(workspace_client_for: Callable[[str], WorkspaceClient] | None = None) -> BaseTool:
    """リクエストごとに、質問者の資格情報で索引を検索するツールを作る。"""
    client = workspace_client_for("user") if workspace_client_for else workspace_client()

    @mlflow.trace(span_type=SpanType.RETRIEVER)
    def retrieve(query: str) -> list[Document]:
        res = client.vector_search_indexes.query_index(
            index_name=INDEX_NAME,
            columns=COLUMNS,
            query_text=query,
            num_results=NUM_RESULTS,
            query_type="HYBRID",
        )
        names = [c.name for c in res.manifest.columns]
        docs = []
        for row in res.result.data_array or []:
            r = dict(zip(names, row))
            docs.append(
                Document(
                    page_content=r["chunk_to_retrieve"],
                    metadata={"doc_uri": r["file_name"], "chunk_id": r["chunk_id"], "file_name": r["file_name"], "pages": r["pages"]},
                    id=r["chunk_id"],
                )
            )
        return docs

    @tool
    def search_documents(query: str) -> str:
        """ボリュームに置いた文書（Automotive SPICE PAM 4.0 日本語版など）から、質問に関係する箇所を探す。
        結果にはファイル名（file_name）とページ番号（pages）が付く。"""
        docs = retrieve(query)
        if not docs:
            return "関連する箇所は見つからなかった。"
        return "\n\n".join(f"[{d.metadata['file_name']} p.{d.metadata['pages']}]\n{d.page_content}" for d in docs)

    return search_documents
