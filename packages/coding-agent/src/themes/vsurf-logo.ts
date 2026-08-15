/**
 * Pre-rendered ASCII versions of the vsurf logo mark.
 *
 * Source: assets/brand/vsurf-mark.svg
 * Re-render at any width: `uv run scripts/render-logo.py --width N`
 */

/** ~14 rows × 42 cols. The default brand mark — half-block </>, splash-ready. */
export const VSURF_LOGO = `         ▄▄▄▄             ▄▄▄    ▄▄▄▄
       ▄██████           ▄████  ██████▄
      ▄██████           ▄████▀   ██████▄
    ▄██████▀           ▄████▀     ▀██████▄
  ▄██████▀            ▄█████        ▀██████▄
 ▄█████▀              █████           ▀█████▄
██████▀              █████             ▀██████
██████▄             █████              ▄██████
 ▀█████▄           █████              ▄█████▀
  ▀██████▄        █████▀            ▄██████▀
    ▀██████▄     ▄████▀           ▄██████▀
      ▀██████   ▄████▀           ██████▀
       ▀██████  ████▀           ██████▀
         ▀▀▀▀    ▀▀▀             ▀▀▀▀`;

/** 7 rows × 22 cols. Compact mark for the chat header — sized to sit beside the version/model/cwd block. */
export const VSURF_LOGO_SMALL = `    ▄▄▄     ▄▄ ▄▄▄
   ███      ██  ███
 ▄██▀      ██    ▀██▄
███       ██       ███
 ▀██▄    ██      ▄██▀
   ███  ██      ███
    ▀▀▀ ▀▀     ▀▀▀`;
