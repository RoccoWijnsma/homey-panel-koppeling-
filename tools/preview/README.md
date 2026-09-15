# Preview tooling

Headless Chromium harnesses that render the app's own HTML with synthetic data. They exist so the
dashboard, the widget and the store artwork can be reviewed and regenerated without a Homey.

```bash
npm install
npx playwright install chromium      # or set CHROMIUM_PATH to an existing browser

npm run preview                      # dashboard + interaction screenshots -> tools/preview/out/
npm run assets                       # regenerates the committed PNG assets and widget previews
```

| Script | What it renders |
|---|---|
| `dashboard.js` | `settings/index.html` at phone and desktop width, light and dark |
| `interactions.js` | The hover tooltip, the devices and settings tabs, the 24 hour range |
| `widget.js` | `widgets/energy-timeline/public/index.html` into the committed `preview-*.png` |
| `assets.js` | The app store tile and the driver image, at every size Homey requires |
| `mock.js` | The synthetic household all of the above draw: base load, a solar arc, appliance bursts and a cloud bank that coincides with the air conditioner starting |

`dashboard.js` also holds the `Homey` stub (settings bridge + fake Web API responses) that
`interactions.js` reuses, so both pages boot exactly as they do inside Homey.

Both `assets.js` and `widget.js` **overwrite committed files**. Review the diff before committing:
the PNGs are deterministic apart from the mock's small random jitter in the load curve.
