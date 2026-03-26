import esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist/main.cjs',
  packages: 'external', // externalize ALL node_modules — only bundle our source
})

console.log('[esbuild] Bundled dist/main.cjs')
