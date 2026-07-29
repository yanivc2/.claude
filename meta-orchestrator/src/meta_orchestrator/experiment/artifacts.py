"""Content-addressed artifact store (v2 §10).

Big blobs (snapshots, patches, logs, reports) live on disk under ``<root>/<sha256>``;
the DB keeps only the hash + metadata. Content addressing gives dedup and integrity for free.
"""
from __future__ import annotations

import hashlib
from pathlib import Path


class ArtifactStore:
    def __init__(self, root: str) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def put_text(self, text: str) -> str:
        return self.put_bytes(text.encode())

    def put_bytes(self, data: bytes) -> str:
        sha = hashlib.sha256(data).hexdigest()
        target = self.root / sha
        if not target.exists():
            target.write_bytes(data)  # idempotent by content
        return sha

    def get_text(self, sha: str) -> str:
        return (self.root / sha).read_text()

    def exists(self, sha: str) -> bool:
        return (self.root / sha).exists()
