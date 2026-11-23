"""Reference vectors from the Python model2vec package, for eval/local-refcheck.mjs.

    python ref-embed.py <models dir> <texts.json> <out.json> [model ...]

Writes {model: [[float, ...], ...], _ids: token ids from the first model} with model2vec's own normalised mean.
Needs `pip install model2vec` (a throwaway venv is enough).
"""
import json
import sys

from model2vec import StaticModel


def main() -> None:
    models_dir, texts_path, out_path, *names = sys.argv[1:]
    names = names or ["potion-base-8M", "potion-base-4M", "potion-base-2M"]
    with open(texts_path, encoding="utf-8") as handle:
        texts = json.load(handle)
    out = {}
    for index, name in enumerate(names):
        model = StaticModel.from_pretrained(f"{models_dir}/{name}")
        out[name] = model.encode(texts, normalize=True).astype(float).tolist()
        if index == 0:
            out["_ids"] = model.tokenize(texts)
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(out, handle)


if __name__ == "__main__":
    main()
