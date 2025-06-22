1. Fix the portrait/landscape icons which indicate if metadata exists for that type
2. Better align metadata with immich on sync. As in, we should add keys to each orientation to determine if it's been deleted from immich
3. Delete images from immich when skipped, but ONLY should the image already exist in the destination album.
4. Add a `Manage` button next to the sync and upload all buttons. If clicked, a full screen modal appears containing the following:
  - A 3 column table with the following columns:
    - Original Image
    - Portrait Image
    - Landscape Image
  - Under Portrait and Landscape, there should be 3 buttons - one to delete the image, one to reupload it, and another to recrop it - which closes the modal and opens the appropriate crop page.
  - Under Original, there should be a button to delete it. Not from the destination album, but from the source album