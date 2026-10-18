1. Reconcile upload records with Immich on sync: if an orientation's `uploaded.asset_id`
   is no longer in the destination album (deleted in Immich), clear that record so the
   image shows as pending again. The record lives in `crops/metadata.json`.
2. When a crop is skipped (or deleted in Manage) and it was already uploaded, also remove
   the uploaded copy from the destination album. Only act when the upload record's
   `asset_id` is actually in the destination album; use `ImmichHandler.trash_asset`.

Done: status icons per orientation, the Manage modal, re-crop from Manage.
