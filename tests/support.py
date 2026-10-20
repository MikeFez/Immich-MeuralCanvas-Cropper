"""Isolated app fixture: synthetic images and no live Immich connections."""
import importlib
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
ASSET = '11111111-1111-4111-8111-111111111111'
PORTRAIT = {'x': 50, 'y': 0, 'width': 45, 'height': 80}
LANDSCAPE = {'x': 0, 'y': 0, 'width': 160, 'height': 90}


def load_isolated_app():
    temporary = tempfile.TemporaryDirectory(prefix='meural-regression-')
    directory = Path(temporary.name)
    (directory / 'config').mkdir()
    (directory / 'config/config.yaml').write_text('''dimensions:
  portrait_size: [90, 160]
  landscape_size: [160, 90]
immich:
  url: http://127.0.0.1:1
  api_key: test-only
  input_album_id: source-album
  output_album_id: output-album
meural:
  devices: []
''')
    sys.path.insert(0, str(ROOT / 'app'))
    with patch.dict(os.environ, {'CONFIG_DIR': str(directory / 'config'),
                                 'CACHE_DIR': str(directory / 'cache')}):
        # Importing the app must not make synchronous network requests. Its
        # background cache warmup is disabled for this isolated test fixture.
        with patch('threading.Thread.start'), patch('requests.Session.get') as get, patch('requests.Session.request') as request:
            application = importlib.import_module('app')
            get.assert_not_called()
            request.assert_not_called()
    return temporary, application


def seed_image(application, asset=ASSET):
    from PIL import Image, ImageDraw
    input_dir = Path(application.config.INPUT_FOLDER)
    input_dir.mkdir(parents=True, exist_ok=True)
    path = input_dir / f'{asset}.jpg'
    image = Image.new('RGB', (160, 90), 'navy')
    ImageDraw.Draw(image).rectangle((0, 0, 79, 89), fill='orange')
    image.save(path)
    metadata_dir = input_dir / '.metadata'
    metadata_dir.mkdir(exist_ok=True)
    (metadata_dir / f'{asset}.json').write_text(json.dumps({
        'asset_id': asset, 'file_path': str(path), 'original_filename': 'synthetic.jpg'
    }))
