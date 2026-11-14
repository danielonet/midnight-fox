# Privacy policy

Midnight Fox does not collect, store or transmit any personal data.

- **No network requests.** The extension never contacts any server. It has no
  analytics, telemetry, crash reporting, ads or remote code.
- **No page content leaves your browser.** The content script only reads the
  colours of elements so it can restyle them locally.
- **Language detection is local.** The popup picks its language from your Firefox
  UI language; no location or network lookup is involved.
- **Settings stay on your device.** Your theme, sliders and per-site choices are
  stored with `storage.local` in your Firefox profile. They are not synced and
  not shared.
- **No third parties.** There are no external libraries or services at runtime.

The manifest declares `data_collection_permissions: none`, which Firefox shows
at install time.

Questions: open an issue at <https://github.com/danielonet/midnight-fox/issues>.
