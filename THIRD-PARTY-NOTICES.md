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

## npm dependencies

Runtime and build dependencies are fetched from the npm registry at install
time (they are **not** vendored in this repository). Each is distributed under
its own license — predominantly MIT, Apache-2.0, ISC, and BSD. See each
package's entry in `node_modules/<pkg>/LICENSE` after `npm install`, or
`package.json` / `package-lock.json` for the dependency list.

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) is published by
Anthropic; see its own license terms on npm / its documentation.

## Character artwork

The pixel character art (`src/renderer/public/manager.png`,
`src/renderer/public/overlay-face.png`) was created by the project author and is
covered by this project's MIT License.

## Acknowledgements

Lain's self-improvement and journaling architecture was inspired by the
**Hermes** agent (MIT). The implementation here is an independent, clean-room
reimplementation — no source code was copied.
