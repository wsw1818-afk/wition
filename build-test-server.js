const { build } = require('esbuild')
const { config } = require('dotenv')
const path = require('path')

const env = config().parsed ?? {}

build({
  entryPoints: ['src-main/test-server.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: 'dist-electron/test-server.js',
  format: 'cjs',
  // better-sqlite3를 외부 모듈로 유지하되, test-deps에서 resolve
  external: ['better-sqlite3', 'ws', 'bufferutil', 'utf-8-validate'],
  define: {
    'process.env.VITE_SUPABASE_URL': JSON.stringify(env.VITE_SUPABASE_URL ?? ''),
    'process.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(env.VITE_SUPABASE_ANON_KEY ?? ''),
    'process.env.VITE_SUPABASE_SERVICE_ROLE_KEY': JSON.stringify(env.VITE_SUPABASE_SERVICE_ROLE_KEY ?? '')
  },
  // 빌드 결과의 맨 앞에 test-deps를 module path에 추가하는 배너
  banner: {
    js: `// test-deps의 Node.js용 better-sqlite3를 우선 로드
const _origResolve = module.constructor._resolveFilename;
const _testDeps = require('path').resolve(__dirname, '..', 'test-deps', 'node_modules');
module.constructor._resolveFilename = function(request, parent, isMain, options) {
  if (request === 'better-sqlite3') {
    try { return _origResolve.call(this, request, { ...parent, paths: [_testDeps, ...(parent?.paths || [])] }, isMain, options); } catch {}
  }
  return _origResolve.call(this, request, parent, isMain, options);
};`
  },
  sourcemap: false,
  minify: false
}).then(() => {
  console.log('✅ dist-electron/test-server.js 빌드 완료')
}).catch((err) => {
  console.error('❌ 빌드 실패:', err)
  process.exit(1)
})
