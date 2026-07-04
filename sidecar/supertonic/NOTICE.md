# Supertonic — third-party components bundled in Lain

Lain bundles a small Node sidecar that runs **Supertonic** (by Supertone Inc.) for
on-device Korean text-to-speech.

- **Inference code** (`helper.js`): MIT License © 2025 Supertone Inc. — see `LICENSE`.
- **Model assets** — voice styles (`voice_styles/*.json`), config (`vendor-onnx/*.json`),
  and the ONNX model files downloaded on first use from
  <https://huggingface.co/Supertone/supertonic-3> : **OpenRAIL-M License** © Supertone Inc.

  OpenRAIL-M permits commercial use and redistribution **subject to use-based
  restrictions** (the model must not be used for the enumerated harmful purposes), and
  those restrictions must be passed through to downstream users.

Upstream: <https://github.com/supertone-inc/supertonic>
