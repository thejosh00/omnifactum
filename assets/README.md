# Logo

An open ring — the `o` of omnifactum, and the loop a GTD list runs in — broken at the
upper right, where the check mark's long arm passes out through the gap. Monoline,
round caps, one stroke weight throughout, so the mark and the wordmark read as one
drawing.

| File | For |
| --- | --- |
| `logo.svg` | The icon. 256×256, self-contained dark tile, so it sits on any background. |
| `logo-mono.svg` | The mark alone, no tile, `stroke="currentColor"`. Inline it and set `color`. |
| `wordmark-light.svg` | Mark plus name, for light backgrounds. |
| `wordmark-dark.svg` | The same, for dark backgrounds. |

Colours: tile `#1B1F2E`, ring `#E8EAF0`, check `#34D399`, wordmark `#16181D` on light
and `#E8EAF0` on dark.

The wordmark letters are drawn as paths, not text, so nothing depends on a font being
installed. Editing the name means editing the geometry.

For a README header that follows the reader's theme:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/wordmark-dark.svg">
  <img alt="omnifactum" src="assets/wordmark-light.svg" width="420">
</picture>
```

`logo-mono.svg` is the one to use anywhere the colour has to come from context — a
favicon mask, print, or a single-colour terminal render. It reads down to about 16px;
below that, drop the ring gap before you drop the ring.
