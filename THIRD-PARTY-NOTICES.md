# Third-Party Notices

Lain itself is released under the [MIT License](LICENSE). It bundles or builds
upon the third-party works listed below, each under its own license.

## Bundled fonts (`src/renderer/fonts/`)

| Font | License | Copyright | Full text |
|---|---|---|---|
| Hack (`Hack-*.ttf`) | MIT + Bitstream Vera + DejaVu (public domain) | © 2018 Source Foundry Authors; © 2003 Bitstream Inc. | [LICENSE-Hack.txt](src/renderer/fonts/LICENSE-Hack.txt) |
| MonoplexKR (`MonoplexKR-*.ttf`) | SIL Open Font License v1.1 | © 2021 Kim Yangsu — Reserved Font Name "Monoplex", "Monoplex KR" | [LICENSE-MonoplexKR.txt](src/renderer/fonts/LICENSE-MonoplexKR.txt) |

- Hack — https://github.com/source-foundry/Hack
- MonoplexKR — https://github.com/y-kim/monoplex

## Bundled icons (`src/renderer/components/icons.tsx`)

The `Icon` component inlines 40 icons (caret-left/right, calendar, x-circle, gear,
bell, pin, trash, plus, check, send, eye, eye-off, refresh, book-open, clock, tag,
chevron-down/up/left/right, menu, magnifier, play, pause, stop, paperclip, image,
folder, bookmark, globe, key, restore, microphone, mic-off, volume, volume-off,
chart, branch, window) sourced from **Reicon** — MIT License, Copyright (c) 2025
Dev Chauhan (<https://github.com/dqev/reicon>). The SVG path data is embedded as-is;
no source code from the reicon package itself is used.

```
MIT License

Copyright (c) 2025 Dev Chauhan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## npm dependencies

Runtime and build dependencies are fetched from the npm registry at install
time (they are **not** vendored in this repository). Each is distributed under
its own license — predominantly MIT, Apache-2.0, ISC, and BSD. See each
package's entry in `node_modules/<pkg>/LICENSE` after `npm install`, or
`package.json` / `package-lock.json` for the dependency list.

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) is published by
Anthropic; see its own license terms on npm / its documentation.

## Text-to-speech — Supertonic (`sidecar/supertonic/`)

Lain bundles a Node sidecar running **Supertonic** (Supertone Inc.) for on-device Korean TTS:

- Inference code (`helper.js`): **MIT** © 2025 Supertone Inc. — see `sidecar/supertonic/LICENSE`.
- Model assets (voice styles + config under `sidecar/supertonic/`, and the ONNX models
  downloaded at first use from <https://huggingface.co/Supertone/supertonic-3>):
  **OpenRAIL-M** © Supertone Inc. — commercial use & redistribution permitted, subject to
  use-based restrictions passed through to downstream users. See `sidecar/supertonic/NOTICE.md`.
- Upstream: <https://github.com/supertone-inc/supertonic>

## Character artwork

The pixel character art (`src/renderer/public/manager.png`,
`src/renderer/public/overlay-face.png`) was created by the project author and is
covered by this project's MIT License.

## Acknowledgements

Lain's self-improvement and journaling architecture was inspired by the
**Hermes** agent (MIT). The implementation here is an independent, clean-room
reimplementation — no source code was copied.
