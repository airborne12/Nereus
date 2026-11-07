// Vite plugin: the licenses of the npm packages bundled into a build. MIT and similar licenses ask
// that copies carry the notice, and these bundles are copies: the app is served to browsers and
// the SDK is loaded by other people's sites.
//
// The packages are the ones Rollup actually put into the chunks (not every dependency), each with
// name, version, license and the text of its LICENSE file.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';

const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md', 'LICENCE', 'LICENCE.md'];

/** License texts for packages published without one, taken from their repositories (build/licenses). */
const VENDORED: [RegExp, string][] = [[/^(rrweb|rrweb-snapshot|rrdom|@rrweb\/.+)$/, 'rrweb.txt']];

interface Pkg { name: string; version: string; license?: string; dependencies?: Record<string, string> }

const readPkg = (dir: string) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Pkg;

function describe(dir: string): string {
  const pkg = readPkg(dir);
  const file = LICENSE_FILES.map((f) => join(dir, f)).find((f) => existsSync(f));
  const vendored = VENDORED.find(([re]) => re.test(pkg.name));
  const text = file ? readFileSync(file, 'utf8').trim()
    : vendored ? readFileSync(new URL(`./licenses/${vendored[1]}`, import.meta.url), 'utf8').trim()
    : `(no license file in the package; license: ${pkg.license ?? 'unknown'})`;
  return `${pkg.name}@${pkg.version} (${pkg.license ?? 'see below'})\n\n${text}`;
}

/** Where Node would find package `name` from `dir`: its own node_modules, then each parent's. */
function resolvePackage(dir: string, name: string): string | null {
  for (let d = dir; ; d = dirname(d)) {
    const candidate = join(d, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(d) === d) return null;
  }
}

/**
 * The packages and, transitively, their runtime dependencies: a package's own dist may inline
 * its dependencies (rrweb does), so they are in the bundle without being modules of their own.
 * Type-only packages are left out.
 */
function withDependencies(dirs: Set<string>): Set<string> {
  const all = new Set<string>();
  const visit = (dir: string) => {
    if (all.has(dir)) return;
    all.add(dir);
    for (const dep of Object.keys(readPkg(dir).dependencies ?? {})) {
      if (dep.startsWith('@types/')) continue;
      const d = resolvePackage(dir, dep);
      if (d) visit(d);
    }
  };
  for (const d of dirs) visit(d);
  return all;
}

/**
 * Writes `fileName` next to the build output; with `banner`, also prepends the same text as a
 * legal comment to that chunk (for single-file bundles such as the SDK).
 */
export function thirdPartyLicenses(opts: { fileName: string; banner?: { chunk: string; title: string } }): Plugin {
  return {
    name: 'third-party-licenses',
    apply: 'build',
    generateBundle(_options, bundle) {
      const dirs = new Set<string>();
      for (const out of Object.values(bundle)) {
        if (out.type !== 'chunk') continue;
        for (const id of out.moduleIds) {
          // The last node_modules/<name> or node_modules/@scope/<name> in the path is the package.
          const m = /^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(id.replace(/^\0/, ''));
          if (m) dirs.add(m[1]!);
        }
      }
      const entries = [...withDependencies(dirs)].map(describe).sort((a, b) => a.localeCompare(b));
      const text = entries.join(`\n\n${'-'.repeat(78)}\n\n`) + '\n';
      this.emitFile({ type: 'asset', fileName: opts.fileName, source: text });
      if (opts.banner) {
        const chunk = Object.values(bundle).find((o) => o.type === 'chunk' && o.fileName === opts.banner!.chunk);
        if (!chunk || chunk.type !== 'chunk') throw new Error(`third-party-licenses: no chunk ${opts.banner.chunk}`);
        // A /*! legal comment; "*/" inside a license text must not end it early.
        chunk.code = `/*!\n * ${opts.banner.title}\n *\n * Bundled third-party code and its licenses:\n *\n${text.replace(/\*\//g, '* /').split('\n').map((l) => ` * ${l}`.trimEnd()).join('\n')}\n */\n${chunk.code}`;
      }
    },
  };
}
