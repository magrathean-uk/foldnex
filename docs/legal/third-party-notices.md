# Third-party notices

Material bundled in Foldnex that carries its own licence, separate from the MIT licence
covering the rest of the source.

## Material Symbols Rounded font

The packaged runtime archive includes `icons/material-symbols-rounded.ttf`. Its accompanying licence is the unmodified Apache License 2.0 text in [icons/material-symbols-LICENSE.txt](../../icons/material-symbols-LICENSE.txt).

Retain that licence with the font in source and distributed extension archives.

## potion-base-4M static embedding model

The packaged runtime archive includes `models/potion-base-4M.int8.bin`, a word-embedding table that lets the local grouping engine compare tab titles offline. It is derived from [minishlab/potion-base-4M](https://huggingface.co/minishlab/potion-base-4M) (revision `9b3cff412d30be9ae8603fe10224c224f3401869`), a Model2Vec static embedding model distilled from BAAI's bge-base-en-v1.5 by the MinishLab project. The model card declares the MIT licence.

The model repository has no licence file, so the MIT licence text of the Model2Vec project that the card names is packaged beside the table as [models/potion-base-4M-LICENSE.txt](../../models/potion-base-4M-LICENSE.txt), with its source recorded at the top of that file.

The int8 file is not the original: `scripts/build-embedding-table.mjs` converts the float32 vectors to int8 with one scale per row and stores the tokenizer's vocabulary and settings beside them. `models/potion-base-4M.json` records the source, the SHA-256 of each input and of the output, and the build command. The table runs entirely on the device; nothing is sent anywhere.

Retain the licence file with the table in source and distributed extension archives.
