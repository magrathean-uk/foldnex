# Similarity channel ablation (model-free grouping)

All F1 values are leave-one-window-out means (setting chosen on the other windows, scored on the window left out); in-sample best beside it. English = ten mostly English windows, non-English = a-household and b-expat.

## Clusters as groups

| Channel | All 12 | English (10) | Non-English (2) | In-sample best | In-sample setting |
| --- | ---: | ---: | ---: | ---: | --- |
| lexical-title | 0.355 | 0.379 | 0.233 | 0.360 | title-t0.02 |
| lexical-title-url | 0.334 | 0.353 | 0.242 | 0.334 | title-url-t0.01 |
| dense-4M | 0.356 | 0.375 | 0.261 | 0.373 | raw-wl0-t0.25 |
| dense-8M | 0.385 | 0.410 | 0.260 | 0.385 | raw-wl0-t0.2 |
| blend-4M | 0.421 | 0.452 | 0.265 | 0.421 | idf-wl1-t0.2 |
| blend-8M | 0.396 | 0.422 | 0.266 | 0.417 | raw-wl1-t0.2 |

### Held-out F1 per window

| Window | lexical-title-url | dense-4M | blend-4M |
| --- | ---: | ---: | ---: |
| a-designer | 0.457 | 0.330 | 0.513 |
| a-hoarder | 0.211 | 0.209 | 0.345 |
| a-household | 0.244 | 0.247 | 0.265 |
| a-oncall | 0.347 | 0.312 | 0.320 |
| a-student | 0.262 | 0.267 | 0.470 |
| b-academic | 0.406 | 0.352 | 0.376 |
| b-expat | 0.239 | 0.275 | 0.265 |
| b-messy | 0.455 | 0.606 | 0.622 |
| b-move | 0.321 | 0.365 | 0.424 |
| b-shop | 0.253 | 0.316 | 0.377 |
| dev | 0.386 | 0.465 | 0.443 |
| life | 0.428 | 0.528 | 0.630 |

## Plan upkeep (held-out F1 at share of tabs hidden; mean over 12 windows)

| Channel | 10% | 20% | 30% | 50% | 20% English | 20% non-English | In-sample 20% | In-sample setting |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| lexical-title | 0.939 | 0.873 | 0.803 | 0.644 | 0.882 | 0.826 | 0.876 | title|mean|0.02 |
| lexical-title-url | 0.936 | 0.864 | 0.801 | 0.646 | 0.878 | 0.795 | 0.864 | title-url|mean|0.02 |
| dense-4M | 0.940 | 0.873 | 0.803 | 0.658 | 0.891 | 0.783 | 0.873 | raw-ctr-wl0|centroid|0.15 |
| dense-8M | 0.946 | 0.880 | 0.817 | 0.673 | 0.903 | 0.766 | 0.880 | idf-ctr-wl0|centroid|0.1 |
| blend-4M | 0.947 | 0.888 | 0.826 | 0.682 | 0.906 | 0.795 | 0.890 | idf-ctr-wl1|mean|0.1 |
| blend-8M | 0.951 | 0.898 | 0.839 | 0.704 | 0.921 | 0.784 | 0.898 | idf-ctr-wl1|mean|0.05 |

### Held-out upkeep F1 per window (20% new tabs)

| Window | lexical-title-url | dense-4M | blend-4M |
| --- | ---: | ---: | ---: |
| a-designer | 0.923 | 0.932 | 0.935 |
| a-hoarder | 0.877 | 0.889 | 0.891 |
| a-household | 0.777 | 0.819 | 0.809 |
| a-oncall | 0.866 | 0.887 | 0.911 |
| a-student | 0.864 | 0.888 | 0.915 |
| b-academic | 0.872 | 0.904 | 0.926 |
| b-expat | 0.812 | 0.747 | 0.780 |
| b-messy | 0.928 | 0.927 | 0.943 |
| b-move | 0.877 | 0.856 | 0.897 |
| b-shop | 0.822 | 0.814 | 0.833 |
| dev | 0.893 | 0.916 | 0.905 |
| life | 0.856 | 0.902 | 0.907 |

## Timing (warm, median of 20, similarity plus clustering, ms)

| Channel | 60 tabs | 200 tabs | 500 tabs |
| --- | ---: | ---: | ---: |
| lexical-title | 0.6 | 4.2 | 26.2 |
| lexical-title-url | 1.8 | 6.5 | 32.6 |
| dense-4M | 4.1 | 20.9 | 38.9 |
| dense-8M | 2.1 | 16.2 | 54.6 |
| blend-4M | 2.3 | 14.4 | 50.2 |
| blend-8M | 3.3 | 18.7 | 67.6 |

## Control and grids

- blend-4M against local.json: cluster 0.421 vs 0.421; upkeep 0.947/0.947, 0.888/0.888, 0.826/0.826, 0.682/0.682; max difference 0.0000.
- blend-8M against local.json: cluster 0.396 vs 0.396; upkeep 0.951/0.951, 0.898/0.898, 0.839/0.839, 0.704/0.704; max difference 0.0000.
- tau grid: blend and dense as run-local (0.15 to 0.6); lexical widened down to 0.005. Theta grid: lexical widened down to 0.005.
- Lexical upkeep uses mean and max representations only (the dense centroid has no lexical form).

## What the embedding table adds

- Clusters: blend-4M 0.421 against lexical-title 0.355 (+0.066; English +0.073, non-English +0.033); dense-4M alone 0.356 is no better than lexical alone, the gain comes from combining them.
- Clusters, by window (blend-4M minus lexical-title): largest dev +0.200, b-shop +0.158, a-student +0.130, life +0.121; none or negative b-expat +0.004, a-oncall -0.006, b-move -0.056.
- Upkeep at 20% new: blend-4M 0.888 against lexical-title 0.873 (+0.015); at 50% +0.038. Lexical-title-url does not beat title alone in either task.
- Upkeep by window: largest dev +0.067, b-academic +0.053, a-hoarder +0.035; lexical ahead on b-expat -0.069, b-move -0.017, b-messy -0.011. On the two non-English windows lexical-title is ahead at 20% (0.826 against 0.795).
- The 8M table is not better than 4M once blended (0.421 against 0.396 for clusters, though it leads in upkeep); the 4 MB table's value is in clusters on English windows, much less in upkeep.
