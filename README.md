# dsh-update-notifier

> 一个给 **DeepSeek Harness (dsh)** 用的更新提醒插件：每次打开 dsh 自动检查新版本并弹窗，支持一键升级与「今日不再提示」。

<p>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue">
  <img alt="platform" src="https://img.shields.io/badge/platform-dsh%20web-0e8ab1">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D20-green">
</p>

---

## 特性

| 能力 | 说明 |
|---|---|
| **启动即检查** | 每次打开 dsh Web 界面都会向宿主查询一次版本，有更新立即弹窗 |
| **一键升级** | 弹窗内直接执行 `npm install -g @deepseek-ai/dsh@<新版本>`，无需手动开终端 |
| **今日不再提示** | 勾选后当天不再打扰；**不勾选则每次打开都会提示**（按自然日计算，跨天自动恢复） |
| **多频道支持** | 可切换 `latest` / `next` / `alpha` 三个 dist-tag 频道 |
| **国内网络友好** | 默认走 npmmirror，失败自动回退 npmjs 官方源 |
| **带缓存** | 宿主侧 10 分钟 TTL 缓存，避免每次刷新页面都打 registry |
| **失败可见** | 升级失败会在弹窗内直接显示 npm 的 stderr，不用去翻日志 |

## 安装

### 方式一：官方 CLI（推荐）

```bash
dsh plugin --profile web add dsh-update-notifier
```

CLI 会自动把插件写入 profile 的 `dsh.profile.bundles`，**无需手工编辑任何配置文件**。

从本地目录安装（开发调试用）：

```bash
dsh plugin --profile web add file:/path/to/dsh-update-notifier
```

### 方式二：手动挂载

在 profile 的 `cordis.patch.yml` 里加一行：

```yaml
- insert:
    - id: dsh-update-notifier
      name: 'dsh-update-notifier'
      config:
        channel: latest
```

安装后**重启 dsh web** 生效。

## 配置

配置写在 profile 的插件行 `config` 下（全部可选）：

```yaml
- insert:
    - id: dsh-update-notifier
      name: 'dsh-update-notifier'
      config:
        registry: https://registry.npmmirror.com   # 主 registry
        fallbackRegistry: https://registry.npmjs.org  # 主源失败时的回退
        channel: latest          # latest | next | alpha
        checkOnStart: true       # 关闭后仅支持手动强制检查（?force=1）
        allowUpgrade: true       # 关闭后弹窗只提示、不提供升级按钮
        cacheTtlSeconds: 600     # 版本元数据缓存时长（秒）
        requestTimeoutMs: 8000   # registry 请求超时
        upgradeTimeoutMs: 300000 # 升级命令超时
```

## 工作原理

```
┌─ 浏览器（客户端半边）───────────────────────────┐
│  shell.overlay 插槽                              │
│    └─ UpdateNotice 组件                          │
│         │ 页面加载 → fetch(/api/check)           │
│         │ 有更新 & 今天未勾选免打扰 → 渲染弹窗    │
│         │ 「升级更新」→ POST /api/upgrade        │
│         └─「今日不再提示」→ localStorage 存日期   │
└──────────────────┬───────────────────────────────┘
                   │ 同源 fetch
┌──────────────────▼───────────────────────────────┐
│  宿主（服务端半边）                                │
│    GET  /dsh-update-notifier/api/check            │
│         ├─ 从进程 argv 反查本机 dsh 版本           │
│         ├─ 拉 registry dist-tags（带 TTL 缓存）    │
│         └─ semver 比较 → updateAvailable          │
│    POST /dsh-update-notifier/api/upgrade          │
│         ├─ 同源校验 + 版本号白名单                 │
│         └─ execFile npm install -g                 │
│    GET  /dsh-update-notifier/api/status           │
└───────────────────────────────────────────────────┘
```

### 为什么是两个半边

dsh 的插件体系里，**服务端只能读文件/发请求，浏览器端才能画界面**。所以本插件分成：

- `lib/index.js` —— 宿主半边，注册 HTTP 路由，负责读版本、查 registry、执行升级；
- `client/client.js` —— 浏览器半边，注册到 `shell.overlay` 全局浮层插槽，负责渲染弹窗。

浏览器半边是**手写的 module-loader bundle**，不需要 TypeScript / 打包工具链：

```js
window.__ModuleLoader__.load({
    id: "dsh-update-notifier",
    factory: (require) => {
        const React = require("react");
        const h = React.createElement;
        // ... 组件与 apply()
        exports.apply = apply;    // ctx.slots.inject("shell.overlay", ...)
        exports.inject = ["slots"];
        return module.exports;
    }
});
```

## 兼容性

插件自 **1.0.1** 起声明宿主契约，安装时 dsh 的插件管理器会据此校验（此前未声明，等于放弃被守卫保护）：

```json
"engines": { "dsh": "^0.1.5-rc.1 || ^0.2.0-rc.1" },
"peerDependencies": {
  "@deepseek-ai/dsh-host-webserver": "^0.1.5-rc.1 || ^0.2.0-rc.1"
}
```

| dsh 版本 | 状态 | 验证方式 |
|---|---|---|
| **0.2.0-rc.2** | ✅ 已验证 | 换端口冒烟启动，接口返回 `{"installed":"0.2.0-rc.2","channel":"next"}` |
| 0.1.7-rc.2 | ✅ 已验证 | 接口返回 200 并正确报告更新状态 |
| 0.1.5-rc.3 | ✅ 已验证 | 安装生效，弹窗完成过一次真实升级 |

用到的 dsh 接口在 0.1.x 与 0.2.0 之间的对照（逐项按 0.2.0-rc.2 核对）：

| 能力 | 0.2.0 现状 |
|---|---|
| `window.__ModuleLoader__.load({ id, factory })` | 未变，与官方客户端插件同构 |
| `ctx.slots.inject("shell.overlay", …)` | 插槽仍在（0.2.0 的插件管理器同样注册到它） |
| `exports.inject = ["slots"]` | 仍是标准写法 |
| `host.webServer.register({ kind: "exact", path, handler })` | 签名未变 |
| `ctx.inject(["webServer"], …)` + `host.effect(…)` | 未变 |

> 0.1.x 与 0.2.0 的破坏性变化集中在**插件之间的相互要求**（例如 `dsh-better-sidebar@0.24.1` 要求 `^0.2.0-rc.1`），本插件用到的接口在两个大版本上没有变化。

## 安全

升级接口能在你机器上执行 `npm install -g`，因此做了三重限制：

1. **同源校验**：`Origin` 必须与 `Host` 一致，第三方页面无法驱动升级；
2. **版本号白名单**：只接受 `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`，`0.1.7-rc.2; rm -rf /` 这类输入直接被拒；
3. **浏览器信任围栏**：dsh 本身的会话 token 机制仍然生效。

> 测试用例覆盖了 `; rm -rf /`、`$(whoami)`、`../../etc/passwd` 等注入尝试，全部返回 400。

## 开发与测试

```bash
# 服务端路由测试（不依赖 dsh 运行时，也不会真的执行升级）
node test/server-routes.test.mjs

# 客户端组件与免打扰逻辑测试（极简 React/浏览器 shim）
node test/client-plugin.test.mjs
```

两套测试合计 **18 + 8 项断言**，覆盖：版本读取、semver 比较、跨源拒绝、注入拦截、插槽注册、弹窗结构、免打扰三种状态。

### 本地联调

```bash
# 用独立的测试 profile，避免影响正在使用的 web profile
dsh --profile plugin-dev --from-default-profile web --dump-config
dsh plugin --profile plugin-dev add file:/path/to/dsh-update-notifier
dsh --profile plugin-dev --port 3098 --no-open
```

## 常见问题

**Q：升级完为什么没有立即生效？**
A：全局 npm 包已替换，但运行中的 dsh 进程仍持有旧版本。**重启 dsh web** 后生效（弹窗成功后会提示这一点）。

**Q：勾了「今日不再提示」，明天还会提示吗？**
A：会。免打扰按**自然日**记录（`localStorage` 里存 `2026-09-29` 这样的日期字符串），跨天自动恢复。

**Q：能只在有重大更新时提示吗？**
A：把 `channel` 设为 `latest`（默认）即可，`alpha` 频道会提示预发布版本。

**Q：公司内网用私有 registry 怎么办？**
A：把 `registry` 指向内网地址即可，`fallbackRegistry` 可设为同一个值以禁用回退。

## License

[MIT](./LICENSE) © Lux-Fer
