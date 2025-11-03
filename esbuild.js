const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				if (location === null) {
					return;
				}
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

/**
 * Plugin to copy template files to output directory
 * @type {import('esbuild').Plugin}
 */
const copyTemplatesPlugin = {
	name: 'copy-templates',

	setup(build) {
		build.onEnd(() => {
			const srcTemplates = path.join(__dirname, 'src', 'templates');
			const outTemplates = path.join(__dirname, 'out', 'templates');

			// Create output templates directory if it doesn't exist
			if (!fs.existsSync(outTemplates)) {
				fs.mkdirSync(outTemplates, { recursive: true });
			}

			// Copy all template files
			if (fs.existsSync(srcTemplates)) {
				const files = fs.readdirSync(srcTemplates);
				files.forEach(file => {
					const srcFile = path.join(srcTemplates, file);
					const outFile = path.join(outTemplates, file);
					fs.copyFileSync(srcFile, outFile);
					console.log(`[copy] ${file} -> out/templates/${file}`);
				});
			}
		});
	},
};

async function main() {
	const ctx = await esbuild.context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'out/extension.js',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
			copyTemplatesPlugin,
		],
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
