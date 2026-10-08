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
pytest
```

The tests mock the device completely. `tests/test_protocol.py` covers crypto,
framing and ADPCM, and runs full talk sessions (wrong password, discovery,
channel guard, talk round trip with TalkReset, waking a sleeping camera) against
the in-process mock NVR in `tests/mock_nvr.py` on 127.0.0.1. No test sends audio
anywhere and no test needs a real camera.

Hassfest runs in CI. To run it locally, from a Home Assistant core checkout:

```bash
python -m script.hassfest --integration-path /path/to/custom_components/reolink_camera_audiohook
```

### Testing on real hardware

Test real devices through Home Assistant itself: copy
`custom_components/reolink_camera_audiohook/` into a test instance, set up the
integration, and call `reolink_camera_audiohook.say` from *Developer tools →
Actions* on a camera you are allowed to make noise with. Mention the device and
camera models you tested with in the pull request.

Never commit credentials, IP addresses of real devices, camera names, snapshots
or recordings.

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
`brands` check accepts this folder. The
[home-assistant/brands](https://github.com/home-assistant/brands) repository no
longer accepts custom integrations, so this folder is the only place for them.

## Releases

1. Update `version` in `manifest.json` and `CHANGELOG.md`.
2. Run `pytest` and hassfest (CI does both).
3. Create a GitHub release (HACS uses releases).
