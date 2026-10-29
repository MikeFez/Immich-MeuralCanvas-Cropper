"""Run with: python -m unittest discover -s tests -v"""
import json
import logging
import shutil
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import Mock, MagicMock, patch

from support import ASSET, PORTRAIT, LANDSCAPE, load_isolated_app, seed_image


class CropRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        logging.disable(logging.CRITICAL)
        cls.temporary, cls.application = load_isolated_app()
        from utils import file_handler
        cls.files = file_handler

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()
        logging.disable(logging.NOTSET)

    def setUp(self):
        self.app = self.application
        shutil.rmtree(self.app.config.INPUT_FOLDER, ignore_errors=True)
        for path in (self.app.config.LEGACY_PROGRESS_FILE, self.app.config.CROP_METADATA_FILE):
            Path(path).unlink(missing_ok=True)
        shutil.rmtree(Path(self.app.config.CACHE_DIR) / 'renders', ignore_errors=True)
        Path(self.app.config.CONFIG_DIR, 'jobs.json').unlink(missing_ok=True)
        self.app.jobs = self.app.JobRunner(str(Path(self.app.config.CONFIG_DIR, 'jobs.json')))
        self.app.config.init_directories()
        seed_image(self.app)
        self.client = self.app.app.test_client()
        self.outbound = patch('requests.Session.request', side_effect=AssertionError('Live HTTP is forbidden in tests'))
        self.outbound.start()
        self.addCleanup(self.outbound.stop)
        # Uploads prefetch the output album; default to an empty one.
        album = patch.object(self.app.immich_handler, 'get_album_assets', return_value=[])
        album.start()
        self.addCleanup(album.stop)

    def enable_logging(self):
        """Let this test see log records (the class silences them)."""
        logging.disable(logging.NOTSET)
        self.addCleanup(logging.disable, logging.CRITICAL)

    def save(self, both=True):
        self.assertTrue(self.files.save_crop(ASSET, 'portrait', PORTRAIT))
        if both:
            self.assertTrue(self.files.save_crop(ASSET, 'landscape', LANDSCAPE))

    def image(self):
        return self.client.get('/images').json[0]

    def saved(self, orientation, asset=ASSET):
        return self.files.saved_crop(self.files.read_all_crop_metadata().get(asset, {}), orientation)

    def crop(self, orientation='portrait', crop=None):
        return self.client.post('/crop', json={'identifier': ASSET, 'orientation': orientation,
                                              'crop': PORTRAIT if crop is None else crop})

    def uploaded(self, orientation):
        """Record the saved crop as uploaded at the current size."""
        crop = self.saved(orientation)
        self.files.mark_uploaded(ASSET, orientation, orientation[0], crop, self.app.config.SIZES[orientation])

    def run_job(self, url):
        """POST a job endpoint, wait for it, and return the finished job."""
        response = self.client.post(url)
        self.assertEqual(response.status_code, 202)
        self.app.jobs.join(5)
        return self.client.get(f"/jobs/{response.json['job']['id']}").json['job']

    def test_offline_app_and_health_are_available(self):
        with patch.object(self.app.immich_handler, 'sync_input_images', side_effect=ConnectionError('offline')):
            job, started = self.app.initial_sync()
            self.app.jobs.join(5)
        self.assertTrue(started)
        self.assertEqual(self.app.jobs.get(job['id'])['status'], 'failed')
        self.assertEqual(self.client.get('/health').status_code, 200)
        self.assertEqual(self.client.get('/').status_code, 200)

    def test_sync_job_reports_progress_and_rejects_overlap(self):
        import threading
        reported, release = threading.Event(), threading.Event()
        def slow_sync(folder, progress):
            progress(1, 3)
            reported.set()
            release.wait(5)
            progress(3, 3)
            return [{}, {}, {}]
        with patch.object(self.app.immich_handler, 'sync_input_images', side_effect=slow_sync):
            first = self.client.post('/sync')
            self.assertEqual(first.status_code, 202)
            job_id = first.json['job']['id']
            self.assertTrue(reported.wait(5))
            running = self.client.get(f'/jobs/{job_id}').json['job']
            self.assertEqual((running['status'], running['done'], running['total']), ('running', 1, 3))
            overlap = self.client.post('/upload-all')
            self.assertEqual(overlap.status_code, 409)
            self.assertEqual(overlap.json['job']['id'], job_id)
            release.set()
            self.app.jobs.join(5)
        finished = self.client.get(f'/jobs/{job_id}').json['job']
        self.assertEqual((finished['status'], finished['result']), ('done', {'images': 3, 'reuploads': 0}))
        self.assertEqual(self.client.get('/jobs/9999').status_code, 404)

    def test_sync_downloads_in_parallel_and_reports_each_asset(self):
        import threading
        ids = [f'{n}{n}{n}{n}{n}{n}{n}{n}-0000-4000-8000-000000000000' for n in range(2, 8)]
        active, peak, lock = 0, 0, threading.Lock()
        def download(asset_id, folder):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
            threading.Event().wait(0.05)
            seed_image(self.app, asset_id)
            with lock:
                active -= 1
            return True, str(Path(folder) / f'{asset_id}.jpg')
        updates = []
        handler = self.app.immich_handler
        with patch.object(handler, 'get_album_assets', return_value=[{'id': ASSET}] + [{'id': i} for i in ids]), \
             patch.object(handler, 'download_asset', side_effect=download):
            result = handler.sync_input_images(self.app.config.INPUT_FOLDER, progress=lambda d, t: updates.append((d, t)))
        self.assertEqual([entry['asset_id'] for entry in result], [ASSET] + ids)
        self.assertGreater(peak, 1)
        self.assertEqual(updates[0], (0, 7))
        self.assertEqual(updates[-1], (7, 7))

    def complete(self):
        return self.client.post('/complete', json={'identifier': ASSET})

    def test_empty_complete_is_rejected(self):
        with patch.object(self.app.immich_handler, 'upload_asset') as upload:
            response = self.complete()
        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.json['success'])
        upload.assert_not_called()
        self.assertEqual(self.image()['status'], 'unprocessed')

    def test_complete_renders_and_uploads_all_saved_crops_from_memory(self):
        import io
        from PIL import Image
        self.save()
        with patch.object(self.app.immich_handler, 'upload_asset', return_value='uploaded') as upload:
            response = self.complete()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json['uploaded_files']), 2)
        self.assertEqual(response.json['image']['status'], 'completed')
        self.assertEqual(self.image()['status'], 'completed')
        for call, (orientation, size) in zip(upload.call_args_list, [('portrait', (90, 160)), ('landscape', (160, 90))]):
            content, filename = call.args[:2]
            self.assertEqual(filename, f'{ASSET}_{orientation}.jpg')
            with Image.open(io.BytesIO(content)) as image:
                self.assertEqual(image.size, size)

    def test_split_output_albums_send_each_orientation_to_its_own_album(self):
        self.save()
        handler = self.app.immich_handler
        self.addCleanup(setattr, handler, 'output_album_ids', handler.output_album_ids)
        handler.output_album_ids = {'portrait': 'album-p', 'landscape': 'album-l'}
        with patch.object(handler, 'upload_asset', return_value='uploaded') as upload:
            self.assertEqual(self.complete().status_code, 200)
        targets = {call.args[1]: call.args[2] for call in upload.call_args_list}
        self.assertEqual(targets[f'{ASSET}_portrait.jpg'], 'album-p')
        self.assertEqual(targets[f'{ASSET}_landscape.jpg'], 'album-l')
        # Each distinct album is read once, not once per orientation.
        self.assertEqual({call.args[0] for call in handler.get_album_assets.call_args_list}, {'album-p', 'album-l'})

    def test_shared_output_album_is_read_once_for_both_orientations(self):
        self.save()
        handler = self.app.immich_handler
        with patch.object(handler, 'upload_asset', return_value='uploaded'):
            self.assertEqual(self.complete().status_code, 200)
        # Both orientations fall back to the one shared album, fetched a single time.
        self.assertEqual(handler.get_album_assets.call_count, 1)
        self.assertEqual(handler.get_album_assets.call_args.args[0], 'output-album')

    def test_complete_replaces_the_previous_album_copy(self):
        self.save(False)
        self.app.immich_handler.get_album_assets.return_value = [
            {'id': 'old-upload', 'originalFileName': f'{ASSET}_portrait.jpg'}]
        with patch.object(self.app.immich_handler, 'upload_asset', return_value='new-upload') as upload:
            self.assertEqual(self.complete().status_code, 200)
        self.assertEqual(upload.call_args.kwargs['replaces'], 'old-upload')
        uploaded = self.files.read_all_crop_metadata()[ASSET]['portrait']['uploaded']
        self.assertEqual((uploaded['asset_id'], uploaded['crop']), ('new-upload', PORTRAIT))

    def test_single_orientation_reupload(self):
        self.save()
        with patch.object(self.app.immich_handler, 'upload_asset', return_value='landscape-upload') as upload:
            response = self.client.post('/upload-single', json={'identifier': ASSET, 'orientation': 'landscape'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json['uploaded_asset_id'], 'landscape-upload')
        self.assertEqual(upload.call_args.args[1], f'{ASSET}_landscape.jpg')
        self.assertEqual(response.json['image']['status'], 'both')  # portrait not uploaded yet
        self.assertEqual(self.client.post('/upload-single', json={'identifier': ASSET, 'orientation': 'other'}).status_code, 400)

    def test_partial_upload_is_failure_and_records_only_the_success(self):
        self.save()
        with patch.object(self.app.immich_handler, 'upload_asset', side_effect=['portrait-upload', RuntimeError('offline')]):
            response = self.complete()
        self.assertEqual(response.status_code, 500)
        self.assertFalse(response.json['success'])
        self.assertEqual(len(response.json['uploaded_files']), 1)
        self.assertEqual(response.json['image']['status'], 'both')
        entry = self.files.read_all_crop_metadata()[ASSET]
        self.assertIn('uploaded', entry['portrait'])
        self.assertNotIn('uploaded', entry['landscape'])

    def test_recrop_after_upload_makes_image_pending_again(self):
        self.save()
        self.uploaded('portrait')
        self.uploaded('landscape')
        self.assertEqual(self.image()['status'], 'completed')
        response = self.crop(crop={**PORTRAIT, 'x': 60})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json['image']['status'], 'both')
        self.assertEqual(self.saved('landscape'), LANDSCAPE)

    def test_crop_reports_metadata_write_failure_and_preserves_saved_crop(self):
        self.save()
        with patch.object(self.files, 'write_json_atomic', side_effect=OSError('disk full')):
            response = self.crop(crop={**PORTRAIT, 'x': 60})
        self.assertEqual(response.status_code, 500)
        self.assertFalse(response.json['success'])
        self.assertEqual(self.saved('portrait'), PORTRAIT)

    def test_invalid_crop_and_orientation_are_rejected(self):
        # The fixture image is 160x90, so x=160 starts outside it.
        for crop in ({**PORTRAIT, 'width': 0}, {**PORTRAIT, 'x': -1}, {**PORTRAIT, 'width': '45'}, {},
                     {**PORTRAIT, 'x': 160}):
            self.assertEqual(self.crop(crop=crop).status_code, 400)
        self.assertEqual(self.crop(orientation='other').status_code, 400)
        self.assertEqual(self.client.delete(f'/crop-data/{ASSET}/other').status_code, 400)
        self.assertEqual(self.files.read_all_crop_metadata(), {})

    def test_only_uuid_asset_ids_are_accepted(self):
        for identifier in (f'{ASSET}.jpg', 'synthetic.jpg', '../config'):
            self.assertEqual(self.client.post('/reset', json={'identifier': identifier}).status_code, 400)
        self.assertEqual(self.client.get(f'/image/{ASSET}.jpg').status_code, 400)
        missing = '33333333-3333-4333-8333-333333333333'
        self.assertEqual(self.client.get(f'/image/{missing}').status_code, 404)
        self.assertEqual(self.client.post('/crop', json={'identifier': missing, 'orientation': 'portrait',
                                                         'crop': PORTRAIT}).status_code, 404)

    def test_delete_trashes_the_uploaded_copy_in_the_destination_album(self):
        self.save()
        self.uploaded('portrait')
        self.uploaded('landscape')
        handler = self.app.immich_handler
        with patch.object(handler, 'get_album_assets', return_value=[{'id': 'p'}, {'id': 'l'}]), \
             patch.object(handler, 'trash_asset') as trash:
            response = self.client.delete(f'/crop-data/{ASSET}/portrait')
        self.assertEqual(response.status_code, 200)
        trash.assert_called_once_with('p')
        self.assertEqual(response.json['image']['crops'], {'portrait': None, 'landscape': LANDSCAPE})
        self.assertEqual(response.json['image']['uploaded'], {'portrait': False, 'landscape': True})
        self.assertNotIn('portrait', self.files.read_all_crop_metadata()[ASSET])

    def test_delete_never_trashes_a_copy_outside_the_destination_album(self):
        self.save()
        self.uploaded('portrait')
        handler = self.app.immich_handler
        # 'p' is gone from the album (moved or deleted in Immich); only the record goes.
        with patch.object(handler, 'get_album_assets', return_value=[{'id': 'other'}]), \
             patch.object(handler, 'trash_asset') as trash:
            response = self.client.delete(f'/crop-data/{ASSET}/portrait')
        self.assertEqual(response.status_code, 200)
        trash.assert_not_called()
        self.assertEqual(response.json['image']['status'], 'landscape')
        self.client.delete(f'/crop-data/{ASSET}/landscape')
        self.assertEqual(self.image()['status'], 'unprocessed')

    def test_delete_without_upload_does_not_contact_immich(self):
        self.save()
        with patch.object(self.app.immich_handler, 'get_album_assets') as album:
            self.assertEqual(self.client.delete(f'/crop-data/{ASSET}/portrait').status_code, 200)
        album.assert_not_called()

    def test_delete_of_legacy_upload_finds_the_copy_by_filename(self):
        self.save()
        self.files.mark_uploaded(ASSET, 'portrait', None, PORTRAIT, self.app.config.SIZES['portrait'])
        album = [{'id': 'legacy', 'originalFileName': f'{ASSET}_portrait.jpg'}]
        handler = self.app.immich_handler
        with patch.object(handler, 'get_album_assets', return_value=album), patch.object(handler, 'trash_asset') as trash:
            self.assertEqual(self.client.delete(f'/crop-data/{ASSET}/portrait').status_code, 200)
        trash.assert_called_once_with('legacy')

    def test_failed_trash_keeps_the_crop_and_its_record(self):
        self.save()
        self.uploaded('portrait')
        handler = self.app.immich_handler
        with patch.object(handler, 'get_album_assets', return_value=[{'id': 'p'}]), \
             patch.object(handler, 'trash_asset', side_effect=self.app.requests.ConnectionError('offline')):
            response = self.client.delete(f'/crop-data/{ASSET}/portrait')
        self.assertEqual(response.status_code, 502)
        self.assertIn('offline', response.json['error'])
        self.assertEqual(self.saved('portrait'), PORTRAIT)
        self.assertEqual(self.files.read_all_crop_metadata()[ASSET]['portrait']['uploaded']['asset_id'], 'p')

    def test_sync_makes_crops_deleted_from_immich_pending_again(self):
        self.save()
        self.uploaded('portrait')
        self.uploaded('landscape')
        self.assertEqual(self.image()['status'], 'completed')
        handler = self.app.immich_handler
        with patch.object(handler, 'sync_input_images', return_value=[{}]), \
             patch.object(handler, 'get_album_assets', return_value=[{'id': 'l'}]):
            job = self.run_job('/sync')
        self.assertEqual(job['result'], {'images': 1, 'reuploads': 1})
        image = self.image()
        self.assertEqual(image['status'], 'both')
        self.assertEqual(image['uploaded'], {'portrait': False, 'landscape': True})
        self.assertEqual(image['crops'], {'portrait': PORTRAIT, 'landscape': LANDSCAPE})

    def test_reconcile_keeps_recent_unfinished_and_legacy_uploads(self):
        self.save()
        self.uploaded('portrait')
        self.files.checkpoint_upload(ASSET, 'landscape', {'asset_id': 'pending'})
        legacy = '22222222-2222-4222-8222-222222222222'
        self.files.save_crop(legacy, 'portrait', PORTRAIT)
        self.files.mark_uploaded(legacy, 'portrait', None, PORTRAIT, self.app.config.SIZES['portrait'])
        album = [{'id': 'x', 'originalFileName': f'{legacy}_portrait.jpg'}]
        present = {'portrait': {'x'}, 'landscape': {'x'}}
        find_legacy = lambda orientation, name: self.app.find_processed_asset(album, name)
        # Uploaded after the album was listed: not yet in the listing, but kept.
        changed = self.files.forget_missing_uploads(present, find_legacy, '2000-01-01T00:00:00+00:00')
        self.assertEqual(changed, [])
        changed = self.files.forget_missing_uploads(present, find_legacy, '2999-01-01T00:00:00+00:00')
        self.assertEqual(changed, [ASSET])
        crops = self.files.read_all_crop_metadata()
        self.assertNotIn('uploaded', crops[ASSET]['portrait'])
        self.assertEqual(crops[ASSET]['landscape']['pending_upload'], {'asset_id': 'pending'})
        self.assertIn('uploaded', crops[legacy]['portrait'])

    def test_sync_succeeds_when_the_destination_album_cannot_be_read(self):
        self.save()
        self.uploaded('portrait')
        handler = self.app.immich_handler
        with patch.object(handler, 'sync_input_images', return_value=[]), \
             patch.object(handler, 'get_album_assets', side_effect=RuntimeError('offline')):
            job = self.run_job('/sync')
        self.assertEqual((job['status'], job['result']), ('done', {'images': 0, 'reuploads': None}))
        self.assertIn('uploaded', self.files.read_all_crop_metadata()[ASSET]['portrait'])

    def test_reset_clears_saved_crops(self):
        self.save()
        response = self.client.post('/reset', json={'identifier': ASSET})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.files.read_all_crop_metadata(), {})
        self.assertEqual(self.image()['status'], 'unprocessed')

    def test_legacy_crops_and_progress_are_migrated_once(self):
        path = Path(self.app.config.CROP_METADATA_FILE)
        path.parent.mkdir(parents=True, exist_ok=True)
        second = '22222222-2222-4222-8222-222222222222'
        path.write_text(json.dumps({'crops': {ASSET: {'portrait': PORTRAIT, 'landscape': LANDSCAPE},
                                              second: {'portrait': PORTRAIT}}}))
        progress = Path(self.app.config.LEGACY_PROGRESS_FILE)
        progress.write_text(json.dumps({ASSET: 'completed', second: 'portrait'}))
        self.files.migrate_legacy_state()
        crops = self.files.read_all_crop_metadata()
        self.assertEqual(crops[ASSET]['landscape']['crop'], LANDSCAPE)
        self.assertEqual(self.files.image_status(crops[ASSET]), 'completed')
        self.assertEqual(self.files.image_status(crops[second]), 'portrait')
        self.assertFalse(progress.exists())
        self.assertTrue(Path(f'{progress}.migrated').exists())
        self.files.migrate_legacy_state()
        self.assertEqual(self.files.read_all_crop_metadata(), crops)

    def test_missing_preview_is_regenerated_from_saved_coordinates(self):
        self.save(False)
        response = self.client.get(f'/output/portrait/{ASSET}')
        self.assertEqual(response.status_code, 200)
        response.close()

    def test_source_removal_does_not_delete_library_asset(self):
        with patch.object(self.app.immich_handler, '_make_request', return_value=[{'id': ASSET, 'success': True}]) as request:
            response = self.client.delete('/delete-original', json={'identifier': ASSET})
        self.assertEqual(response.status_code, 200)
        request.assert_called_once_with('DELETE', '/albums/source-album/assets', json={'ids': [ASSET]})
        self.assertEqual(self.client.get('/images').json, [])

    def test_source_removal_failure_keeps_local_cache(self):
        with patch.object(self.app.immich_handler, '_make_request', return_value=[{'id': ASSET, 'success': False}]):
            response = self.client.delete('/delete-original', json={'identifier': ASSET})
        self.assertEqual(response.status_code, 502)
        self.assertEqual(len(self.client.get('/images').json), 1)

    def test_face_boxes_prefer_visible_people_and_normalize(self):
        from utils.immich_handler import face_boxes
        face = lambda x1, y1, x2, y2, person=None: {
            'boundingBoxX1': x1, 'boundingBoxY1': y1, 'boundingBoxX2': x2, 'boundingBoxY2': y2,
            'imageWidth': 200, 'imageHeight': 100, 'person': person}
        visible, hidden, unassigned = face(20, 10, 60, 50, {'id': 'a'}), face(0, 0, 10, 10, {'isHidden': True}), face(100, 0, 120, 20)
        self.assertEqual(face_boxes([visible, hidden, unassigned]), [[0.1, 0.1, 0.3, 0.5]])
        self.assertEqual(face_boxes([hidden, unassigned]), [[0.5, 0.0, 0.6, 0.2]])
        self.assertEqual(face_boxes([{'imageWidth': 0}, face(-5, 0, 250, 50)]), [[0.0, 0.0, 1.0, 0.5]])
        self.assertEqual(face_boxes([]), [])

    def test_sync_fetches_faces_once_for_cached_images(self):
        from datetime import datetime, timedelta, timezone
        from utils.immich_handler import faces_stale
        handler = self.app.immich_handler
        faces = [{'boundingBoxX1': 0, 'boundingBoxY1': 0, 'boundingBoxX2': 40, 'boundingBoxY2': 45,
                  'imageWidth': 160, 'imageHeight': 90, 'person': {'id': 'a'}}]
        with patch.object(handler, 'get_album_assets', return_value=[{'id': ASSET}]), \
             patch.object(handler, '_make_request', return_value=faces) as request:
            handler.sync_input_images(self.app.config.INPUT_FOLDER)
            handler.sync_input_images(self.app.config.INPUT_FOLDER)
        request.assert_called_once_with('GET', '/faces', params={'id': ASSET}, quiet_statuses=(401, 403))
        self.assertEqual(self.image()['faces'], [[0.0, 0.0, 0.25, 0.5]])
        now = datetime.now(timezone.utc)
        self.assertFalse(faces_stale({'faces': [], 'faces_at': (now - timedelta(hours=1)).isoformat()}, now))
        self.assertTrue(faces_stale({'faces': [], 'faces_at': (now - timedelta(days=2)).isoformat()}, now))

    def test_missing_face_permission_costs_one_quiet_request_per_sync(self):
        handler = self.app.immich_handler
        self.addCleanup(handler.configure, self.app.config.settings['immich'])
        self.enable_logging()
        ids = [ASSET] + [f'{n}{n}{n}{n}{n}{n}{n}{n}-0000-4000-8000-000000000000' for n in range(2, 8)]
        for asset in ids[1:]:
            seed_image(self.app, asset)
        denied = self.app.requests.HTTPError('403', response=Mock(status_code=403))
        album = [{'id': asset} for asset in ids]
        with patch.object(handler, 'get_album_assets', return_value=album), \
             patch.object(handler, '_make_request', side_effect=denied) as request, \
             self.assertLogs(level='WARNING') as logs:
            self.assertEqual(len(handler.sync_input_images(self.app.config.INPUT_FOLDER)), len(ids))
            self.assertEqual(request.call_count, 1)
            request.assert_called_with('GET', '/faces', params={'id': request.call_args.kwargs['params']['id']},
                                       quiet_statuses=(401, 403))
            handler.sync_input_images(self.app.config.INPUT_FOLDER)
            self.assertEqual(request.call_count, 2)
        self.assertEqual(len(logs.records), 1)
        self.assertIn('face.read', logs.output[0])
        self.assertEqual(self.image()['faces'], [])
        # Once the permission is added, the next sync fetches every image's faces.
        with patch.object(handler, 'get_album_assets', return_value=album), \
             patch.object(handler, '_make_request', return_value=[]) as request:
            handler.sync_input_images(self.app.config.INPUT_FOLDER)
        self.assertEqual(request.call_count, len(ids))

    def test_expected_errors_are_not_logged_as_failures(self):
        handler = self.app.immich_handler
        self.enable_logging()
        response = Mock(ok=False, status_code=403, text='Missing required permission: face.read')
        response.raise_for_status.side_effect = self.app.requests.HTTPError('403', response=response)
        with patch.object(handler.http, 'session') as session, self.assertNoLogs(level='ERROR'):
            session.return_value.request.return_value = response
            with self.assertRaises(self.app.requests.HTTPError):
                handler._make_request('GET', '/faces', quiet_statuses=(403,))
        with patch.object(handler.http, 'session') as session, self.assertLogs(level='ERROR'):
            session.return_value.request.return_value = response
            with self.assertRaises(self.app.requests.HTTPError):
                handler._make_request('GET', '/faces')

    def test_trash_helper_passes_correct_method_endpoint_and_json(self):
        with patch.object(self.app.immich_handler, '_make_request', return_value={}) as request:
            self.app.immich_handler.trash_asset(ASSET)
        request.assert_called_once_with('DELETE', '/assets', json={'ids': [ASSET]})

    def test_batch_partial_failure_never_marks_asset_completed(self):
        self.save()
        with patch.object(self.app.immich_handler, 'upload_asset', side_effect=['uploaded', RuntimeError('offline')]):
            job = self.run_job('/upload-all')
        self.assertEqual((job['status'], job['done'], job['total']), ('done', 1, 1))
        self.assertFalse(job['result']['success'])
        self.assertEqual(job['result']['failed_assets'], [ASSET])
        self.assertEqual(len(job['result']['uploaded_assets']), 1)
        self.assertEqual(self.image()['status'], 'both')

    def test_upload_all_sends_only_new_or_changed_crops(self):
        self.save()
        self.uploaded('portrait')
        with patch.object(self.app.immich_handler, 'upload_asset', return_value='remote') as upload:
            job = self.run_job('/upload-all')
            self.assertEqual([c.args[1] for c in upload.call_args_list], [f'{ASSET}_landscape.jpg'])
            self.assertTrue(job['result']['success'])
            self.assertEqual(self.image()['status'], 'completed')
            # Nothing changed: no album fetch, no uploads.
            upload.reset_mock()
            self.app.immich_handler.get_album_assets.reset_mock()
            job = self.run_job('/upload-all')
            upload.assert_not_called()
            self.app.immich_handler.get_album_assets.assert_not_called()
            self.assertEqual((job['result']['success'], job['result']['uploaded_assets'], job['total']), (True, [], 0))
            # A new selection is sent again.
            self.crop(crop={**PORTRAIT, 'x': 60})
            self.run_job('/upload-all')
            self.assertEqual([c.args[1] for c in upload.call_args_list], [f'{ASSET}_portrait.jpg'])

    def test_complete_skips_crops_already_in_immich_and_reupload_forces(self):
        self.save()
        self.uploaded('portrait')
        with patch.object(self.app.immich_handler, 'upload_asset', return_value='remote') as upload:
            response = self.complete()
            self.assertEqual(response.status_code, 200)
            self.assertEqual([c.args[1] for c in upload.call_args_list], [f'{ASSET}_landscape.jpg'])
            upload.reset_mock()
            response = self.complete()
            self.assertEqual((response.status_code, response.json['uploaded_files']), (200, []))
            upload.assert_not_called()
            # Manage's Re-upload sends an up-to-date crop anyway.
            response = self.client.post('/upload-single', json={'identifier': ASSET, 'orientation': 'portrait'})
            self.assertEqual(response.status_code, 200)
            self.assertEqual([c.args[1] for c in upload.call_args_list], [f'{ASSET}_portrait.jpg'])

    def test_new_output_size_makes_uploaded_crops_pending(self):
        self.save(False)
        self.uploaded('portrait')
        self.assertEqual(self.image()['status'], 'completed')
        with patch.dict(self.app.config.SIZES, portrait=(45, 80)):
            self.assertEqual(self.image()['status'], 'portrait')
            # Upload records from before sizes were recorded count as the current size.
            self.files._update_entry(ASSET, lambda entry: entry['portrait']['uploaded'].pop('size'))
            self.assertEqual(self.image()['status'], 'completed')

    def test_native_resolution_uploads_cropped_pixels_without_resizing(self):
        from io import BytesIO
        from PIL import Image
        # A 16:9 landscape crop that is smaller than the configured landscape size.
        crop = {'x': 0, 'y': 0, 'width': 80, 'height': 45}
        self.assertTrue(self.files.save_crop(ASSET, 'landscape', crop))
        with patch.dict(self.app.config.settings['dimensions'], {'native_resolution': True}):
            with patch.object(self.app.immich_handler, 'upload_asset', return_value='uploaded') as upload:
                response = self.client.post('/upload-single', json={'identifier': ASSET, 'orientation': 'landscape'})
            self.assertEqual(response.status_code, 200, response.json)
            self.assertEqual(Image.open(BytesIO(upload.call_args.args[0])).size, (80, 45))
        # Fixed mode resizes the very same crop up to the configured landscape size.
        with patch.object(self.app.immich_handler, 'upload_asset', return_value='uploaded') as upload:
            self.client.post('/upload-single', json={'identifier': ASSET, 'orientation': 'landscape'})
        self.assertEqual(Image.open(BytesIO(upload.call_args.args[0])).size, (160, 90))

    def test_toggling_native_resolution_makes_uploaded_crops_pending(self):
        self.save(False)
        self.uploaded('portrait')
        self.assertEqual(self.image()['status'], 'completed')
        with patch.dict(self.app.config.settings['dimensions'], {'native_resolution': True}):
            self.assertEqual(self.image()['status'], 'portrait')

    def test_dimensions_report_native_resolution_flag(self):
        self.assertFalse(self.client.get('/dimensions').json['native_resolution'])
        with patch.dict(self.app.config.settings['dimensions'], {'native_resolution': True}):
            self.assertTrue(self.client.get('/dimensions').json['native_resolution'])

    def test_corrupt_metadata_is_not_overwritten(self):
        path = Path(self.app.config.CROP_METADATA_FILE)
        path.parent.mkdir(exist_ok=True, parents=True)
        path.write_text('{broken')
        self.assertFalse(self.files.save_crop(ASSET, 'portrait', PORTRAIT))
        self.assertEqual(path.read_text(), '{broken')

    def test_atomic_write_failure_preserves_old_document(self):
        self.save()
        with patch.object(self.files.os, 'replace', side_effect=OSError('interrupted')):
            self.assertFalse(self.files.save_crop(ASSET, 'portrait', {**PORTRAIT, 'x': 60}))
        self.assertEqual(self.saved('portrait'), PORTRAIT)

    def test_concurrent_metadata_updates_do_not_lose_other_assets(self):
        with ThreadPoolExecutor(max_workers=4) as executor:
            results = list(executor.map(lambda n: self.files.save_crop(f'asset-{n}', 'portrait', PORTRAIT), range(12)))
        self.assertTrue(all(results))
        self.assertEqual(len(self.files.read_all_crop_metadata()), 12)

    def test_uploaded_single_orientation_is_completed_with_one_crop(self):
        self.save(False)
        self.uploaded('portrait')
        image = self.image()
        self.assertEqual(image['status'], 'completed')
        self.assertEqual(image['crops'], {'portrait': PORTRAIT, 'landscape': None})

    def test_http_calls_always_have_timeout(self):
        response = Mock(ok=True, content=b'{}')
        response.json.return_value = {}
        with patch('requests.Session.request', return_value=response) as request:
            self.app.immich_handler._make_request('GET', '/server/ping')
        self.assertEqual(request.call_args.kwargs['timeout'], (5, 60))

    def test_upload_rejects_failed_album_membership(self):
        handler = self.app.immich_handler
        with patch.object(handler, '_make_request', return_value={'id': 'uploaded'}), \
             patch.object(handler, 'add_assets_to_album', return_value=False):
            with self.assertRaisesRegex(RuntimeError, 'destination album failed'):
                handler.upload_asset(b'jpeg', f'{ASSET}_portrait.jpg', handler.output_album_id)

    def reupload(self, upload_response):
        """Upload over an existing processed version; return the new ID and request calls."""
        handler = self.app.immich_handler
        with patch.object(handler, '_make_request', side_effect=[upload_response, {}]) as request, \
             patch.object(handler, 'add_assets_to_album', return_value=True):
            asset_id = handler.upload_asset(b'jpeg', f'{ASSET}_portrait.jpg', handler.output_album_id,
                                            replaces='old-upload')
        return asset_id, [call.args for call in request.call_args_list]

    def test_reupload_supersedes_and_trashes_previous_version(self):
        asset_id, calls = self.reupload({'id': 'new-upload'})
        self.assertEqual(asset_id, 'new-upload')
        self.assertEqual(calls, [('POST', '/assets'), ('DELETE', '/assets')])

    def test_identical_reupload_deduplicated_by_immich_keeps_existing_asset(self):
        asset_id, calls = self.reupload({'id': 'old-upload', 'status': 'duplicate'})
        self.assertEqual(asset_id, 'old-upload')
        self.assertEqual(calls, [('POST', '/assets')])

    def test_previous_copy_is_matched_by_upload_filename(self):
        from utils.immich_handler import find_processed_asset
        album = [{'id': 'other', 'originalFileName': 'holiday.jpg'},
                 {'id': 'old', 'originalFileName': f'{ASSET}_portrait.jpg'}]
        self.assertEqual(find_processed_asset(album, f'{ASSET}_portrait.jpg'), 'old')
        self.assertIsNone(find_processed_asset(album, f'{ASSET}_landscape.jpg'))

    def test_album_lookup_failure_aborts_upload_instead_of_duplicating(self):
        self.save(False)
        self.app.immich_handler.get_album_assets.side_effect = ConnectionError('offline')
        with patch.object(self.app.immich_handler, '_make_request') as request:
            response = self.complete()
        self.assertEqual(response.status_code, 500)
        request.assert_not_called()

    def test_each_orientation_uses_a_distinct_device_asset_id(self):
        handler = self.app.immich_handler
        device_ids = []
        with patch.object(handler, '_make_request', return_value={'id': 'uploaded'}) as request, \
             patch.object(handler, 'add_assets_to_album', return_value=True):
            for orientation in ('portrait', 'landscape'):
                handler.upload_asset(b'jpeg', f'{ASSET}_{orientation}.jpg', handler.output_album_id)
                device_ids.append(request.call_args.kwargs['data']['deviceAssetId'])
        self.assertEqual(device_ids, [f'{ASSET}_portrait', f'{ASSET}_landscape'])

    def test_sync_redownloads_missing_image(self):
        source = Path(self.app.config.INPUT_FOLDER) / f'{ASSET}.jpg'
        source.unlink()
        handler = self.app.immich_handler
        def download(asset_id, folder):
            seed_image(self.app, asset_id)
            return True, str(Path(folder) / f'{asset_id}.jpg')
        with patch.object(handler, 'get_album_assets', return_value=[{'id': ASSET}]), \
             patch.object(handler, 'download_asset', side_effect=download) as fetch:
            result = handler.sync_input_images(self.app.config.INPUT_FOLDER)
        fetch.assert_called_once()
        self.assertTrue(source.exists())
        self.assertEqual(result[0]['asset_id'], ASSET)

    def test_sync_repairs_corrupt_source_and_metadata(self):
        handler = self.app.immich_handler
        source = Path(self.app.config.INPUT_FOLDER) / f'{ASSET}.jpg'
        metadata = Path(self.app.config.INPUT_FOLDER) / '.metadata' / f'{ASSET}.json'
        for corrupt_path in (source, metadata):
            corrupt_path.write_bytes(b'broken')
            def download(asset_id, folder):
                seed_image(self.app, asset_id)
                return True, str(source)
            with patch.object(handler, 'get_album_assets', return_value=[{'id': ASSET}]), \
                 patch.object(handler, 'download_asset', side_effect=download) as fetch:
                handler.sync_input_images(self.app.config.INPUT_FOLDER)
            fetch.assert_called_once()

    def test_sync_removes_departed_assets_but_keeps_saved_crops(self):
        self.save()
        with patch.object(self.app.immich_handler, 'get_album_assets', return_value=[]):
            self.app.immich_handler.sync_input_images(self.app.config.INPUT_FOLDER)
        self.assertEqual(self.client.get('/images').json, [])
        self.assertEqual(self.saved('portrait'), PORTRAIT)

    def test_failed_or_malformed_album_fetch_never_prunes_cache(self):
        handler = self.app.immich_handler
        real_fetch = type(handler).get_album_assets.__get__(handler)
        for value in (None, {}, {'assets': 'invalid'}, {'assets': {'items': 'invalid'}}):
            with patch.object(handler, '_make_request', return_value=value), \
                 patch.object(handler, 'get_album_assets', side_effect=real_fetch):
                with self.assertRaises(ValueError):
                    handler.sync_input_images(self.app.config.INPUT_FOLDER)
            self.assertEqual(len(self.client.get('/images').json), 1)
        with patch.object(handler, 'get_album_assets', side_effect=ConnectionError('offline')):
            with self.assertRaises(ConnectionError):
                handler.sync_input_images(self.app.config.INPUT_FOLDER)
        self.assertEqual(len(self.client.get('/images').json), 1)

    def test_album_assets_page_through_metadata_search(self):
        handler = self.app.immich_handler
        real_fetch = type(handler).get_album_assets.__get__(handler)
        pages = [{'assets': {'items': [{'id': 'a'}, {'id': 'b'}], 'nextPage': '2'}},
                 {'assets': {'items': [{'id': 'c'}], 'nextPage': None}}]
        with patch.object(handler, '_make_request', side_effect=pages) as request:
            self.assertEqual([asset['id'] for asset in real_fetch('album-id')], ['a', 'b', 'c'])
        self.assertEqual([call.args for call in request.call_args_list], [('POST', '/search/metadata')] * 2)
        self.assertEqual([call.kwargs['json'] for call in request.call_args_list],
                         [{'albumIds': ['album-id'], 'page': page, 'size': 1000} for page in (1, 2)])

    def test_failed_download_is_reported_instead_of_successful_sync(self):
        handler = self.app.immich_handler
        with patch.object(handler, 'get_album_assets', return_value=[{'id': 'new-asset'}]), \
             patch.object(handler, 'download_asset', return_value=(False, '')):
            with self.assertRaisesRegex(RuntimeError, 'retry Sync'):
                handler.sync_input_images(self.app.config.INPUT_FOLDER)

    def test_thumbnail_is_small_and_conditionally_cached(self):
        import io
        from PIL import Image
        path = Path(self.app.config.INPUT_FOLDER) / f'{ASSET}.jpg'
        Image.new('RGB', (1200, 800), 'orange').save(path)
        response = self.client.get(f'/thumbnail/{ASSET}')
        self.assertEqual(response.status_code, 200)
        with Image.open(io.BytesIO(response.data)) as image:
            self.assertLessEqual(max(image.size), 320)
        etag = response.headers['ETag']
        cached = self.client.get(f'/thumbnail/{ASSET}', headers={'If-None-Match': etag})
        self.assertEqual(cached.status_code, 304)
        cached.close()
        Image.new('RGB', (1200, 800), 'navy').save(path)
        changed = self.client.get(f'/thumbnail/{ASSET}', headers={'If-None-Match': etag})
        self.assertEqual(changed.status_code, 200)
        self.assertNotEqual(changed.headers['ETag'], etag)
        response.close()
        changed.close()

    def test_renderer_preserves_exif_and_color_profile_with_correct_dimensions(self):
        import io
        import piexif
        from PIL import Image, ImageCms
        from utils.image_processor import render_image
        path = Path(self.app.config.INPUT_FOLDER) / f'{ASSET}.jpg'
        profile = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
        exif = {'0th': {piexif.ImageIFD.Orientation: 6, piexif.ImageIFD.Make: b'Test Camera'},
                'Exif': {piexif.ExifIFD.DateTimeOriginal: b'2020:01:02 03:04:05'},
                'GPS': {piexif.GPSIFD.GPSLatitudeRef: b'N',
                        piexif.GPSIFD.GPSLatitude: ((40, 1), (30, 1), (0, 1))}, '1st': {}, 'thumbnail': None}
        Image.new('RGB', (160, 90), 'orange').save(path, exif=piexif.dump(exif), icc_profile=profile)
        content = render_image(path, {'x': 0, 'y': 100, 'width': 90, 'height': 60}, (90, 60))
        with Image.open(io.BytesIO(content)) as image:
            saved = piexif.load(image.info['exif'])
            self.assertEqual(image.size, (90, 60))
            self.assertEqual(image.info['icc_profile'], profile)
            self.assertEqual(saved['0th'][piexif.ImageIFD.Orientation], 1)
            self.assertEqual(saved['0th'][piexif.ImageIFD.Make], b'Test Camera')
            self.assertEqual(saved['Exif'][piexif.ExifIFD.DateTimeOriginal], b'2020:01:02 03:04:05')
            self.assertEqual(saved['GPS'][piexif.GPSIFD.GPSLatitudeRef], b'N')
            self.assertEqual(saved['Exif'][piexif.ExifIFD.PixelXDimension], 90)
            self.assertEqual(saved['Exif'][piexif.ExifIFD.PixelYDimension], 60)
            # Quality 95 has much smaller quantization values than low-quality output.
            self.assertLess(max(image.quantization[0]), 30)

    def test_meural_preview_upload_and_saved_preview_have_identical_pixels(self):
        from PIL import Image
        path = Path(self.app.config.INPUT_FOLDER) / f'{ASSET}.jpg'
        exif = Image.Exif()
        exif[274] = 6
        Image.new('RGB', (160, 90), 'orange').save(path, exif=exif)
        crop = {'x': 0, 'y': 100, 'width': 90, 'height': 60}
        self.assertEqual(self.crop('landscape', crop).status_code, 200)
        with patch.object(self.app.meural_handler, 'preview_image', return_value={'success': True}) as preview, \
             patch.object(self.app.immich_handler, 'upload_asset', return_value='uploaded') as upload:
            response = self.client.post('/meural/preview', json={'identifier': ASSET, 'orientation': 'landscape',
                                                                 'device_ip': '127.0.0.1'})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(self.complete().status_code, 200)
        saved = self.client.get(f'/output/landscape/{ASSET}').data
        self.assertEqual(preview.call_args.args[1], saved)
        self.assertEqual(upload.call_args.args[0], saved)

    def test_meural_requires_an_explicit_pass(self):
        from utils.meural_handler import MeuralHandler
        handler = MeuralHandler([{'name': 'test', 'ip': '127.0.0.1'}])
        passed = Mock(status_code=200, text='ok')
        passed.json.return_value = {'status': 'pass'}
        unparsable = Mock(status_code=200, text='<html>')
        unparsable.json.side_effect = ValueError('not json')
        with patch.object(handler, '_set_preview_duration'), \
             patch('requests.Session.post', side_effect=[passed, unparsable]) as post:
            self.assertTrue(handler.preview_image('127.0.0.1', b'jpeg')['success'])
            self.assertFalse(handler.preview_image('127.0.0.1', b'jpeg')['success'])
        self.assertEqual(post.call_args.kwargs['files']['photo'][2], 'image/jpeg')
        self.assertFalse(handler.preview_image('10.0.0.1', b'jpeg')['success'])

    def test_slow_upload_does_not_block_listing_previews_or_other_images(self):
        import threading
        second = '22222222-2222-4222-8222-222222222222'
        seed_image(self.app, second)
        self.save(False)
        started, release = threading.Event(), threading.Event()
        def upload(*args, **kwargs):
            started.set()
            if not release.wait(5):
                raise TimeoutError('Test upload was not released')
            return 'uploaded'
        def complete():
            return self.app.app.test_client().post('/complete', json={'identifier': ASSET})
        with patch.object(self.app.immich_handler, 'upload_asset', side_effect=upload), \
             ThreadPoolExecutor(max_workers=3) as executor:
            future = executor.submit(complete)
            self.assertTrue(started.wait(2))
            try:
                listing = executor.submit(lambda: self.app.app.test_client().get('/images')).result(timeout=1)
                preview = executor.submit(lambda: self.app.app.test_client().get(f'/output/portrait/{ASSET}')).result(timeout=1)
                other = executor.submit(lambda: self.app.app.test_client().post('/crop', json={
                    'identifier': second, 'orientation': 'portrait', 'crop': PORTRAIT
                })).result(timeout=1)
                self.assertEqual(listing.status_code, 200)
                self.assertEqual(preview.status_code, 200)
                self.assertEqual(other.status_code, 200)
            finally:
                release.set()
            self.assertEqual(future.result(timeout=2).status_code, 200)

    def test_download_publishes_complete_native_image_and_metadata(self):
        import io
        from PIL import Image
        buffer = io.BytesIO()
        Image.new('RGB', (80, 120), 'orange').save(buffer, format='PNG')
        response = MagicMock()
        response.__enter__.return_value = response
        response.iter_content.return_value = [buffer.getvalue()]
        handler = self.app.immich_handler
        with patch.object(handler, '_make_request', return_value={'originalFileName': 'native.png'}), \
             patch('requests.Session.get', return_value=response):
            success, path = handler.download_asset(ASSET, self.app.config.INPUT_FOLDER)
        self.assertTrue(success)
        self.assertTrue(path.endswith('.png'))
        with Image.open(path) as image:
            self.assertEqual(image.size, (80, 120))
        self.assertEqual(self.files.get_filename_from_asset_id(ASSET), f'{ASSET}.png')

    def test_interrupted_download_preserves_previous_cache(self):
        handler = self.app.immich_handler
        path = Path(self.app.config.INPUT_FOLDER) / f'{ASSET}.jpg'
        original = path.read_bytes()
        def chunks(**kwargs):
            yield b'incomplete image'
            raise ConnectionError('download interrupted')
        response = MagicMock()
        response.__enter__.return_value = response
        response.iter_content.side_effect = chunks
        with patch.object(handler, '_make_request', return_value={'originalFileName': 'original.jpg'}), \
             patch('requests.Session.get', return_value=response):
            success, _ = handler.download_asset(ASSET, self.app.config.INPUT_FOLDER)
        self.assertFalse(success)
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(sorted(p.name for p in path.parent.iterdir()), ['.metadata', f'{ASSET}.jpg'])

    def test_converted_download_uses_upright_shared_renderer(self):
        import io
        from PIL import Image
        image = Image.new('RGB', (160, 90), 'orange')
        exif = Image.Exif()
        exif[274] = 6
        buffer = io.BytesIO()
        image.save(buffer, format='JPEG', exif=exif)
        response = MagicMock()
        response.__enter__.return_value = response
        response.iter_content.return_value = [buffer.getvalue()]
        # The conversion branch depends on the source extension. A synthetic
        # JPEG payload exercises it without a fixture HEIC encoder dependency.
        with patch.object(self.app.immich_handler, '_make_request', return_value={'originalFileName': 'source.heic'}), \
             patch('requests.Session.get', return_value=response):
            success, path = self.app.immich_handler.download_asset(ASSET, self.app.config.INPUT_FOLDER)
        self.assertTrue(success)
        with Image.open(path) as output:
            self.assertEqual(output.size, (90, 160))
            self.assertEqual(output.getexif()[274], 1)


    def keep_settings(self):
        """Restore config.yaml and the applied settings after this test."""
        import copy
        config = self.app.config
        snapshot, text = copy.deepcopy(config.settings), Path(config.CONFIG_FILE).read_text()
        def restore():
            Path(config.CONFIG_FILE).write_text(text)
            config.apply_settings(snapshot)
            self.app.immich_handler.configure(snapshot['immich'])
            self.app.meural_handler.configure(snapshot['meural']['devices'])
        self.addCleanup(restore)

    def settings_payload(self, **immich):
        return {'immich': {'url': 'http://127.0.0.1:1', 'api_key': '', 'input_album_id': 'source-album',
                           'output_album_id': 'new-output', **immich},
                'dimensions': {'portrait_size': [90, 160], 'landscape_size': [160, 90]},
                'meural': {'devices': []}}

    def test_settings_never_return_the_api_key(self):
        response = self.client.get('/settings').json
        self.assertTrue(response['configured'])
        self.assertTrue(response['settings']['immich']['has_api_key'])
        self.assertNotIn('api_key', response['settings']['immich'])
        self.assertNotIn('test-only', json.dumps(response))

    def test_settings_save_applies_without_restart_and_keeps_saved_key(self):
        import os, stat, yaml
        self.keep_settings()
        payload = self.settings_payload()
        payload['dimensions']['portrait_size'] = [60, 160]
        payload['meural']['devices'] = [{'name': ' Hall ', 'ip': '10.0.0.5', 'preview_duration': 15}]
        response = self.client.put('/settings', json=payload)
        self.assertEqual(response.status_code, 200, response.json)
        saved = yaml.safe_load(Path(self.app.config.CONFIG_FILE).read_text())
        self.assertEqual(saved['immich']['api_key'], 'test-only')
        self.assertEqual(saved['immich']['output_album_id'], 'new-output')
        self.assertEqual(stat.S_IMODE(os.stat(self.app.config.CONFIG_FILE).st_mode), 0o600)
        self.assertEqual(self.app.immich_handler.output_album_id, 'new-output')
        self.assertEqual(self.app.immich_handler.api_key, 'test-only')
        self.assertEqual(self.client.get('/dimensions').json['portrait'], {'width': 60, 'height': 160})
        self.assertEqual(self.client.get('/meural/devices').json['devices'], [{'name': 'Hall', 'ip': '10.0.0.5'}])
        self.assertNotIn('test-only', json.dumps(response.json))

    def test_native_resolution_is_saved_applied_and_returned(self):
        self.keep_settings()
        payload = self.settings_payload()
        payload['dimensions']['native_resolution'] = True
        response = self.client.put('/settings', json=payload)
        self.assertEqual(response.status_code, 200, response.json)
        self.assertTrue(self.app.config.native_resolution())
        self.assertTrue(self.client.get('/settings').json['settings']['dimensions']['native_resolution'])

    def test_settings_reject_non_boolean_native_resolution(self):
        self.keep_settings()
        payload = self.settings_payload()
        payload['dimensions']['native_resolution'] = 'yes'
        response = self.client.put('/settings', json=payload)
        self.assertEqual(response.status_code, 400)
        self.assertIn('true or false', response.json['error'])
        self.assertFalse(self.app.config.native_resolution())

    def test_split_output_albums_are_saved_applied_and_returned(self):
        import yaml
        self.keep_settings()
        payload = self.settings_payload(output_album_id='', output_album_portrait_id='album-p',
                                        output_album_landscape_id='album-l')
        response = self.client.put('/settings', json=payload)
        self.assertEqual(response.status_code, 200, response.json)
        handler = self.app.immich_handler
        self.assertEqual(handler.output_album('portrait'), 'album-p')
        self.assertEqual(handler.output_album('landscape'), 'album-l')
        saved = yaml.safe_load(Path(self.app.config.CONFIG_FILE).read_text())['immich']
        self.assertEqual(saved['output_album_portrait_id'], 'album-p')
        view = self.client.get('/settings').json['settings']['immich']
        self.assertEqual(view['output_album_landscape_id'], 'album-l')

    def test_shared_output_album_still_covers_both_orientations(self):
        self.keep_settings()
        response = self.client.put('/settings', json=self.settings_payload(output_album_id='shared'))
        self.assertEqual(response.status_code, 200, response.json)
        handler = self.app.immich_handler
        self.assertEqual((handler.output_album('portrait'), handler.output_album('landscape')), ('shared', 'shared'))

    def test_saved_key_is_never_sent_to_a_different_url(self):
        self.keep_settings()
        before = Path(self.app.config.CONFIG_FILE).read_text()
        response = self.client.put('/settings', json=self.settings_payload(url='http://attacker.example'))
        self.assertEqual(response.status_code, 400)
        self.assertIn('Re-enter the API key', response.json['error'])
        self.assertEqual(Path(self.app.config.CONFIG_FILE).read_text(), before)
        # Album lookups follow the same rule; the setUp guard fails any outbound request.
        albums = self.client.post('/settings/albums', json={'url': 'http://attacker.example', 'api_key': ''})
        self.assertEqual(albums.status_code, 400)
        changed = self.client.put('/settings', json=self.settings_payload(url='http://other:2283', api_key=' new-key '))
        self.assertEqual(changed.status_code, 200, changed.json)
        self.assertEqual(self.app.immich_handler.api_key, 'new-key')

    def test_settings_reject_invalid_values(self):
        self.keep_settings()
        cases = {
            'url': (self.settings_payload(url='ftp://immich'), 'http://'),
            'same albums': (self.settings_payload(output_album_id='source-album'), 'must be different'),
            'no album': (self.settings_payload(input_album_id=' '), 'input album'),
            'split missing one': (self.settings_payload(
                output_album_id='', output_album_portrait_id='album-p'), 'output album for landscape'),
            'split equals input': (self.settings_payload(
                output_album_id='', output_album_portrait_id='source-album',
                output_album_landscape_id='album-l'), 'must be different'),
        }
        size = self.settings_payload()
        size['dimensions']['landscape_size'] = [0, 90]
        cases['size'] = (size, 'Landscape size')
        for label, device in {'device ip': {'name': 'A', 'ip': 'http://x/'},
                              'device name': {'name': '', 'ip': '10.0.0.1'},
                              'duration': {'name': 'A', 'ip': '10.0.0.1', 'preview_duration': 0}}.items():
            payload = self.settings_payload()
            payload['meural']['devices'] = [device]
            cases[label] = (payload, '')
        for label, (payload, message) in cases.items():
            with self.subTest(label):
                response = self.client.put('/settings', json=payload)
                self.assertEqual(response.status_code, 400)
                self.assertIn(message, response.json['error'])
        self.assertEqual(self.app.immich_handler.output_album_id, 'output-album')

    def test_output_thumbnail_is_small_and_per_orientation_upload_state_is_listed(self):
        from io import BytesIO
        from PIL import Image
        self.app.config.SIZES['portrait'] = (1080, 1920)
        self.addCleanup(self.app.config.SIZES.__setitem__, 'portrait', (90, 160))
        self.save()
        full = self.client.get(f'/output/portrait/{ASSET}')
        thumb = self.client.get(f'/output/portrait/{ASSET}?size=thumb')
        self.assertEqual(Image.open(BytesIO(full.data)).size, (1080, 1920))
        self.assertEqual(Image.open(BytesIO(thumb.data)).size, (405, 720))
        self.assertNotEqual(full.headers['ETag'], thumb.headers['ETag'])
        self.files.mark_uploaded(ASSET, 'portrait', 'p', PORTRAIT, (1080, 1920))
        self.assertEqual(self.image()['needs_upload'], {'portrait': False, 'landscape': True})

    def test_frame_finish_defaults_validates_and_reaches_the_page(self):
        self.keep_settings()
        self.assertEqual(self.client.get('/settings').json['settings']['display'], {'frame': 'light-wood'})
        self.assertIn(b'data-frame="light-wood"', self.client.get('/').data)
        payload = self.settings_payload()
        payload['display'] = {'frame': 'mahogany'}
        self.assertEqual(self.client.put('/settings', json=payload).status_code, 400)
        payload['display'] = {'frame': 'black'}
        self.assertEqual(self.client.put('/settings', json=payload).status_code, 200)
        self.assertIn(b'data-frame="black"', self.client.get('/').data)

    def test_sync_interval_is_validated_and_defaults_to_15_minutes(self):
        self.keep_settings()
        for value in (-1, 1441, '15', True, 1.5):
            payload = self.settings_payload()
            payload['sync'] = {'interval_minutes': value}
            with self.subTest(value):
                response = self.client.put('/settings', json=payload)
                self.assertEqual(response.status_code, 400)
                self.assertIn('Sync interval', response.json['error'])
        response = self.client.put('/settings', json=self.settings_payload())
        self.assertEqual(response.json['settings']['sync'], {'interval_minutes': 15})
        payload = self.settings_payload()
        payload['sync'] = {'interval_minutes': 0}
        self.assertEqual(self.client.put('/settings', json=payload).json['settings']['sync'], {'interval_minutes': 0})

    def test_scheduled_sync_follows_the_interval(self):
        settings = self.app.config.settings
        with patch.dict(settings['sync'], interval_minutes=15), \
             patch.object(self.app.jobs, 'last_started', return_value=100.0):
            self.assertFalse(self.app.sync_due(now=100 + 15 * 60 - 1))
            self.assertTrue(self.app.sync_due(now=100 + 15 * 60))
            with patch.object(self.app.config, 'is_configured', return_value=False):
                self.assertFalse(self.app.sync_due(now=10 ** 6))
        with patch.dict(settings['sync'], interval_minutes=0):
            self.assertFalse(self.app.sync_due(now=10 ** 6))
        with patch.dict(settings['sync'], interval_minutes=15), \
             patch.object(self.app.jobs, 'last_started', return_value=None):
            self.assertTrue(self.app.sync_due())

    def test_jobs_endpoint_reports_the_last_finished_sync(self):
        with patch.object(self.app.immich_handler, 'sync_input_images', return_value=[]):
            job = self.run_job('/sync')
        status = self.client.get('/jobs').json
        self.assertEqual((status['running'], status['last_sync']), (None, job['id']))
        with patch.object(self.app.immich_handler, 'sync_input_images', side_effect=RuntimeError('offline')):
            self.run_job('/sync')
        # A failed sync changed nothing, so the page has nothing to refresh.
        self.assertEqual(self.client.get('/jobs').json['last_sync'], job['id'])

    def test_settings_wait_for_running_job(self):
        import threading
        self.keep_settings()
        release = threading.Event()
        job, started = self.app.jobs.start('sync', lambda progress: release.wait(5))
        self.assertTrue(started)
        try:
            response = self.client.put('/settings', json=self.settings_payload())
            self.assertEqual(response.status_code, 409)
            self.assertIn('sync', response.json['error'])
        finally:
            release.set()
            self.app.jobs.join(5)

    def test_album_list_merges_owned_and_shared_albums(self):
        import requests
        calls = []
        def fake(handler, method, endpoint, **kwargs):
            calls.append((handler.base_url, handler.api_key, endpoint, kwargs.get('params')))
            if kwargs.get('params'):
                return [{'id': 'b', 'albumName': 'beta', 'assetCount': 2, 'shared': True},
                        {'id': 'a', 'albumName': 'Alpha', 'assetCount': 1}]
            return [{'id': 'a', 'albumName': 'Alpha', 'assetCount': 1}]
        with patch.object(self.app.ImmichHandler, '_make_request', autospec=True, side_effect=fake):
            response = self.client.post('/settings/albums', json={'url': 'http://127.0.0.1:1/', 'api_key': ''})
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual([album['name'] for album in response.json['albums']], ['Alpha', 'beta'])
        self.assertTrue(response.json['albums'][1]['shared'])
        self.assertEqual({call[:2] for call in calls}, {('http://127.0.0.1:1', 'test-only')})
        rejected = requests.HTTPError(response=Mock(status_code=401))
        with patch.object(self.app.ImmichHandler, '_make_request', side_effect=rejected):
            response = self.client.post('/settings/albums', json={'url': 'http://new:2283', 'api_key': 'bad'})
        self.assertEqual(response.status_code, 400)
        self.assertIn('rejected the API key', response.json['error'])

    def test_editor_preview_is_small_upright_and_original_coordinates_remain_valid(self):
        import io
        from PIL import Image
        path = Path(self.app.config.INPUT_FOLDER) / f'{ASSET}.jpg'
        exif = Image.Exif()
        exif[274] = 6
        Image.new('RGB', (4000, 3000), 'orange').save(path, exif=exif)
        self.assertEqual(self.image()['source_size'], {'width': 3000, 'height': 4000})
        response = self.client.get(f'/editor-image/{ASSET}')
        self.assertEqual(response.status_code, 200)
        with Image.open(io.BytesIO(response.data)) as preview:
            self.assertEqual(preview.size, (1536, 2048))
            self.assertNotIn(274, preview.getexif())
        cached = self.client.get(f'/editor-image/{ASSET}', headers={'If-None-Match': response.headers['ETag']})
        self.assertEqual(cached.status_code, 304)
        crop = {'x': 2000, 'y': 2500, 'width': 900, 'height': 1500}
        self.assertEqual(self.crop(crop=crop).status_code, 200)
        self.assertEqual(self.saved('portrait'), crop)

    def test_render_cache_reuses_bytes_and_invalidates_for_crop_size_source_and_renderer(self):
        from utils import render_cache
        from PIL import Image
        path = Path(self.app.config.INPUT_FOLDER) / f'{ASSET}.jpg'
        with patch.object(render_cache, 'render_image', wraps=render_cache.render_image) as render:
            original, key = render_cache.cached_render(path, PORTRAIT, (90, 160))
            self.assertEqual(render_cache.cached_render(path, PORTRAIT, (90, 160)), (original, key))
            self.assertEqual(render.call_count, 1)
            changed = {**PORTRAIT, 'x': 0}
            self.assertNotEqual(render_cache.cached_render(path, changed, (90, 160))[1], key)
            self.assertNotEqual(render_cache.cached_render(path, PORTRAIT, (45, 80))[1], key)
            Image.new('RGB', (160, 90), 'green').save(path)
            self.assertNotEqual(render_cache.cached_render(path, PORTRAIT, (90, 160))[1], key)
            with patch.object(render_cache, 'RENDERER_VERSION', 2):
                self.assertNotEqual(render_cache.cached_render(path, PORTRAIT, (90, 160))[1], key)
            self.assertEqual(render.call_count, 5)

    def test_preview_upload_and_meural_share_a_single_cached_render(self):
        from utils import render_cache
        self.save(False)
        with patch.object(render_cache, 'render_image', wraps=render_cache.render_image) as render, \
             patch.object(self.app.immich_handler, 'upload_asset', return_value='uploaded'), \
             patch.object(self.app.meural_handler, 'preview_image', return_value={'success': True}):
            first = self.client.get(f'/output/portrait/{ASSET}')
            self.assertEqual(self.client.get(f'/output/portrait/{ASSET}', headers={
                'If-None-Match': first.headers['ETag']}).status_code, 304)
            self.assertEqual(self.complete().status_code, 200)
            self.assertEqual(self.client.post('/meural/preview', json={
                'identifier': ASSET, 'orientation': 'portrait', 'device_ip': '127.0.0.1'}).status_code, 200)
            self.assertEqual(render.call_count, 1)

    def test_render_cache_bounds_disk_usage(self):
        from utils import render_cache
        path = Path(self.app.config.INPUT_FOLDER) / f'{ASSET}.jpg'
        directory = Path(self.app.config.CACHE_DIR, 'renders')
        with patch.object(render_cache, 'MAX_BYTES', 1):
            content, _ = render_cache.cached_render(path, PORTRAIT, (90, 160))
        self.assertTrue(content.startswith(b'\xff\xd8'))
        self.assertEqual(list(directory.glob('*.jpg')), [])

    def test_concurrent_preview_requests_render_once(self):
        from utils import render_cache
        path = Path(self.app.config.INPUT_FOLDER) / f'{ASSET}.jpg'
        with patch.object(render_cache, 'render_image', wraps=render_cache.render_image) as render, \
             ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: render_cache.cached_render(path, PORTRAIT, (90, 160)), range(4)))
        self.assertTrue(all(result == results[0] for result in results))
        self.assertEqual(render.call_count, 1)

    def test_failed_album_attachment_resumes_without_uploading_again(self):
        self.save(False)
        handler = self.app.immich_handler
        with patch.object(handler, '_make_request', return_value={'id': 'new'}) as request, \
             patch.object(handler, 'add_assets_to_album', side_effect=[False, True]):
            self.assertEqual(self.complete().status_code, 500)
            pending = self.files.read_all_crop_metadata()[ASSET]['portrait']['pending_upload']
            self.assertEqual(pending['asset_id'], 'new')
            self.assertFalse(pending['attached'])
            self.assertEqual(self.complete().status_code, 200)
            self.assertEqual(request.call_count, 1)
        state = self.files.read_all_crop_metadata()[ASSET]['portrait']
        self.assertNotIn('pending_upload', state)
        self.assertEqual(state['uploaded']['asset_id'], 'new')

    def test_upload_resume_after_final_local_record_write_fails(self):
        self.save(False)
        handler = self.app.immich_handler
        with patch.object(handler, '_make_request', return_value={'id': 'new'}) as request, \
             patch.object(handler, 'add_assets_to_album', return_value=True) as attach:
            with patch.object(self.app, 'mark_uploaded', side_effect=OSError('disk full')):
                self.assertEqual(self.complete().status_code, 500)
            pending = self.files.read_all_crop_metadata()[ASSET]['portrait']['pending_upload']
            self.assertTrue(pending['attached'])
            self.assertEqual(self.complete().status_code, 200)
            self.assertEqual((request.call_count, attach.call_count), (1, 1))
        self.assertEqual(self.image()['status'], 'completed')

    def test_failed_cleanup_resumes_only_cleanup(self):
        self.save(False)
        handler = self.app.immich_handler
        handler.get_album_assets.return_value = [{'id': 'old', 'originalFileName': f'{ASSET}_portrait.jpg'}]
        with patch.object(handler, '_make_request', return_value={'id': 'new'}) as request, \
             patch.object(handler, 'add_assets_to_album', return_value=True) as attach, \
             patch.object(handler, 'trash_asset', side_effect=[RuntimeError('offline'), None]) as trash:
            self.assertEqual(self.complete().status_code, 500)
            pending = self.files.read_all_crop_metadata()[ASSET]['portrait']['pending_upload']
            self.assertTrue(pending['attached'])
            self.assertEqual(pending['replaces'], 'old')
            self.assertEqual(self.complete().status_code, 200)
            self.assertEqual((request.call_count, attach.call_count, trash.call_count), (1, 1, 2))

    def test_changed_crop_finishes_pending_upload_before_publishing_new_crop(self):
        self.save(False)
        handler = self.app.immich_handler
        with patch.object(handler, '_make_request', side_effect=[{'id': 'first'}, {'id': 'second'}]) as request, \
             patch.object(handler, 'add_assets_to_album', side_effect=[False, True, True]), \
             patch.object(handler, 'trash_asset') as trash:
            self.assertEqual(self.complete().status_code, 500)
            changed = {**PORTRAIT, 'x': 0}
            self.assertTrue(self.files.save_crop(ASSET, 'portrait', changed))
            self.assertEqual(self.complete().status_code, 200)
            self.assertEqual(request.call_count, 2)
            trash.assert_called_once_with('first')
        state = self.files.read_all_crop_metadata()[ASSET]['portrait']
        self.assertEqual(state['uploaded']['crop'], changed)
        self.assertEqual(state['uploaded']['asset_id'], 'second')

    def test_pending_upload_cannot_resume_against_another_server(self):
        self.save(False)
        handler = self.app.immich_handler
        with patch.object(handler, '_make_request', return_value={'id': 'new'}), \
             patch.object(handler, 'add_assets_to_album', return_value=False):
            self.assertEqual(self.complete().status_code, 500)
        with patch.object(handler, 'base_url', 'http://elsewhere'), \
             patch.object(handler, '_make_request') as request:
            self.assertEqual(self.complete().status_code, 500)
            request.assert_not_called()

    def test_cancel_upload_keeps_completed_work_and_retry_only_processes_remaining_images(self):
        import threading
        second = '22222222-2222-4222-8222-222222222222'
        seed_image(self.app, second)
        self.save(False)
        self.files.save_crop(second, 'portrait', PORTRAIT)
        started, release = threading.Event(), threading.Event()
        def upload(*args, **kwargs):
            started.set()
            if not release.wait(5):
                raise TimeoutError('Upload was not released')
            return 'uploaded'
        with patch.object(self.app.immich_handler, 'upload_asset', side_effect=upload) as send:
            response = self.client.post('/upload-all')
            job_id = response.json['job']['id']
            try:
                self.assertTrue(started.wait(3))
                self.assertEqual(self.client.post(f'/jobs/{job_id}/cancel').status_code, 200)
            finally:
                release.set()
                self.app.jobs.join(5)
            job = self.app.jobs.get(job_id)
            self.assertEqual(job['status'], 'cancelled')
            self.assertEqual(job['done'], 1)
            self.assertEqual(job['remaining_assets'], [second])
            self.assertEqual(send.call_count, 1)
            response = self.client.post(f'/jobs/{job_id}/retry')
            self.assertEqual(response.status_code, 202)
            self.app.jobs.join(5)
            self.assertEqual(send.call_count, 2)
            self.assertEqual(send.call_args.args[1], f'{second}_portrait.jpg')
        restored = self.app.JobRunner(str(Path(self.app.config.CONFIG_DIR, 'jobs.json')))
        self.assertEqual(restored.get(job_id)['status'], 'cancelled')
        self.assertGreaterEqual(restored.get(job_id)['elapsed_seconds'], 0)

    def test_failed_images_have_errors_and_retry_excludes_successful_images(self):
        second = '22222222-2222-4222-8222-222222222222'
        seed_image(self.app, second)
        self.save(False)
        self.files.save_crop(second, 'portrait', PORTRAIT)
        with patch.object(self.app.immich_handler, 'upload_asset', side_effect=[RuntimeError('server busy'), 'ok']):
            job = self.run_job('/upload-all')
        self.assertEqual(job['errors'], {ASSET: 'server busy'})
        with patch.object(self.app.immich_handler, 'upload_asset', return_value='retried') as send:
            retried = self.run_job(f"/jobs/{job['id']}/retry")
            self.assertEqual(retried['total'], 1)
            self.assertEqual(retried['errors'], {})
            send.assert_called_once()
            self.assertEqual(send.call_args.args[1], f'{ASSET}_portrait.jpg')

    def test_restart_preserves_unfinished_job_and_monotonic_ids(self):
        path = Path(self.app.config.CONFIG_DIR, 'restart-jobs.json')
        runner = self.app.JobRunner(str(path))
        with patch('threading.Thread.start'):
            job, _ = runner.start('sync', lambda progress: None)
        restored = self.app.JobRunner(str(path))
        self.assertEqual(restored.get(job['id'])['status'], 'interrupted')
        new, started = restored.start('sync', lambda progress: {'images': 0})
        restored.join(3)
        self.assertTrue(started)
        self.assertGreater(new['id'], job['id'])

    def test_job_retry_rejects_changed_settings_and_successful_jobs(self):
        job, _ = self.app.start_job('sync', lambda progress: {'images': 0})
        self.app.jobs.join(3)
        self.assertEqual(self.client.post(f"/jobs/{job['id']}/retry").status_code, 400)
        with patch.dict(self.app.config.settings['immich'], {'output_album_id': 'changed'}):
            self.assertEqual(self.client.post(f"/jobs/{job['id']}/retry").status_code, 409)
        self.assertEqual(self.client.post('/jobs/99999/cancel').status_code, 404)

    def test_sync_failures_record_image_errors_and_targeted_retry_preserves_other_cache_entries(self):
        handler = self.app.immich_handler
        second = '22222222-2222-4222-8222-222222222222'
        handler.get_album_assets.return_value = [{'id': ASSET}, {'id': second}]
        with patch.object(handler, 'download_asset', return_value=(False, 'download timed out')):
            job = self.run_job('/sync')
        self.assertEqual(job['status'], 'failed')
        self.assertEqual(job['errors'], {second: 'download timed out'})
        def download(asset, folder):
            seed_image(self.app, asset)
            return True, str(Path(folder, f'{asset}.jpg'))
        with patch.object(handler, 'download_asset', side_effect=download) as fetch:
            retried = self.run_job(f"/jobs/{job['id']}/retry")
        self.assertEqual(retried['status'], 'done')
        self.assertEqual(retried['total'], 1)
        fetch.assert_called_once_with(second, self.app.config.INPUT_FOLDER)
        self.assertIsNotNone(self.files.get_image(ASSET))

    def test_sync_cancellation_skips_queued_downloads_and_keeps_in_flight_result(self):
        import threading
        second = '22222222-2222-4222-8222-222222222222'
        third = '33333333-3333-4333-8333-333333333333'
        started, release = threading.Event(), threading.Event()
        handler = self.app.immich_handler
        handler.get_album_assets.return_value = [{'id': ASSET}, {'id': second}, {'id': third}]
        def download(asset, folder):
            started.set()
            if not release.wait(5):
                raise TimeoutError('Download was not released')
            seed_image(self.app, asset)
            return True, str(Path(folder, f'{asset}.jpg'))
        with patch.object(handler, 'download_asset', side_effect=download) as fetch:
            job, _ = self.app.start_job('sync', lambda progress: {
                'images': len(handler.sync_input_images(self.app.config.INPUT_FOLDER, progress, workers=1))})
            try:
                self.assertTrue(started.wait(3))
                self.assertEqual(self.client.post(f"/jobs/{job['id']}/cancel").status_code, 200)
            finally:
                release.set()
                self.app.jobs.join(5)
            finished = self.app.jobs.get(job['id'])
            self.assertEqual(finished['status'], 'cancelled')
            self.assertEqual(finished['remaining_assets'], [third])
            self.assertEqual(finished['done'], 2)
            fetch.assert_called_once_with(second, self.app.config.INPUT_FOLDER)
        self.assertIsNotNone(self.files.get_image(second))

    def test_http_sessions_reuse_connections_per_thread(self):
        import threading
        from utils.http_client import HttpClient
        session = HttpClient().session
        first = session()
        self.assertIs(first, session())
        sessions = []
        def other_thread():
            sessions.extend([session(), session()])
        thread = threading.Thread(target=other_thread)
        thread.start()
        thread.join(3)
        self.assertIs(sessions[0], sessions[1])
        self.assertIsNot(first, sessions[0])
        self.assertIsNot(first, HttpClient().session())
        self.assertEqual(first.get_adapter('http://').max_retries.total, 0)

    def test_missing_config_starts_unconfigured(self):
        config = self.app.config
        with patch.object(config, 'CONFIG_FILE', str(Path(self.temporary.name) / 'missing.yaml')):
            defaults = config.load_settings()
        self.assertEqual(defaults, config.DEFAULT_SETTINGS)
        self.assertFalse(config.is_configured(defaults))
        with self.assertRaisesRegex(RuntimeError, 'not configured'):
            self.app.ImmichHandler(defaults['immich']).get_album_assets('album')
        with patch.object(config, 'is_configured', return_value=False):
            self.assertEqual(self.app.initial_sync(), (None, False))


if __name__ == '__main__':
    unittest.main()
