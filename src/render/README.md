# Card Renderer

## Install

```bash
npm install
```

## Fonts

Place any local font files in:

- `assets/fonts/*.ttf`
- `assets/fonts/*.otf`
- `assets/fonts/*.woff`
- `assets/fonts/*.woff2`

The renderer logs which font is chosen for each role (`headline`, `numbers`, `stats`) from configured fallback stacks.

## Run

```bash
npm run render:cards
```

This writes PNGs to `output/`:

- `output/week_result_<matchId>.png`
- `output/mvp_<matchId>.png`

## Tuning

Adjust style constants in `src/render/config.js`:

- `strokeScale`
- `shadowBlur`
- `shadowOffsetX`, `shadowOffsetY`
- `skewX`
- `gradientTop`, `gradientBottom`
- `letterSpacing` per role

## Notes

- Renderer uses supersampling (`SCALE=2`) and downscales to `1024x1024` for cleaner outlines.
- Output is deterministic for identical inputs and assets.
