"""Biblioteca de documentos: guarda los archivos originales, el texto extraído
(en fragmentos) y mantiene el índice de búsqueda en memoria."""
from __future__ import annotations

import json
import os
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .extract import chunk_pages, extract_pages
from .search import SearchIndex, normalize


class Library:
    def __init__(self, data_dir):
        self.data_dir = Path(data_dir).resolve()
        self.files_dir = self.data_dir / "archivos"
        self.chunks_dir = self.data_dir / "fragmentos"
        self.catalog_path = self.data_dir / "catalogo.json"
        self.history_path = self.data_dir / "consultas.json"
        self.docs = {}
        self.chunks = {}  # doc_id -> [{"page", "text"}]
        self.index = SearchIndex()
        self._lock = threading.Lock()

    def init(self):
        self.files_dir.mkdir(parents=True, exist_ok=True)
        self.chunks_dir.mkdir(parents=True, exist_ok=True)
        for doc in _read_json(self.catalog_path, []):
            chunks = _read_json(self.chunks_dir / f"{doc['id']}.json", [])
            self.docs[doc["id"]] = doc
            self.chunks[doc["id"]] = chunks
            for i, c in enumerate(chunks):
                self.index.add(doc["id"], i, c["text"])

    def list(self) -> list[dict]:
        return sorted(self.docs.values(), key=lambda d: d["uploadedAt"], reverse=True)

    def get(self, doc_id):
        return self.docs.get(doc_id)

    def file_path(self, doc) -> Path:
        return self.files_dir / doc["storedName"]

    def add(self, data: bytes, original_name: str, mime: str, meta: dict) -> dict:
        pages = extract_pages(data, original_name)
        chunks = chunk_pages(pages)
        char_count = sum(len(c["text"]) for c in chunks)

        doc_id = str(uuid.uuid4())
        ext = Path(original_name).suffix.lower()
        field = lambda k: str(meta.get(k) or "").strip()  # noqa: E731
        doc = {
            "id": doc_id,
            "titulo": field("titulo") or Path(original_name).stem,
            "nombreArchivo": original_name,
            "storedName": f"{doc_id}{ext}",
            "mime": mime or "",
            "tamano": len(data),
            "paginas": sum(1 for p in pages if p["page"] is not None) or None,
            "fragmentos": len(chunks),
            "caracteres": char_count,
            "marca": field("marca"),
            "modelo": field("modelo"),
            "anios": field("anios"),
            "categoria": field("categoria"),
            "notas": field("notas"),
            "uploadedAt": datetime.now(timezone.utc).isoformat(),
            "aviso": "No se pudo extraer texto (¿PDF escaneado sin OCR?)." if char_count < 50 else "",
        }

        with self._lock:
            self.file_path(doc).write_bytes(data)
            _write_json(self.chunks_dir / f"{doc_id}.json", chunks)
            self.docs[doc_id] = doc
            self.chunks[doc_id] = chunks
            for i, c in enumerate(chunks):
                self.index.add(doc_id, i, c["text"])
            self._save_catalog()
        return doc

    def update(self, doc_id, meta: dict):
        with self._lock:
            doc = self.docs.get(doc_id)
            if not doc:
                return None
            for key in ("titulo", "marca", "modelo", "anios", "categoria", "notas"):
                if isinstance(meta.get(key), str):
                    doc[key] = meta[key].strip()
            self._save_catalog()
            return doc

    def remove(self, doc_id) -> bool:
        with self._lock:
            doc = self.docs.pop(doc_id, None)
            if not doc:
                return False
            self.index.remove_doc(doc_id)
            self.chunks.pop(doc_id, None)
            self.file_path(doc).unlink(missing_ok=True)
            (self.chunks_dir / f"{doc_id}.json").unlink(missing_ok=True)
            self._save_catalog()
            return True

    def search(self, text="", codes=(), vehiculo=None, limit=8) -> list[dict]:
        """Busca los fragmentos más relevantes. Los documentos etiquetados con la misma
        marca/modelo/año reciben prioridad; los de otra marca se penalizan."""
        vehiculo = vehiculo or {}
        marca = normalize(vehiculo.get("marca"))
        modelo = normalize(vehiculo.get("modelo"))
        anio = int(vehiculo["anio"]) if str(vehiculo.get("anio") or "").isdigit() else None

        def doc_boost(doc_id):
            d = self.docs.get(doc_id)
            if not d:
                return 1.0
            boost = 1.0
            if d["marca"] and marca:
                dm = normalize(d["marca"])
                boost *= 1.6 if (marca in dm or dm in marca) else 0.5
            if d["modelo"] and modelo:
                dm = normalize(d["modelo"])
                boost *= 1.5 if (modelo in dm or dm in modelo) else 0.8
            if d["anios"] and anio:
                boost *= 1.3 if year_in_range(anio, d["anios"]) else 0.85
            return boost

        vehicle_terms = [v for v in (vehiculo.get("marca"), vehiculo.get("modelo"), vehiculo.get("motor")) if v]
        out = []
        for r in self.index.search(text, codes, vehicle_terms, doc_boost, limit):
            doc = self.docs[r["doc_id"]]
            chunk = self.chunks[r["doc_id"]][r["chunk_index"]]
            out.append(
                {
                    "docId": r["doc_id"],
                    "titulo": doc["titulo"],
                    "nombreArchivo": doc["nombreArchivo"],
                    "pagina": chunk["page"],
                    "texto": chunk["text"],
                    "score": round(r["score"], 3),
                }
            )
        return out

    def _save_catalog(self):
        _write_json(self.catalog_path, self.list())

    # ---- Historial de consultas ----
    def add_history(self, entry: dict):
        with self._lock:
            history = _read_json(self.history_path, [])
            history.insert(0, entry)
            _write_json(self.history_path, history[:500])

    def history(self, limit=100) -> list[dict]:
        return _read_json(self.history_path, [])[:limit]


def year_in_range(year: int, spec: str) -> bool:
    """Acepta "2015", "2012-2016", "2010, 2012, 2014-2016"."""
    for part in re.split(r"[,;]", str(spec)):
        part = part.strip()
        if not part:
            continue
        m = re.fullmatch(r"(\d{4})\s*(?:-|a|al|to)\s*(\d{4})", part, re.I)
        if m and int(m[1]) <= year <= int(m[2]):
            return True
        if part.isdigit() and int(part) == year:
            return True
    return False


def _read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return fallback


def _write_json(path: Path, data):
    tmp = path.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)
