"""Serve synthetic data for browser regressions; never contacts a live server."""
from unittest.mock import Mock
from pathlib import Path
from PIL import Image
from support import ASSET, load_isolated_app, seed_image

if __name__ == '__main__':
    temporary, application = load_isolated_app()
    seed_image(application)
    seed_image(application, '22222222-2222-4222-8222-222222222222')
    # Odd dimensions exercise preview rounding and mapping to original pixels.
    Image.new('RGB', (4097, 3073), 'navy').save(
        Path(application.config.INPUT_FOLDER, '22222222-2222-4222-8222-222222222222.jpg'))
    application.immich_handler.upload_asset = Mock(return_value='test-uploaded')
    application.immich_handler.remove_from_input_album = Mock(return_value={'success': True})
    application.immich_handler.sync_input_images = Mock(return_value=[])
    application.immich_handler.get_album_assets = Mock(return_value=[])
    application.app.run(host='127.0.0.1', port=5087, threaded=True, use_reloader=False)
