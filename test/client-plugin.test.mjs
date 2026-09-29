/**
 * 客户端半边测试：用极简 React / 浏览器 shim 驱动真实客户端代码，
 * 验证 1) module-loader 注册契约 2) 插槽注册 3) 弹窗结构 4) 今日不再提示逻辑。
 */
import { readFile } from 'node:fs/promises';

let registration = null;
const store = new Map();

// ---- 浏览器环境 shim ----
globalThis.window = {
    __ModuleLoader__: { load: (reg) => { registration = reg; } },
    localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
};
globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '', setAttribute: () => {} }),
    head: { appendChild: () => {} },
};

const src = await readFile(new URL('../client/client.js', import.meta.url), 'utf8');
// eslint-disable-next-line no-new-func
new Function(src)();

const results = [];
const check = (name, ok, extra) => {
    results.push((ok ? '  [OK]   ' : '  [FAIL] ') + name + (extra ? '  -> ' + extra : ''));
    return ok;
};

check('module-loader 注册被调用', registration !== null);
check('注册 id 正确', registration && registration.id === 'dsh-update-notifier', registration && registration.id);

// ---- 极简 React shim ----
const hookState = [];
let hookIndex = 0;
const setterLog = [];
const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useState: (initial) => {
        const slot = hookState[hookIndex] !== undefined ? hookState[hookIndex] : initial;
        const idx = hookIndex;
        hookIndex += 1;
        return [slot, (v) => { setterLog.push({ idx, value: v }); }];
    },
    useEffect: (fn) => { pendingEffects.push(fn); },
    useCallback: (fn) => fn,
};
let pendingEffects = [];
const requireShim = (name) => {
    if (name === 'react') return React;
    throw new Error('unexpected require: ' + name);
};

const mod = registration.factory(requireShim);
check('factory 导出 apply', typeof mod.apply === 'function');
check('factory 导出 inject = ["slots"]', Array.isArray(mod.inject) && mod.inject.length === 1 && mod.inject[0] === 'slots', JSON.stringify(mod.inject));

// ---- 插槽注册 ----
let injectedSlot = null;
let registeredId = null;
let registeredComp = null;
const fakeCtx = {
    slots: {
        inject: (name, cb) => { injectedSlot = name; cb(); },
        register: (meta, comp) => { registeredId = meta.id; registeredComp = comp; return () => {}; },
    },
};
mod.apply(fakeCtx);
check('注册进 shell.overlay 插槽', injectedSlot === 'shell.overlay', injectedSlot);
check('注册 id = dsh-update-notifier', registeredId === 'dsh-update-notifier', registeredId);
check('注册的是组件函数', typeof registeredComp === 'function');

// ---- 弹窗结构（注入 prompt 状态）----
const PAYLOAD = {
    installed: '0.1.5-rc.3', channel: 'latest', target: '0.1.7-rc.2',
    publishedAt: '2026-09-24T14:18:11.337Z', updateAvailable: true,
    distTags: { latest: '0.1.7-rc.2' }, registry: 'https://registry.npmmirror.com', upgradeAllowed: true,
};
function renderWith(state, payload, fetchImpl) {
    hookState.length = 0;
    hookState.push(state, payload, '', false, '');
    hookIndex = 0;
    pendingEffects = [];
    setterLog.length = 0;
    globalThis.fetch = fetchImpl;
    const tree = registeredComp();
    return { tree, effects: pendingEffects.slice() };
}

const flatten = (node) => {
    if (node === null || node === undefined || node === false) return [];
    if (typeof node === 'string' || typeof node === 'number') return [String(node)];
    if (Array.isArray(node)) return node.flatMap(flatten);
    return [String(node.type)].concat(flatten(node.props.className || ''), node.children.flatMap(flatten));
};

const { tree } = renderWith('prompt', PAYLOAD, async () => ({ ok: true, json: async () => PAYLOAD }));
const flat = flatten(tree).join(' | ');
check('弹窗根节点为 .dsh-un-mask', flat.includes('dsh-un-mask'));
check('包含「发现新版本」', flat.includes('发现新版本'));
check('包含当前版本', flat.includes('0.1.5-rc.3'));
check('包含目标版本', flat.includes('0.1.7-rc.2'));
check('包含「升级更新」按钮', flat.includes('升级更新'));
check('包含「取消」按钮', flat.includes('取消'));
check('包含「今日不再提示」', flat.includes('今日不再提示'));
check('包含发布时间', flat.includes('2026-09-24') || flat.includes('2026-09-24 22:18'));

// ---- 今日不再提示逻辑 ----
const today = (() => {
    const d = new Date();
    const p = (n) => (n < 10 ? '0' + n : String(n));
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
})();

async function runEffectWithSnooze(value) {
    store.clear();
    if (value !== null) store.set('dsh-update-notifier:snooze-date', value);
    const r = renderWith('checking', null, async () => ({ ok: true, json: async () => PAYLOAD }));
    // 执行 useEffect（检查逻辑）
    for (const fn of r.effects) { fn(); }
    await new Promise((res) => setTimeout(res, 30));
    return setterLog.map((s) => s.value);
}

const withSnooze = await runEffectWithSnooze(today);
check('今日已勾选「不再提示」时：不弹窗', withSnooze.includes('prompt') === false, JSON.stringify(withSnooze));

const withoutSnooze = await runEffectWithSnooze(null);
check('未勾选时：出现弹窗（prompt）', withoutSnooze.includes('prompt') === true, JSON.stringify(withoutSnooze));

const yesterday = '2000-01-01';
const staleSnooze = await runEffectWithSnooze(yesterday);
check('免打扰过期（非今天）时：再次弹窗', staleSnooze.includes('prompt') === true, JSON.stringify(staleSnooze));

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('  [FAIL]')).length;
console.log('\n合计: ' + results.length + ' 项，失败 ' + failed + ' 项');
process.exit(failed === 0 ? 0 : 1);
