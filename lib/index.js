/**
 * dsh-update-notifier — 宿主（服务端）半边。
 *
 * 职责：
 *   1. 读取本机已安装的 dsh 版本；
 *   2. 查询 npm registry 的 dist-tags 与发布时间；
 *   3. 暴露两个同源 HTTP 接口给浏览器半边：
 *        GET  /dsh-update-notifier/api/check    —— 是否有更新
 *        POST /dsh-update-notifier/api/upgrade  —— 执行全局升级
 *
 * 设计取舍：
 *   - 版本元数据在宿主侧带 TTL 缓存，避免每次打开页面都打 registry；
 *   - registry 走 npmmirror 优先，符合国内网络环境，可配置覆盖；
 *   - 升级接口只接受「registry 上真实存在的版本号」，用严格正则拦截拼接注入。
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const name = 'dsh-update-notifier';

/** 被检查的包（就是 dsh 本体）。 */
const PKG = '@deepseek-ai/dsh';
/** 版本号白名单：0.1.7-rc.2 这种形式，杜绝任何 shell 拼接风险。 */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** 允许的升级频道。 */
const CHANNELS = new Set(['latest', 'next', 'alpha']);

const ROUTE_PREFIX = '/dsh-update-notifier';

/** 默认配置，可被 profile 的 config 覆盖。 */
const DEFAULTS = {
    registry: 'https://registry.npmmirror.com',
    fallbackRegistry: 'https://registry.npmjs.org',
    channel: 'latest',
    checkOnStart: true,
    allowUpgrade: true,
    cacheTtlSeconds: 600,
    requestTimeoutMs: 8000,
    upgradeTimeoutMs: 300000,
};

function sendJson(response, status, payload) {
    response.writeHead(status, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify(payload));
}

/** 变更类接口要求同源，防止被第三方页面驱动。 */
function sameOrigin(request) {
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (origin === undefined || host === undefined) {
        return false;
    }
    try {
        return new URL(origin).host === host;
    } catch {
        return false;
    }
}

async function readJsonBody(request, maxBytes = 4096) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > maxBytes) {
            throw new Error('request body too large');
        }
        chunks.push(buffer);
    }
    if (size === 0) {
        return {};
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * 解析语义化版本，返回可比较结构。
 * @param value - 版本字符串。
 * @returns 解析结果，非法版本返回 null。
 */
function parseVersion(value) {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value ?? '').trim());
    if (m === null) {
        return null;
    }
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] === undefined ? null : m[4].split('.') };
}

/**
 * 比较两个版本（semver 子集）：正式版大于同号预发布版。
 * @returns a>b 为 1，a<b 为 -1，相等为 0。
 */
function compareVersion(a, b) {
    const A = parseVersion(a);
    const B = parseVersion(b);
    if (A === null || B === null) {
        return 0;
    }
    for (let i = 0; i < 3; i += 1) {
        if (A.nums[i] !== B.nums[i]) {
            return A.nums[i] > B.nums[i] ? 1 : -1;
        }
    }
    if (A.pre === null && B.pre === null) {
        return 0;
    }
    if (A.pre === null) {
        return 1;
    }
    if (B.pre === null) {
        return -1;
    }
    const len = Math.max(A.pre.length, B.pre.length);
    for (let i = 0; i < len; i += 1) {
        const x = A.pre[i];
        const y = B.pre[i];
        if (x === undefined) {
            return -1;
        }
        if (y === undefined) {
            return 1;
        }
        const nx = /^\d+$/.test(x);
        const ny = /^\d+$/.test(y);
        if (nx && ny) {
            if (Number(x) !== Number(y)) {
                return Number(x) > Number(y) ? 1 : -1;
            }
        } else if (nx !== ny) {
            return nx ? -1 : 1;
        } else if (x !== y) {
            return x > y ? 1 : -1;
        }
    }
    return 0;
}

/**
 * 定位本机 dsh 安装目录并读出已安装版本。
 * 主路径：从进程 argv 反推（dsh 以 node .../dsh/lib/bin.js 启动）。
 * @returns 版本与目录信息。
 */
async function installedInfo() {
    const candidates = [];
    const argv1 = process.argv[1];
    if (typeof argv1 === 'string' && argv1.length > 0) {
        candidates.push(path.resolve(path.dirname(argv1), '..'));
    }
    // 回退：常见的 npm 全局安装位置
    const appData = process.env.APPDATA;
    if (typeof appData === 'string' && appData.length > 0) {
        candidates.push(path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
    }
    if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0) {
        candidates.push(path.join(process.env.DSH_HOME, '..', 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
    }
    for (const dir of candidates) {
        try {
            const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
            if (pkg.name === PKG) {
                return { version: pkg.version, dir, resolvedBy: 'package.json' };
            }
        } catch {
            // 继续尝试下一个候选路径
        }
    }
    return { version: 'unknown', dir: null, resolvedBy: null };
}

/**
 * 拉取 registry 元数据（dist-tags + 发布时间）。
 * @param registry - registry 根地址。
 * @param timeoutMs - 请求超时。
 */
async function fetchMeta(registry, timeoutMs) {
    const base = String(registry).replace(/\/+$/, '');
    const url = `${base}/${PKG.replace('/', '%2f')}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: { accept: 'application/json' },
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const json = await response.json();
        return {
            registry: base,
            distTags: json['dist-tags'] ?? {},
            time: json.time ?? {},
            latestVersion: json['dist-tags']?.latest ?? null,
        };
    } finally {
        clearTimeout(timer);
    }
}

function runNpmInstall(target, timeoutMs) {
    return new Promise((resolve) => {
        const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        const args = ['install', '-g', `${PKG}@${target}`];
        execFile(npm, args, {
            // Windows 上 npm 是 .cmd，需要 shell 才能被 execFile 执行；
            // target 已通过 VERSION_RE 白名单校验，不存在拼接注入。
            shell: process.platform === 'win32',
            timeout: timeoutMs,
            windowsHide: true,
            maxBuffer: 8 * 1024 * 1024,
        }, (error, stdout, stderr) => {
            resolve({
                ok: error === null,
                error: error === null ? null : (error.killed === true ? 'timeout' : error.message),
                stdout: String(stdout ?? '').slice(-4000),
                stderr: String(stderr ?? '').slice(-4000),
            });
        });
    });
}

/**
 * 插件入口。
 * @param ctx - 宿主上下文。
 * @param config - profile 覆盖配置。
 */
export function apply(ctx, config) {
    const options = { ...DEFAULTS, ...(config ?? {}) };
    /** 版本元数据缓存：{ at, data } */
    let cache = null;
    /** 升级过程状态，用于前端轮询展示。 */
    let upgradeState = { running: false, target: null, startedAt: 0, result: null };

    async function loadMeta(force) {
        const now = Date.now();
        if (force !== true && cache !== null && now - cache.at < options.cacheTtlSeconds * 1000) {
            return cache.data;
        }
        let data;
        try {
            data = await fetchMeta(options.registry, options.requestTimeoutMs);
        } catch (primaryError) {
            if (options.fallbackRegistry === options.registry) {
                throw primaryError;
            }
            data = await fetchMeta(options.fallbackRegistry, options.requestTimeoutMs);
        }
        cache = { at: now, data };
        return data;
    }

    function buildCheckPayload(meta, installed) {
        const channel = CHANNELS.has(options.channel) ? options.channel : 'latest';
        const target = meta.distTags[channel] ?? meta.distTags.latest ?? null;
        const publishedAt = target === null ? null : (meta.time[target] ?? null);
        const updateAvailable = target !== null
            && installed.version !== 'unknown'
            && compareVersion(target, installed.version) > 0;
        return {
            installed: installed.version,
            channel,
            target,
            publishedAt,
            updateAvailable,
            distTags: meta.distTags,
            registry: meta.registry,
            upgradeAllowed: options.allowUpgrade === true,
        };
    }

    ctx.inject(['webServer'], (host) => {
        host.effect(() => {
            const disposers = [];

            disposers.push(host.webServer.register({
                kind: 'exact',
                path: `${ROUTE_PREFIX}/api/check`,
                handler: async (request, response) => {
                    if (request.method !== 'GET') {
                        response.writeHead(405, { allow: 'GET' });
                        response.end();
                        return;
                    }
                    const url = new URL(request.url ?? '/', 'http://localhost');
                    const force = url.searchParams.get('force') === '1';
                    try {
                        const installed = await installedInfo();
                        if (options.checkOnStart !== true && force !== true) {
                            sendJson(response, 200, { installed: installed.version, updateAvailable: false, disabled: true });
                            return;
                        }
                        const meta = await loadMeta(force);
                        sendJson(response, 200, buildCheckPayload(meta, installed));
                    } catch (error) {
                        sendJson(response, 200, {
                            installed: (await installedInfo()).version,
                            updateAvailable: false,
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                },
            }));

            disposers.push(host.webServer.register({
                kind: 'exact',
                path: `${ROUTE_PREFIX}/api/upgrade`,
                handler: async (request, response) => {
                    if (request.method !== 'POST') {
                        response.writeHead(405, { allow: 'POST' });
                        response.end();
                        return;
                    }
                    if (!sameOrigin(request)) {
                        sendJson(response, 403, { ok: false, error: 'cross-origin request rejected' });
                        return;
                    }
                    if (options.allowUpgrade !== true) {
                        sendJson(response, 403, { ok: false, error: 'upgrade is disabled by configuration' });
                        return;
                    }
                    if (upgradeState.running) {
                        sendJson(response, 409, { ok: false, error: 'an upgrade is already running', target: upgradeState.target });
                        return;
                    }
                    let body;
                    try {
                        body = await readJsonBody(request);
                    } catch (error) {
                        sendJson(response, 400, { ok: false, error: 'invalid json body' });
                        return;
                    }
                    const target = String(body?.version ?? '');
                    if (!VERSION_RE.test(target)) {
                        sendJson(response, 400, { ok: false, error: 'a concrete semantic version is required' });
                        return;
                    }
                    upgradeState = { running: true, target, startedAt: Date.now(), result: null };
                    try {
                        const result = await runNpmInstall(target, options.upgradeTimeoutMs);
                        upgradeState = { running: false, target, startedAt: upgradeState.startedAt, result };
                        sendJson(response, 200, {
                            ok: result.ok,
                            target,
                            needsRestart: result.ok,
                            output: result.stdout,
                            error: result.error,
                            stderr: result.stderr,
                        });
                    } catch (error) {
                        upgradeState = { running: false, target, startedAt: Date.now(), result: null };
                        sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
                    }
                },
            }));

            disposers.push(host.webServer.register({
                kind: 'exact',
                path: `${ROUTE_PREFIX}/api/status`,
                handler: (request, response) => {
                    if (request.method !== 'GET') {
                        response.writeHead(405, { allow: 'GET' });
                        response.end();
                        return;
                    }
                    sendJson(response, 200, upgradeState);
                },
            }));

            return () => {
                for (const dispose of disposers) {
                    if (typeof dispose === 'function') {
                        dispose();
                    }
                }
            };
        }, 'dsh-update-notifier: http routes');
    });
}
