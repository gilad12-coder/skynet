// Turbopack loader for @codingame/monaco-vscode-* JavaScript files (see
// next.config.ts). Those files load each stylesheet with
// `import * as name from './x.css'` and then call `registerCss(name)`.
// From Next 16.4, Turbopack fails the build on a namespace import of a global
// stylesheet ("non-ecmascript placeable asset"). This loader rewrites each one
// to a side-effect import plus an empty object. The stylesheet stays global,
// and `registerCss` still gets an object without a `default`, so it does
// nothing, as it did on Next 16.3.
const CSS_NAMESPACE_IMPORT = /import \* as ([A-Za-z_$][\w$]*) from ('[^'\n]+\.css');/g;

module.exports = function monacoCssImportLoader(source) {
  return source.replace(CSS_NAMESPACE_IMPORT, "import $2; const $1 = {};");
};
