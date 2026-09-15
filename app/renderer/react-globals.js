// react-globals.js — React and ReactDOM arrive as UMD globals from
// dist/vendor (loaded by index.html), not as bundled modules. Re-exporting
// them here keeps the bundle small and lets every source file use a plain
// import instead of reaching for `window`.

export const React = window.React;
export const ReactDOM = window.ReactDOM;
