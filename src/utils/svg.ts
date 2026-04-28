// src/utils/svg.ts
//
// Minimal SVG sanitiser for icons fed into dangerouslySetInnerHTML.
//
// Today, icons are only created by the user inside the panel — but they're
// stored verbatim in macros.json and a future "import profile pack" / paste-
// from-clipboard / marketplace flow would happily ship a hostile <svg> with
// `onload`, `<script>`, or `javascript:` URLs. CEP runs with --enable-nodejs
// so that's effectively code execution.
//
// We strip three things:
//   - <script> elements (and their content)
//   - on* event-handler attributes
//   - href / xlink:href values that begin with "javascript:" or "data:" (the
//     latter because data: SVGs can themselves carry script)

const SCRIPT_TAG_RE = /<script\b[\s\S]*?<\/script\s*>/gi;
const SELF_CLOSING_SCRIPT_RE = /<script\b[^>]*\/>/gi;
const ON_ATTR_RE = /\son[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_HREF_RE = /\s(href|xlink:href)\s*=\s*(?:"\s*(?:javascript|data):[^"]*"|'\s*(?:javascript|data):[^']*'|\s*(?:javascript|data):[^\s>]+)/gi;

/** Returns a sanitised copy of an SVG string. Non-SVG input passes through
 * unchanged — callers branch on `startsWith('<svg')` already. */
export function sanitizeSvg(input: string): string {
  if (!input) return input;
  return input
    .replace(SCRIPT_TAG_RE, '')
    .replace(SELF_CLOSING_SCRIPT_RE, '')
    .replace(ON_ATTR_RE, '')
    .replace(JS_HREF_RE, '');
}
