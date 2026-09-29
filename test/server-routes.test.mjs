// 服务端路由测试台：用假的 ctx/webServer 挂载真实 handler，只验证读取与校验路径
import http from 'node:http';
import { apply } from '../lib/index.js';

const routes = [];
const fakeHost = {
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
    effect: (fn, label) => { console.log('[effect]', label); return fn(); },
};
const ctx = { inject: (deps, cb) => { console.log('[inject]', deps.join(',')); cb(fakeHost); } };

apply(ctx, { registry: 'https://registry.npmmirror.com' });
console.log('[routes]', routes.map((r) => r.path).join(', '));

const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    const route = routes.find((r) => r.path === path);
    if (!route) { res.writeHead(404); res.end('no route'); return; }
    Promise.resolve(route.handler(req, res)).catch((e) => {
        if (!res.headersSent) { res.writeHead(500, { 'content-type': 'text/plain' }); }
        res.end(String(e && e.message ? e.message : e));
    });
});

const PORT = 3199;
await new Promise((r) => server.listen(PORT, r));
const base = 'http://127.0.0.1:' + PORT;

async function show(label, promise) {
    try {
        const res = await promise;
        const text = await res.text();
        console.log('\n### ' + label);
        console.log('  status: ' + res.status);
        console.log('  body  : ' + text.slice(0, 700));
    } catch (e) {
        console.log('\n### ' + label + '\n  ERROR: ' + e.message);
    }
}

// 1) 正常检查
await show('GET /check（读取本机版本 + npmmirror 元数据）', fetch(base + '/dsh-update-notifier/api/check'));

// 2) 方法不允许
await show('POST /check（应 405）', fetch(base + '/dsh-update-notifier/api/check', { method: 'POST' }));

// 3) 跨源拒绝
await show('POST /upgrade 跨源（应 403）', fetch(base + '/dsh-update-notifier/api/upgrade', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example.com', host: '127.0.0.1:' + PORT },
    body: JSON.stringify({ version: '0.1.7-rc.2' }),
}));

// 4) 版本号注入拦截（关键安全测试）
for (const bad of ['0.1.7-rc.2; rm -rf /', '$(whoami)', '../../etc/passwd', '', 'latest']) {
    await show('POST /upgrade 非法版本 ' + JSON.stringify(bad) + '（应 400）', fetch(base + '/dsh-update-notifier/api/upgrade', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base, host: '127.0.0.1:' + PORT },
        body: JSON.stringify({ version: bad }),
    }));
}

// 5) 状态接口
await show('GET /status', fetch(base + '/dsh-update-notifier/api/status'));

server.close();
console.log('\n[done] 服务端路由验证结束（未执行任何真实升级）');
