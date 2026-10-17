# dsh-plugin-restart-btn

为 DeepSeek Harness 桌面版在**侧边栏页脚**（设置按钮旁）添加一个「重启」按钮，
带确认弹窗，点击后**彻底重启整个 DSH 应用**（完全退出后自动重新启动）。

## 安装

在 DSH 的插件管理器里安装一个 bundle，spec 直接填 GitHub 地址即可：

```
github:kviiinh/dsh-plugin-restart-btn
```

安装后**重启 DSH**（退出应用再打开）即可看到按钮。

> **为什么需要重启，而不是刷新页面**
>
> 插件由两部分组成：Host 半边在 DSH 的 Host 进程里运行，Client 半边（按钮 UI）
> 只在页面启动时通过 `__DSH_BOOT__` 注入。
>
> **DSH 桌面端没有页面刷新快捷键**：它的 Windows 应用菜单只注册了开发者工具
> （F12），`role: "reload"` 与 `F5`/`Ctrl+R` 都只存在于开发模式分支，打包版
> 全部不可用。而重启 DSH 会同时重新加载 Host 插件和页面，是最可靠的生效方式。
>
> 装好这个插件之后，你还可以直接点那个「重启」按钮完成同样的操作。

## 前置条件

- **仅 Windows**：重启器依赖 `taskkill`，且实现针对 Windows 进程模型。
- **仅桌面版 DSH**：以纯 Node 或 `dsh web` 启动时会提示无法自动重启（预期行为）。

## 为什么需要这样一个插件

DSH 的重启能力（`app.relaunch()`）只存在于 Electron 主进程，且相关菜单项被
`development = !app.isPackaged` 关掉，打包版用户用不到；preload 也没有暴露任何
重启 IPC。插件运行在 Host 子进程里，无法从内部重启自己 —— 如果直接
`process.exit()`，主进程会把它当作崩溃并弹错误框，而且**不会自动重启**。

本插件的做法是：插件只负责**派发**一个脱离 DSH 进程树的独立重启器，由它完成
「退出→等待→拉起」。

```
DeepSeek Harness.exe (主进程, 拥有窗口与单实例锁)
  └─ dsh-desktop-host    ← 插件在这里
        └─ spawn(detached) restart-host.js   ← 脱离进程树，DSH 退出后仍存活
              ├─ 强制结束主进程 (taskkill /F，单 pid，绝不用 /T)
              ├─ 等 Host 因 IPC 断开自行退出
              └─ 重新启动 DeepSeek Harness.exe
```

## 架构：Client 与 Host 如何通信

Client 半边**不**使用 `host.call` —— 那个入口只属于沙箱化的动态包（dynamic
package）。普通 bundle 通过 Host 服务或 HTTP 路由通信，本插件选择后者：

```
client.js  ──POST /plugins-local/dsh-restart──▶  index.js
            {"action":"capability"}              探测是否可重启
            {"action":"restart"}                 派发重启器
```

这样就不需要 typert 代码生成，也**不依赖任何 Host 组件的内部 props**。

## 一条必须遵守的规则：只碰声明过的服务

Client 端的页面启动会在加载完所有插件后做一次审计：**任何一个插件条目没进入
`active` 状态，整个页面启动就判定失败**，桌面壳随即弹出「应用无法启动」并退出应用。

因此 `apply(ctx)` 里**只能访问 `inject` 里声明过的服务**。本插件只声明
`inject: ['slots']`，所以绝不能碰 `ctx.locale`、`ctx.theme`、`ctx.remote` 等 ——
它们在此时可能是 `undefined`，访问即抛异常 → 条目失败 → 整个应用起不来。

界面文案因此由本插件自带（按 `document.documentElement.lang` 选择中/英文），
不读取 locale 服务。

## 三条会导致「整个应用无法启动」的坑（均已踩过）

浏览器端的启动审计会**逐条检查每个插件是否进入 `active`**，任何一条失败就让
整个 DSH 无法启动。以下都是实际踩过的：

1. **`apply(ctx)` 访问未在 `inject` 声明的服务**（如 `ctx.locale`）→ 抛异常。
2. **`dsh.client.inject` 里写了包名**（例如 `@deepseek-ai/dsh-client-ui-settings-account`）→
   浏览器把它当**服务名**解析，永远等不到 → 条目卡住/失败。
   该字段只用于**排定加载顺序**，且必须写服务名而非包名；本插件不需要，故省略。
3. **使用沙箱内置对象 `styles` / `host`** → 它们只存在于沙箱化动态包；
   普通 bundle 里是 `undefined`，调用即抛。注入样式请直接 `document.createElement('style')`。

另外 `dsh.client.immediately: true` 会让插件在早期阶段就被执行，风险更高；除非确有必要，不要开。

## 文件说明

| 文件 | 作用 |
|---|---|
| `package.json` | 包清单：`dsh.bundle.patch` 与 `dsh.client` 声明 |
| `cordis.patch.yml` | Loader 补丁，插入本插件的 Host 行 |
| `index.js` | Host 半边：注册 HTTP 路由、探测可执行文件与主进程 pid、spawn 重启器 |
| `restart-host.js` | 独立重启器：退出、等待、重新启动；日志写 `%TEMP%\dsh-restart.log` |
| `client.js` | Client 半边：注册 `sidebar.footer.action` 里的「重启」按钮 |
| `locale/en.json`、`locale/zh.json` | 插件列表中的标题与描述 |
| `icon.svg` | 插件图标 |

## 使用

侧边栏底部、设置按钮旁 →「重启」。侧边栏展开时是带文字的整行按钮，
收起时是 36px 圆形图标按钮（与旁边内置的插件面板按钮同尺寸、同圆角）。

点击后先弹出确认框：

- 默认焦点在「取消」上，误按回车不会重启
- 按 Esc 或点击遮罩可取消
- 确认后应用退出并自动重新启动

样式全部取自 DSH 内置页脚按钮的规格（42px 行高、12px 圆角、`--dsw-alias-*`
主题令牌），因此与相邻按钮对齐，并自动跟随深浅色主题。

## 为什么不能优雅退出，而是直接结束

托盘菜单里的「退出」很快，因为它是在**主进程内部**调用 `app.quit()`。
从插件的外部进程做不到这一点，而 `taskkill`（不带 `/F`）反而更糟：

> 它发送 **WM_CLOSE**，DSH 的 `window.on('close')` 会走 `DesktopQuitConfirmation`
> ——先 `inspectQuit()` 检查是否有任务在跑，再弹一个原生确认框。
> 那个框没有人去点，于是窗口一直挂着。**这就是早期版本卡 15 秒的原因。**

所以重启器直接走强制结束，跳过 WM_CLOSE 整套流程。**顺序非常关键**：

1. **先结束主进程**；
2. **等 Host 自己退出** —— 它通过 IPC 通道挂主进程，主进程一死，Host 的
   `process.once('disconnect', stop)` 会自己收尾；
3. 只有 Host 迟迟不退时，才在**没有父进程可观察它**的情况下补一刀；
4. 两者都消失后，启动新实例。

> **为什么不能先杀 Host**：主进程里 `child.once('close')` 对**任何**退出码
> 都调用 `fail()`，连 `code 0` 也算致命：
>
> ```js
> if (code !== 0 && code !== null) this.fail(...'host exited with '+code)
> else this.fail(...'host stopped')
> ```
>
> 先杀 Host 会让主进程判定为崩溃并弹出「应用无法启动」错误框。整个重启虽然
> 最终成功，但会**闪一下错误弹窗** —— 这正是早期版本的诡异现象。

**绝不使用 `taskkill /T`**：重启器本身是 Host 的子进程，`/T` 会把重启器自己
一起杀掉——早期版本因此出现「退出了但再也不启动」。

## 版本要求与排错

- 仅适用于**桌面版**（可执行文件旁存在 `resources/app.asar`）。以纯 Node 或
  `dsh web` 方式启动时，按钮会提示「当前 DSH 实例无法自动重启」，这是预期行为。
- 重启器日志：`%TEMP%\dsh-restart.log`。正常一次重启应类似：

  ```
  --- relauncher start (main=… host=… exe=…)
  terminating main process …
  main process … exited
  started the app as pid …
  ```

  若停在 `terminating main process` 之后没有 `exited`，说明进程未被结束；
  若停在 `exited` 之后没有 `started`，说明可执行文件路径有问题。

## 设计取舍

- 使用官方**增量插槽** `sidebar.footer.action`（`replaceRisk: none`），新 id 会
  添加到现有条目旁边，不替换任何内置按钮，因此 DSH 升级后不易失效。
- 不 `inject` 任何服务、不读取其它包的私有 props，组件只用插槽给出的 `wide`。

> 早期版本曾用 `settings.launcher` 槽位把「重启」放进账号菜单的「意见反馈」下方。
> 该槽位是**单槽位**，替换 Host 账号菜单就必须复刻其 `inject`（`hooks.account`、
> `theme`、`start`、`cancel` 等）私有契约；漏掉 `inject` 会让 `useAccount` 变成
> `undefined`，渲染时抛异常，进而导致**整个应用启动失败**。因此改用官方增量插槽。
