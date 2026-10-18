"""Download the pinned FastEmbed model, validating its official ONNX checksum.

The ModelScope mirror is an explicit fallback for networks that cannot reach HF.
No model code is downloaded or executed. TLS verification remains enabled.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import time

import httpx

MODEL = 'BAAI/bge-small-en-v1.5'
REPOSITORY = 'Qdrant/bge-small-en-v1.5-onnx-Q'
REVISION = '1f3d275a6ce3ce89dcdd43f3332af99a65d34fd6'
MODEL_SHA256 = '51f1bd0addd6e859e42c2c8021a5e5461385bb676a649f4b269aa445449f2431'
CHECKSUM_SOURCE = f'https://huggingface.co/{REPOSITORY}/blob/{REVISION}/model_optimized.onnx'
FILES = ('model_optimized.onnx', 'config.json', 'tokenizer.json',
         'tokenizer_config.json', 'special_tokens_map.json', 'vocab.txt', 'ort_config.json')


def download(destination: Path, source: str):
    destination.mkdir(parents=True, exist_ok=True)
    base = (f'https://huggingface.co/{REPOSITORY}/resolve/{REVISION}'
            if source == 'huggingface' else
            f'https://modelscope.cn/models/{REPOSITORY}/resolve/master')
    records = {}
    with httpx.Client(timeout=httpx.Timeout(120, connect=20), follow_redirects=True) as client:
        for name in FILES:
            target = destination / name
            staging = target.with_suffix(target.suffix + '.download')
            digest = hashlib.sha256()
            size = 0
            with client.stream('GET', base + '/' + name) as response:
                response.raise_for_status()
                with staging.open('wb') as output:
                    for chunk in response.iter_bytes():
                        size += len(chunk)
                        if size > 70_000_000:
                            raise ValueError(f'Unexpectedly large model artifact: {name}')
                        digest.update(chunk)
                        output.write(chunk)
            checksum = digest.hexdigest()
            if name == 'model_optimized.onnx' and checksum != MODEL_SHA256:
                staging.unlink(missing_ok=True)
                raise ValueError('Model checksum differs from the official Qdrant artifact.')
            if name.endswith('.json'):
                json.loads(staging.read_text(encoding='utf-8'))
            staging.replace(target)
            records[name] = {'sha256': checksum, 'bytes': size}
            print(f'{name}: {size:,} bytes verified' if name.endswith('.onnx') else
                  f'{name}: {size:,} bytes downloaded', flush=True)
    config = json.loads((destination / 'config.json').read_text())
    if config.get('hidden_size') != 384 or config.get('model_type') != 'bert':
        raise ValueError('Unexpected embedding model configuration.')
    manifest = dict(model=MODEL, repository=REPOSITORY, source=source,
                    official_checksum_source=CHECKSUM_SOURCE,
                    onnx_checksum_verified=True, downloaded_at=time.time(), files=records)
    (destination / 'relay-model-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print('Set EMBEDDING_LOCAL_PATH=' + str(destination.resolve()))
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', choices=('huggingface', 'modelscope'), default='huggingface')
    parser.add_argument('--destination', type=Path, default=Path('data/embedding-models/bge-small-en-v1.5'))
    args = parser.parse_args()
    download(args.destination, args.source)
