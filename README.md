# dsh-eval

`dsh-eval` 是 DeepSeek Harness（DSH）的证据优先评测插件。它在彼此隔离的工作区内成对运行受信任的本地 baseline 与 candidate，用评测器控制的文件、JSON 和可信脚本检查外部世界状态，再生成带输入哈希、逐次观察和预注册门槛的 JSON/Markdown 报告。

当前版本是 development candidate。仓库内 keyless 校准套件故意比较一个已知错误实现和一个已知正确实现；它能证明评测器检测到预期差异，不能证明任何真实 DSH 插件或模型已经提升。真实模型与生产晋级仍需单独运行。

当前兼容目标为 DSH `0.1.1-rc.2` 与 `0.1.2-alpha.1` 系列的公开 session 事件契约。具体 checkout 的兼容性需要重新运行 Loader、打包和 DSH 进程检查，不能从旧报告推断。

## 能力边界

- 版本化 `manifest`、case、report 和 probe 契约，未知字段失败关闭。
- baseline/candidate 按 case 和 repetition 配对；固定 seed 决定首个顺序，随后严格 AB/BA 交替，同一 pair 不并发。
- 每次运行使用独立 workspace、home、临时目录和环境；父进程环境默认只传递系统启动所需字段。
- fixture、trusted scorer 和 variant artifact 全部 SHA-256 内容寻址；每次观测只执行该 variant 的私有 artifact 快照，入口 artifact 必须与实际 argv/executable 绑定。
- 内置退出码、文件存在/缺失、文件内容、JSON Pointer 和可信 Node.js 脚本评分器。
- 记录超时、取消、退出码、信号、启动错误、完整输出字节数/哈希和工作区 diff；默认不保存输出正文。
- 报告 success/score/latency 分布、Wilson 95% 区间、逐对改进/退化和质量/安全/隐私/稳定性门槛。
- profile 加载本插件时，probe 从 DSH `session/event` 记录 turn、model call、tool error 和 durable usage；这些数据由被测进程写入，只是自报观测，不能通过 token/cost 晋级门槛。
- Cordis `ctx.evals` 服务、独立 `dsh-eval` CLI、Loader 组合/热卸载，以及 timeout、取消和 CLI 信号清理。

## 环境要求

- Node.js `^22.19.0` 或 `>=24.0.0`。
- Corepack 和 pnpm `10.33.0`。
- Cordis `^4.0.1`。
- 作为 DSH 插件加载时，需要与 `package.json` 中 `peerDependencies` 匹配的 `@deepseek-ai/dsh-session`。

本地进程 runner 只适合执行受信任代码。不可信 candidate 必须放到由外部平台提供文件、网络、进程和资源隔离的容器或 VM 中。

## 安装

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm run check
corepack pnpm pack
$tarball = (Resolve-Path .\dsh-eval-0.1.0.tgz).Path
dsh plugin --profile web add $tarball
dsh --profile web --dump-config
```

包内 `cordis.patch.yml` 会插入 id 为 `dsh-eval` 的配置行。插件加载后提供 `ctx.evals.run(manifest, options)`；独立 CLI 不需要先启动 DSH。当前包没有正式发布标签，部署应固定生成的 tarball 和 Git commit。

## 配置

默认配置会把报告和临时运行目录放在 `<DSH_HOME>/eval/v1` 下。需要覆盖时，在 profile 的 `cordis.patch.yml` 中重述完整 `config`：

```yaml
- id: dsh-eval
  config:
    reportsPath: C:\managed\dsh-eval\reports
    runsPath: C:\managed\dsh-eval\runs
    defaultTimeoutMs: 300000
    maxConcurrency: 1
    keepWorkspaces: never
    includeProcessOutput: false
    logLifecycle: false
```

| 配置 | 默认值 | 作用 |
| --- | ---: | --- |
| `reportsPath` | `<DSH_HOME>/eval/v1/reports` | JSON 和 Markdown 报告目录，必须是绝对路径 |
| `runsPath` | `<DSH_HOME>/eval/v1/runs` | 每次运行的隔离 workspace 根目录，必须是绝对路径 |
| `defaultTimeoutMs` | `300000` | 单个被测进程默认超时，单位为毫秒 |
| `defaultScorerTimeoutMs` | `30000` | 可信脚本评分器默认超时，单位为毫秒 |
| `maxOutputBytes` | `1000000` | 每个 stdout/stderr 流最多捕获的字节数 |
| `maxConcurrency` | `1` | 不同 pair 的最大并发数，范围 `1..16` |
| `maxWorkspaceEntries` | `20000` | 单个 workspace 快照最多条目数 |
| `maxWorkspaceBytes` | `268435456` | 单个 workspace 快照的普通文件总字节上限 |
| `maxAssertionBytes` | `10000000` | 一条文件或 JSON assertion 最多读取的字节数 |
| `keepWorkspaces` | `never` | 可选 `never`、`failed` 或 `always` |
| `includeProcessOutput` | `false` | 是否把有界 stdout/stderr 正文写入报告 |
| `logLifecycle` | `false` | 是否记录不含任务内容的加载和卸载诊断 |

保留 workspace 或进程输出可能保存私有任务内容，只应在受保护的调试目录中短期启用。未知键、相对路径和越界值会在加载时失败。

## 命令行使用

包的 `dsh-eval` 命令支持校验和运行 manifest：

```powershell
dsh-eval validate .\evals\manifest.json
dsh-eval run .\evals\manifest.json --output .\evals\reports\latest.json --require-pass
```

`--require-pass` 在本地预注册门槛为 `fail` 或 `not-configured` 时返回退出码 2。`decision: pass` 仍不是自动晋级证明：本地报告固定写入 `assurance: local-trusted-process`、`promotionEligible: false` 和阻断原因。

一旦提供 `thresholds`，validator 会要求恰好选择 `test` split、至少 5 次重复、两侧 runtime/entry artifact，以及成功率、平均分增益、逐对/任务回归、均值/p95 延迟和 safety/privacy/stability 全部门槛；模型比较还必须预注册 token 与成本门槛。缺字段不是“跳过”，而是 manifest 无效。

## 最小 manifest

```json
{
  "schema": "dsh-eval-manifest",
  "schemaVersion": 1,
  "id": "plugin-comparison",
  "dataset": {
    "id": "frozen-cases",
    "version": "2026-08-30",
    "caseFiles": ["cases/case-001.json"]
  },
  "variants": {
    "baseline": {
      "id": "stable",
      "revision": "git:abc123",
      "executable": "node",
      "args": ["{manifestDir}/runners/stable.mjs"],
      "artifacts": ["runners/stable.mjs", "artifacts/stable.tgz"],
      "entryArtifact": "runners/stable.mjs",
      "runtime": {
        "harnessVersion": "0.1.2-alpha.1",
        "profile": "headless",
        "provider": "openai",
        "model": "pinned-model-id",
        "sampling": { "temperature": 0, "topP": 1, "seed": 7, "maxOutputTokens": 4096 }
      }
    },
    "candidate": {
      "id": "candidate",
      "revision": "git:def456",
      "executable": "node",
      "args": ["{manifestDir}/runners/candidate.mjs"],
      "artifacts": ["runners/candidate.mjs", "artifacts/candidate.tgz"],
      "entryArtifact": "runners/candidate.mjs",
      "runtime": {
        "harnessVersion": "0.1.2-alpha.1",
        "profile": "headless",
        "provider": "openai",
        "model": "pinned-model-id",
        "sampling": { "temperature": 0, "topP": 1, "seed": 7, "maxOutputTokens": 4096 }
      }
    }
  },
  "execution": {
    "splits": ["test"],
    "repetitions": 5,
    "seed": 20260830,
    "timeoutMs": 300000,
    "maxConcurrency": 1
  },
  "thresholds": {
    "minimumCandidateSuccessRate": 0.8,
    "minimumSuccessRateDelta": 0,
    "minimumMeanScoreDelta": 0.05,
    "maximumPairRegressionCount": 0,
    "maximumTaskRegressionCount": 0,
    "maximumMeanDurationRegressionRatio": 0.2,
    "maximumP95DurationRegressionRatio": 0.2,
    "maximumMeanTotalTokensRegressionRatio": 0.1,
    "maximumMeanEstimatedCostRegressionRatio": 0.1,
    "requireNoSafetyRegression": true,
    "requireNoPrivacyRegression": true,
    "requireNoStabilityRegression": true
  }
}
```

case 将 `task` 交给进程，并把 `fixture` 复制到私有 workspace。`taskInput` 可为 `argument`（默认）、`stdin` 或 `none`。`{manifestDir}` 在运行时指向只包含已登记 artifacts 的私有快照，未列出的相对依赖会直接失败；`{workspace}` 指向当前 case 的世界状态。密钥值不能写进 `env`；真实模型运行应只在 `inheritEnv` 中列出所需变量名，并确保报告/fixture 不含密钥。`HOME`、`DSH_HOME`、临时目录、`NODE_OPTIONS` 和所有 `DSH_EVAL_*` 名称由评测器保留，大小写变体也不能覆盖。

完整字段与信任边界见 [架构说明](docs/ARCHITECTURE.md)，运行、清理和回滚见 [运维说明](docs/OPERATIONS.md)，当前证据见 [验收账本](docs/ACCEPTANCE.md)。可执行样例位于 [`examples/`](examples/)。

## 评测 DSH

DSH 的受支持应用入口仍是命名 profile。variant 的版本化 runner 应在评测器提供的独立 `DSH_HOME` 中准备 profile，然后启动：

```text
dsh --profile headless --patch <baseline-or-candidate.cordis.yml> <task>
```

两侧 patch 必须加载真实 baseline/candidate 组合；若要采集自报 probe 指标，也要加载 `dsh-eval`。runner、patch、打包插件和 lockfile 都应列入 `artifacts`，`entryArtifact` 指向实际启动的版本化 runner。对于 SDK 多轮任务，runner 应使用公开 `@deepseek-ai/dsh-sdk-client` 并在每次 case 后 `await harness.close()`；不要内嵌上游 Cordis 树或访问 DSH 私有源码。真实晋级还要由容器/VM 外部观察 session/billing，当前本地 token/cost gate 会有意失败关闭。

## 验证

普通检查和独立验证入口需要分别运行：

```powershell
$dshRoot = 'C:\path\to\deepseek-harness'
corepack pnpm run check
corepack pnpm run test:integration
corepack pnpm run eval:keyless
corepack pnpm run eval:current-dsh -- --dsh-root $dshRoot
corepack pnpm run eval:pack
```

`check` 只代表类型检查、普通测试和构建通过。`eval:keyless` 是评测器校准，不证明真实 candidate 改进；`eval:current-dsh` 只验证指定 DSH checkout 的服务、probe 和卸载兼容性；`eval:pack` 只验证打包产物。真实模型、外部隔离、独立 billing、Unix 和 canary 都必须单独运行和报告。

## 数据、停用与回滚

默认数据位置：

```text
<DSH_HOME>/eval/v1/
├─ reports/   # 规范 JSON 报告及生成的 Markdown
└─ runs/      # 临时或按策略保留的运行 workspace
```

JSON 报告是规范证据，Markdown 是生成的阅读视图。备份报告时还要保存报告引用的 manifest、case、fixture、scorer、runner、patch、lockfile 和两侧 artifact；只保存 Markdown 不足以复现结论。

停止所有 evaluator 后移除插件：

```powershell
dsh plugin --profile web remove dsh-eval
dsh --profile web --dump-config
```

确认没有评测进程后，可以按保留策略删除 `runs/`。报告删除是独立的数据治理决定。回滚插件时安装先前固定的 tarball，并保留旧报告中的 evaluator version；不得改写旧报告来伪装版本等价。

## 已知限制

- 本地进程与路径隔离不是安全沙箱。恶意候选仍拥有评测器用户的文件权限；不可信候选必须在容器或 VM 中运行。未来外部 runner 可接 Harbor，但核心不嵌入 Python。
- probe 文件路径和身份字段对被测进程可见，因此指标可伪造；同时没有形成 durable usage 的 provider 重试可能漏计。它只用于诊断，不能成为本地晋级门槛。
- timeout/取消会回收已知进程树；Windows 上顶层进程正常退出后自行脱离的后代无法由 Node `spawn` 可靠收容。此类 runner 必须使用外部 Job Object/容器监督，报告会保留该 promotion blocker。
- trusted script 是 evaluator-controlled Oracle，但当前在本机克隆 workspace 中执行，不是容器 verifier。
- keyless、Loader、打包或 mock 上游结果都不能替代真实模型、Unix、容器隔离和 canary 证据；当前状态以 [验收说明](docs/ACCEPTANCE.md) 为准。

## 文档

- [架构说明](docs/ARCHITECTURE.md)：manifest、隔离、完整性和信任边界。
- [运维说明](docs/OPERATIONS.md)：运行、故障响应、备份和卸载。
- [验收说明](docs/ACCEPTANCE.md)：当前证据与未运行门禁。
- [示例](examples/)：可执行 manifest 和 fixture。

## 许可证

MIT，见 [LICENSE](LICENSE)。
