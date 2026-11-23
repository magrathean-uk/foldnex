# Local embedding comparison

| Pipeline (encoder) | Parameters | Quantised weights | Dimension | CPU time / 100 texts | F1, 12 windows | F1, 10 other windows | F1, mixed-language (a-household, b-expat) | Upkeep 20% | Upkeep 30% |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| potion-base-4M | 3.8M | 3.9 MB | 128 | 2.3 ms | 0.421 | 0.452 | 0.265 | 0.888 | 0.826 |
| potion-base-8M | 7.6M | 7.7 MB | 256 | 2.2 ms | 0.396 | 0.422 | 0.266 | 0.898 | 0.839 |
| sentence-transformers/all-MiniLM-L6-v2 | 22.7M | 22.8 MB | 384 | 395.6 ms | 0.465 | 0.503 | 0.272 | 0.907 | 0.862 |
| BAAI/bge-small-en-v1.5 | 33.4M | 33.8 MB | 384 | 754.6 ms | 0.428 | 0.457 | 0.280 | 0.913 | 0.863 |
| intfloat/multilingual-e5-small | 117.7M | 118.1 MB | 384 | 850.8 ms | 0.408 | 0.436 | 0.269 | 0.921 | 0.873 |
| google/embeddinggemma-300m | 308.0M | 176.1 MB | 768 | 4877.5 ms | 0.521 | 0.545 | 0.402 | 0.932 | 0.900 |

Best transformers against the better potion table: google/embeddinggemma-300m +0.100 F1; sentence-transformers/all-MiniLM-L6-v2 +0.044 F1. The table shows their weight and inference costs.

This compares pipelines, not encoders alone: the encoder, the text it is given and the idf and centring options all differ between rows (see the last paragraph). A claim about an encoder alone needs matched inputs and search grids.

In-sample cluster F1: potion-base-4M 0.421; potion-base-8M 0.417; sentence-transformers/all-MiniLM-L6-v2 0.465; BAAI/bge-small-en-v1.5 0.439; intfloat/multilingual-e5-small 0.408; google/embeddinggemma-300m 0.521.
All F1 values are leave-one-window-out means over tabs with a gold task. The language split is two mixed-language windows (a-household and b-expat) against the 10 others; both are subsets of the same held-out selections. In-sample bests and per-window choices are in JSON.
Upkeep uses gold groups (optimistic), four hide shares and 20 seeds; settings are selected jointly over all shares.
Check: both potion rows reproduce the held-out clusters-as-groups headline of the current local.json on all 12 windows (4M 0.4209 against 0.4209, 8M 0.3960 against 0.3960).
Sizes exclude tokenizers and runtimes: add about 0.7 MB for potion, 0.71 MB for MiniLM/BGE, 17.08 MB for E5 and 20.32 MB for Gemma.
Transformers concatenate title and URL words once; E5 uses `query:` and Gemma uses `task: clustering | query:`. Potion weights URL tokens by 0.5 and its search includes idf and centring; the transformer search includes centring only. Timings exclude loading and compare Node with ONNX.
