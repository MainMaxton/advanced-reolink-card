# Contributing

## Tests

```bash
pip install -r requirements_test.txt
pytest
```

The tests mock the device completely; `tests/test_protocol_mock.py` runs the
Baichuan client against an in-process mock server on 127.0.0.1. No test sends
audio anywhere. Hassfest and the HACS action run in GitHub Actions
(`.github/workflows/validate.yml`).

Never commit credentials, IP addresses of real devices or camera names. The
scripts in `scripts/` read the device address, user and password from the
environment.

## Brand assets (icon and logo)

The artwork is original (a camera with sound waves) and must not be replaced by
Reolink's trademarked logo. Sources are in `docs/brand/*.svg` (the logos use the
Inter font).

Home Assistant 2026.3 and newer load brand images straight from the integration:

```
custom_components/reolink_camera_audiohook/brand/
  icon.png        256 x 256     icon@2x.png       512 x 512
  logo.png        708 x 128     logo@2x.png      1416 x 256
  dark_logo.png   708 x 128     dark_logo@2x.png 1416 x 256
```

All PNGs are transparent, trimmed and optimised (oxipng). The HACS action's
`brands` check accepts this folder, so it is no longer skipped in the workflow.

`brands/custom_integrations/reolink_camera_audiohook/` holds the same files laid
out for a pull request to
[home-assistant/brands](https://github.com/home-assistant/brands), which is what
Home Assistant older than 2026.3 (and the HACS store listing) use. Note that the
brands repository has stopped accepting new custom-integration submissions since
local brand images were introduced, so a PR may be closed; the local `brand/`
folder is the supported way. If you still try it:

1. Fork home-assistant/brands and copy the folder to
   `custom_integrations/reolink_camera_audiohook/`.
2. PR title: `Add Reolink Camera AudioHook custom integration`.
3. PR body: "Brand images for the custom integration `reolink_camera_audiohook`
   (<repository URL>). Original artwork, not the Reolink logo."

## Releases

1. Update `version` in `manifest.json` and `CHANGELOG.md`.
2. Run `pytest` and hassfest (CI does both).
3. Create a GitHub release (HACS uses releases).
