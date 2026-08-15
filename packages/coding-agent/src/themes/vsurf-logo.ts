/**
 * Pre-rendered ASCII versions of the vsurf logo mark.
 *
 * Source: assets/brand/vsurf-mark.svg
 * Re-render at any width: `uv run scripts/render-logo.py --width N`
 */

/** ~10 rows × 38 cols. The default brand mark — half-block </>, splash-ready. */
export const VSURF_LOGO = `       ▄█▄         ▄█▄  ▄█▄
     ▄████        ████  ████▄
   ▄████▀        ████    ▀████▄
  ▄███▀         ▄███▀      ▀███▄
▄████▀         ▄███▀        ▀████▄
▀████▄        ▄███▀         ▄████▀
  ▀███▄      ▄███▀         ▄███▀
   ▀████▄    ████        ▄████▀
     ▀████  ████        ████▀
       ▀█▀  ▀█▀         ▀█▀`;

/** 5 rows × 17 cols. Compact mark for the chat header — same height as the version/model/cwd block. */
export const VSURF_LOGO_SMALL = `  ▄██    ██ ██▄
 ███▀   ███ ▀███
███    ███    ███
 ███▄ ███   ▄███
  ▀██ ██    ██▀`;
