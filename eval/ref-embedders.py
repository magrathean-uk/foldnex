#!/usr/bin/env python3
"""Generate local reference vectors; see eval/local-embedders.mjs.

Install fastembed (for onnxruntime, tokenizers and huggingface_hub) into a venv.
Usage: python eval/ref-embedders.py /absolute/path/to/vectors.json /absolute/path/to/model-cache
Downloaded model files stay in the model cache directory, outside the repo.
"""
import json
import os
import pathlib
import subprocess
import sys
import time
import traceback

ROOT = pathlib.Path(__file__).resolve().parent.parent
USAGE = 'Usage: python eval/ref-embedders.py /absolute/path/to/vectors.json /absolute/path/to/model-cache'
if len(sys.argv) != 3 or not all(pathlib.Path(arg).is_absolute() for arg in sys.argv[1:]):
    raise SystemExit(USAGE)
MODEL_DIR = pathlib.Path(sys.argv[2])
os.environ['HF_HOME'] = str(MODEL_DIR / 'hf')
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'

import numpy as np
import onnxruntime as ort
from huggingface_hub import hf_hub_download
from tokenizers import Tokenizer

# These are the smallest candidate ONNX exports which are run here, including
# the quantised weights; tokenizer and runtime overhead are recorded separately.
MODELS = [
    ('sentence-transformers/all-MiniLM-L6-v2', 'Xenova/all-MiniLM-L6-v2', 'onnx/model_uint8.onnx', 22713216, 384, 'mean', ''),
    ('BAAI/bge-small-en-v1.5', 'Xenova/bge-small-en-v1.5', 'onnx/model_int8.onnx', 33360000, 384, 'cls', ''),
    ('intfloat/multilingual-e5-small', 'Xenova/multilingual-e5-small', 'onnx/model_int8.onnx', 117653760, 384, 'mean', 'query: '),
    ('google/embeddinggemma-300m', 'onnx-community/embeddinggemma-300m-ONNX', 'onnx/model_q4f16.onnx', 308000000, 768, 'builtin', 'task: clustering | query: '),
]


def main():
    js = """import {loadWindows,urlWords} from './eval/lib.mjs';
const windows=await loadWindows();
console.log(JSON.stringify(Object.fromEntries(Object.entries(windows).map(([n,t])=>[n,t.map(x=>x.title+' '+urlWords(x.url))]))));"""
    windows = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', js], cwd=ROOT))
    texts = [text for group in windows.values() for text in group]
    selected_models = set(filter(None, os.environ.get('FOLDNEX_ONLY_MODELS', '').split(',')))
    output_path = pathlib.Path(sys.argv[1])
    out = json.loads(output_path.read_text()) if selected_models and output_path.exists() else {'models': {}, 'skipped': {}}
    for name, repo, filename, params, dim, pooling, prefix in MODELS:
        if selected_models and name not in selected_models:
            continue
        if os.environ.get('FOLDNEX_SKIP_GEMMA') and pooling == 'builtin':
            continue
        try:
            result = None
            for attempt in range(2):
                try:
                    # The second attempt uses an independently exported quantisation.
                    selected = filename if attempt == 0 else 'onnx/model_quantized.onnx'
                    files = ['tokenizer.json', selected]
                    if pooling == 'builtin':
                        files.append(selected + '_data')
                    paths = {f: hf_hub_download(repo, f, cache_dir=str(MODEL_DIR / 'hf' / 'hub')) for f in files}
                    tokenizer = Tokenizer.from_file(paths['tokenizer.json'])
                    tokenizer.enable_truncation(max_length=512 if pooling != 'builtin' else 2048)
                    options = ort.SessionOptions()
                    options.intra_op_num_threads = 1
                    options.inter_op_num_threads = 1
                    session = ort.InferenceSession(paths[selected], sess_options=options, providers=['CPUExecutionProvider'])
                    inputs = {x.name for x in session.get_inputs()}
                    pad = tokenizer.token_to_id('[PAD]')
                    if pad is None: pad = tokenizer.token_to_id('<pad>')
                    tokenizer.enable_padding(pad_id=pad if pad is not None else 0)

                    def encode(batch):
                        encoded = tokenizer.encode_batch([prefix + text for text in batch])
                        ids = np.array([x.ids for x in encoded], dtype=np.int64)
                        mask = np.array([x.attention_mask for x in encoded], dtype=np.int64)
                        feed = {'input_ids': ids, 'attention_mask': mask, 'token_type_ids': np.zeros_like(ids)}
                        values = session.run(None, {k: v for k, v in feed.items() if k in inputs})
                        if pooling == 'builtin':
                            vector = values[1]
                        elif pooling == 'cls':
                            vector = values[0][:, 0, :]
                        else:
                            vector = (values[0] * mask[:, :, None]).sum(axis=1) / np.maximum(mask.sum(axis=1)[:, None], 1)
                        vector = vector / np.maximum(np.linalg.norm(vector, axis=1, keepdims=True), 1e-12)
                        if vector.shape != (len(batch), dim) or not np.isfinite(vector).all():
                            raise ValueError(f'unexpected vectors {vector.shape}')
                        return vector

                    encode(texts[:4])
                    start = time.process_time()
                    vectors = np.concatenate([encode(texts[i:i+16]) for i in range(0, len(texts), 16)])
                    elapsed = time.process_time() - start
                    parts = {}
                    offset = 0
                    for window, group in windows.items():
                        parts[window] = vectors[offset:offset+len(group)].round(8).tolist()
                        offset += len(group)
                    weight_bytes = sum(os.path.getsize(paths[f]) for f in files if f.startswith('onnx/'))
                    # The q4f16 Gemma export was CPU smoke-tested; if a fallback
                    # is needed the independently verified smaller size remains.
                    smallest = 176115397 if name == 'google/embeddinggemma-300m' else weight_bytes
                    metadata = {'parameters': params, 'dimension': dim, 'quantised_bytes': smallest,
                                'evaluated_weight_bytes': weight_bytes,
                                'smallest_export': (repo + '/onnx/model_q4f16.onnx' if smallest != weight_bytes else repo + '/' + selected),
                                'tokenizer_bytes': os.path.getsize(paths['tokenizer.json']),
                                'cpu_seconds_per_100': elapsed * 100 / len(texts),
                                'runtime': 'ONNX Runtime CPU, one thread, batches of 16; warm model',
                                'export': repo + '/' + selected, 'prefix': prefix}
                    result = {'windows': parts, 'metadata': metadata}
                    break
                except Exception as exc:
                    print(f'{name}: attempt {attempt+1} failed: {type(exc).__name__}: {exc}', file=sys.stderr, flush=True)
                    last = f'{type(exc).__name__}: {exc}'
            if result is None:
                out['models'].pop(name, None)
                out['skipped'][name] = last
            else:
                out['skipped'].pop(name, None)
                out['models'][name] = result
                print(f'{name}: {metadata}', flush=True)
            # Preserve completed models if a later download or inference fails.
            pathlib.Path(sys.argv[1]).write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')) + '\n')
        except Exception as exc:
            out['skipped'][name] = f'{type(exc).__name__}: {exc}'
            traceback.print_exc()
    pathlib.Path(sys.argv[1]).write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')) + '\n')
    if not out['models']:
        raise SystemExit('No models succeeded')


if __name__ == '__main__':
    main()
