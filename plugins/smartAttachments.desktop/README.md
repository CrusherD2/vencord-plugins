# SmartAttachments

Compress oversized videos locally and add download links for external file transfers.

> Made by [joobert](https://github.com/joobert). Licensed under GPL-3.0 like the rest of this repository.

## Features

- Videos over the upload limit are compressed locally with FFmpeg so they fit in Discord.
- Files that are still too large (and optionally any non-video file) are uploaded to an external host, and a download link is added to your message.
- Choose between **Gofile** (supports `.exe`, configurable expiry), **Filebin** (up to 7 days) and **Litterbox** (configurable expiry).
- Review and rename files before they are sent.
- A progress window, plus a **Transfer History** to revoke Gofile links you created.
- Adds an upload button to the chat bar.

## Requirements

- **Desktop only** (Discord desktop app or Vesktop).
- Video compression needs **FFmpeg and FFprobe**. On Windows:

  ```
  winget install --id Gyan.FFmpeg --exact --source winget
  ```

  Then restart Discord.

## Settings

| Setting | Description |
| --- | --- |
| External Uploads | Include non-video files in external uploads. Gofile also handles `.exe` files. |
| Size Policy | Match the current chat's Discord limit, or always target 20 MB. |
| Transfer Provider | Gofile, Filebin or Litterbox. |
| Expiry | Default link expiry for Gofile and Litterbox. You can change it for each batch. |

## Privacy

Files routed to an external host are uploaded to that service and anyone with the link can download them until it expires.
