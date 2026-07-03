# Bundled binaries — Motion GIFS panel

The Motion GIFS panel shells out to **ffmpeg** and **gifski** via Node
(`src/utils/gifExport.ts`), locating them relative to the extension root
(`SystemPath.EXTENSION`) under this folder:

```
bin/
├── win/
│   ├── ffmpeg.exe
│   └── gifski.exe
└── mac/
    ├── ffmpeg
    └── gifski
```

## Getting the binaries

- **ffmpeg** — https://ffmpeg.org/download.html (a static build; only the
  `ffmpeg` executable is needed, not `ffprobe`/`ffplay`).
- **gifski** — https://gif.ski / https://github.com/ImageOptim/gifski

Drop the executables into the matching platform folder. They are **not** checked
into git (see `.gitignore`); each dev/CI machine provides them, and they are
included when the extension is packaged into a `.zxp`.

On macOS the executables need the executable bit; `resolveBinaries()` restores
it with `chmod 0755` on first run in case ZXP zipping stripped it.

## Output-module templates

The native "Export active comp" flow renders through AE output-module templates
carried in `templates/gipher_templates.aepx` (git-tracked, unlike these
binaries). The host script (`giphRenderComp` in `jsx/hostscript.jsx`) imports
that project on first use and registers the `GIPHER_*` templates into the user's
AE. The `GIPHER_*` names are kept from the original script on purpose.

## Licensing (free distribution)

- ffmpeg: LGPL/GPL — ship the license text; for GPL builds, make source available.
- gifski: AGPL-3.0 — the panel is distributed free and its source is available,
  which satisfies AGPL copyleft. Keep the source public to stay compliant.
