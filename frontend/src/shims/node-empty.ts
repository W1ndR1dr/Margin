/**
 * Empty stand-in for node built-ins (`fs`, `path`, `url`) that only appear on
 * dead branches of emscripten codec glue and vtk.js XML IO. Importing them in
 * the browser must not throw; nothing in Margin ever calls them.
 */
const notAvailable = (name: string) => () => {
  throw new Error(`node "${name}" is not available in the browser`);
};

export const readFileSync = notAvailable('fs.readFileSync');
export const existsSync = (): boolean => false;
export const join = (...parts: string[]): string => parts.filter(Boolean).join('/');
export const resolve = join;
export const dirname = (p: string): string => p.slice(0, Math.max(p.lastIndexOf('/'), 0));
export const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
export const normalize = (p: string): string => p;
export const sep = '/';

/** `url` is only used for its WHATWG classes, which the browser already has. */
export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;
export const fileURLToPath = (u: string): string => String(u).replace(/^file:\/\//, '');
export const pathToFileURL = (p: string): string => `file://${p}`;
export const parse = (u: string): unknown => {
  try {
    return new globalThis.URL(u);
  } catch {
    return {};
  }
};
export const format = (u: unknown): string => String(u);

export default {
  readFileSync,
  existsSync,
  join,
  resolve,
  dirname,
  basename,
  normalize,
  sep,
  URL,
  URLSearchParams,
  fileURLToPath,
  pathToFileURL,
  parse,
  format,
};
