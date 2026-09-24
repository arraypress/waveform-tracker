// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * Guards the packaging contract: the manifest's entry points, the build
 * scripts that produce them, and that the CommonJS bundle actually exports the
 * tracker. The behaviour tests import `src/`, so a broken `main` (the IIFE
 * build used to be `main`, and `require()` of it returns `{}`) only surfaces
 * once someone installs the tarball.
 *
 * Runs in node rather than jsdom: esbuild's JS/CLI and `require()` are Node
 * APIs, and the CJS bundle must load without a DOM.
 */

// vitest sets the cwd to the package root.
const root = process.cwd();
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

/** @param {string} script - An esbuild command line. */
const outfileOf = (script) => script.match(/--outfile=(\S+)/)?.[1];

describe('package manifest', () => {
	it('reads the manifest it means to assert against', () => {
		expect(pkg.name).toBe('@arraypress/waveform-tracker');
	});

	it('marks the package as ESM so Node loads the .esm.js entry without guessing', () => {
		expect(pkg.type).toBe('module');
	});

	it('points main/require at the CJS build and module/import at the ESM build', () => {
		expect(pkg.main).toBe('dist/waveform-tracker.cjs');
		expect(pkg.module).toBe('dist/waveform-tracker.esm.js');
		expect(pkg.exports['.']).toMatchObject({
			import: './dist/waveform-tracker.esm.js',
			require: './dist/waveform-tracker.cjs',
		});
		expect(pkg.exports['./dist/*']).toBe('./dist/*');
		expect(pkg.exports['./src/*']).toBe('./src/*'); // shipped in `files`; don't break deep imports
		expect(pkg.exports['./package.json']).toBe('./package.json');
	});

	it('builds every file the manifest names', () => {
		expect(pkg.scripts['build:cjs']).toContain('--format=cjs');
		expect(outfileOf(pkg.scripts['build:cjs'])).toBe(pkg.main);
		expect(outfileOf(pkg.scripts['build:esm'])).toBe(pkg.module);
		expect(pkg.scripts.build).toContain('build:cjs');
	});

	it('tests and rebuilds before publishing, so a stale dist cannot ship', () => {
		expect(pkg.scripts.prepublishOnly).toBe('npm test && npm run build');
	});
});

describe('CommonJS bundle', () => {
	it('exports the tracker singleton to require()', () => {
		const dir = mkdtempSync(join(tmpdir(), 'waveform-tracker-'));
		try {
			// Build with the real script, redirected to a scratch file, so the
			// test checks the published build without touching dist/.
			const outfile = join(dir, 'waveform-tracker.cjs');
			const script = pkg.scripts['build:cjs']
				.replace(/^esbuild\b/, resolve(root, 'node_modules/.bin/esbuild'))
				.replace(/--outfile=\S+/, `--outfile=${outfile}`);
			execSync(script, { cwd: root, stdio: 'pipe' });

			const mod = createRequire(import.meta.url)(outfile);
			expect(typeof mod.default.init).toBe('function');
			expect(typeof mod.default.trackPlayer).toBe('function');
			expect(mod.default.getTrackedCount()).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
