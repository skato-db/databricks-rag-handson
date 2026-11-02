"""ハンズオン用の文書検索ツール。1-1 で作った AI Search の索引をハイブリッド検索する。

ノートブック（1-2）では AI Bridge の VectorSearchRetrieverTool を使うが、Agent Runtime では
アプリのサービスプリンシパルの資格情報が Databricks SDK 経由で渡される。そのため、ここでは SDK の
vector_search_indexes.query_index で同じ索引を同じ列・同じ方式（HYBRID）で検索する。

索引名は app.yaml の env（AI_SEARCH_INDEX）で渡す。デプロイ後、アプリのサービスプリンシパルに
索引の SELECT と、カタログ・スキーマの USE 権限が必要（1-2 のノートブックで付ける）。
"""

import os

import mlflow
from langchain_core.tools import tool
from mlflow.entities import Document, SpanType

from databricks_agentkit import workspace_client

INDEX_NAME = os.environ.get("AI_SEARCH_INDEX", "")
COLUMNS = ["chunk_id", "file_name", "pages", "chunk_to_retrieve"]
NUM_RESULTS = 5


@mlflow.trace(span_type=SpanType.RETRIEVER)
def _retrieve(query: str) -> list[Document]:
    res = workspace_client().vector_search_indexes.query_index(
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
    docs = _retrieve(query)
    if not docs:
        return "関連する箇所は見つからなかった。"
    return "\n\n".join(
        f"[{d.metadata['file_name']} p.{d.metadata['pages']}]\n{d.page_content}" for d in docs
    )
