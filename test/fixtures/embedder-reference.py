"""Reference vectors for test/embedder.test.js, following model2vec's StaticModel.encode.

    python embedder-reference.py <model dir> <texts.json> <out.json>

Tokens come from the Hugging Face `tokenizers` library reading tokenizer.json (no
special tokens added), unknown-token ids are dropped, the token rows of the float32
matrix are averaged and the mean is scaled to unit length. Needs only `tokenizers`
and `numpy`; the `model2vec` package itself is the same few lines around them.
Writes {"ids": [[...]], "vectors": [[...]]}.
"""
import json
import struct
import sys

import numpy as np
from tokenizers import Tokenizer


def main() -> None:
    model_dir, texts_path, out_path = sys.argv[1:4]
    with open(f"{model_dir}/model.safetensors", "rb") as handle:
        raw = handle.read()
    header_length = struct.unpack("<Q", raw[:8])[0]
    header = json.loads(raw[8 : 8 + header_length])
    start, end = header["embeddings"]["data_offsets"]
    rows, dim = header["embeddings"]["shape"]
    matrix = np.frombuffer(raw, dtype="<f4", count=rows * dim, offset=8 + header_length + start).reshape(rows, dim)
    tokenizer = Tokenizer.from_file(f"{model_dir}/tokenizer.json")
    unk = tokenizer.token_to_id("[UNK]")
    with open(texts_path, encoding="utf-8") as handle:
        texts = json.load(handle)
    ids, vectors = [], []
    for text in texts:
        row = [i for i in tokenizer.encode(text, add_special_tokens=False).ids[:512] if i != unk]
        ids.append(row)
        mean = matrix[row].mean(axis=0) if row else np.zeros(dim, dtype=np.float32)
        norm = np.linalg.norm(mean)
        vectors.append((mean / (norm if norm > 0 else 1.0)).astype(float).tolist())
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump({"ids": ids, "vectors": vectors}, handle)


if __name__ == "__main__":
    main()
