# Contributing

Thanks for helping! Bug reports, ideas and pull requests are welcome. By taking
part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Please report
security problems privately (see [SECURITY.md](SECURITY.md)), not in issues.

## Issues

- Use the issue forms (bug report / feature request).
- **Never post secrets or private camera data**: no passwords, IP addresses,
  serial numbers / UIDs, camera names, snapshots or recordings. Diagnostics from
  Home Assistant (*Download diagnostics*) redact the password, username, address
  and device IDs; check them anyway before attaching.
- Debug logs: enable `custom_components.reolink_camera_audiohook: debug` under
  `logger:` and redact addresses and names in what you paste.

## Pull requests

1. Fork the repository and create a branch from `main`
   (for example `fix/sleeping-doorbell-timeout`).
2. Make your change with tests (see below). Keep user-facing text in
   `strings.json` and mirror it in `translations/en.json`.
3. Update `README.md` and `CHANGELOG.md` (under an *Unreleased* heading at the top) when
   behaviour changes.
4. Open a pull request against `main` and fill in the template.
5. Use a [Conventional Commits](https://www.conventionalcommits.org/) title, for
   example `fix: wake battery cameras before TalkConfig`, `feat: ...`,
   `docs: ...`, `test: ...`, `ci: ...`, `build: ...`, `refactor: ...`. PRs are
   squash-merged, so the PR title becomes the commit message on `main`.

`main` is protected: changes land only through pull requests that pass CI
(`Hassfest`, `Tests`, and `HACS validation` once the repository is public) and
have an approving review from a code owner. Workflows from first-time
contributors' forks start after a maintainer approves them.

## Tests

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements_test.txt
pytest                              # flows, actions, entities, protocol mock
python scripts/offline_checks.py    # ADPCM and talk flow against a mock device
```

The tests mock the device completely; `tests/test_protocol_mock.py` runs the
Baichuan client against an in-process mock server on 127.0.0.1. No test sends
audio anywhere and no test needs a real camera.

Hassfest runs in CI. To run it locally, from a Home Assistant core checkout:

```bash
python -m script.hassfest --integration-path /path/to/custom_components/reolink_camera_audiohook
```

Never commit credentials, IP addresses of real devices or camera names. The
scripts in `scripts/` read the device address, user and password from the
environment, and `scripts/test_talk.py say` only plays on a channel passed with
`--allow-channel`.

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
